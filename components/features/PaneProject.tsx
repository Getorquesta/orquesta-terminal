'use client'

/**
 * The pane header's project block: one chip that answers "where is this agent
 * working?" at a glance — repo, branch, worktree, and how much it has changed —
 * with a popover for the full path and the git actions (review, isolate,
 * change folder).
 *
 * Replaces the old separate Folder button + branch chip, which showed only the
 * last path segment and never got a branch under Tauri (nothing emitted it).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Folder, GitBranch, GitFork, FileDiff, FolderOpen, Copy, Check, Trash2, Loader2, ArrowUp, ArrowDown, ChevronDown, AlertTriangle } from 'lucide-react'
import { writeText as clipboardWrite } from '@tauri-apps/plugin-clipboard-manager'
import { changedFiles, gitInfo, type GitInfo, type PaneWorktree } from '@/lib/git'

const POLL_MS = 4000

/** Live git status for a folder; re-polls while the window is visible. */
export function useGitInfo(cwd?: string): { info: GitInfo | null; refresh: () => void } {
  const [info, setInfo] = useState<GitInfo | null>(null)
  const seq = useRef(0)

  const refresh = useCallback(() => {
    if (!cwd) { setInfo(null); return }
    const n = ++seq.current
    gitInfo(cwd).then(
      (i) => { if (n === seq.current) setInfo(i) },
      () => { if (n === seq.current) setInfo(null) },
    )
  }, [cwd])

  useEffect(() => {
    setInfo(null)
    refresh()
    const t = setInterval(() => { if (document.visibilityState === 'visible') refresh() }, POLL_MS)
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => { clearInterval(t); window.removeEventListener('focus', onFocus) }
  }, [refresh])

  return { info, refresh }
}

function shortPath(p: string): string {
  const home = p.match(/^(\/home\/[^/]+|\/Users\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)/)?.[0]
  return home ? '~' + p.slice(home.length) : p
}

interface Props {
  cwd?: string
  info: GitInfo | null
  worktree?: PaneWorktree
  /** A worktree create/remove is in flight. */
  busy?: boolean
  error?: string | null
  onPickFolder: () => void
  onReview: () => void
  onIsolate: () => void
  onRemoveWorktree: () => void
}

export function PaneProjectChip({ cwd, info, worktree, busy, error, onPickFolder, onReview, onIsolate, onRemoveWorktree }: Props) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  const repo = info?.isRepo
  const isWt = !!(worktree || info?.isWorktree)
  // In a worktree the folder is an opaque "pane-1110-…"; the repo name is what
  // the user recognizes. Elsewhere, the folder IS the project.
  const label = !cwd ? 'Folder' : repo ? (info?.repoName || info?.folder) : (info?.folder || cwd.split(/[/\\]/).filter(Boolean).pop() || cwd)
  // A pane opened in a repo's subfolder shows it after the repo name. git
  // prints C:/… on Windows where the picker gave C:\…, so compare normalized.
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const sub = cwd && repo && info?.top && !isWt && norm(cwd).startsWith(norm(info.top) + '/')
    ? cwd.replace(/\\/g, '/').replace(/\/+$/, '').slice(info.top.replace(/\/+$/, '').length + 1)
    : ''
  const branch = info?.branch || (info?.detachedAt ? `@${info.detachedAt}` : null)
  const changes = changedFiles(info)
  const ins = info?.insertions ?? 0
  const del = info?.deletions ?? 0

  const copyPath = async () => {
    if (!cwd) return
    try {
      // WebKitGTK refuses navigator.clipboard outside a user-activation window
      // more often than not; the Tauri plugin always works in the app.
      await clipboardWrite(cwd).catch(() => navigator.clipboard.writeText(cwd))
      setCopied(true); setTimeout(() => setCopied(false), 1200) } catch {}
  }

  return (
    <div ref={rootRef} className="relative flex min-w-0 shrink items-center" onMouseDown={(e) => e.stopPropagation()}>
      <button
        onClick={() => (cwd ? setOpen((o) => !o) : onPickFolder())}
        className={`group flex min-w-0 items-center overflow-hidden rounded border text-[10px] font-mono transition-colors ${
          isWt ? 'border-violet-500/30 bg-violet-500/[0.08] hover:bg-violet-500/15'
            : cwd ? 'border-zinc-700/60 bg-zinc-800/60 hover:bg-zinc-700/70'
            : 'border-transparent bg-zinc-800/70 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
        }`}
        title={cwd ? `${cwd}${branch ? ` — ${branch}` : ''} — click for details` : 'Choose a working folder for this terminal'}
      >
        <span className={`flex min-w-0 items-center gap-1 px-1.5 py-0.5 ${cwd ? 'text-amber-200/90' : ''}`}>
          {isWt ? <GitFork className="h-3 w-3 shrink-0 text-violet-300" /> : <Folder className="h-3 w-3 shrink-0 opacity-80" />}
          <span className="truncate max-w-[9rem]">{label}</span>
          {sub && <span className="truncate max-w-[5rem] text-zinc-500">/{sub}</span>}
        </span>
        {branch && (
          <span className="flex min-w-0 items-center gap-1 border-l border-zinc-700/60 px-1.5 py-0.5 text-emerald-300/90">
            <GitBranch className="h-3 w-3 shrink-0 opacity-80" />
            <span className="truncate max-w-[8rem]">{branch.replace(/^orq\//, '')}</span>
            {(info?.ahead ?? 0) > 0 && <span className="flex items-center text-sky-300"><ArrowUp className="h-2.5 w-2.5" />{info!.ahead}</span>}
            {(info?.behind ?? 0) > 0 && <span className="flex items-center text-orange-300"><ArrowDown className="h-2.5 w-2.5" />{info!.behind}</span>}
          </span>
        )}
        {(info?.conflicts ?? 0) > 0 && (
          <span className="flex items-center gap-0.5 border-l border-zinc-700/60 px-1.5 py-0.5 text-red-400" title={`${info!.conflicts} conflicted`}>
            <AlertTriangle className="h-2.5 w-2.5" />{info!.conflicts}
          </span>
        )}
        {busy && <Loader2 className="mx-1 h-3 w-3 animate-spin text-zinc-400" />}
        {cwd && <ChevronDown className="mr-1 h-2.5 w-2.5 shrink-0 text-zinc-500 group-hover:text-zinc-300" />}
      </button>

      {/* Change counter doubles as the Review button — the main thing you do
          with a dirty agent pane. */}
      {repo && changes > 0 && (
        <button
          onClick={onReview}
          className="ml-1 flex shrink-0 items-center gap-1 rounded bg-zinc-800/70 px-1.5 py-0.5 text-[10px] font-mono hover:bg-zinc-700"
          title={`${changes} changed file${changes === 1 ? '' : 's'} — review the diff and send notes to the agent`}
        >
          <FileDiff className="h-3 w-3 text-zinc-400" />
          <span className="text-emerald-400">+{ins}</span>
          <span className="text-red-400">−{del}</span>
        </button>
      )}

      {open && cwd && (
        <div className="absolute left-0 top-full z-50 mt-1 w-72 overflow-hidden rounded-md border border-zinc-700 bg-zinc-900/95 text-[11px] shadow-xl backdrop-blur">
          <div className="space-y-1 border-b border-zinc-800 px-3 py-2 font-mono">
            <div className="flex items-center gap-1.5 text-zinc-200">
              {isWt ? <GitFork className="h-3.5 w-3.5 text-violet-300" /> : <Folder className="h-3.5 w-3.5 text-amber-300/80" />}
              <span className="truncate font-semibold">{label}</span>
              {isWt && <span className="rounded bg-violet-500/20 px-1 text-[9px] uppercase tracking-wide text-violet-200">worktree</span>}
            </div>
            <div className="flex items-center gap-1 text-zinc-500">
              <span className="min-w-0 flex-1 truncate" dir="rtl" title={cwd}>{shortPath(cwd)}</span>
              <button onClick={copyPath} className="shrink-0 rounded p-0.5 hover:bg-zinc-800 hover:text-zinc-300" title="Copy path">
                {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
              </button>
            </div>
            {repo ? (
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-zinc-400">
                {branch && <span className="text-emerald-300/90">⎇ {branch}</span>}
                {worktree && <span>from <span className="text-zinc-300">{worktree.base}</span></span>}
                <span>{changes ? `${changes} changed` : 'clean'}</span>
                {(info?.staged ?? 0) > 0 && <span>{info!.staged} staged</span>}
                {(info?.untracked ?? 0) > 0 && <span>{info!.untracked} new</span>}
              </div>
            ) : info ? (
              <div className="text-zinc-500">Not a git repository</div>
            ) : null}
            {isWt && info?.root && <div className="truncate text-zinc-600" title={info.root}>main: {shortPath(info.root)}</div>}
            {error && <div className="rounded bg-red-500/10 px-1.5 py-1 font-sans text-red-300">{error}</div>}
          </div>
          <div className="py-1">
            {repo && (
              <MenuItem icon={<FileDiff className="h-3.5 w-3.5" />} onClick={() => { setOpen(false); onReview() }}
                label="Review changes" hint={worktree ? `vs ${worktree.base}` : 'vs HEAD'} />
            )}
            {repo && !isWt && (
              <MenuItem icon={<GitFork className="h-3.5 w-3.5 text-violet-300" />} onClick={() => { setOpen(false); onIsolate() }}
                disabled={busy} label="Isolate in a new worktree" hint="own branch · restarts the session" />
            )}
            <MenuItem icon={<FolderOpen className="h-3.5 w-3.5" />} onClick={() => { setOpen(false); onPickFolder() }}
              label="Change folder…" hint="restarts the session" />
            {worktree && (
              <MenuItem icon={<Trash2 className="h-3.5 w-3.5 text-red-400" />} onClick={() => { setOpen(false); onRemoveWorktree() }}
                disabled={busy} label="Remove worktree" hint={`keeps branch ${worktree.branch}`} danger />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function MenuItem({ icon, label, hint, onClick, disabled, danger }: {
  icon: React.ReactNode; label: string; hint?: string; onClick: () => void; disabled?: boolean; danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-800 disabled:opacity-40 ${danger ? 'text-red-300' : 'text-zinc-200'}`}
    >
      <span className="shrink-0 text-zinc-400">{icon}</span>
      <span className="flex-1">{label}</span>
      {hint && <span className="truncate text-[10px] text-zinc-500">{hint}</span>}
    </button>
  )
}
