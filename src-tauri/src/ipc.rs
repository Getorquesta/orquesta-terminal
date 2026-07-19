use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

use crate::cloud;
use crate::state::AppState;

// ── PTY Commands ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn session_start(
    session_id: String,
    cli_type: Option<String>,
    rows: Option<u16>,
    cols: Option<u16>,
    cwd: Option<String>,
    resume_id: Option<String>,
    hosted_user_id: Option<String>,
    hosted_token: Option<String>,
    hosted_api_url: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<Value, String> {
    crate::pty::spawn_session(
        session_id,
        cli_type.unwrap_or_else(|| "shell".into()),
        rows.unwrap_or(24),
        cols.unwrap_or(80),
        cwd,
        resume_id,
        hosted_user_id,
        hosted_token,
        hosted_api_url,
        Arc::clone(&state),
    )
    .await
}

#[tauri::command]
pub fn session_input(
    session_id: String,
    data: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    crate::pty::write_session(&session_id, &data, &state)
}

#[tauri::command]
pub fn session_resize(
    session_id: String,
    rows: u16,
    cols: u16,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    crate::pty::resize_session(&session_id, cols, rows, &state)
}

#[tauri::command]
pub fn session_end(
    session_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    crate::pty::kill_session(&session_id, &state)
}

#[tauri::command]
pub fn session_force_end(
    session_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    crate::pty::kill_session(&session_id, &state)
}

// ── Filesystem Commands ───────────────────────────────────────────────────────

#[tauri::command]
pub async fn fs_list_dir(
    path: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<Value, String> {
    let result = crate::fs::list_dir(path).await?;
    // Also emit event for backward-compat with fire-and-listen pattern
    state
        .app_handle
        .emit("fs:list-dir-result", result.clone())
        .ok();
    Ok(result)
}

#[tauri::command]
pub async fn fs_native_pick(
    app: AppHandle,
    start_dir: Option<String>,
) -> Result<Value, String> {
    use tauri_plugin_dialog::DialogExt;
    use tokio::sync::oneshot;

    let home = dirs::home_dir()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let start = start_dir.unwrap_or(home);

    let (tx, rx) = oneshot::channel();

    app.dialog()
        .file()
        .set_directory(&start)
        .pick_folder(move |path| {
            let _ = tx.send(path);
        });

    match rx.await {
        Ok(Some(p)) => Ok(json!({
            "ok": true,
            "path": p.to_string(),
            "available": true,
        })),
        _ => Ok(json!({
            "ok": false,
            "path": null,
            "available": true,
        })),
    }
}

// ── Hook Enrollment ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn hook_status(cwd: Option<String>) -> Result<Value, String> {
    let dir = hook_target_dir(cwd.as_deref());
    let orquesta_json = dir.join(".orquesta.json");

    match tokio::fs::read_to_string(&orquesta_json).await {
        Ok(raw) => {
            let cfg: Value = serde_json::from_str(&raw).unwrap_or_default();
            Ok(json!({
                "configured": true,
                "cwd": dir.to_string_lossy(),
                "projectId": cfg["projectId"],
                "projectName": cfg["projectName"],
                "apiUrl": cfg["apiUrl"],
            }))
        }
        Err(_) => Ok(json!({
            "configured": false,
            "cwd": dir.to_string_lossy(),
        })),
    }
}

#[tauri::command]
pub async fn hook_init_project(
    token: String,
    api_url: Option<String>,
    project_id: String,
    project_name: Option<String>,
    cwd: Option<String>,
) -> Result<Value, String> {
    let dir = hook_target_dir(cwd.as_deref());

    // Guard: do not enroll $HOME
    let home = dirs::home_dir().unwrap_or_default();
    if dir == home {
        return Ok(json!({
            "ok": false,
            "message": "Cannot enroll home directory — open this terminal in the project folder first.",
        }));
    }

    let api_url = api_url.unwrap_or_else(|| "https://getorquesta.com".into());

    // Write .orquesta.json
    let config = json!({
        "projectId": project_id,
        "projectName": project_name,
        "token": token,
        "apiUrl": api_url,
    });
    let orquesta_json = dir.join(".orquesta.json");
    tokio::fs::write(&orquesta_json, serde_json::to_string_pretty(&config).unwrap() + "\n")
        .await
        .map_err(|e| e.to_string())?;

    // .gitignore
    let gitignore_path = dir.join(".gitignore");
    let existing = tokio::fs::read_to_string(&gitignore_path)
        .await
        .unwrap_or_default();
    if !existing.contains(".orquesta.json") {
        let entry = "\n# Orquesta hook config (contains token)\n.orquesta.json\n";
        tokio::fs::write(&gitignore_path, existing + entry)
            .await
            .ok();
    }

    // .claude/settings.json — only if orquesta-agent is available
    let bin = crate::daemon::resolve_orquesta_agent_bin();
    let claude_hooked = if let Some(bin_path) = &bin {
        let claude_dir = dir.join(".claude");
        tokio::fs::create_dir_all(&claude_dir)
            .await
            .map_err(|e| e.to_string())?;

        let settings_path = claude_dir.join("settings.json");
        let raw = tokio::fs::read_to_string(&settings_path)
            .await
            .unwrap_or_else(|_| "{}".into());
        let mut settings: Value = serde_json::from_str(&raw).unwrap_or(json!({}));

        if settings["hooks"].is_null() {
            settings["hooks"] = json!({});
        }
        let hooks = settings["hooks"].as_object_mut().unwrap();

        let hook_cmd = |event: &str| format!("{} hook {}", bin_path, event);
        let entries = [
            ("UserPromptSubmit", json!([{ "hooks": [{ "type": "command", "command": hook_cmd("prompt-submit") }] }])),
            ("PostToolUse", json!([{ "matcher": "Edit|Write|Bash|Read|Glob|Grep", "hooks": [{ "type": "command", "command": hook_cmd("tool-use"), "async": true }] }])),
            ("Stop", json!([{ "hooks": [{ "type": "command", "command": hook_cmd("stop") }] }])),
        ];

        for (event, entry) in &entries {
            if !hooks.contains_key(*event) {
                hooks.insert(event.to_string(), entry.clone());
            }
        }

        tokio::fs::write(&settings_path, serde_json::to_string_pretty(&settings).unwrap() + "\n")
            .await
            .map_err(|e| e.to_string())?;

        true
    } else {
        false
    };

    let msg = if claude_hooked {
        format!(
            "Hooked \"{}\" — restart the CLI in this pane so prompts start logging.",
            project_name.as_deref().unwrap_or(&project_id)
        )
    } else {
        format!(
            "Enrolled \"{}\" for orquesta-cli. Install orquesta-agent to also log claude prompts.",
            project_name.as_deref().unwrap_or(&project_id)
        )
    };

    Ok(json!({
        "ok": true,
        "cwd": dir.to_string_lossy(),
        "message": msg,
        "configured": true,
        "projectId": project_id,
        "projectName": project_name,
        "claudeHooked": claude_hooked,
    }))
}

fn hook_target_dir(cwd: Option<&str>) -> std::path::PathBuf {
    cwd.map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default())
}

// ── Terminal Sharing ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn terminal_share(
    session_id: String,
    project_id: String,
    api_url: String,
    cli_token: String,
    cli_type: Option<String>,
    cwd: Option<String>,
    label: Option<String>,
    allow_control: Option<bool>,
    state: State<'_, Arc<AppState>>,
) -> Result<Value, String> {
    use crate::state::SharedTerminalInfo;

    let cli_type_str = cli_type.unwrap_or_else(|| "shell".into());
    let channel = format!("agent:project-{project_id}");

    let info = SharedTerminalInfo {
        session_id: session_id.clone(),
        project_id: project_id.clone(),
        channel: channel.clone(),
        api_url: api_url.clone(),
        cli_token: cli_token.clone(),
        cli_type: cli_type_str.clone(),
        cwd: cwd.clone(),
        label: label.clone(),
        allow_control: allow_control.unwrap_or(false),
        buffer: String::new(),
    };

    {
        let mut shared = state.shared_terminals.lock().unwrap();
        shared.insert(session_id.clone(), info);
    }

    // Phase 5: Connect to cloud WebSocket and subscribe to the project channel
    let state_arc = Arc::clone(&state);
    let conn_result = crate::cloud::get_or_create_share_conn(
        &api_url,
        &cli_token,
        &project_id,
        &session_id,
        &state_arc,
    )
    .await;

    // Phase 5: Register the share via REST API (best-effort; don't fail the whole call)
    let _ = crate::cloud::register_share(
        &api_url,
        &cli_token,
        &project_id,
        &session_id,
        label.as_deref(),
        &cli_type_str,
        cwd.as_deref(),
    )
    .await;

    // Phase 5: Emit session:started on the cloud channel
    {
        let key = crate::cloud::conn_key(&api_url, &cli_token, &project_id);
        let frame = format!(
            r#"42["broadcast",{{"channel":"{channel}","event":"session:started","payload":{{"sessionId":"{session_id}","label":{},"cliType":"{cli_type_str}"}},"self":false}}]"#,
            label
                .as_deref()
                .map(|l| format!(r#""{l}""#))
                .unwrap_or_else(|| "null".into()),
        );
        let tx_opt = {
            let conns = state.cloud_conns.lock().unwrap();
            conns.get(&key).map(|c| c.tx.clone())
        };
        if let Some(tx) = tx_opt {
            let _ = tx.send(frame).await;
        }
    }

    // Emit share-status to frontend
    state
        .app_handle
        .emit(
            "terminal:share-status",
            json!({
                "sessionId": session_id,
                "shared": true,
                "projectId": project_id,
                "connected": conn_result.is_ok(),
            }),
        )
        .ok();

    Ok(json!({
        "ok": true,
        "sessionId": session_id,
        "channel": channel,
        "projectId": project_id,
    }))
}

#[tauri::command]
pub async fn terminal_unshare(
    session_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    // Phase 5: broadcast ended + REST PATCH + cleanup
    crate::cloud::stop_share(&session_id, &Arc::clone(&state)).await?;

    state
        .app_handle
        .emit(
            "terminal:share-status",
            json!({ "sessionId": session_id, "shared": false }),
        )
        .ok();

    Ok(())
}

#[tauri::command]
pub async fn terminal_share_control(
    session_id: String,
    allow_control: bool,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let mut shared = state.shared_terminals.lock().unwrap();
    if let Some(info) = shared.get_mut(&session_id) {
        info.allow_control = allow_control;
    }
    Ok(())
}

#[tauri::command]
pub fn terminal_cursor(
    session_id: String,
    id: String,
    name: String,
    color: String,
    x: f64,
    y: f64,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    // Update viewer tracking
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    {
        let mut viewers = state.session_viewers.lock().unwrap();
        let session_viewers = viewers.entry(session_id.clone()).or_default();
        session_viewers.insert(id.clone(), (name.clone(), now));
    }

    // TODO Phase 5: broadcast cursor to cloud viewers
    Ok(())
}

// ── Daemon Commands ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn daemon_preflight(
    api_url: Option<String>,
    cli_token: String,
    project_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Value, String> {
    crate::daemon::preflight(
        &api_url.unwrap_or_default(),
        &cli_token,
        &project_id,
        &state,
    )
    .await
}

#[tauri::command]
pub async fn daemon_start(
    api_url: Option<String>,
    cli_token: String,
    project_id: String,
    project_name: Option<String>,
    cwd: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<Value, String> {
    crate::daemon::start_daemon(
        &api_url.unwrap_or_default(),
        &cli_token,
        &project_id,
        project_name.as_deref(),
        cwd.as_deref(),
        Arc::clone(&state),
    )
    .await
}

#[tauri::command]
pub fn daemon_stop(
    project_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Value, String> {
    crate::daemon::stop_daemon(&project_id, &state)
}

#[tauri::command]
pub fn daemon_status_request(
    project_id: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<Value, String> {
    Ok(crate::daemon::daemon_status(project_id.as_deref(), &state))
}

// ── External Sessions ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn sessions_external_list() -> Result<Value, String> {
    crate::agent::list_external_sessions().await
}

#[tauri::command]
pub async fn sessions_external_attach(
    session_id: String,
    file: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    crate::agent::attach_external_session(session_id, file, Arc::clone(&state)).await
}

#[tauri::command]
pub fn sessions_external_detach(
    session_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    crate::agent::detach_external_session(&session_id, &state);
    Ok(())
}

// ── Remote Sessions ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn remote_list_agents(
    api_url: Option<String>,
    token: String,
    project_id: String,
) -> Result<Value, String> {
    let base = api_url.unwrap_or_else(|| "https://getorquesta.com".into());
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{base}/api/orquesta-cli/projects/{project_id}/agents"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(body)
}

#[tauri::command]
pub async fn remote_start(
    api_url: Option<String>,
    token: String,
    project_id: String,
    cols: Option<u16>,
    rows: Option<u16>,
    target_agent_token_id: Option<String>,
    working_directory: Option<String>,
    resume: Option<bool>,
    state: State<'_, Arc<AppState>>,
) -> Result<Value, String> {
    let base = api_url.unwrap_or_else(|| "https://getorquesta.com".into());
    let session_id = format!("remote-{}", uuid::Uuid::new_v4());

    // Connect (or reuse) the cloud WebSocket for the viewer side
    let conn_key = cloud::get_or_create_remote_conn(
        &base, &token, &project_id, &session_id, &state,
    )
    .await?;

    // Ask the remote agent to start a session
    cloud::remote_send(
        &conn_key,
        "session:start",
        json!({
            "sessionId": session_id,
            "projectId": project_id,
            "cols": cols.unwrap_or(220),
            "rows": rows.unwrap_or(50),
            "targetAgentTokenId": target_agent_token_id,
            "workingDirectory": working_directory,
            "resume": resume.unwrap_or(false),
        }),
        &state,
    )
    .await?;

    // Store the remote session
    {
        let mut remote_sessions = state.remote_sessions.lock().unwrap();
        remote_sessions.insert(
            session_id.clone(),
            crate::state::RemoteSession {
                session_id: session_id.clone(),
                project_id: project_id.clone(),
                channel: format!("cockpit:project-{project_id}"),
                conn_key,
            },
        );
    }

    Ok(json!({ "ok": true, "sessionId": session_id }))
}

#[tauri::command]
pub async fn remote_input(
    session_id: String,
    input: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let conn_key = {
        let remote_sessions = state.remote_sessions.lock().unwrap();
        remote_sessions.get(&session_id).map(|s| s.conn_key.clone())
    };
    if let Some(key) = conn_key {
        cloud::remote_send(
            &key,
            "session:input",
            json!({ "sessionId": session_id, "data": input }),
            &state,
        )
        .await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn remote_resize(
    session_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let conn_key = {
        let remote_sessions = state.remote_sessions.lock().unwrap();
        remote_sessions.get(&session_id).map(|s| s.conn_key.clone())
    };
    if let Some(key) = conn_key {
        cloud::remote_send(
            &key,
            "session:resize",
            json!({ "sessionId": session_id, "cols": cols, "rows": rows }),
            &state,
        )
        .await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn remote_detach(
    session_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let conn_key = {
        let remote_sessions = state.remote_sessions.lock().unwrap();
        remote_sessions.get(&session_id).map(|s| s.conn_key.clone())
    };
    if let Some(key) = conn_key {
        // Notify the agent we are detaching
        let _ = cloud::remote_send(
            &key,
            "session:detach",
            json!({ "sessionId": session_id }),
            &state,
        )
        .await;
        cloud::remote_cleanup(&session_id, &key, &state);
    }
    Ok(())
}

#[tauri::command]
pub async fn remote_end(
    session_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let conn_key = {
        let remote_sessions = state.remote_sessions.lock().unwrap();
        remote_sessions.get(&session_id).map(|s| s.conn_key.clone())
    };
    if let Some(key) = conn_key {
        // Ask the agent to terminate the session
        let _ = cloud::remote_send(
            &key,
            "session:end",
            json!({ "sessionId": session_id }),
            &state,
        )
        .await;
        cloud::remote_cleanup(&session_id, &key, &state);
    }
    Ok(())
}

// ── Hosted Proxy ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn hosted_proxy(
    url: String,
    token: String,
    method: Option<String>,
    body: Option<Value>,
) -> Result<Value, String> {
    let method = method.unwrap_or_else(|| "GET".into());
    let client = reqwest::Client::new();

    let mut req = match method.to_uppercase().as_str() {
        "POST"   => client.post(&url),
        "PATCH"  => client.patch(&url),
        "DELETE" => client.delete(&url),
        "PUT"    => client.put(&url),
        _        => client.get(&url),
    };

    req = req
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json");

    if let Some(b) = body {
        req = req.json(&b);
    }

    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let json_body: Value = resp.json().await.unwrap_or(json!({}));

    if status.is_client_error() || status.is_server_error() {
        let msg = json_body["error"]
            .as_str()
            .or_else(|| json_body["message"].as_str())
            .unwrap_or("Request failed")
            .to_string();
        return Err(msg);
    }

    Ok(json_body)
}

#[tauri::command]
pub async fn hosted_upload(
    url: String,
    token: String,
    data: String,
    filename: Option<String>,
    content_type: Option<String>,
) -> Result<Value, String> {
    let client = reqwest::Client::new();
    let part = reqwest::multipart::Part::bytes(data.into_bytes())
        .file_name(filename.unwrap_or_else(|| "upload".into()))
        .mime_str(content_type.as_deref().unwrap_or("text/plain"))
        .map_err(|e| e.to_string())?;

    let form = reqwest::multipart::Form::new().part("file", part);

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {token}"))
        .multipart(form)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let json_body: Value = resp.json().await.unwrap_or(json!({}));
    Ok(json_body)
}
