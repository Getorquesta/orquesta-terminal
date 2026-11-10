/**
 * Git for panes — thin wrappers over the Rust `git_*` commands (src-tauri/src/
 * git.rs) plus a unified-diff parser for the review panel.
 *
 * Outside Tauri (browser preview) every call rejects; callers treat that the
 * same as "not a repo".
 */
import { invoke } from '@tauri-apps/api/core'

export interface GitInfo {
  isRepo: boolean
  folder: string
  top?: string
  /** Main checkout root — equals `top` unless this folder is a linked worktree. */
  root?: string
  repoName?: string
  isWorktree?: boolean
  branch?: string | null
  detachedAt?: string | null
  ahead?: number
  behind?: number
  staged?: number
  modified?: number
  untracked?: number
  conflicts?: number
  insertions?: number
  deletions?: number
  remote?: string | null
}

/** A pane isolated in its own worktree (persisted with the pane). */
export interface PaneWorktree {
  path: string
  branch: string
  /** Branch (or commit) the worktree was cut from — the review diff's base. */
  base: string
  baseCommit: string
  root: string
}

const hasTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

function call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  if (!hasTauri()) return Promise.reject(new Error('git: no Tauri backend'))
  return invoke<T>(cmd, args)
}

export const gitInfo = (cwd: string) => call<GitInfo>('git_info', { cwd })

export const gitWorktreeCreate = (cwd: string, name?: string) =>
  call<PaneWorktree & { ok: true }>('git_worktree_create', { cwd, name })

export const gitWorktreeRemove = (path: string, force = false) =>
  call<{ ok: boolean; dirty?: boolean; error?: string }>('git_worktree_remove', { path, force })

export const gitDiff = (cwd: string, base?: string) =>
  call<{ ok: boolean; diff: string; base: string; truncated: boolean }>('git_diff', { cwd, base })

/** Files changed in any way (staged, unstaged, untracked, conflicted). */
export function changedFiles(i: GitInfo | null | undefined): number {
  if (!i?.isRepo) return 0
  return (i.staged ?? 0) + (i.modified ?? 0) + (i.untracked ?? 0) + (i.conflicts ?? 0)
}

// ── Unified diff parsing ─────────────────────────────────────────────────────

export type DiffLineKind = 'add' | 'del' | 'ctx'

export interface DiffLine {
  kind: DiffLineKind
  text: string
  /** Line number on the old side (del/ctx). */
  oldNo?: number
  /** Line number on the new side (add/ctx). */
  newNo?: number
}

export interface DiffHunk {
  header: string
  lines: DiffLine[]
}

export interface DiffFile {
  path: string
  oldPath?: string
  status: 'added' | 'deleted' | 'renamed' | 'modified' | 'binary'
  hunks: DiffHunk[]
  additions: number
  deletions: number
}

function unquote(p: string): string {
  // git C-quotes paths with unusual characters: "a/caf\303\251.txt"
  if (!p.startsWith('"')) return p
  try {
    const bytes: number[] = []
    const s = p.slice(1, -1)
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\' && /[0-7]{3}/.test(s.slice(i + 1, i + 4))) {
        bytes.push(parseInt(s.slice(i + 1, i + 4), 8)); i += 3
      } else if (s[i] === '\\' && i + 1 < s.length) {
        const m: Record<string, string> = { n: '\n', t: '\t', '"': '"', '\\': '\\' }
        bytes.push(...new TextEncoder().encode(m[s[i + 1]] ?? s[i + 1])); i += 1
      } else {
        bytes.push(...new TextEncoder().encode(s[i]))
      }
    }
    return new TextDecoder().decode(new Uint8Array(bytes))
  } catch {
    return p.slice(1, -1)
  }
}

const stripSide = (p: string) => unquote(p).replace(/^[ab]\//, '')

export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | null = null
  let hunk: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0

  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      // Path comes from the +++/--- lines when present; this is the fallback
      // (binary files and pure renames have neither).
      const m = raw.match(/^diff --git (?:"?a\/)?(.+?)"? (?:"?b\/)(.+?)"?$/)
      file = { path: m ? m[2] : raw.slice(11), status: 'modified', hunks: [], additions: 0, deletions: 0 }
      files.push(file)
      hunk = null
      continue
    }
    if (!file) continue
    if (!hunk) {
      if (raw.startsWith('new file mode')) file.status = 'added'
      else if (raw.startsWith('deleted file mode')) file.status = 'deleted'
      else if (raw.startsWith('rename from ')) { file.status = 'renamed'; file.oldPath = unquote(raw.slice(12)) }
      else if (raw.startsWith('rename to ')) file.path = unquote(raw.slice(10))
      else if (raw.startsWith('Binary files')) file.status = 'binary'
      else if (raw.startsWith('--- ')) {
        const p = raw.slice(4)
        if (p !== '/dev/null' && p !== 'NUL' && !file.oldPath) file.oldPath = stripSide(p)
      } else if (raw.startsWith('+++ ')) {
        const p = raw.slice(4)
        if (p !== '/dev/null' && p !== 'NUL') file.path = stripSide(p)
      }
    }
    const h = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/)
    if (h) {
      oldNo = parseInt(h[1], 10)
      newNo = parseInt(h[2], 10)
      hunk = { header: raw, lines: [] }
      file.hunks.push(hunk)
      continue
    }
    if (!hunk) continue
    const c = raw[0]
    if (c === '+') { hunk.lines.push({ kind: 'add', text: raw.slice(1), newNo: newNo++ }); file.additions++ }
    else if (c === '-') { hunk.lines.push({ kind: 'del', text: raw.slice(1), oldNo: oldNo++ }); file.deletions++ }
    else if (c === ' ') hunk.lines.push({ kind: 'ctx', text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ })
    // "\ No newline at end of file" and blank trailing lines are skipped.
  }
  return files
}

// ── Review notes → agent prompt ──────────────────────────────────────────────

export interface ReviewNote {
  id: string
  path: string
  /** New-side line when present (what the agent sees in the file now). */
  line: number
  side: 'new' | 'old'
  /** The code on that line, for context. */
  code: string
  text: string
}

export function notesToPrompt(notes: ReviewNote[], general?: string): string {
  const parts: string[] = ['Review of your current changes. Address each note, then summarize what you changed.', '']
  const sorted = [...notes].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
  sorted.forEach((n, i) => {
    const where = n.side === 'old' ? `${n.path} (removed line ${n.line})` : `${n.path}:${n.line}`
    const code = n.code.trim()
    parts.push(`${i + 1}. ${where}${code ? ` — \`${code.length > 120 ? code.slice(0, 117) + '…' : code}\`` : ''}`)
    for (const l of n.text.trim().split('\n')) parts.push(`   ${l}`)
  })
  if (general?.trim()) {
    parts.push('', 'General:', general.trim())
  }
  return parts.join('\n')
}
