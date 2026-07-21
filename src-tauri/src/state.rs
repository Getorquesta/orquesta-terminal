use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

// ── PTY Sessions ─────────────────────────────────────────────────────────────

pub struct PtySession {
    pub writer: Box<dyn std::io::Write + Send>,
    // Kept so the PTY can be resized after spawn (TUI apps like orquesta-cli
    // redraw based on the reported terminal size; a stale size garbles output).
    pub master: Box<dyn portable_pty::MasterPty + Send>,
    pub cli_type: String,
    pub cwd: String,
    pub pid: Option<u32>,
}

// ── Shared Terminals ─────────────────────────────────────────────────────────

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedTerminalInfo {
    pub session_id: String,
    pub project_id: String,
    pub channel: String,
    pub api_url: String,
    pub cli_token: String,
    pub cli_type: String,
    pub cwd: Option<String>,
    pub label: Option<String>,
    pub allow_control: bool,
    pub buffer: String,
}

// ── Daemon ───────────────────────────────────────────────────────────────────

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonInfo {
    pub project_id: String,
    pub project_name: Option<String>,
    pub token_name: String,
    pub token_id: Option<String>,
    pub cwd: String,
    pub pid: Option<u32>,
    pub started_at: u64,
    pub log_tail: Vec<String>,
    pub running: bool,
}

// ── Cloud connections ─────────────────────────────────────────────────────────
// NOTE: rust_socketio client added in Phase 5. Using Arc<tokio::sync::Mutex> placeholder.

pub struct CloudConn {
    // Sender for frames to the cloud WebSocket (Phase 5: replace with rust_socketio client)
    pub tx: tokio::sync::mpsc::Sender<String>,
    pub refs: HashSet<String>,
}

// ── Remote sessions ───────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct RemoteSession {
    pub session_id: String,
    pub project_id: String,
    pub channel: String,
    pub conn_key: String,
}

// ── External JSONL tailers ────────────────────────────────────────────────────

pub struct FileTailer {
    pub abort: tokio::sync::oneshot::Sender<()>,
}

// ── App State ─────────────────────────────────────────────────────────────────

pub struct AppState {
    pub sessions: Mutex<HashMap<String, PtySession>>,
    pub shared_terminals: Mutex<HashMap<String, SharedTerminalInfo>>,
    pub cloud_conns: Mutex<HashMap<String, CloudConn>>,
    pub remote_sessions: Mutex<HashMap<String, RemoteSession>>,
    pub remote_conns: Mutex<HashMap<String, CloudConn>>,
    pub daemons: Mutex<HashMap<String, DaemonInfo>>,
    pub session_viewers: Mutex<HashMap<String, HashMap<String, (String, u64)>>>,
    pub file_tailers: Mutex<HashMap<String, FileTailer>>,
    pub app_handle: AppHandle,
}

impl AppState {
    pub fn new(app_handle: AppHandle) -> Arc<Self> {
        Arc::new(Self {
            sessions: Mutex::new(HashMap::new()),
            shared_terminals: Mutex::new(HashMap::new()),
            cloud_conns: Mutex::new(HashMap::new()),
            remote_sessions: Mutex::new(HashMap::new()),
            remote_conns: Mutex::new(HashMap::new()),
            daemons: Mutex::new(HashMap::new()),
            session_viewers: Mutex::new(HashMap::new()),
            file_tailers: Mutex::new(HashMap::new()),
            app_handle,
        })
    }
}
