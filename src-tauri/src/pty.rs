use std::io::Read;
use std::sync::{Arc, OnceLock};
use portable_pty::{CommandBuilder, PtySize};
use serde_json::json;
use tauri::Emitter;

use crate::state::{AppState, PtySession};

/// The user's real login-shell PATH, computed once and cached.
///
/// A GUI launch (from a `.desktop` file / AppImage) does NOT source the user's
/// shell profile, so the app process's PATH lacks nvm / npm-global / `~/.local/bin`.
/// That makes installed CLIs (claude, orquesta, kimi, …) look "not installed" and
/// unrunnable. We ask the login+interactive shell for its PATH once and reuse it
/// for both detection and the spawned PTY environment. AppImage mount segments are
/// stripped so we never reintroduce the poisoned paths.
fn login_shell_path() -> Option<&'static str> {
    static PATH: OnceLock<Option<String>> = OnceLock::new();
    PATH.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
        let out = std::process::Command::new(&shell)
            .args(["-lic", "printf %s \"$PATH\""])
            .output()
            .ok()?;
        let raw = String::from_utf8_lossy(&out.stdout);
        let appdir = std::env::var("APPDIR").ok();
        let cleaned = strip_mount_paths(raw.trim(), appdir.as_deref(), "/tmp/.mount_");
        if cleaned.is_empty() { None } else { Some(cleaned) }
    })
    .as_deref()
}

/// Absolute path to `bin`, searching the login-shell PATH first (so GUI launches
/// resolve nvm/npm-global installs) and falling back to the app's own PATH.
fn resolve_bin(bin: &str) -> Option<String> {
    let cwd = std::env::current_dir().unwrap_or_default();
    if let Some(p) = login_shell_path() {
        if let Ok(path) = which::which_in(bin, Some(p), &cwd) {
            return Some(path.to_string_lossy().into_owned());
        }
    }
    which::which(bin).ok().map(|p| p.to_string_lossy().into_owned())
}

/// If `bin` is installed, return its absolute path directly; otherwise return a
/// shell that prints a friendly "not installed" message and then stays open.
fn cli_or_shell(bin: &str, install_hint: &str, env_extras: Vec<(String, String)>) -> (String, Vec<String>, Vec<(String, String)>) {
    if let Some(abs) = resolve_bin(bin) {
        return (abs, vec![], env_extras);
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    let msg = format!(
        r#"printf '\r\n\033[1;33m  {bin} is not installed.\033[0m\r\n  {install_hint}\r\n\r\n'; exec {shell}"#
    );
    (shell, vec!["-c".to_string(), msg], env_extras)
}

/// Remove the AppImage mount segments from a `PATH`-style (`:`-separated) value.
/// Returns the remaining real-system segments joined back together (may be empty).
fn strip_mount_paths(value: &str, appdir: Option<&str>, mount_prefix: &str) -> String {
    value
        .split(':')
        .filter(|seg| {
            !seg.is_empty()
                && !seg.contains(mount_prefix)
                && appdir.map_or(true, |d| !seg.starts_with(d))
        })
        .collect::<Vec<_>>()
        .join(":")
}

/// Build the environment for a spawned PTY.
///
/// When Orquesta Terminal runs as an AppImage, its runtime exports variables
/// (`PYTHONHOME`, `PYTHONPATH`, `LD_LIBRARY_PATH`, `GTK_PATH`, …) pointing into
/// the read-only mount at `$APPDIR` (`/tmp/.mount_*`). Inheriting those into a
/// user's shell hijacks system tools — e.g. `python3` dies with
/// `ModuleNotFoundError: No module named 'encodings'`. Here we drop the runtime's
/// own vars, prefer any `<VAR>_ORIG` backup the runtime stashed, and strip mount
/// path segments from the rest (dropping vars that end up empty). Outside an
/// AppImage the environment is passed through unchanged.
fn build_pty_env(env_extras: &[(String, String)]) -> Vec<(String, String)> {
    const MOUNT_PREFIX: &str = "/tmp/.mount_";
    // Variables the AppImage runtime uses for its own bookkeeping — never forward.
    const RUNTIME_VARS: &[&str] = &["APPDIR", "APPIMAGE", "ARGV0", "OWD"];

    let appdir = std::env::var("APPDIR").ok();
    let is_appimage = appdir.is_some() || std::env::var("APPIMAGE").is_ok();

    let mut result: Vec<(String, String)> = Vec::new();
    for (k, v) in std::env::vars() {
        if !is_appimage {
            result.push((k, v));
            continue;
        }
        if RUNTIME_VARS.contains(&k.as_str()) || k.ends_with("_ORIG") {
            continue;
        }
        // Prefer the original value the runtime backed up, if any.
        let value = std::env::var(format!("{k}_ORIG")).ok().unwrap_or(v);
        let points_into_mount = value.contains(MOUNT_PREFIX)
            || appdir.as_deref().map_or(false, |d| value.contains(d));
        if points_into_mount {
            let cleaned = strip_mount_paths(&value, appdir.as_deref(), MOUNT_PREFIX);
            if cleaned.is_empty() {
                continue; // e.g. PYTHONHOME/PYTHONPATH with no real counterpart
            }
            result.push((k, cleaned));
        } else {
            result.push((k, value));
        }
    }

    // Replace PATH with the user's login-shell PATH so a GUI-launched app can still
    // find nvm / npm-global / ~/.local/bin CLIs inside the terminal.
    if let Some(p) = login_shell_path() {
        result.retain(|(k, _)| k != "PATH");
        result.push(("PATH".to_string(), p.to_string()));
    }

    for (k, v) in env_extras {
        result.push((k.clone(), v.clone()));
    }
    result
}

/// Resolve CLI command + args from a cliType string.
fn resolve_command(
    cli_type: &str,
    resume_id: Option<&str>,
    hosted_user_id: Option<&str>,
    hosted_token: Option<&str>,
    hosted_api_url: Option<&str>,
) -> (String, Vec<String>, Vec<(String, String)>) {
    let mut env_extras: Vec<(String, String)> = Vec::new();

    if let Some(uid) = hosted_user_id {
        env_extras.push(("ORQUESTA_HOSTED_USER_ID".into(), uid.into()));
    }
    if let Some(tok) = hosted_token {
        env_extras.push(("ORQUESTA_HOSTED_TOKEN".into(), tok.into()));
    }
    if let Some(url) = hosted_api_url {
        env_extras.push(("ORQUESTA_HOSTED_API_URL".into(), url.into()));
    }

    match cli_type {
        "claude" => {
            let mut args = vec!["--dangerously-skip-permissions".to_string()];
            if let Some(rid) = resume_id {
                args.push("--resume".into());
                args.push(rid.into());
            }
            let cmd = resolve_bin("claude").unwrap_or_else(|| "claude".into());
            (cmd, args, env_extras)
        }
        "orquesta" => cli_or_shell("orquesta", "npm i -g orquesta-cli", env_extras),
        "kimi"     => cli_or_shell("kimi",     "npm i -g @moonshot-ai/kimi-cli", env_extras),
        "kiro"     => cli_or_shell("kiro",     "Download Kiro at https://kiro.dev", env_extras),
        "opencode" => cli_or_shell("opencode", "npm i -g opencode", env_extras),
        "gemini"   => cli_or_shell("gemini",   "npm i -g @google/gemini-cli", env_extras),
        "codex"    => cli_or_shell("codex",    "npm i -g @openai/codex", env_extras),
        "aider"    => cli_or_shell("aider",    "pip install aider-chat", env_extras),
        "continue" => cli_or_shell("continue", "npm i -g continue", env_extras),
        _ => {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
            (shell, vec![], env_extras)
        }
    }
}

/// Spawn a new PTY session and start streaming output to the frontend.
pub async fn spawn_session(
    session_id: String,
    cli_type: String,
    rows: u16,
    cols: u16,
    cwd: Option<String>,
    resume_id: Option<String>,
    hosted_user_id: Option<String>,
    hosted_token: Option<String>,
    hosted_api_url: Option<String>,
    state: Arc<AppState>,
) -> Result<serde_json::Value, String> {
    let (cmd, args, env_extras) = resolve_command(
        &cli_type,
        resume_id.as_deref(),
        hosted_user_id.as_deref(),
        hosted_token.as_deref(),
        hosted_api_url.as_deref(),
    );

    let pty_system = portable_pty::native_pty_system();

    let pty_size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = pty_system
        .openpty(pty_size)
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    let mut command = CommandBuilder::new(&cmd);
    for arg in &args {
        command.arg(arg);
    }

    // Set working directory
    let work_dir = cwd
        .clone()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().to_string_lossy().into());
    command.cwd(&work_dir);

    // Inherit environment and add extras, stripping AppImage-injected vars
    // (PYTHONHOME, LD_LIBRARY_PATH, …) that would otherwise hijack system tools.
    command.env_clear();
    for (k, v) in build_pty_env(&env_extras) {
        command.env(k, v);
    }
    command.env("TERM", "xterm-256color");

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| format!("Failed to spawn {cmd}: {e}"))?;

    let pid = child.process_id();

    // Clone master for writing (stored in state)
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to get PTY writer: {e}"))?;

    // Clone master for reading (used in background task)
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {e}"))?;

    // Store session
    {
        let mut sessions = state.sessions.lock().unwrap();
        sessions.insert(
            session_id.clone(),
            PtySession {
                writer,
                cli_type: cli_type.clone(),
                cwd: work_dir.clone(),
                pid,
            },
        );
    }

    // Emit session:started
    state
        .app_handle
        .emit(
            "session:started",
            json!({
                "sessionId": session_id,
                "pid": pid,
                "cwd": work_dir,
                "cliType": cli_type,
            }),
        )
        .ok();

    // Spawn background reader task
    let state_clone = Arc::clone(&state);
    let sid = session_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        output_reader_loop(sid, reader, child, state_clone);
    });

    Ok(json!({
        "ok": true,
        "sessionId": session_id,
        "pid": pid,
    }))
}

fn output_reader_loop(
    session_id: String,
    mut reader: Box<dyn Read + Send>,
    mut child: Box<dyn portable_pty::Child + Send>,
    state: Arc<AppState>,
) {
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => {
                // PTY closed — wait for exit status
                let exit_code = child.wait().ok().map(|s| s.exit_code());

                state
                    .app_handle
                    .emit(
                        "session:ended",
                        json!({
                            "sessionId": session_id,
                            "exitCode": exit_code,
                        }),
                    )
                    .ok();

                // Mirror to cloud if shared
                crate::cloud::maybe_broadcast_ended(&session_id, &state);

                // Remove from sessions map
                state.sessions.lock().unwrap().remove(&session_id);
                break;
            }
            Ok(n) => {
                let data = String::from_utf8_lossy(&buf[..n]).to_string();

                // Emit to frontend
                state
                    .app_handle
                    .emit(
                        "session:output",
                        json!({
                            "sessionId": session_id,
                            "data": data,
                        }),
                    )
                    .ok();

                // Mirror to cloud if shared
                crate::cloud::maybe_broadcast_output(&session_id, &data, &state);
            }
        }
    }
}

/// Write data into a running PTY.
pub fn write_session(session_id: &str, data: &str, state: &AppState) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session not found: {session_id}"))?;

    use std::io::Write;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Resize a running PTY.
pub fn resize_session(
    session_id: &str,
    cols: u16,
    rows: u16,
    state: &AppState,
) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let _session = sessions
        .get(session_id)
        .ok_or_else(|| format!("Session not found: {session_id}"))?;

    // Note: portable-pty resize is on the master handle which we don't keep separately.
    // We use a workaround: send TIOCSWINSZ via the writer's underlying fd.
    // For now emit a no-op acknowledgment — resize via escape sequences still works.
    drop(sessions);

    state
        .app_handle
        .emit(
            "session:resized",
            serde_json::json!({ "sessionId": session_id, "cols": cols, "rows": rows }),
        )
        .ok();

    Ok(())
}

/// Kill a PTY session cleanly.
pub fn kill_session(session_id: &str, state: &AppState) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    // Dropping the PtySession closes the writer → PTY master → process gets SIGHUP
    sessions.remove(session_id);
    Ok(())
}
