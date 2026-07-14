// Phase 5: Full cloud WebSocket bridge (rust_socketio + ws.orquesta.live)
// For now: stubs that let the rest of the code compile.

use std::sync::Arc;
use crate::state::AppState;

pub fn conn_key(api_url: &str, token: &str, project_id: &str) -> String {
    format!("{api_url}:{token}:{project_id}")
}

/// Mirror PTY output to cloud if this session is being shared.
pub fn maybe_broadcast_output(session_id: &str, data: &str, state: &Arc<AppState>) {
    let shared = state.shared_terminals.lock().unwrap();
    if let Some(info) = shared.get(session_id) {
        let session_id = info.session_id.clone();
        drop(shared);

        // Update scrollback buffer (max 200KB)
        let mut shared = state.shared_terminals.lock().unwrap();
        if let Some(info) = shared.get_mut(&session_id) {
            info.buffer.push_str(data);
            if info.buffer.len() > 200_000 {
                let excess = info.buffer.len() - 200_000;
                info.buffer.drain(..excess);
            }
        }

        // TODO Phase 5: send via cloud WebSocket
    }
}

/// Announce session ended on the cloud channel.
pub fn maybe_broadcast_ended(_session_id: &str, _state: &Arc<AppState>) {
    // TODO Phase 5: broadcast session:ended via cloud WebSocket
}

/// Prune viewers that haven't sent a heartbeat in 70 seconds.
pub fn prune_stale_viewers(state: &Arc<AppState>) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let mut viewers = state.session_viewers.lock().unwrap();
    for session_viewers in viewers.values_mut() {
        session_viewers.retain(|_, (_, last_seen)| now - *last_seen < 70_000);
    }
}
