mod agent;
mod cloud;
mod daemon;
mod error;
mod fs;
mod ipc;
mod pty;
mod render_guard;
mod state;
mod updater;

use std::sync::Arc;
use state::AppState;
use tauri::Manager;

pub fn run() {
    // Must run before Tauri brings up GTK/WebKit: the webview reads these
    // variables when it is created. See render_guard for why software rendering
    // is sometimes the only mode that survives.
    let render_mode = render_guard::apply_render_mode();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(move |app| {
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

            // Background: heartbeat every shared terminal every 60s, so the
            // dashboard can tell a live share from one whose cockpit is gone.
            let state_shares = Arc::clone(&app_state);
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(
                    std::time::Duration::from_secs(60),
                );
                loop {
                    interval.tick().await;
                    cloud::heartbeat_shares(&state_shares).await;
                }
            });

            // Watch the webview renderer for the life of the app. On a
            // graphics stack that segfaults inside the driver this is the only
            // signal that anything is wrong — the Tauri process keeps running
            // and the user just gets a dead window.
            render_guard::start_watchdog(app.handle().clone(), render_mode.clone());

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
            ipc::open_external_url,
            ipc::hosted_proxy,
            ipc::hosted_upload,
            // Graphics diagnostics
            render_guard::render_diagnostics,
            // Updates
            updater::check_for_update,
            updater::can_self_update,
        ])
        .on_window_event(|_window, event| {
            if matches!(
                event,
                tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
            ) {
                render_guard::mark_shutdown();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // Quitting kills the webview renderer too — including the updater's
            // relaunch. Tell the watchdog, or a deliberate exit reads as a
            // driver crash and the app comes back after the user closed it.
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                render_guard::mark_shutdown();
            }
        });
}
