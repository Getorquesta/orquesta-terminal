use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Serialize, Deserialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    #[serde(rename = "isDir")]
    pub is_dir: bool,
}

/// List entries in a directory. Returns home dir if path is None.
pub async fn list_dir(path: Option<String>) -> Result<Value, String> {
    let home = dirs::home_dir()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let target = path.unwrap_or_else(|| home.clone());
    let target_path = std::path::Path::new(&target);

    if !target_path.exists() {
        return Err(format!("Path does not exist: {target}"));
    }

    let parent = target_path
        .parent()
        .map(|p| p.to_string_lossy().to_string());

    let mut entries: Vec<DirEntry> = Vec::new();

    let mut read_dir = tokio::fs::read_dir(&target)
        .await
        .map_err(|e| e.to_string())?;

    while let Ok(Some(entry)) = read_dir.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue; // skip hidden files
        }
        let path = entry.path().to_string_lossy().to_string();
        let is_dir = entry
            .file_type()
            .await
            .map(|t| t.is_dir())
            .unwrap_or(false);

        entries.push(DirEntry { name, path, is_dir });
    }

    entries.sort_by(|a, b| {
        // Directories first, then alphabetical
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(json!({
        "ok": true,
        "path": target,
        "parent": parent,
        "home": home,
        "entries": entries,
    }))
}
