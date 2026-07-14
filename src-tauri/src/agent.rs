use serde_json::{json, Value};
use std::sync::Arc;
use tauri::Emitter;

use crate::state::{AppState, FileTailer};

/// List active external Claude sessions from ~/.claude/projects/
pub async fn list_external_sessions() -> Result<Value, String> {
    let home = dirs::home_dir().ok_or("Cannot find home directory")?;
    let projects_dir = home.join(".claude").join("projects");

    if !projects_dir.exists() {
        return Ok(json!({ "sessions": [] }));
    }

    let mut sessions = Vec::new();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let mut dir = tokio::fs::read_dir(&projects_dir)
        .await
        .map_err(|e| e.to_string())?;

    while let Ok(Some(project_entry)) = dir.next_entry().await {
        if !project_entry
            .file_type()
            .await
            .map(|t| t.is_dir())
            .unwrap_or(false)
        {
            continue;
        }

        let project_path = project_entry.path();
        let cwd = decode_project_dir(project_entry.file_name().to_string_lossy().as_ref());

        let mut jsonl_dir = match tokio::fs::read_dir(&project_path).await {
            Ok(d) => d,
            Err(_) => continue,
        };

        while let Ok(Some(file_entry)) = jsonl_dir.next_entry().await {
            let name = file_entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".jsonl") {
                continue;
            }

            let file_path = file_entry.path();
            let metadata = match tokio::fs::metadata(&file_path).await {
                Ok(m) => m,
                Err(_) => continue,
            };

            let size = metadata.len();
            let modified = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);

            let session_id = name.trim_end_matches(".jsonl").to_string();
            let is_active = now - modified < 30_000; // active if modified in last 30s

            sessions.push(json!({
                "id": session_id,
                "cwd": cwd,
                "file": file_path.to_string_lossy(),
                "lastActivity": modified,
                "size": size,
                "isActive": is_active,
            }));
        }
    }

    // Sort by lastActivity desc
    sessions.sort_by(|a, b| {
        let ta = a["lastActivity"].as_u64().unwrap_or(0);
        let tb = b["lastActivity"].as_u64().unwrap_or(0);
        tb.cmp(&ta)
    });

    Ok(json!({ "sessions": sessions }))
}

/// Decode Claude's directory encoding scheme (replaces / with -)
fn decode_project_dir(encoded: &str) -> String {
    // Claude encodes the cwd by replacing / with - (and leading / becomes -)
    // e.g. "-home-user-projects-myapp" → "/home/user/projects/myapp"
    if encoded.starts_with('-') {
        format!("/{}", encoded[1..].replace('-', "/"))
    } else {
        encoded.replace('-', "/")
    }
}

/// Start tailing a JSONL session file, emitting 'sessions:external-data' events.
pub async fn attach_external_session(
    session_id: String,
    file: String,
    state: Arc<AppState>,
) -> Result<(), String> {
    // If already attached, detach first
    detach_external_session(&session_id, &state);

    let (abort_tx, mut abort_rx) = tokio::sync::oneshot::channel::<()>();

    {
        let mut tailers = state.file_tailers.lock().unwrap();
        tailers.insert(session_id.clone(), FileTailer { abort: abort_tx });
    }

    let state_clone = Arc::clone(&state);
    let sid = session_id.clone();
    let file_path = file.clone();

    tauri::async_runtime::spawn(async move {
        // Read last 50 lines first
        let mut offset: u64 = replay_last_lines(&file_path, &sid, &state_clone, 50).await;

        loop {
            tokio::select! {
                _ = &mut abort_rx => break,
                _ = tokio::time::sleep(tokio::time::Duration::from_millis(500)) => {
                    offset = tail_new_content(&file_path, &sid, &state_clone, offset).await;
                }
            }
        }
    });

    Ok(())
}

async fn replay_last_lines(
    file_path: &str,
    session_id: &str,
    state: &Arc<AppState>,
    max_lines: usize,
) -> u64 {
    let content = match tokio::fs::read_to_string(file_path).await {
        Ok(c) => c,
        Err(_) => return 0,
    };

    let lines: Vec<&str> = content.lines().collect();
    let start = if lines.len() > max_lines {
        lines.len() - max_lines
    } else {
        0
    };

    for line in &lines[start..] {
        if !line.is_empty() {
            state
                .app_handle
                .emit(
                    "sessions:external-data",
                    serde_json::json!({ "sessionId": session_id, "line": line }),
                )
                .ok();
        }
    }

    content.len() as u64
}

async fn tail_new_content(
    file_path: &str,
    session_id: &str,
    state: &Arc<AppState>,
    offset: u64,
) -> u64 {
    let metadata = match tokio::fs::metadata(file_path).await {
        Ok(m) => m,
        Err(_) => return offset,
    };

    let size = metadata.len();
    if size <= offset {
        return offset;
    }

    // Read new bytes
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let mut file = match tokio::fs::File::open(file_path).await {
        Ok(f) => f,
        Err(_) => return offset,
    };

    if file
        .seek(std::io::SeekFrom::Start(offset))
        .await
        .is_err()
    {
        return offset;
    }

    let mut buf = Vec::new();
    if file.read_to_end(&mut buf).await.is_err() {
        return offset;
    }

    let new_content = String::from_utf8_lossy(&buf);
    for line in new_content.lines() {
        if !line.is_empty() {
            state
                .app_handle
                .emit(
                    "sessions:external-data",
                    serde_json::json!({ "sessionId": session_id, "line": line }),
                )
                .ok();
        }
    }

    size
}

/// Stop tailing a JSONL session file.
pub fn detach_external_session(session_id: &str, state: &Arc<AppState>) {
    let mut tailers = state.file_tailers.lock().unwrap();
    if let Some(tailer) = tailers.remove(session_id) {
        let _ = tailer.abort.send(());
    }
}
