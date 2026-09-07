use serde_json::{json, Value};
use std::sync::Arc;
use tauri::Emitter;

use crate::state::{AppState, DaemonInfo};

/// Resolve the orquesta-agent binary path.
///
/// `which()` alone is not enough: an app launched from the desktop (dock, .desktop
/// file, Spotlight) inherits a bare PATH that knows nothing about nvm, volta, fnm
/// or homebrew — so an `npm i -g orquesta-agent` that works fine in the user's
/// terminal is invisible here, and hook enrollment silently skips writing the
/// Claude hooks. So we also ask a login shell (same PATH as their terminal) and
/// finally look inside the version managers' install dirs ourselves.
pub fn resolve_orquesta_agent_bin() -> Option<String> {
    // Explicit override always wins.
    if let Ok(p) = std::env::var("ORQUESTA_AGENT_BIN") {
        if !p.is_empty() && std::path::Path::new(&p).exists() {
            return Some(p);
        }
    }

    if let Ok(path) = which::which("orquesta-agent") {
        return Some(path.to_string_lossy().to_string());
    }

    if let Some(path) = probe_login_shell() {
        return Some(path);
    }

    for dir in candidate_bin_dirs() {
        let candidate = dir.join(BIN_NAME);
        if candidate.exists() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }

    None
}

#[cfg(target_os = "windows")]
const BIN_NAME: &str = "orquesta-agent.cmd";
#[cfg(not(target_os = "windows"))]
const BIN_NAME: &str = "orquesta-agent";

/// Ask the user's login shell where the binary is — it sources their profile,
/// so nvm/volta/asdf shims are on its PATH even when ours is bare.
#[cfg(not(target_os = "windows"))]
fn probe_login_shell() -> Option<String> {
    use std::process::Command;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    let out = Command::new(&shell)
        .args(["-lc", "command -v orquesta-agent"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_string();
    if path.is_empty() || !std::path::Path::new(&path).exists() {
        return None;
    }
    Some(path)
}

#[cfg(target_os = "windows")]
fn probe_login_shell() -> Option<String> {
    None
}

/// Directories a global npm install can land in, most specific first.
fn candidate_bin_dirs() -> Vec<std::path::PathBuf> {
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();

    if let Some(home) = dirs::home_dir() {
        for rel in [
            ".local/bin",
            ".npm-global/bin",
            ".npm-packages/bin",
            ".volta/bin",
            ".bun/bin",
            ".yarn/bin",
            "n/bin",
            "AppData/Roaming/npm",
        ] {
            dirs.push(home.join(rel));
        }

        // Version managers keep one bin dir per installed node — newest first.
        for (root, suffix) in [
            (home.join(".nvm/versions/node"), ""),
            (home.join(".local/share/fnm/node-versions"), "installation"),
            (home.join(".asdf/installs/nodejs"), ""),
        ] {
            let Ok(entries) = std::fs::read_dir(&root) else {
                continue;
            };
            let mut versions: Vec<std::path::PathBuf> =
                entries.filter_map(|e| e.ok()).map(|e| e.path()).collect();
            versions.sort();
            for version in versions.into_iter().rev() {
                dirs.push(version.join(suffix).join("bin"));
            }
        }
    }

    dirs.extend(
        ["/usr/local/bin", "/usr/bin", "/opt/homebrew/bin"]
            .iter()
            .map(std::path::PathBuf::from),
    );

    dirs
}

/// Check preflight status before starting a daemon.
///
/// Answers the takeover modal's one question: what would a second agent collide
/// with? So it LISTS the project's agents (dashboard's own online window) and
/// reports whether this machine already runs a daemon for it. It deliberately
/// does NOT mint an agent token — minting is a side effect, and a cancelled
/// pre-flight used to leave a stray `daemon-preflight` token on the project.
pub async fn preflight(
    api_url: &str,
    cli_token: &str,
    project_id: &str,
    state: &Arc<AppState>,
) -> Result<Value, String> {
    let local = {
        let daemons = state.daemons.lock().unwrap();
        daemons.get(project_id).map(|d| (d.running, d.pid))
    }; // MutexGuard dropped before any await
    let local_running = local.map(|(running, _)| running).unwrap_or(false);
    let local_pid = local.and_then(|(_, pid)| pid);

    let bin = resolve_orquesta_agent_bin();

    let base = if api_url.is_empty() {
        "https://getorquesta.com"
    } else {
        api_url
    };

    // Every failure below is REPORTED, never propagated: the modal offers
    // "you can still proceed", and an Err here would leave it spinning instead.
    let mut online: Vec<Value> = Vec::new();
    let mut error: Option<String> = None;

    if cli_token.is_empty() {
        error = Some("not signed in".into());
    } else {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client
            .get(format!("{base}/api/orquesta-cli/projects/{project_id}/agents"))
            .header("Authorization", format!("Bearer {cli_token}"))
            .send()
            .await;
        match resp {
            Err(e) => error = Some(e.to_string()),
            Ok(r) if !r.status().is_success() => {
                error = Some(format!("HTTP {}", r.status().as_u16()));
            }
            Ok(r) => match r.json::<Value>().await {
                Err(e) => error = Some(e.to_string()),
                Ok(body) => {
                    let empty: Vec<Value> = Vec::new();
                    for a in body["agents"].as_array().unwrap_or(&empty) {
                        if a["online"] == Value::Bool(true) {
                            online.push(json!({
                                "id": a["id"],
                                "name": a["name"],
                                "lastSeen": a["lastSeen"],
                            }));
                        }
                    }
                }
            },
        }
    }

    if bin.is_none() {
        error = Some("orquesta-agent not found in PATH".into());
    }

    Ok(json!({
        "ok": error.is_none(),
        "projectId": project_id,
        "online": online,
        "localDaemon": { "running": local_running, "pid": local_pid },
        "bin": bin,
        "error": error,
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
        .post(format!("{base}/api/orquesta-cli/projects/{project_id}/agent-token"))
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
        "message": match pid {
            Some(p) => format!("Agent started (pid {p})."),
            None => "Agent started.".to_string(),
        },
    }))
}

/// Signal a process tree to exit. `kill_on_drop` cannot do this for us: the
/// `Child` was moved into the exit-watch task, so dropping the map entry drops
/// nothing — the daemon kept running while the UI reported it stopped.
fn kill_pid(pid: u32) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let out = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output();
    #[cfg(not(target_os = "windows"))]
    let out = std::process::Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .output();

    match out {
        Ok(o) if o.status.success() => Ok(()),
        // Already gone counts as stopped.
        Ok(o) => {
            let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
            if err.contains("No such process") || err.contains("not found") {
                Ok(())
            } else {
                Err(err)
            }
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Stop a running daemon.
pub fn stop_daemon(project_id: &str, state: &Arc<AppState>) -> Result<Value, String> {
    let pid = {
        let mut daemons = state.daemons.lock().unwrap();
        match daemons.remove(project_id) {
            Some(d) => d.pid,
            None => return Ok(json!({
                "ok": false,
                "reason": "not_found",
                "projectId": project_id,
                "message": "No local daemon is running for this project.",
            })),
        }
    };

    // A daemon we tracked but whose pid we never got: the entry is gone, so the
    // exit watcher will reap it — report stopped rather than leaving it listed.
    let killed = match pid {
        Some(p) => kill_pid(p),
        None => Ok(()),
    };
    state
        .app_handle
        .emit("daemon:status", json!({ "projectId": project_id, "running": false }))
        .ok();

    match killed {
        Ok(()) => Ok(json!({
            "ok": true,
            "projectId": project_id,
            "message": "Agent stopped.",
        })),
        Err(e) => Ok(json!({
            "ok": false,
            "projectId": project_id,
            "message": format!("Could not stop the agent: {e}"),
        })),
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
