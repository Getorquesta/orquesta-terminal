use serde_json::{json, Value};
use std::sync::Arc;
use tauri::Emitter;

use crate::state::{AppState, DaemonInfo};

/// Resolve the orquesta-agent binary path.
pub fn resolve_orquesta_agent_bin() -> Option<String> {
    // Try which first
    if let Ok(path) = which::which("orquesta-agent") {
        return Some(path.to_string_lossy().to_string());
    }

    // Fallback candidates
    let candidates = [
        "/usr/local/bin/orquesta-agent",
        "/usr/bin/orquesta-agent",
    ];

    for candidate in &candidates {
        if std::path::Path::new(candidate).exists() {
            return Some(candidate.to_string());
        }
    }

    // Try env var
    std::env::var("ORQUESTA_AGENT_BIN").ok()
}

/// Check preflight status before starting a daemon.
pub async fn preflight(
    api_url: &str,
    cli_token: &str,
    project_id: &str,
    state: &Arc<AppState>,
) -> Result<Value, String> {
    // Check if daemon already running for this project
    {
        let daemons = state.daemons.lock().unwrap();
        if daemons.get(project_id).map(|d| d.running).unwrap_or(false) {
            return Ok(json!({
                "ok": false,
                "reason": "already_running",
                "projectId": project_id,
            }));
        }
    } // MutexGuard dropped before any await

    // Check orquesta-agent binary
    let bin = resolve_orquesta_agent_bin();
    if bin.is_none() {
        return Ok(json!({
            "ok": false,
            "reason": "binary_not_found",
            "message": "orquesta-agent not found in PATH",
        }));
    }

    // Mint a project-scoped token via REST
    let base = if api_url.is_empty() {
        "https://getorquesta.com"
    } else {
        api_url
    };

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{base}/api/orquesta-cli/projects/{project_id}/agent-tokens"))
        .header("Authorization", format!("Bearer {cli_token}"))
        .json(&json!({ "name": "daemon-preflight" }))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Ok(json!({
            "ok": false,
            "reason": "auth_failed",
            "status": resp.status().as_u16(),
        }));
    }

    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(json!({
        "ok": true,
        "bin": bin,
        "tokenInfo": body,
    }))
}

/// Spawn orquesta-agent --daemon and pump its stdout/stderr to frontend.
pub async fn start_daemon(
    api_url: &str,
    cli_token: &str,
    project_id: &str,
    project_name: Option<&str>,
    cwd: Option<&str>,
    state: Arc<AppState>,
) -> Result<Value, String> {
    let bin = resolve_orquesta_agent_bin()
        .ok_or("orquesta-agent binary not found")?;

    // Mint a project-scoped token
    let base = if api_url.is_empty() {
        "https://getorquesta.com"
    } else {
        api_url
    };

    let client = reqwest::Client::new();
    let token_resp = client
        .post(format!("{base}/api/orquesta-cli/projects/{project_id}/agent-tokens"))
        .header("Authorization", format!("Bearer {cli_token}"))
        .json(&json!({ "name": format!("daemon-{project_id}") }))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !token_resp.status().is_success() {
        return Err(format!("Failed to mint agent token: HTTP {}", token_resp.status()));
    }

    let token_body: Value = token_resp.json().await.map_err(|e| e.to_string())?;
    let oat_token = token_body["token"]
        .as_str()
        .ok_or("No token in response")?
        .to_string();
    let token_id = token_body["id"].as_str().unwrap_or("").to_string();
    let token_name = token_body["name"].as_str().unwrap_or("daemon").to_string();

    let work_dir = cwd
        .map(|s| s.to_string())
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().to_string_lossy().to_string());

    // Build command
    let mut cmd = tokio::process::Command::new(&bin);
    cmd.arg("--daemon")
        .arg("--token").arg(&oat_token)
        .arg("--working-dir").arg(&work_dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    if !base.contains("getorquesta.com") {
        cmd.arg("--api-url").arg(base);
    }

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn daemon: {e}"))?;

    let pid = child.id();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    // Store daemon info
    {
        let mut daemons = state.daemons.lock().unwrap();
        daemons.insert(
            project_id.to_string(),
            DaemonInfo {
                project_id: project_id.to_string(),
                project_name: project_name.map(String::from),
                token_name,
                token_id: if token_id.is_empty() { None } else { Some(token_id) },
                cwd: work_dir,
                pid,
                started_at: now,
                log_tail: Vec::new(),
                running: true,
            },
        );
    }

    // Emit initial status
    state
        .app_handle
        .emit("daemon:status", json!({ "projectId": project_id, "running": true, "pid": pid }))
        .ok();

    // Pump stdout
    let state_out = Arc::clone(&state);
    let pid_out = project_id.to_string();
    if let Some(stdout) = child.stdout.take() {
        tauri::async_runtime::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                // Store in log_tail (last 100 lines)
                {
                    let mut daemons = state_out.daemons.lock().unwrap();
                    if let Some(d) = daemons.get_mut(&pid_out) {
                        d.log_tail.push(line.clone());
                        if d.log_tail.len() > 100 {
                            d.log_tail.remove(0);
                        }
                    }
                }
                state_out
                    .app_handle
                    .emit("daemon:log", json!({ "projectId": pid_out, "line": line }))
                    .ok();
            }
        });
    }

    // Pump stderr + watch for exit
    let state_err = Arc::clone(&state);
    let pid_err = project_id.to_string();
    if let Some(stderr) = child.stderr.take() {
        tauri::async_runtime::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                state_err
                    .app_handle
                    .emit("daemon:log", json!({ "projectId": pid_err, "line": line, "stderr": true }))
                    .ok();
            }
        });
    }

    // Watch for exit
    let state_exit = Arc::clone(&state);
    let pid_exit = project_id.to_string();
    tauri::async_runtime::spawn(async move {
        let _ = child.wait().await;
        {
            let mut daemons = state_exit.daemons.lock().unwrap();
            if let Some(d) = daemons.get_mut(&pid_exit) {
                d.running = false;
            }
        }
        state_exit
            .app_handle
            .emit("daemon:status", json!({ "projectId": pid_exit, "running": false }))
            .ok();
    });

    Ok(json!({
        "ok": true,
        "projectId": project_id,
        "pid": pid,
        "tokenName": token_body["name"],
    }))
}

/// Stop a running daemon.
pub fn stop_daemon(project_id: &str, state: &Arc<AppState>) -> Result<Value, String> {
    let mut daemons = state.daemons.lock().unwrap();
    if let Some(daemon) = daemons.get_mut(project_id) {
        daemon.running = false;
        // The tokio::process::Child drops when the spawn task exits
        // We just mark as not running; the kill_on_drop will handle it
        daemons.remove(project_id);
        state
            .app_handle
            .emit("daemon:status", json!({ "projectId": project_id, "running": false }))
            .ok();
        Ok(json!({ "ok": true, "projectId": project_id }))
    } else {
        Ok(json!({ "ok": false, "reason": "not_found" }))
    }
}

/// Get status of one or all daemons.
pub fn daemon_status(project_id: Option<&str>, state: &Arc<AppState>) -> Value {
    let daemons = state.daemons.lock().unwrap();
    if let Some(pid) = project_id {
        if let Some(d) = daemons.get(pid) {
            json!({ "daemons": [d] })
        } else {
            json!({ "daemons": [] })
        }
    } else {
        let all: Vec<&DaemonInfo> = daemons.values().collect();
        json!({ "daemons": all })
    }
}
