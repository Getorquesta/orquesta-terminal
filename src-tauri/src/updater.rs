//! Startup update check.
//!
//! The app installs updates itself through `tauri-plugin-updater`: it reads the
//! `latest.json` published with each release, downloads the installer for this
//! platform, verifies its minisign signature and restarts. What lives here is
//! the fallback for builds the updater cannot replace — a `.deb`/`.rpm` install
//! owns its files through the package manager, so there we only *report* the
//! new version and send the user to the release page.
//!
//! `check_for_update` asks GitHub for the latest *published* release and
//! compares its tag with the running build. Drafts and pre-releases are
//! invisible to `/releases/latest`, so a tag that CI has built but nobody
//! published yet never nags anyone.

use serde::{Deserialize, Serialize};
use std::time::Duration;

const RELEASES_API: &str =
    "https://api.github.com/repos/Getorquesta/orquesta-terminal/releases/latest";
const RELEASES_PAGE: &str = "https://github.com/Getorquesta/orquesta-terminal/releases/latest";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub update_available: bool,
    pub current: String,
    /// Tag of the newest published release, without the leading `v`.
    pub latest: Option<String>,
    /// Where the user downloads it — the release page, never a raw asset.
    pub url: String,
    pub notes: Option<String>,
    pub published_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: Option<String>,
    html_url: Option<String>,
    body: Option<String>,
    published_at: Option<String>,
}

/// `v0.1.21-beta.2` → `[0, 1, 21]`. The pre-release / build suffix is dropped
/// whole — otherwise its own dots would show up as extra version components.
fn parse_version(raw: &str) -> Vec<u64> {
    let core = raw.trim().trim_start_matches(['v', 'V']);
    let core = core.split(['-', '+']).next().unwrap_or(core);
    core.split('.')
        .map(|part| {
            let digits: String = part.chars().take_while(|c| c.is_ascii_digit()).collect();
            digits.parse::<u64>().unwrap_or(0)
        })
        .collect()
}

fn is_newer(latest: &str, current: &str) -> bool {
    let (a, b) = (parse_version(latest), parse_version(current));
    let len = a.len().max(b.len());
    for i in 0..len {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

/// Whether this build can replace itself in place.
///
/// On Linux the updater rewrites the running AppImage, so a `.deb`/`.rpm`
/// install — no `APPIMAGE` in the environment — has to go through apt/dnf or a
/// fresh download instead. Windows (NSIS) and macOS (.app) always can.
#[tauri::command]
pub fn can_self_update() -> bool {
    if cfg!(target_os = "linux") {
        std::env::var_os("APPIMAGE").is_some()
    } else {
        true
    }
}

#[tauri::command]
pub async fn check_for_update() -> Result<UpdateInfo, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let resp = client
        .get(RELEASES_API)
        // GitHub rejects requests without a User-Agent.
        .header("User-Agent", format!("orquesta-terminal/{current}"))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("update check failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("update check failed: HTTP {}", resp.status()));
    }

    let release: GithubRelease = resp
        .json()
        .await
        .map_err(|e| format!("update check failed: {e}"))?;

    let latest = release
        .tag_name
        .map(|t| t.trim().trim_start_matches(['v', 'V']).to_string())
        .filter(|t| !t.is_empty());

    let update_available = latest
        .as_deref()
        .map(|l| is_newer(l, &current))
        .unwrap_or(false);

    Ok(UpdateInfo {
        update_available,
        current,
        latest,
        url: release
            .html_url
            .filter(|u| u.starts_with("https://"))
            .unwrap_or_else(|| RELEASES_PAGE.to_string()),
        notes: release.body.filter(|b| !b.trim().is_empty()),
        published_at: release.published_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tags_with_and_without_prefix() {
        assert_eq!(parse_version("v0.1.21"), vec![0, 1, 21]);
        assert_eq!(parse_version("0.1.21"), vec![0, 1, 21]);
        assert_eq!(parse_version("v1.0.0-beta.3"), vec![1, 0, 0]);
    }

    #[test]
    fn compares_versions() {
        assert!(is_newer("0.1.21", "0.1.20"));
        assert!(is_newer("0.2.0", "0.1.99"));
        assert!(is_newer("1.0", "0.9.9"));
        assert!(!is_newer("0.1.20", "0.1.20"));
        assert!(!is_newer("0.1.19", "0.1.20"));
        // A pre-release of the version we already run is not an upgrade.
        assert!(!is_newer("0.1.20-rc.1", "0.1.20"));
    }
}
