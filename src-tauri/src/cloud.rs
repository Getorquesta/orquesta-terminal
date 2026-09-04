// Phase 5: Full cloud WebSocket bridge via tokio-tungstenite + EIO4/Socket.io v4

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async_tls_with_config, tungstenite::Message};

use crate::state::{Alive, AppState, CloudConn};

// ── Helpers ───────────────────────────────────────────────────────────────────

/// The cloud's realtime relay. Hosted Orquesta splits the two services:
/// getorquesta.com answers REST only — its /socket.io just hits Next, whose
/// server never handles the upgrade, so the connection hangs open until the
/// user gives up. Self-hosted OSS serves both from one origin, so only the
/// cloud host is remapped.
const CLOUD_WS_URL: &str = "wss://ws.orquesta.live";

/// Host part of a base URL, without scheme, path or trailing slash.
fn url_host(url: &str) -> &str {
    url.trim_end_matches('/')
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .split('/')
        .next()
        .unwrap_or("")
}

/// Derive the WebSocket URL from an API base URL.
/// "https://getorquesta.com"  → "wss://ws.orquesta.live"  (see CLOUD_WS_URL)
/// "https://ws.orquesta.live" → "wss://ws.orquesta.live"
/// "http://localhost:3000"    → "ws://localhost:3000"
fn to_ws_url(api_url: &str) -> String {
    if matches!(url_host(api_url), "getorquesta.com" | "www.getorquesta.com") {
        return CLOUD_WS_URL.to_string();
    }
    let api_url = api_url.trim_end_matches('/');
    if let Some(rest) = api_url.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = api_url.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        api_url.to_string()
    }
}

/// The EIO4 SOCKET_CONNECT frame carrying our credentials.
///
/// The packet's JSON payload *is* `socket.handshake.auth` — socket.io does not
/// unwrap an "auth" key for you. Nesting one (`40{"auth":{"cliToken":…}}`) left
/// the relay reading an undefined token and answering
/// `44{"message":"No auth credentials"}`.
fn connect_frame(cli_token: &str) -> String {
    format!("40{}", json!({ "cliToken": cli_token }))
}

/// Turn a socket.io CONNECT_ERROR frame (`44{"message":"…"}`) into its message.
fn connect_error_message(frame: &str) -> String {
    serde_json::from_str::<Value>(frame.trim_start_matches("44"))
        .ok()
        .and_then(|v| v["message"].as_str().map(str::to_string))
        .unwrap_or_else(|| frame.to_string())
}

/// Give up on a WebSocket that never completes its handshake.
///
/// `connect_async` has no timeout of its own: pointed at an endpoint that
/// accepts the TCP+TLS connection and then never answers the upgrade (which is
/// exactly what an API host fronted by nginx does), it waits forever and the
/// awaiting IPC call never resolves.
const WS_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Build a canonical connection key from the base parameters.
pub fn conn_key(api_url: &str, token: &str, project_id: &str) -> String {
    format!("{api_url}:{token}:{project_id}")
}

/// A fresh liveness flag for a socket that has just connected.
fn new_alive() -> Alive {
    Arc::new(AtomicBool::new(true))
}

/// Take a ref on the cached connection under `key`, if it is still usable.
///
/// Returns false when the caller has to build a new socket — either there was
/// none, or the one we had is dead. Dead conns are evicted here because nothing
/// else does it: a network drop or a relay restart only ends the socket's tasks,
/// and reusing the leftover entry sends every frame into a void that reports
/// success. That turned one lost connection into "remote sessions are broken
/// until you restart the app".
fn claim_live_conn(conns: &mut HashMap<String, CloudConn>, key: &str, session_id: &str) -> bool {
    match conns.get_mut(key) {
        Some(conn) if conn.alive.load(Ordering::Relaxed) => {
            conn.refs.insert(session_id.to_string());
            true
        }
        Some(_) => {
            conns.remove(key);
            false
        }
        None => false,
    }
}

// ── CloudSocket ───────────────────────────────────────────────────────────────

/// Handle to an active cloud WebSocket connection.
pub struct CloudSocket {
    /// Send raw WS text frames to the socket.
    pub tx: mpsc::Sender<Message>,
    /// Session IDs currently using this connection.
    pub refs: HashSet<String>,
    /// Cleared by the reader/writer tasks when the socket dies. See [`Alive`].
    pub alive: Alive,
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

    let (ws_stream, _) = tokio::time::timeout(
        WS_CONNECT_TIMEOUT,
        connect_async_tls_with_config(&url, None, false, None),
    )
    .await
    .map_err(|_| format!("WS connect timed out: {ws_base}"))?
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

    // 2. Send SOCKET_CONNECT  `40{"cliToken":"..."}`
    let connect_frame = connect_frame(cli_token);
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
        return Err(format!("Cloud auth rejected: {}", connect_error_message(&ok_text)));
    }
    if !ok_text.starts_with("40") {
        return Err(format!("Unexpected SOCKET_CONNECT frame: {ok_text}"));
    }

    // ── Spawn writer task ─────────────────────────────────────────────────────

    let (tx, mut rx) = mpsc::channel::<Message>(256);
    let alive = new_alive();

    let alive_writer = Arc::clone(&alive);
    tauri::async_runtime::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
        alive_writer.store(false, Ordering::Relaxed);
    });

    // ── Spawn reader task ─────────────────────────────────────────────────────

    let tx_reader = tx.clone();
    let alive_reader = Arc::clone(&alive);
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
        alive_reader.store(false, Ordering::Relaxed);
    });

    Ok(CloudSocket { tx, refs: HashSet::new(), alive })
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
            // The dashboard viewer sends the bytes as `input`; the local cockpit
            // (and older bridges) send them as `data`. Accept either — reading
            // only one of them silently swallowed every remote keystroke.
            let input = data["input"]
                .as_str()
                .or_else(|| data["data"].as_str())
                .unwrap_or("")
                .to_string();

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
            let (viewer_id, viewer_name) = viewer_identity(&data);

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

            // Replay our scrollback so the joiner starts with a full screen.
            send_scrollback(&session_id, &viewer_id, tx, state).await;
        }

        "session:viewer_leave" => {
            let session_id = data["sessionId"].as_str().unwrap_or("").to_string();
            let (viewer_id, _) = viewer_identity(&data);

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
            let (viewer_id, _) = viewer_identity(&data);

            send_scrollback(&session_id, &viewer_id, tx, state).await;
        }

        // A dashboard watcher's pointer — hand it to the cockpit UI, which draws
        // the peer cursors over the pane.
        "terminal:cursor" => {
            let session_id = data["sessionId"].as_str().unwrap_or("").to_string();
            if session_id.is_empty() {
                return;
            }
            let is_shared = {
                let shared = state.shared_terminals.lock().unwrap();
                shared.contains_key(&session_id)
            };
            if is_shared {
                use tauri::Emitter;
                let _ = state.app_handle.emit("terminal:cursor", data.clone());
            }
        }

        _ => {} // unknown event, ignore
    }
}

/// Pull a viewer's id/name out of an event payload.
///
/// The dashboard viewer nests them (`{viewer: {id, name}}`); the local cockpit
/// sends them flat (`viewerId`/`viewerName`). Reading only the flat form made
/// every dashboard `viewer_join` bail on an empty id — no presence badge, and
/// (worse) no scrollback replay, so the remote terminal stayed blank.
fn viewer_identity(data: &Value) -> (String, String) {
    let id = data["viewerId"]
        .as_str()
        .or_else(|| data["viewer"]["id"].as_str())
        .or_else(|| data["id"].as_str())
        .unwrap_or("")
        .to_string();
    let name = data["viewerName"]
        .as_str()
        .or_else(|| data["viewer"]["name"].as_str())
        .or_else(|| data["name"].as_str())
        .unwrap_or("Anonymous")
        .to_string();
    (id, name)
}

/// Replay a shared terminal's captured scrollback to a (re)joining viewer.
///
/// Goes out as a normal `broadcast` on the SAME project channel the live output
/// uses — a mid-stream joiner has no history otherwise, and an idle pane emits
/// nothing new, so without this the viewer just shows an empty black box.
/// `viewerId` is echoed back so each viewer can ignore somebody else's replay.
async fn send_scrollback(
    session_id: &str,
    viewer_id: &str,
    tx: &mpsc::Sender<Message>,
    state: &Arc<AppState>,
) {
    if session_id.is_empty() {
        return;
    }
    let info = {
        let shared = state.shared_terminals.lock().unwrap();
        shared
            .get(session_id)
            .map(|i| (i.channel.clone(), i.buffer.clone()))
    };
    let (channel, scrollback) = match info {
        Some(v) => v,
        None => return,
    };
    // Replay is useless without the geometry it was rendered at: the viewer has
    // to size its terminal to the host's, or every TUI redraw under-erases and
    // the prompt line stacks instead of overwriting.
    let (cols, rows) = session_geometry(session_id, state);
    let frame = socketio_frame(&json!([
        "broadcast",
        {
            "channel": channel,
            "event": "session:sync",
            "payload": {
                "sessionId": session_id,
                "viewerId": viewer_id,
                "cols": cols,
                "rows": rows,
                "data": scrollback
            },
            "self": false
        }
    ]));
    let _ = tx.send(Message::Text(frame.into())).await;
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

    // Reuse the connection we have — unless it died, in which case reconnect.
    let already_connected = {
        let mut conns = state.cloud_conns.lock().unwrap();
        claim_live_conn(&mut conns, &key, session_id)
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
        let alive_bridge = Arc::clone(&socket.alive);

        tauri::async_runtime::spawn(async move {
            while let Some(s) = str_rx.recv().await {
                if raw_tx.send(Message::Text(s.into())).await.is_err() {
                    // The writer task is gone — say so instead of silently
                    // dropping this frame and every one after it.
                    alive_bridge.store(false, Ordering::Relaxed);
                    break;
                }
            }
        });

        {
            let mut conns = state.cloud_conns.lock().unwrap();
            let mut refs = HashSet::new();
            refs.insert(session_id.to_string());
            conns.insert(
                key.clone(),
                CloudConn { tx: str_tx, refs, alive: socket.alive },
            );
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
    allow_control: bool,
) -> Result<(), String> {
    let url = format!("{api_url}/api/orquesta-cli/projects/{project_id}/shared-terminals");
    let body = json!({
        "sessionId": session_id,
        "label": label.unwrap_or(session_id),
        "cliType": cli_type,
        "cwd": cwd.unwrap_or(""),
        "allowControl": allow_control,
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

// ── patch_share ───────────────────────────────────────────────────────────────

/// PATCH a shared-terminal row: refresh its heartbeat, flip control, or close it.
///
/// The endpoint is the COLLECTION route with `sessionId` in the body — there is
/// no `/shared-terminals/{sessionId}` sub-route. Addressing one (as the close
/// path used to) 404s, which is why a stopped share stayed `active` in the
/// dashboard forever.
pub async fn patch_share(
    api_url: &str,
    cli_token: &str,
    project_id: &str,
    session_id: &str,
    allow_control: Option<bool>,
    status: Option<&str>,
) -> Result<(), String> {
    let url = format!("{api_url}/api/orquesta-cli/projects/{project_id}/shared-terminals");
    let mut body = json!({ "sessionId": session_id });
    if let Some(allow) = allow_control {
        body["allowControl"] = json!(allow);
    }
    if let Some(s) = status {
        body["status"] = json!(s);
    }

    let client = reqwest::Client::new();
    let resp = client
        .patch(&url)
        .header("Authorization", format!("Bearer {cli_token}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("patch_share REST: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("patch_share {status}: {text}"));
    }

    Ok(())
}

// ── heartbeat_shares ──────────────────────────────────────────────────────────

/// Keep every active share's `last_active_at` fresh.
///
/// Without this the row's timestamp only ever moved when the share was created,
/// so the dashboard could not tell a live terminal from one whose cockpit was
/// quit, crashed or rebooted — every share it ever saw stayed green forever.
/// The dashboard treats a share with no heartbeat for a few minutes as offline.
pub async fn heartbeat_shares(state: &Arc<AppState>) {
    let shares: Vec<(String, String, String, String)> = {
        let shared = state.shared_terminals.lock().unwrap();
        shared
            .values()
            .map(|i| {
                (
                    i.api_url.clone(),
                    i.cli_token.clone(),
                    i.project_id.clone(),
                    i.session_id.clone(),
                )
            })
            .collect()
    };

    for (api_url, cli_token, project_id, session_id) in shares {
        let _ = patch_share(&api_url, &cli_token, &project_id, &session_id, None, None).await;

        // A dropped socket is silent: the PTY keeps running, the row keeps
        // heartbeating, and the watchers just never see another byte. Rebuild it
        // here (get_or_create_share_conn evicts the dead entry and re-subscribes).
        let key = conn_key(&api_url, &cli_token, &project_id);
        let alive = {
            let conns = state.cloud_conns.lock().unwrap();
            conns
                .get(&key)
                .map(|c| c.alive.load(Ordering::Relaxed))
                .unwrap_or(false)
        };
        if !alive {
            let _ =
                get_or_create_share_conn(&api_url, &cli_token, &project_id, &session_id, state)
                    .await;
        }
    }
}

// ── maybe_broadcast_cursor ────────────────────────────────────────────────────

/// Mirror this cockpit's own pointer to the watchers, if the pane is shared.
///
/// The dashboard viewer already broadcasts (and renders) `terminal:cursor`, so
/// without this half the multiplayer cursors only worked watcher↔watcher and
/// the person actually driving the terminal was invisible.
pub fn maybe_broadcast_cursor(
    session_id: &str,
    id: &str,
    name: &str,
    color: &str,
    x: f64,
    y: f64,
    state: &Arc<AppState>,
) {
    let info_opt = {
        let shared = state.shared_terminals.lock().unwrap();
        shared.get(session_id).map(|i| {
            (
                i.channel.clone(),
                i.api_url.clone(),
                i.cli_token.clone(),
                i.project_id.clone(),
            )
        })
    };

    let (channel, api_url, cli_token, project_id) = match info_opt {
        Some(v) => v,
        None => return,
    };

    let key = conn_key(&api_url, &cli_token, &project_id);
    let frame = socketio_frame(&json!([
        "broadcast",
        {
            "channel": channel,
            "event": "terminal:cursor",
            "payload": {
                "sessionId": session_id,
                "id": id,
                "name": name,
                "color": color,
                "x": x,
                "y": y
            },
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

/// The current size of a live PTY session, defaulting to 80x24 if it is gone.
fn session_geometry(session_id: &str, state: &Arc<AppState>) -> (u16, u16) {
    let sessions = state.sessions.lock().unwrap();
    sessions
        .get(session_id)
        .map(|s| (s.cols, s.rows))
        .unwrap_or((80, 24))
}

// ── maybe_broadcast_geometry ──────────────────────────────────────────────────

/// Tell shared viewers the host terminal's new size.
///
/// Only the host's size is authoritative — a view-only viewer never sends
/// `session:resize` (that path is gated on control), so without this the two
/// sides silently disagree forever.
pub fn maybe_broadcast_geometry(session_id: &str, cols: u16, rows: u16, state: &Arc<AppState>) {
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
            "event": "session:geometry",
            "payload": { "sessionId": sid, "cols": cols, "rows": rows },
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
        // PATCH status=closed so the dashboard drops it from the live list.
        let _ = patch_share(&api_url, &cli_token, &project_id, &sid, None, Some("closed")).await;

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
        // The agent refused or failed to spawn — relay so the UI stops waiting
        "session:error" | "remote:error" => {
            let _ = state.app_handle.emit("remote:error", &data);
        }
        // Session ended on the agent side — relay and clean up
        "session:ended" | "remote:ended" => {
            let session_id = data["sessionId"].as_str().unwrap_or("").to_string();
            let _ = state.app_handle.emit("remote:ended", &data);
            if !session_id.is_empty() {
                // Drop the connection ref as well. Forgetting only the session
                // left the socket pinned open by a ref no one would ever
                // release — the same cleanup an explicit End does.
                let conn_key = {
                    let remote_sessions = state.remote_sessions.lock().unwrap();
                    remote_sessions.get(&session_id).map(|s| s.conn_key.clone())
                };
                match conn_key {
                    Some(key) => remote_cleanup(&session_id, &key, state),
                    None => {
                        state.remote_sessions.lock().unwrap().remove(&session_id);
                    }
                }
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

    let (ws_stream, _) = tokio::time::timeout(
        WS_CONNECT_TIMEOUT,
        connect_async_tls_with_config(&url, None, false, None),
    )
    .await
    .map_err(|_| format!("Remote WS connect timed out: {ws_base}"))?
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
    let connect_frame = connect_frame(cli_token);
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
        return Err(format!("Remote cloud auth rejected: {}", connect_error_message(&ok_text)));
    }
    if !ok_text.starts_with("40") {
        return Err(format!("Remote WS: unexpected SOCKET_CONNECT frame: {ok_text}"));
    }

    let (tx, mut rx) = mpsc::channel::<Message>(256);
    let alive = new_alive();

    let alive_writer = Arc::clone(&alive);
    tauri::async_runtime::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
        alive_writer.store(false, Ordering::Relaxed);
    });

    let tx_reader = tx.clone();
    let alive_reader = Arc::clone(&alive);
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
        alive_reader.store(false, Ordering::Relaxed);
    });

    Ok(CloudSocket { tx, refs: HashSet::new(), alive })
}

/// The channel a project's agents live on. Everything about an interactive
/// session — start, input, resize, end, and the output coming back — travels
/// on it; the dashboard's own InteractiveSession uses the same one.
pub fn agent_channel(project_id: &str) -> String {
    format!("agent:project-{project_id}")
}

/// Return the conn_key for the remote (viewer) connection, creating it if needed.
/// Subscribes to `agent:project-{project_id}` channel on first connect.
pub async fn get_or_create_remote_conn(
    api_url: &str,
    cli_token: &str,
    project_id: &str,
    session_id: &str,
    state: &Arc<AppState>,
) -> Result<String, String> {
    // Use a distinct key namespace so remote and share conns don't collide.
    let key = format!("remote::{}", conn_key(api_url, cli_token, project_id));

    // Reuse the connection we have — unless it died, in which case reconnect.
    let already_connected = {
        let mut conns = state.remote_conns.lock().unwrap();
        claim_live_conn(&mut conns, &key, session_id)
    };

    if !already_connected {
        let socket = connect_remote_socket(api_url, cli_token, Arc::clone(state)).await?;

        // Join the agents' channel — being in the room is what makes the relay
        // deliver session:started / session:output back to us.
        let channel = agent_channel(project_id);
        let sub_frame = socketio_frame(&json!(["subscribe", { "channel": channel }]));
        socket
            .tx
            .send(Message::Text(sub_frame.into()))
            .await
            .map_err(|e| format!("remote subscribe: {e}"))?;

        // Bridge Message channel → String channel for CloudConn compatibility
        let (str_tx, mut str_rx) = mpsc::channel::<String>(256);
        let raw_tx = socket.tx.clone();
        let alive_bridge = Arc::clone(&socket.alive);
        tauri::async_runtime::spawn(async move {
            while let Some(s) = str_rx.recv().await {
                if raw_tx.send(Message::Text(s.into())).await.is_err() {
                    alive_bridge.store(false, Ordering::Relaxed);
                    break;
                }
            }
        });

        {
            let mut conns = state.remote_conns.lock().unwrap();
            let mut refs = HashSet::new();
            refs.insert(session_id.to_string());
            conns.insert(
                key.clone(),
                CloudConn { tx: str_tx, refs, alive: socket.alive },
            );
        }
    }

    Ok(key)
}

/// Send an event to a project's agents via an active remote (viewer) connection.
///
/// The relay is a plain pub/sub: it only understands `subscribe` / `broadcast`
/// / `presence:*` and silently drops anything else. Emitting `session:start`
/// as a bare event — which is what this used to do — therefore reached nobody,
/// and the modal waited on a reply that could never come.
pub async fn remote_send(
    conn_key: &str,
    channel: &str,
    event: &str,
    data: Value,
    state: &Arc<AppState>,
) -> Result<(), String> {
    let frame = socketio_frame(&json!([
        "broadcast",
        { "channel": channel, "event": event, "payload": data, "self": false }
    ]));
    let tx = {
        let conns = state.remote_conns.lock().unwrap();
        conns
            .get(conn_key)
            // A dead socket still accepts frames into the bridge for a moment;
            // say the connection is gone rather than pretend this was sent.
            .filter(|c| c.alive.load(Ordering::Relaxed))
            .map(|c| c.tx.clone())
    };
    match tx {
        Some(tx) => tx.send(frame).await.map_err(|e| format!("remote_send {event}: {e}")),
        None => Err(format!("Lost the connection to the cloud — reopen the session ({event})")),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_api_host_maps_to_the_relay() {
        // getorquesta.com/socket.io never answers the upgrade — pointing the
        // socket there is what left "Open" spinning forever.
        assert_eq!(to_ws_url("https://getorquesta.com"), CLOUD_WS_URL);
        assert_eq!(to_ws_url("https://getorquesta.com/"), CLOUD_WS_URL);
        assert_eq!(to_ws_url("https://www.getorquesta.com"), CLOUD_WS_URL);
        assert_eq!(to_ws_url("https://ws.orquesta.live"), CLOUD_WS_URL);
    }

    #[test]
    fn self_hosted_origins_are_left_alone() {
        // OSS serves REST and socket.io from one origin.
        assert_eq!(to_ws_url("http://localhost:3000"), "ws://localhost:3000");
        assert_eq!(to_ws_url("https://orquesta.example.com"), "wss://orquesta.example.com");
    }

    #[test]
    fn agents_share_one_channel_per_project() {
        assert_eq!(agent_channel("abc"), "agent:project-abc");
    }

    #[test]
    fn credentials_sit_at_the_top_of_the_connect_packet() {
        // socket.io hands the packet payload straight to handshake.auth. An
        // "auth" wrapper made the relay answer "No auth credentials".
        assert_eq!(connect_frame("oclt_x"), r#"40{"cliToken":"oclt_x"}"#);
        // Quotes in a token would otherwise break out of the JSON.
        assert_eq!(connect_frame("a\"b"), r#"40{"cliToken":"a\"b"}"#);
    }

    /// A cached connection, alive or not.
    fn conn(alive: bool) -> CloudConn {
        CloudConn {
            tx: mpsc::channel::<String>(1).0,
            refs: HashSet::new(),
            alive: Arc::new(AtomicBool::new(alive)),
        }
    }

    #[test]
    fn a_live_connection_is_reused_and_takes_the_ref() {
        let mut conns = HashMap::new();
        conns.insert("k".to_string(), conn(true));

        assert!(claim_live_conn(&mut conns, "k", "sess-1"));
        assert!(conns["k"].refs.contains("sess-1"));
    }

    #[test]
    fn a_dead_connection_is_evicted_so_the_caller_reconnects() {
        // Nothing else ever removes it: a network drop or a relay restart only
        // ends the socket's tasks. Reusing the leftover entry is what made
        // remote sessions stay broken until the app was restarted.
        let mut conns = HashMap::new();
        conns.insert("k".to_string(), conn(false));

        assert!(!claim_live_conn(&mut conns, "k", "sess-1"));
        assert!(!conns.contains_key("k"));
    }

    #[test]
    fn an_unknown_key_means_connect() {
        let mut conns = HashMap::new();
        assert!(!claim_live_conn(&mut conns, "k", "sess-1"));
    }

    #[test]
    fn a_rejected_connect_reads_as_its_message() {
        assert_eq!(
            connect_error_message(r#"44{"message":"Invalid CLI token"}"#),
            "Invalid CLI token"
        );
        // Anything unparseable is passed through rather than swallowed.
        assert_eq!(connect_error_message("44garbage"), "44garbage");
    }
}
