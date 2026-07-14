mod agent;
mod cloud;
mod daemon;
mod error;
mod fs;
mod ipc;
mod pty;
mod state;

use std::sync::Arc;
use state::AppState;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let app_state = AppState::new(handle);

            // Background: prune stale terminal viewers every 30s
            let state_viewers = Arc::clone(&app_state);
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(
                    std::time::Duration::from_secs(30),
                );
                loop {
                    interval.tick().await;
                    cloud::prune_stale_viewers(&state_viewers);
                }
            });

            app.manage(app_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // PTY
            ipc::session_start,
            ipc::session_input,
            ipc::session_resize,
            ipc::session_end,
            ipc::session_force_end,
            // Filesystem
            ipc::fs_list_dir,
            ipc::fs_native_pick,
            // Hook enrollment
            ipc::hook_status,
            ipc::hook_init_project,
            // Terminal sharing
            ipc::terminal_share,
            ipc::terminal_unshare,
            ipc::terminal_share_control,
            ipc::terminal_cursor,
            // Daemon
            ipc::daemon_preflight,
            ipc::daemon_start,
            ipc::daemon_stop,
            ipc::daemon_status_request,
            // External sessions
            ipc::sessions_external_list,
            ipc::sessions_external_attach,
            ipc::sessions_external_detach,
            // Remote sessions
            ipc::remote_list_agents,
            ipc::remote_start,
            ipc::remote_input,
            ipc::remote_resize,
            ipc::remote_detach,
            ipc::remote_end,
            // Hosted proxy
            ipc::hosted_proxy,
            ipc::hosted_upload,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
