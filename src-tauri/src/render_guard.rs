//! Keeps the window alive when the GPU driver takes the webview down with it.
//!
//! WebKitGTK renders the page in a separate `WebKitWebProcess`. On some Linux
//! graphics stacks that process segfaults *inside the driver* — observed on a
//! GeForce GTX 1660 Ti driven by Mesa 25.2.8 / NVK, where the whole backtrace
//! sits in `libgallium`:
//!
//! ```text
//! WebKitWebProces[1745601]: segfault at 0 ... in libgallium-25.2.8.so
//! #0..#7  libgallium-25.2.8-0ubuntu0.24.04.2.so
//! ```
//!
//! The Tauri process survives, so the app does not exit and nothing is logged:
//! the user is left with a dead window and no way to tell why. Measured on the
//! affected machine, the crash lands 25-45 s after launch — *after* the page
//! has painted — so a "did the frontend come up?" probe misses it entirely.
//! Liveness of the renderer process is the only signal that catches both the
//! never-painted case and the painted-then-died one.
//!
//! Recovery is to take WebKit off the GPU path. `WEBKIT_DISABLE_DMABUF_RENDERER`
//! is NOT enough — it was tried on the affected machine and crashed identically,
//! and so did `WEBKIT_DISABLE_COMPOSITING_MODE`, because accelerated compositing
//! still goes through Mesa. `LIBGL_ALWAYS_SOFTWARE=1` moves rendering to
//! llvmpipe and the renderer then stays up indefinitely. That is what this
//! module escalates to, and the choice is sticky: a driver that crashes once
//! crashes every time, and flip-flopping would just hand the user a dead window
//! on every other launch. `ORQUESTA_FORCE_GPU=1` clears it once the driver is
//! fixed.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// How the webview was told to render this launch.
pub const MODE_GPU: &str = "gpu";
pub const MODE_SOFTWARE: &str = "software";

/// The renderer must show up within this long, or it never will.
const RENDERER_GRACE: Duration = Duration::from_secs(30);
/// How often the watchdog looks.
const POLL_INTERVAL: Duration = Duration::from_secs(3);
/// Consecutive misses before a renderer counts as gone. Two polls, so a read of
/// /proc that races the process table cannot on its own trigger a restart.
const MISSES_BEFORE_DEAD: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderState {
    /// The mode the NEXT launch should use.
    pub mode: String,
    /// How many launches lost their renderer.
    pub failures: u32,
    /// Set at launch, cleared when the renderer is confirmed alive. True at
    /// startup means the previous launch never got a working renderer.
    pub pending: bool,
    pub last_launch: Option<String>,
    pub last_failure: Option<String>,
    /// Why we are in software mode, in words, for the UI and for support.
    pub reason: Option<String>,
}

impl Default for RenderState {
    fn default() -> Self {
        Self {
            mode: MODE_GPU.to_string(),
            failures: 0,
            pending: false,
            last_launch: None,
            last_failure: None,
            reason: None,
        }
    }
}

fn state_path() -> Option<PathBuf> {
    Some(dirs::config_dir()?.join("com.orquesta.terminal").join("render-state.json"))
}

fn log_path() -> Option<PathBuf> {
    Some(dirs::data_dir()?.join("com.orquesta.terminal").join("logs").join("render.log"))
}

pub fn read_state() -> RenderState {
    let Some(path) = state_path() else { return RenderState::default() };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn write_state(state: &RenderState) {
    let Some(path) = state_path() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(state) {
        let _ = std::fs::write(path, json);
    }
}

/// Append one line to the render log, rotating at 512 KB.
///
/// This module's whole failure mode is invisibility: on the affected machine the
/// app wrote nothing to disk at all, and the crash had to be recovered from
/// `coredumpctl`. So every decision here leaves a line behind.
pub fn log_line(line: &str) {
    let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let entry = format!("[{stamp}] {line}\n");
    eprint!("[render-guard] {line}\n");

    let Some(path) = log_path() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 512 * 1024 {
            let _ = std::fs::rename(&path, path.with_extension("log.1"));
        }
    }
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(entry.as_bytes());
    }
}

/// Pick the render mode for this launch and apply it to the environment.
///
/// MUST run before Tauri initializes GTK/WebKit — the variables are read when
/// the webview is created, so setting them later has no effect.
#[cfg(target_os = "linux")]
pub fn apply_render_mode() -> String {
    // WebKitGTK's DMABUF renderer paints a black window on several Linux setups
    // (NVIDIA proprietary drivers, VMs, some Mesa versions), where the app runs
    // but never composites. Cheap, so it stays on unconditionally; it is simply
    // not sufficient for the driver crash this module handles.
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    let mut state = read_state();

    // The user's own choice always wins, and is never persisted over: someone
    // debugging with an explicit variable does not want it remembered.
    if std::env::var_os("LIBGL_ALWAYS_SOFTWARE").is_some() {
        log_line("launch: LIBGL_ALWAYS_SOFTWARE set by the environment — leaving it alone");
        return MODE_SOFTWARE.to_string();
    }

    // Escape hatch for a machine whose driver got fixed.
    if std::env::var("ORQUESTA_FORCE_GPU").map(|v| v != "0").unwrap_or(false) {
        log_line("launch: ORQUESTA_FORCE_GPU set — clearing software mode and the failure count");
        state = RenderState { last_launch: Some(now()), pending: true, ..RenderState::default() };
        write_state(&state);
        return MODE_GPU.to_string();
    }

    // A launch that never confirmed a renderer is a failure, counted now
    // because the launch that suffered it could not count it itself — that is
    // the case where the process is killed or the machine powers off before the
    // watchdog runs.
    if state.pending {
        state.failures += 1;
        state.last_failure = Some(now());
        log_line(&format!(
            "launch: previous run never confirmed a renderer (failures={})",
            state.failures
        ));
    }

    if state.failures > 0 && state.mode != MODE_SOFTWARE {
        state.mode = MODE_SOFTWARE.to_string();
        state.reason = Some(
            "the GPU driver crashed the webview renderer; rendering in software".to_string(),
        );
    }

    let mode = state.mode.clone();
    if mode == MODE_SOFTWARE {
        std::env::set_var("LIBGL_ALWAYS_SOFTWARE", "1");
    }

    state.pending = true;
    state.last_launch = Some(now());
    write_state(&state);

    log_line(&format!("launch: render mode = {mode} (failures={})", state.failures));
    mode
}

#[cfg(not(target_os = "linux"))]
pub fn apply_render_mode() -> String {
    MODE_GPU.to_string()
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn now() -> String {
    chrono::Local::now().to_rfc3339()
}

/// Set as soon as the app is on its way out.
///
/// Quitting kills the renderer too, and the watchdog cannot tell that apart
/// from a driver crash — so without this flag closing the window would count as
/// a graphics failure and, worse, relaunch the app the user just closed.
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

/// Called from the window/exit events. Idempotent.
pub fn mark_shutdown() {
    SHUTTING_DOWN.store(true, Ordering::SeqCst);
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn is_shutting_down() -> bool {
    SHUTTING_DOWN.load(Ordering::SeqCst)
}

/// Is a `WebKitWebProcess` of ours running?
///
/// `comm` is capped at 15 characters by the kernel, so the renderer shows up as
/// `WebKitWebProces` — and the network process as `WebKitNetworkPr`, which is
/// why the match is on the prefix and not on a contains().
#[cfg(target_os = "linux")]
fn renderer_alive() -> bool {
    let me = std::process::id();
    let Ok(entries) = std::fs::read_dir("/proc") else { return false };

    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid) = name.to_str() else { continue };
        if !pid.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else { continue };

        // comm is parenthesised and may itself contain spaces or parens, so the
        // fields after it are found from the LAST ')'.
        let Some(open) = stat.find('(') else { continue };
        let Some(close) = stat.rfind(')') else { continue };
        if close <= open {
            continue;
        }
        if !stat[open + 1..close].starts_with("WebKitWebProces") {
            continue;
        }
        // After the ')': state, then ppid.
        let mut rest = stat[close + 1..].split_whitespace();
        let _state = rest.next();
        if rest.next().and_then(|p| p.parse::<u32>().ok()) == Some(me) {
            return true;
        }
    }
    false
}

/// Watch the renderer for the life of the app, and escalate if it dies.
#[cfg(target_os = "linux")]
pub fn start_watchdog(app: tauri::AppHandle, booted_mode: String) {
    std::thread::spawn(move || {
        let started = std::time::Instant::now();
        let mut seen = false;
        let mut misses = 0u32;

        loop {
            std::thread::sleep(POLL_INTERVAL);

            if is_shutting_down() {
                return;
            }

            if renderer_alive() {
                if !seen {
                    seen = true;
                    // The renderer is up, so this launch worked. Clearing
                    // `pending` here — rather than at exit — is what makes a
                    // kill -9 or a power cut indistinguishable from a clean
                    // run, instead of counting as a graphics failure.
                    let mut state = read_state();
                    state.pending = false;
                    write_state(&state);
                    log_line(&format!(
                        "renderer up after {:?} in {booted_mode} mode",
                        started.elapsed()
                    ));
                }
                misses = 0;
                continue;
            }

            if !seen {
                if started.elapsed() < RENDERER_GRACE {
                    continue;
                }
                log_line("renderer never appeared within the grace period");
                escalate(&app, &booted_mode, "the webview renderer never started");
                return;
            }

            misses += 1;
            if misses < MISSES_BEFORE_DEAD {
                continue;
            }

            log_line(&format!(
                "renderer died after {:?} in {booted_mode} mode",
                started.elapsed()
            ));
            escalate(&app, &booted_mode, "the webview renderer crashed");
            return;
        }
    });
}

#[cfg(not(target_os = "linux"))]
pub fn start_watchdog(_app: tauri::AppHandle, _booted_mode: String) {}

/// Record the failure and, if there is somewhere better to go, restart into it.
#[cfg(target_os = "linux")]
fn escalate(app: &tauri::AppHandle, booted_mode: &str, what: &str) {
    // Belt and braces around the shutdown flag: if there is no window left,
    // the renderer is gone because the app is closing, not because it crashed.
    // Getting this wrong relaunches an app the user deliberately quit.
    use tauri::Manager;
    if is_shutting_down() || app.webview_windows().is_empty() {
        log_line("renderer gone while the app was closing — not a graphics failure");
        return;
    }

    let mut state = read_state();
    state.pending = false; // the failure is now recorded explicitly
    state.failures += 1;
    state.last_failure = Some(now());
    state.reason = Some(format!("{what}; rendering in software"));

    if booted_mode == MODE_SOFTWARE {
        // Software rendering does not touch the GPU driver, so there is no
        // further fallback to try. Restarting would only loop.
        write_state(&state);
        log_line("already in software mode — not restarting, there is nothing left to fall back to");
        return;
    }

    state.mode = MODE_SOFTWARE.to_string();
    write_state(&state);
    log_line("restarting with LIBGL_ALWAYS_SOFTWARE=1");

    // Never returns.
    app.restart();
}

/// What the frontend needs to explain a degraded session to the user.
#[derive(Serialize)]
pub struct RenderDiagnostics {
    pub mode: String,
    pub failures: u32,
    pub reason: Option<String>,
    pub last_failure: Option<String>,
    pub log_path: Option<String>,
}

#[tauri::command]
pub fn render_diagnostics() -> RenderDiagnostics {
    let state = read_state();
    RenderDiagnostics {
        mode: state.mode,
        failures: state.failures,
        reason: state.reason,
        last_failure: state.last_failure,
        log_path: log_path().map(|p| p.to_string_lossy().to_string()),
    }
}
