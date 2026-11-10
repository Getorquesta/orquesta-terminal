//! Git plumbing for panes: repo status for the header, one worktree per pane so
//! parallel agents never edit the same checkout, and the diff the review panel
//! annotates.
//!
//! Everything shells out to the user's own `git` — no libgit2 — so worktrees,
//! hooks, and config behave exactly as they do in their terminal.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tokio::process::Command;

/// Biggest diff handed to the webview. A lockfile regen can produce tens of MB;
/// the panel only needs enough to review, and says so when it was cut.
const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;
/// Untracked files rendered as "new file" hunks, at most.
const MAX_UNTRACKED_FILES: usize = 200;

struct Out {
    ok: bool,
    code: i32,
    stdout: String,
    stderr: String,
}

async fn git(cwd: &Path, args: &[&str]) -> Result<Out, String> {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(cwd)
        .envs(crate::pty::spawn_env())
        // Never block on a credential or editor prompt: there is no TTY here.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: don't flash a console for every status poll.
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("git not available: {e}"))?;
    Ok(Out {
        ok: out.status.success(),
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
    })
}

async fn git_ok(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let o = git(cwd, args).await?;
    if o.ok {
        Ok(o.stdout.trim_end().to_string())
    } else {
        Err(if o.stderr.is_empty() { format!("git {} failed", args.join(" ")) } else { o.stderr })
    }
}

fn dir_of(cwd: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(cwd);
    if !p.is_dir() {
        return Err(format!("Not a directory: {cwd}"));
    }
    Ok(p)
}

fn base_name(p: &str) -> String {
    Path::new(p.trim_end_matches(['/', '\\']))
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Lowercase, `[a-z0-9-]`, no leading/trailing dashes, max 40 chars.
fn slug(s: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
        if out.len() >= 40 {
            break;
        }
    }
    out.trim_matches('-').to_string()
}

/// The main checkout's root, even when `cwd` is inside a linked worktree.
async fn main_root(cwd: &Path) -> Result<PathBuf, String> {
    let common = git_ok(cwd, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).await?;
    let common = PathBuf::from(common);
    // `<root>/.git` for a normal repo; a bare repo has no work tree to return.
    Ok(common.parent().map(Path::to_path_buf).unwrap_or(common))
}

/// Header status for a pane's folder. Never errors for "not a repo" — that is a
/// normal answer (`isRepo: false`) the header renders as a plain folder.
pub async fn info(cwd: &str) -> Result<Value, String> {
    let dir = dir_of(cwd)?;
    let top = match git(&dir, &["rev-parse", "--show-toplevel"]).await? {
        o if o.ok => o.stdout.trim().to_string(),
        _ => return Ok(json!({ "isRepo": false, "folder": base_name(cwd) })),
    };
    let root = main_root(&dir).await.unwrap_or_else(|_| PathBuf::from(&top));
    let root_s = root.to_string_lossy().to_string();
    let is_worktree = Path::new(&top) != root.as_path();

    // One porcelain v2 call gives branch, upstream counts and every change.
    let st = git(&dir, &["status", "--porcelain=v2", "--branch", "--untracked-files=normal"]).await?;
    let mut branch: Option<String> = None;
    let mut detached_at: Option<String> = None;
    let (mut ahead, mut behind) = (0i64, 0i64);
    let (mut staged, mut modified, mut untracked, mut conflicts) = (0u32, 0u32, 0u32, 0u32);
    for line in st.stdout.lines() {
        if let Some(h) = line.strip_prefix("# branch.head ") {
            if h != "(detached)" {
                branch = Some(h.to_string());
            }
        } else if let Some(h) = line.strip_prefix("# branch.oid ") {
            detached_at = Some(h.chars().take(7).collect());
        } else if let Some(ab) = line.strip_prefix("# branch.ab ") {
            for part in ab.split_whitespace() {
                if let Some(n) = part.strip_prefix('+') { ahead = n.parse().unwrap_or(0); }
                if let Some(n) = part.strip_prefix('-') { behind = n.parse().unwrap_or(0); }
            }
        } else if line.starts_with("? ") {
            untracked += 1;
        } else if line.starts_with("u ") {
            conflicts += 1;
        } else if line.starts_with("1 ") || line.starts_with("2 ") {
            let xy: Vec<char> = line[2..4].chars().collect();
            if xy[0] != '.' { staged += 1; }
            if xy[1] != '.' { modified += 1; }
        }
    }

    // Line totals vs HEAD (staged + unstaged). Cheap; skipped on an empty repo.
    let (mut ins, mut del) = (0u64, 0u64);
    if let Ok(o) = git(&dir, &["diff", "HEAD", "--numstat"]).await {
        for l in o.stdout.lines() {
            let mut it = l.split('\t');
            ins += it.next().and_then(|n| n.parse().ok()).unwrap_or(0);
            del += it.next().and_then(|n| n.parse().ok()).unwrap_or(0);
        }
    }

    let remote = git(&dir, &["remote", "get-url", "origin"]).await.ok()
        .filter(|o| o.ok).map(|o| o.stdout.trim().to_string());

    Ok(json!({
        "isRepo": true,
        "folder": base_name(cwd),
        "top": top,
        "root": root_s,
        "repoName": base_name(&root_s),
        "isWorktree": is_worktree,
        "branch": branch,
        "detachedAt": if branch.is_none() { detached_at } else { None },
        "ahead": ahead,
        "behind": behind,
        "staged": staged,
        "modified": modified,
        "untracked": untracked,
        "conflicts": conflicts,
        "insertions": ins,
        "deletions": del,
        "remote": remote,
    }))
}

/// Create a linked worktree for a pane on a fresh branch off the current HEAD.
///
/// Lives under `~/.orquesta/worktrees/<repo>/<slug>` — outside the repo so build
/// tools and watchers in the main checkout never see it, and outside /tmp so it
/// survives a reboot.
pub async fn worktree_create(cwd: &str, name: Option<String>) -> Result<Value, String> {
    let dir = dir_of(cwd)?;
    let root = main_root(&dir).await.map_err(|_| "This folder is not a git repository".to_string())?;
    let repo = slug(&base_name(&root.to_string_lossy()));
    let base_branch = git_ok(&dir, &["rev-parse", "--abbrev-ref", "HEAD"]).await.unwrap_or_default();
    let base_commit = git_ok(&dir, &["rev-parse", "HEAD"]).await
        .map_err(|_| "The repository has no commits yet — commit once before isolating a pane".to_string())?;

    let stamp = chrono::Local::now().format("%m%d-%H%M%S").to_string();
    let wanted = name.as_deref().map(slug).filter(|s| !s.is_empty());
    let leaf = match wanted {
        Some(s) => format!("{s}-{}", &stamp[stamp.len() - 4..]),
        None => format!("pane-{stamp}"),
    };
    let parent = dirs::home_dir()
        .ok_or("No home directory")?
        .join(".orquesta")
        .join("worktrees")
        .join(if repo.is_empty() { "repo".into() } else { repo });
    std::fs::create_dir_all(&parent).map_err(|e| format!("Cannot create {}: {e}", parent.display()))?;
    let path = parent.join(&leaf);
    let branch = format!("orq/{leaf}");
    let path_s = path.to_string_lossy().to_string();

    git_ok(&dir, &["worktree", "add", "-b", &branch, &path_s, &base_commit]).await?;

    Ok(json!({
        "ok": true,
        "path": path_s,
        "branch": branch,
        "base": if base_branch.is_empty() || base_branch == "HEAD" { base_commit.clone() } else { base_branch },
        "baseCommit": base_commit,
        "root": root.to_string_lossy(),
    }))
}

/// Remove a pane's worktree. Refuses (unless `force`) when it holds uncommitted
/// work, so closing a pane can't silently throw an agent's changes away. The
/// branch is kept: its commits stay reachable for merging later.
pub async fn worktree_remove(path: &str, force: bool) -> Result<Value, String> {
    let dir = dir_of(path)?;
    let root = main_root(&dir).await?;
    if root.as_path() == dir.as_path() {
        return Err("Refusing to remove the main checkout".into());
    }
    if !force {
        let dirty = git_ok(&dir, &["status", "--porcelain"]).await?;
        if !dirty.trim().is_empty() {
            return Ok(json!({ "ok": false, "dirty": true, "error": "Worktree has uncommitted changes" }));
        }
    }
    let mut args = vec!["worktree", "remove"];
    if force { args.push("--force"); }
    args.push(path);
    git_ok(&root, &args).await?;
    Ok(json!({ "ok": true }))
}

/// Unified diff of the working tree against `base` (a ref or commit; default
/// HEAD), untracked files included as new-file hunks. With a base branch, the
/// merge-base is used so the panel shows only what this pane's agent changed.
pub async fn diff(cwd: &str, base: Option<String>) -> Result<Value, String> {
    let dir = dir_of(cwd)?;
    let target = match base.as_deref().filter(|b| !b.is_empty()) {
        Some(b) => git_ok(&dir, &["merge-base", "HEAD", b]).await.unwrap_or_else(|_| b.to_string()),
        None => "HEAD".to_string(),
    };
    let tracked = git(&dir, &["diff", "--no-color", "--no-ext-diff", "-U3", &target, "--"]).await?;
    if !tracked.ok {
        // Empty repo: no HEAD. Fall back to the index-vs-worktree diff.
        if tracked.stderr.contains("unknown revision") || tracked.stderr.contains("bad revision") {
            return Ok(json!({ "ok": true, "diff": "", "base": target, "truncated": false }));
        }
        return Err(tracked.stderr);
    }
    let mut text = tracked.stdout;
    let mut truncated = false;

    let others = git_ok(&dir, &["ls-files", "--others", "--exclude-standard", "-z"]).await.unwrap_or_default();
    let null_dev = if cfg!(windows) { "NUL" } else { "/dev/null" };
    for (i, file) in others.split('\0').filter(|f| !f.is_empty()).enumerate() {
        if i >= MAX_UNTRACKED_FILES || text.len() > MAX_DIFF_BYTES {
            truncated = true;
            break;
        }
        // --no-index exits 1 when the files differ, which they always do here.
        if let Ok(o) = git(&dir, &["diff", "--no-color", "--no-index", "--", null_dev, file]).await {
            if o.code == 0 || o.code == 1 {
                text.push_str(&o.stdout);
            }
        }
    }
    if text.len() > MAX_DIFF_BYTES {
        let mut cut = MAX_DIFF_BYTES;
        while !text.is_char_boundary(cut) { cut -= 1; }
        text.truncate(cut);
        truncated = true;
    }
    Ok(json!({ "ok": true, "diff": text, "base": target, "truncated": truncated }))
}
