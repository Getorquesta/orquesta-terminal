// Phase 5: Full cloud WebSocket bridge via tokio-tungstenite + EIO4/Socket.io v4

use std::collections::HashSet;
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async_tls_with_config, tungstenite::Message};

use crate::state::AppState;

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Derive the WebSocket URL from an API base URL.
/// "https://ws.orquesta.live" → "wss://ws.orquesta.live"
/// "http://localhost:3000"    → "ws://localhost:3000"
fn to_ws_url(api_url: &str) -> String {
    if let Some(rest) = api_url.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = api_url.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        api_url.to_string()
    }
}

/// Build a canonical connection key from the base parameters.
pub fn conn_key(api_url: &str, token: &str, project_id: &str) -> String {
    format!("{api_url}:{token}:{project_id}")
}

// ── CloudSocket ───────────────────────────────────────────────────────────────

/// Handle to an active cloud WebSocket connection.
pub struct CloudSocket {
    /// Send raw WS text frames to the socket.
    pub tx: mpsc::Sender<Message>,
    /// Session IDs currently using this connection.
    pub refs: HashSet<String>,
}

// ── connect_socket ────────────────────────────────────────────────────────────

/// Establish a raw EIO4/Socket.io v4 WebSocket connection and return a
/// `CloudSocket` whose `tx` channel drives the write half.
///
/// EIO4 handshake sequence:
///   ← `0{...}` (ENGINE_OPEN)
///   → `40{"auth":{"cliToken":"..."}}` (SOCKET_CONNECT)
///   ← `40` (SOCKET_CONNECT_OK)
///
/// After the handshake a background task runs that:
///   • replies to PING (`2`) with PONG (`3`)
///   • dispatches `42[...]` Socket.io events to `handle_socketio_event`
pub async fn connect_socket(
    api_url: &str,
    cli_token: &str,
    project_id: &str,
    state: Arc<AppState>,
) -> Result<CloudSocket, String> {
    let ws_base = to_ws_url(api_url);
    let url = format!("{ws_base}/socket.io/?EIO=4&transport=websocket");

    let (ws_stream, _) = connect_async_tls_with_config(&url, None, false, None)
        .await
        .map_err(|e| format!("WS connect failed: {e}"))?;

    let (mut sink, mut stream) = ws_stream.split();

    // ── EIO4 Handshake ────────────────────────────────────────────────────────

    // 1. Receive ENGINE_OPEN  `0{"sid":"...","pingInterval":...,"pingTimeout":...}`
    let open_msg = stream
        .next()
        .await
        .ok_or("WS closed before ENGINE_OPEN")?
        .map_err(|e| format!("WS read error: {e}"))?;
    let open_text = match &open_msg {
        Message::Text(t) => t.as_str().to_string(),
        _ => return Err("Expected text for ENGINE_OPEN".into()),
    };
    if !open_text.starts_with('0') {
        return Err(format!("Unexpected EIO4 open frame: {open_text}"));
    }

    // 2. Send SOCKET_CONNECT  `40{"auth":{"cliToken":"..."}}`
    let connect_frame = format!(
        r#"40{{"auth":{{"cliToken":"{}"}}}}"#,
        cli_token.replace('"', "\\\"")
    );
    sink.send(Message::Text(connect_frame.into()))
        .await
        .map_err(|e| format!("WS send SOCKET_CONNECT: {e}"))?;

    // 3. Receive SOCKET_CONNECT_OK `40` (or error `44{...}`)
    let ok_msg = stream
        .next()
        .await
        .ok_or("WS closed before SOCKET_CONNECT_OK")?
        .map_err(|e| format!("WS read error: {e}"))?;
    let ok_text = match &ok_msg {
        Message::Text(t) => t.as_str().to_string(),
        _ => return Err("Expected text for SOCKET_CONNECT_OK".into()),
    };
    if ok_text.starts_with("44") {
        return Err(format!("Cloud auth rejected: {ok_text}"));
    }
    if !ok_text.starts_with("40") {
        return Err(format!("Unexpected SOCKET_CONNECT frame: {ok_text}"));
    }

    // ── Spawn writer task ─────────────────────────────────────────────────────

    let (tx, mut rx) = mpsc::channel::<Message>(256);

    tauri::async_runtime::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    // ── Spawn reader task ─────────────────────────────────────────────────────

    let tx_reader = tx.clone();
    let project_id_owned = project_id.to_string();
    tauri::async_runtime::spawn(async move {
        while let Some(result) = stream.next().await {
            match result {
                Err(_) => break,
                Ok(Message::Close(_)) => break,
                Ok(Message::Ping(data)) => {
                    // Respond to WS-level pings
                    let _ = tx_reader.send(Message::Pong(data)).await;
                }
                Ok(Message::Text(text)) => {
                    let text_str = text.as_str().to_string();
                    if text_str == "2" {
                        // EIO4 PING → send PONG
                        let _ = tx_reader.send(Message::Text("3".into())).await;
                    } else if let Some(rest) = text_str.strip_prefix("42") {
                        let rest = rest.to_string();
                        handle_socketio_event(
                            &rest,
                            &project_id_owned,
                            &tx_reader,
                            &state,
                        )
                        .await;
                    }
                    // 41 = SOCKET_DISCONNECT, 2 handled, rest ignored
                }
                Ok(_) => {} // binary / pong frames ignored
            }
        }
    });

    Ok(CloudSocket { tx, refs: HashSet::new() })
}

// ── handle_socketio_event ─────────────────────────────────────────────────────

/// Dispatch an incoming Socket.io event payload (the part after the `42` prefix).
async fn handle_socketio_event(
    payload: &str,
    _project_id: &str,
    tx: &mpsc::Sender<Message>,
    state: &Arc<AppState>,
) {
    // Payload is a JSON array: `["event_name", {...}]`
    let arr: Value = match serde_json::from_str(payload) {
        Ok(v) => v,
        Err(_) => return,
    };
    let event = match arr.get(0).and_then(|v| v.as_str()) {
        Some(e) => e.to_string(),
        None => return,
    };
    let data = arr.get(1).cloned().unwrap_or(Value::Null);

    match event.as_str() {
        "session:input" => {
            let session_id = data["sessionId"].as_str().unwrap_or("").to_string();
            let input = data["data"].as_str().unwrap_or("").to_string();

            // Check allow_control before writing
            let allow = {
                let shared = state.shared_terminals.lock().unwrap();
                shared
                    .get(&session_id)
                    .map(|i| i.allow_control)
                    .unwrap_or(false)
            };

            if allow && !session_id.is_empty() {
                use std::io::Write as IoWrite;
                let mut sessions = state.sessions.lock().unwrap();
                if let Some(sess) = sessions.get_mut(&session_id) {
                    let _ = sess.writer.write_all(input.as_bytes());
                }
            }
        }

        "session:resize" => {
            let session_id = data["sessionId"].as_str().unwrap_or("").to_string();
            let cols = data["cols"].as_u64().unwrap_or(80) as u16;
            let rows = data["rows"].as_u64().unwrap_or(24) as u16;

            let allow = {
                let shared = state.shared_terminals.lock().unwrap();
                shared
                    .get(&session_id)
                    .map(|i| i.allow_control)
                    .unwrap_or(false)
            };

            if allow && !session_id.is_empty() {
                let _ = crate::pty::resize_session(&session_id, cols, rows, state);
            }
        }

        "session:viewer_join" => {
            let session_id = data["sessionId"].as_str().unwrap_or("").to_string();
            let viewer_id = data["viewerId"].as_str().unwrap_or("").to_string();
            let viewer_name = data["viewerName"]
                .as_str()
                .unwrap_or("Anonymous")
                .to_string();

            if session_id.is_empty() || viewer_id.is_empty() {
                return;
            }

            let now = now_ms();
            {
                let mut viewers = state.session_viewers.lock().unwrap();
                viewers
                    .entry(session_id.clone())
                    .or_default()
                    .insert(viewer_id.clone(), (viewer_name.clone(), now));
            }

            emit_viewers_update(&session_id, state);

            // Send scrollback to the joining viewer
            let buf = {
                let shared = state.shared_terminals.lock().unwrap();
                shared.get(&session_id).map(|i| i.buffer.clone())
            };
            if let Some(scrollback) = buf {
                let frame = socketio_frame(&json!([
                    "session:sync",
                    {
                        "sessionId": session_id,
                        "viewerId": viewer_id,
                        "data": scrollback
                    }
                ]));
                let _ = tx.send(Message::Text(frame.into())).await;
            }
        }

        "session:viewer_leave" => {
            let session_id = data["sessionId"].as_str().unwrap_or("").to_string();
            let viewer_id = data["viewerId"].as_str().unwrap_or("").to_string();

            if session_id.is_empty() || viewer_id.is_empty() {
                return;
            }

            {
                let mut viewers = state.session_viewers.lock().unwrap();
                if let Some(sv) = viewers.get_mut(&session_id) {
                    sv.remove(&viewer_id);
                }
            }

            emit_viewers_update(&session_id, state);
        }

        "session:sync_request" => {
            let session_id = data["sessionId"].as_str().unwrap_or("").to_string();
            let viewer_id = data["viewerId"].as_str().unwrap_or("").to_string();

            let buf = {
                let shared = state.shared_terminals.lock().unwrap();
                shared.get(&session_id).map(|i| i.buffer.clone())
            };
            if let Some(scrollback) = buf {
                let frame = socketio_frame(&json!([
                    "broadcast",
                    {
                        "channel": format!("agent:session-{session_id}"),
                        "event": "session:sync",
                        "payload": {
                            "sessionId": session_id,
                            "viewerId": viewer_id,
                            "data": scrollback
                        },
                        "self": false
                    }
                ]));
                let _ = tx.send(Message::Text(frame.into())).await;
            }
        }

        _ => {} // unknown event, ignore
    }
}

// ── get_or_create_share_conn ──────────────────────────────────────────────────

/// Return the conn_key for the cloud connection for a project, creating it if
/// it doesn't exist yet.  Also subscribes to the project channel on first connect.
pub async fn get_or_create_share_conn(
    api_url: &str,
    cli_token: &str,
    project_id: &str,
    session_id: &str,
    state: &Arc<AppState>,
) -> Result<String, String> {
    let key = conn_key(api_url, cli_token, project_id);

    // Check if we already have a live connection
    let already_connected = {
        let conns = state.cloud_conns.lock().unwrap();
        conns.contains_key(&key)
    };

    if !already_connected {
        // Build the connection
        let socket = connect_socket(api_url, cli_token, project_id, Arc::clone(state)).await?;

        // Subscribe to the project channel
        let channel = format!("agent:project-{project_id}");
        let sub_frame = socketio_frame(&json!(["subscribe", { "channel": channel }]));
        socket
            .tx
            .send(Message::Text(sub_frame.into()))
            .await
            .map_err(|e| format!("subscribe send: {e}"))?;

        // Bridge Message channel → String channel for CloudConn compatibility
        let (str_tx, mut str_rx) = mpsc::channel::<String>(256);
        let raw_tx = socket.tx.clone();

        tauri::async_runtime::spawn(async move {
            while let Some(s) = str_rx.recv().await {
                let _ = raw_tx.send(Message::Text(s.into())).await;
            }
        });

        {
            let mut conns = state.cloud_conns.lock().unwrap();
            let mut refs = HashSet::new();
            refs.insert(session_id.to_string());
            conns.insert(
                key.clone(),
                crate::state::CloudConn {
                    tx: str_tx,
                    refs,
                },
            );
        }
    } else {
        // Increment refs
        let mut conns = state.cloud_conns.lock().unwrap();
        if let Some(conn) = conns.get_mut(&key) {
            conn.refs.insert(session_id.to_string());
        }
    }

    Ok(key)
}

// ── register_share ────────────────────────────────────────────────────────────

/// POST to the REST API to register a new shared-terminal entry.
pub async fn register_share(
    api_url: &str,
    cli_token: &str,
    project_id: &str,
    session_id: &str,
    label: Option<&str>,
    cli_type: &str,
    cwd: Option<&str>,
) -> Result<(), String> {
    let url = format!("{api_url}/api/orquesta-cli/projects/{project_id}/shared-terminals");
    let body = json!({
        "sessionId": session_id,
        "label": label.unwrap_or(session_id),
        "cliType": cli_type,
        "cwd": cwd.unwrap_or(""),
        "status": "active",
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {cli_token}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("register_share REST: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("register_share {status}: {text}"));
    }

    Ok(())
}

// ── maybe_broadcast_output ────────────────────────────────────────────────────

/// Mirror PTY output to cloud if this session is being shared.
pub fn maybe_broadcast_output(session_id: &str, data: &str, state: &Arc<AppState>) {
    // Collect what we need while holding the lock, then drop it before any send
    let info_opt = {
        let shared = state.shared_terminals.lock().unwrap();
        shared.get(session_id).map(|i| {
            (
                i.session_id.clone(),
                i.channel.clone(),
                i.api_url.clone(),
                i.cli_token.clone(),
                i.project_id.clone(),
            )
        })
    };

    let (sid, channel, api_url, cli_token, project_id) = match info_opt {
        Some(v) => v,
        None => return,
    };

    // Update scrollback buffer (max 200 KB)
    {
        let mut shared = state.shared_terminals.lock().unwrap();
        if let Some(info) = shared.get_mut(&sid) {
            info.buffer.push_str(data);
            if info.buffer.len() > 200_000 {
                let excess = info.buffer.len() - 200_000;
                info.buffer.drain(..excess);
            }
        }
    }

    // Send the broadcast frame via the cloud connection
    let key = conn_key(&api_url, &cli_token, &project_id);
    let frame = socketio_frame(&json!([
        "broadcast",
        {
            "channel": channel,
            "event": "session:output",
            "payload": { "sessionId": sid, "data": data },
            "self": false
        }
    ]));

    let state_clone = Arc::clone(state);
    tauri::async_runtime::spawn(async move {
        let tx_opt = {
            let conns = state_clone.cloud_conns.lock().unwrap();
            conns.get(&key).map(|c| c.tx.clone())
        };
        if let Some(tx) = tx_opt {
            let _ = tx.send(frame).await;
        }
    });
}

// ── maybe_broadcast_ended ─────────────────────────────────────────────────────

/// Announce session ended on the cloud channel.
pub fn maybe_broadcast_ended(session_id: &str, state: &Arc<AppState>) {
    let info_opt = {
        let shared = state.shared_terminals.lock().unwrap();
        shared.get(session_id).map(|i| {
            (
                i.session_id.clone(),
                i.channel.clone(),
                i.api_url.clone(),
                i.cli_token.clone(),
                i.project_id.clone(),
            )
        })
    };

    let (sid, channel, api_url, cli_token, project_id) = match info_opt {
        Some(v) => v,
        None => return,
    };

    let key = conn_key(&api_url, &cli_token, &project_id);
    let frame = socketio_frame(&json!([
        "broadcast",
        {
            "channel": channel,
            "event": "session:ended",
            "payload": { "sessionId": sid },
            "self": false
        }
    ]));

    let state_clone = Arc::clone(state);
    tauri::async_runtime::spawn(async move {
        let tx_opt = {
            let conns = state_clone.cloud_conns.lock().unwrap();
            conns.get(&key).map(|c| c.tx.clone())
        };
        if let Some(tx) = tx_opt {
            let _ = tx.send(frame).await;
        }
    });
}

// ── stop_share ────────────────────────────────────────────────────────────────

/// Broadcast session:ended, PATCH status=closed via REST, remove from state,
/// and disconnect the cloud connection if no sessions remain.
pub async fn stop_share(session_id: &str, state: &Arc<AppState>) -> Result<(), String> {
    // Broadcast ended first
    maybe_broadcast_ended(session_id, state);

    // Collect info for REST call before removing from state
    let info_opt = {
        let shared = state.shared_terminals.lock().unwrap();
        shared.get(session_id).map(|i| {
            (
                i.api_url.clone(),
                i.cli_token.clone(),
                i.project_id.clone(),
                i.session_id.clone(),
            )
        })
    };

    if let Some((api_url, cli_token, project_id, sid)) = info_opt {
        // PATCH status=closed
        let url = format!(
            "{api_url}/api/orquesta-cli/projects/{project_id}/shared-terminals/{sid}"
        );
        let client = reqwest::Client::new();
        let _ = client
            .patch(&url)
            .header("Authorization", format!("Bearer {cli_token}"))
            .json(&json!({ "status": "closed" }))
            .send()
            .await;

        // Decrement refs; disconnect if refs == 0
        let key = conn_key(&api_url, &cli_token, &project_id);
        let should_remove = {
            let mut conns = state.cloud_conns.lock().unwrap();
            if let Some(conn) = conns.get_mut(&key) {
                conn.refs.remove(session_id);
                conn.refs.is_empty()
            } else {
                false
            }
        };
        if should_remove {
            let mut conns = state.cloud_conns.lock().unwrap();
            conns.remove(&key);
        }
    }

    // Remove from shared_terminals
    {
        let mut shared = state.shared_terminals.lock().unwrap();
        shared.remove(session_id);
    }

    Ok(())
}

// ── prune_stale_viewers ───────────────────────────────────────────────────────

/// Prune viewers that haven't sent a heartbeat in 70 seconds.
pub fn prune_stale_viewers(state: &Arc<AppState>) {
    let now = now_ms();
    let mut viewers = state.session_viewers.lock().unwrap();
    for session_viewers in viewers.values_mut() {
        session_viewers.retain(|_, (_, last_seen)| now - *last_seen < 70_000);
    }
}

// ── Private helpers ───────────────────────────────────────────────────────────

/// Format a Socket.io v4 text event frame: `42<json_array>`
pub(crate) fn socketio_frame(arr: &Value) -> String {
    format!("42{arr}")
}

/// Current time as milliseconds since UNIX epoch.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Emit `terminal:viewers` to the frontend with the current viewer list for a session.
fn emit_viewers_update(session_id: &str, state: &Arc<AppState>) {
    use tauri::Emitter;

    let viewers_snapshot: Vec<Value> = {
        let viewers = state.session_viewers.lock().unwrap();
        viewers
            .get(session_id)
            .map(|sv| {
                sv.iter()
                    .map(|(id, (name, _))| json!({ "id": id, "name": name }))
                    .collect()
            })
            .unwrap_or_default()
    };

    state
        .app_handle
        .emit(
            "terminal:viewers",
            json!({ "sessionId": session_id, "viewers": viewers_snapshot }),
        )
        .ok();
}

// ── Remote Sessions (cockpit / viewer side) ───────────────────────────────────

/// Dispatch incoming Socket.io events on the remote (viewer) connection to the frontend.
async fn handle_remote_event(payload: &str, state: &Arc<AppState>) {
    use tauri::Emitter;

    let arr: Value = match serde_json::from_str(payload) {
        Ok(v) => v,
        Err(_) => return,
    };
    let event = match arr.get(0).and_then(|v| v.as_str()) {
        Some(e) => e.to_string(),
        None => return,
    };
    let data = arr.get(1).cloned().unwrap_or(Value::Null);

    match event.as_str() {
        // Agent confirmed the session started — relay to frontend
        "session:started" | "remote:started" => {
            let _ = state.app_handle.emit("remote:started", &data);
        }
        // Agent sent terminal output — relay to frontend
        "session:output" | "remote:output" => {
            let _ = state.app_handle.emit("remote:output", &data);
        }
        // Session ended on the agent side — relay and clean up
        "session:ended" | "remote:ended" => {
            let session_id = data["sessionId"].as_str().unwrap_or("").to_string();
            let _ = state.app_handle.emit("remote:ended", &data);
            if !session_id.is_empty() {
                let mut remote_sessions = state.remote_sessions.lock().unwrap();
                remote_sessions.remove(&session_id);
            }
        }
        _ => {}
    }
}

/// Open a WebSocket to the cloud *as a viewer* (cockpit side).
/// The reader task dispatches remote:* events to the frontend via `app_handle.emit`.
async fn connect_remote_socket(
    api_url: &str,
    cli_token: &str,
    state: Arc<AppState>,
) -> Result<CloudSocket, String> {
    let ws_base = to_ws_url(api_url);
    let url = format!("{ws_base}/socket.io/?EIO=4&transport=websocket");

    let (ws_stream, _) = connect_async_tls_with_config(&url, None, false, None)
        .await
        .map_err(|e| format!("Remote WS connect: {e}"))?;

    let (mut sink, mut stream) = ws_stream.split();

    // 1. ENGINE_OPEN
    let open_msg = stream
        .next()
        .await
        .ok_or("Remote WS closed before ENGINE_OPEN")?
        .map_err(|e| format!("Remote WS read: {e}"))?;
    let open_text = match &open_msg {
        Message::Text(t) => t.as_str().to_string(),
        _ => return Err("Remote WS: expected text for ENGINE_OPEN".into()),
    };
    if !open_text.starts_with('0') {
        return Err(format!("Remote WS: unexpected EIO4 open: {open_text}"));
    }

    // 2. SOCKET_CONNECT
    let connect_frame = format!(
        r#"40{{"auth":{{"cliToken":"{}"}}}}"#,
        cli_token.replace('"', "\\\"")
    );
    sink.send(Message::Text(connect_frame.into()))
        .await
        .map_err(|e| format!("Remote WS: send SOCKET_CONNECT: {e}"))?;

    // 3. SOCKET_CONNECT_OK
    let ok_msg = stream
        .next()
        .await
        .ok_or("Remote WS closed before SOCKET_CONNECT_OK")?
        .map_err(|e| format!("Remote WS read: {e}"))?;
    let ok_text = match &ok_msg {
        Message::Text(t) => t.as_str().to_string(),
        _ => return Err("Remote WS: expected text for SOCKET_CONNECT_OK".into()),
    };
    if ok_text.starts_with("44") {
        return Err(format!("Remote cloud auth rejected: {ok_text}"));
    }
    if !ok_text.starts_with("40") {
        return Err(format!("Remote WS: unexpected SOCKET_CONNECT frame: {ok_text}"));
    }

    let (tx, mut rx) = mpsc::channel::<Message>(256);

    tauri::async_runtime::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    let tx_reader = tx.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(result) = stream.next().await {
            match result {
                Err(_) | Ok(Message::Close(_)) => break,
                Ok(Message::Ping(data)) => {
                    let _ = tx_reader.send(Message::Pong(data)).await;
                }
                Ok(Message::Text(text)) => {
                    let text_str = text.as_str().to_string();
                    if text_str == "2" {
                        let _ = tx_reader.send(Message::Text("3".into())).await;
                    } else if let Some(rest) = text_str.strip_prefix("42") {
                        let rest = rest.to_string();
                        handle_remote_event(&rest, &state).await;
                    }
                }
                Ok(_) => {}
            }
        }
    });

    Ok(CloudSocket { tx, refs: HashSet::new() })
}

/// Return the conn_key for the remote (viewer) connection, creating it if needed.
/// Subscribes to `cockpit:project-{project_id}` channel on first connect.
pub async fn get_or_create_remote_conn(
    api_url: &str,
    cli_token: &str,
    project_id: &str,
    session_id: &str,
    state: &Arc<AppState>,
) -> Result<String, String> {
    // Use a distinct key namespace so remote and share conns don't collide.
    let key = format!("remote::{}", conn_key(api_url, cli_token, project_id));

    let already_connected = {
        let conns = state.remote_conns.lock().unwrap();
        conns.contains_key(&key)
    };

    if !already_connected {
        let socket = connect_remote_socket(api_url, cli_token, Arc::clone(state)).await?;

        // Subscribe to the cockpit channel for this project
        let channel = format!("cockpit:project-{project_id}");
        let sub_frame = socketio_frame(&json!(["subscribe", { "channel": channel }]));
        socket
            .tx
            .send(Message::Text(sub_frame.into()))
            .await
            .map_err(|e| format!("remote subscribe: {e}"))?;

        // Bridge Message channel → String channel for CloudConn compatibility
        let (str_tx, mut str_rx) = mpsc::channel::<String>(256);
        let raw_tx = socket.tx.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(s) = str_rx.recv().await {
                let _ = raw_tx.send(Message::Text(s.into())).await;
            }
        });

        {
            let mut conns = state.remote_conns.lock().unwrap();
            let mut refs = HashSet::new();
            refs.insert(session_id.to_string());
            conns.insert(
                key.clone(),
                crate::state::CloudConn {
                    tx: str_tx,
                    refs,
                },
            );
        }
    } else {
        let mut conns = state.remote_conns.lock().unwrap();
        if let Some(conn) = conns.get_mut(&key) {
            conn.refs.insert(session_id.to_string());
        }
    }

    Ok(key)
}

/// Send an event to the cloud via an active remote (viewer) connection.
pub async fn remote_send(
    conn_key: &str,
    event: &str,
    data: Value,
    state: &Arc<AppState>,
) -> Result<(), String> {
    let frame = socketio_frame(&json!([event, data]));
    let tx = {
        let conns = state.remote_conns.lock().unwrap();
        conns.get(conn_key).map(|c| c.tx.clone())
    };
    match tx {
        Some(tx) => tx.send(frame).await.map_err(|e| format!("remote_send {event}: {e}")),
        None => Err(format!("No remote conn for key {conn_key}")),
    }
}

/// Remove a remote session from state and decrement the conn's ref count.
/// Drops the connection if no sessions remain.
pub fn remote_cleanup(session_id: &str, conn_key: &str, state: &Arc<AppState>) {
    {
        let mut remote_sessions = state.remote_sessions.lock().unwrap();
        remote_sessions.remove(session_id);
    }
    let should_remove = {
        let mut conns = state.remote_conns.lock().unwrap();
        if let Some(conn) = conns.get_mut(conn_key) {
            conn.refs.remove(session_id);
            conn.refs.is_empty()
        } else {
            false
        }
    };
    if should_remove {
        let mut conns = state.remote_conns.lock().unwrap();
        conns.remove(conn_key);
    }
}
