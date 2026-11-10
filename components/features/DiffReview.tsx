'use client'

/**
 * Review an agent's changes inside its pane: the working tree's diff against
 * the pane's base (HEAD, or the branch its worktree was cut from), notes pinned
 * to exact lines, and one button that pastes them into the agent as a single
 * prompt — left for the user to send with Enter, like every other seed.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X, RefreshCw, MessageSquarePlus, Send, Trash2, FileDiff, ChevronRight, AlertTriangle, Loader2, GitFork } from 'lucide-react'
import { gitDiff, notesToPrompt, parseUnifiedDiff, type DiffFile, type DiffLine, type ReviewNote } from '@/lib/git'

interface Props {
  cwd: string
  /** Diff base; undefined = HEAD (uncommitted changes only). */
  base?: string
  /** Label for the base in the header, e.g. "main" or "HEAD". */
  baseLabel?: string
  /** Persisted per pane by the caller so closing the panel keeps drafts. */
  notes: ReviewNote[]
  onNotesChange: (notes: ReviewNote[]) => void
  onSend: (prompt: string) => void
  onClose: () => void
}

const lineKey = (path: string, l: DiffLine) =>
  l.kind === 'del' ? `${path}|old|${l.oldNo}` : `${path}|new|${l.newNo}`

export function DiffReview({ cwd, base, baseLabel, notes, onNotesChange, onSend, onClose }: Props) {
  const [files, setFiles] = useState<DiffFile[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [composer, setComposer] = useState<{ key: string } | null>(null)
  const [general, setGeneral] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await gitDiff(cwd, base)
      setFiles(parseUnifiedDiff(res.diff))
      setTruncated(res.truncated)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setFiles([])
    } finally {
      setLoading(false)
    }
  }, [cwd, base])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !composer) { e.stopPropagation(); onClose() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [composer, onClose])

  const notesByKey = useMemo(() => {
    const m = new Map<string, ReviewNote[]>()
    for (const n of notes) {
      const k = `${n.path}|${n.side}|${n.line}`
      m.set(k, [...(m.get(k) ?? []), n])
    }
    return m
  }, [notes])

  const totals = useMemo(() => {
    const f = files ?? []
    return {
      files: f.length,
      add: f.reduce((s, x) => s + x.additions, 0),
      del: f.reduce((s, x) => s + x.deletions, 0),
    }
  }, [files])

  const saveNote = (path: string, l: DiffLine, text: string) => {
    if (!text.trim()) { setComposer(null); return }
    const side = l.kind === 'del' ? 'old' : 'new'
    const line = (side === 'old' ? l.oldNo : l.newNo) ?? 0
    onNotesChange([...notes, { id: Math.random().toString(36).slice(2, 10), path, line, side, code: l.text, text: text.trim() }])
    setComposer(null)
  }

  const removeNote = (id: string) => onNotesChange(notes.filter((n) => n.id !== id))

  const send = () => {
    if (!notes.length && !general.trim()) return
    onSend(notesToPrompt(notes, general))
    onNotesChange([])
    setGeneral('')
    onClose()
  }

  const jumpTo = (path: string) => {
    const el = scrollRef.current?.querySelector(`[data-file="${CSS.escape(path)}"]`)
    el?.scrollIntoView({ block: 'start' })
  }

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path); else next.add(path)
      return next
    })

  return (
    <div
      className="@container absolute inset-0 z-30 flex flex-col bg-[#0a0c10]/97 text-zinc-300 backdrop-blur"
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800 px-3 py-1.5 text-[11px] font-mono">
        <FileDiff className="h-3.5 w-3.5 text-emerald-400" />
        <span className="text-zinc-200">Review</span>
        <span className="text-zinc-500">vs</span>
        <span className="flex items-center gap-1 rounded bg-zinc-800/80 px-1.5 py-0.5 text-zinc-300">
          {base && <GitFork className="h-3 w-3 text-violet-300" />}
          {baseLabel || base || 'HEAD'}
        </span>
        {files && (
          <span className="text-zinc-500">
            {totals.files} file{totals.files === 1 ? '' : 's'}
            <span className="ml-1.5 text-emerald-400">+{totals.add}</span>
            <span className="ml-1 text-red-400">−{totals.del}</span>
          </span>
        )}
        {truncated && (
          <span className="flex items-center gap-1 text-amber-400" title="The diff was too large and was cut">
            <AlertTriangle className="h-3 w-3" /> truncated
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button onClick={load} className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" title="Refresh diff">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </button>
          <button onClick={onClose} className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" title="Close (Esc)">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* File list — only when the pane is wide enough to afford it. */}
        {files && files.length > 1 && (
          <div className="hidden w-52 shrink-0 overflow-y-auto border-r border-zinc-800/80 py-1 @2xl:block">
            {files.map((f) => {
              const n = notes.filter((x) => x.path === f.path).length
              return (
                <button
                  key={f.path}
                  onClick={() => jumpTo(f.path)}
                  className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] font-mono hover:bg-zinc-800/70"
                  title={f.path}
                >
                  <StatusDot status={f.status} />
                  <span className="min-w-0 flex-1 truncate" dir="rtl">{f.path}</span>
                  {n > 0 && <span className="rounded bg-amber-500/20 px-1 text-[10px] text-amber-300">{n}</span>}
                </button>
              )
            })}
          </div>
        )}

        {/* Diff body */}
        <div ref={scrollRef} className="min-w-0 flex-1 overflow-auto">
          {error && <div className="m-3 rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300">{error}</div>}
          {files && files.length === 0 && !error && (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-xs text-zinc-500">
              <FileDiff className="h-6 w-6 text-zinc-700" />
              No changes vs {baseLabel || 'HEAD'}
            </div>
          )}
          {!files && !error && (
            <div className="flex h-full items-center justify-center text-xs text-zinc-500">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading diff…
            </div>
          )}
          {files?.map((f) => (
            <div key={f.path} data-file={f.path} className="border-b border-zinc-800/60">
              <button
                onClick={() => toggle(f.path)}
                className="sticky top-0 z-10 flex w-full items-center gap-2 bg-zinc-900/95 px-3 py-1 text-left text-[11px] font-mono hover:bg-zinc-800"
              >
                <ChevronRight className={`h-3 w-3 shrink-0 text-zinc-500 transition-transform ${collapsed.has(f.path) ? '' : 'rotate-90'}`} />
                <StatusDot status={f.status} />
                <span className="min-w-0 truncate text-zinc-200">
                  {f.status === 'renamed' && f.oldPath ? <><span className="text-zinc-500">{f.oldPath} → </span>{f.path}</> : f.path}
                </span>
                <span className="ml-auto shrink-0 text-emerald-400">+{f.additions}</span>
                <span className="shrink-0 text-red-400">−{f.deletions}</span>
              </button>
              {!collapsed.has(f.path) && (
                f.status === 'binary' ? (
                  <div className="px-4 py-2 text-[11px] text-zinc-500">Binary file changed</div>
                ) : (
                  <table className="w-full border-collapse font-mono text-[11.5px] leading-[1.45]">
                    <tbody>
                      {f.hunks.map((h, hi) => (
                        <HunkRows
                          key={hi}
                          file={f}
                          hunkHeader={h.header}
                          lines={h.lines}
                          notesByKey={notesByKey}
                          composer={composer}
                          setComposer={setComposer}
                          onSave={saveNote}
                          onRemove={removeNote}
                        />
                      ))}
                    </tbody>
                  </table>
                )
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Footer: general note + send */}
      <div className="flex shrink-0 items-end gap-2 border-t border-zinc-800 px-3 py-2">
        <textarea
          value={general}
          onChange={(e) => setGeneral(e.target.value)}
          rows={1}
          placeholder="General feedback (optional) — click a line's + to pin a note"
          className="min-h-[28px] flex-1 resize-y rounded bg-zinc-900 px-2 py-1 text-xs text-zinc-200 outline-none ring-1 ring-zinc-800 placeholder:text-zinc-600 focus:ring-emerald-600/50"
        />
        {notes.length > 0 && (
          <button
            onClick={() => onNotesChange([])}
            className="flex h-7 items-center gap-1 rounded px-2 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
            title="Discard all notes"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
        <button
          onClick={send}
          disabled={!notes.length && !general.trim()}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded bg-emerald-600 px-3 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
          title="Paste the notes into the agent as one prompt (press Enter in the terminal to send)"
        >
          <Send className="h-3 w-3" />
          Send {notes.length > 0 ? `${notes.length} note${notes.length === 1 ? '' : 's'}` : ''} to agent
        </button>
      </div>
    </div>
  )
}

function StatusDot({ status }: { status: DiffFile['status'] }) {
  const map: Record<DiffFile['status'], [string, string]> = {
    added: ['A', 'text-emerald-400'],
    deleted: ['D', 'text-red-400'],
    renamed: ['R', 'text-violet-300'],
    modified: ['M', 'text-amber-300'],
    binary: ['B', 'text-zinc-400'],
  }
  const [ch, cls] = map[status]
  return <span className={`w-3 shrink-0 text-center text-[10px] font-bold ${cls}`}>{ch}</span>
}

function HunkRows({
  file, hunkHeader, lines, notesByKey, composer, setComposer, onSave, onRemove,
}: {
  file: DiffFile
  hunkHeader: string
  lines: DiffLine[]
  notesByKey: Map<string, ReviewNote[]>
  composer: { key: string } | null
  setComposer: (c: { key: string } | null) => void
  onSave: (path: string, l: DiffLine, text: string) => void
  onRemove: (id: string) => void
}) {
  return (
    <>
      <tr>
        <td colSpan={4} className="bg-cyan-500/[0.06] px-3 py-0.5 text-[10.5px] text-cyan-300/70">{hunkHeader}</td>
      </tr>
      {lines.map((l, i) => {
        const key = lineKey(file.path, l)
        const pinned = notesByKey.get(key) ?? []
        const open = composer?.key === key
        const bg = l.kind === 'add' ? 'bg-emerald-500/[0.09]' : l.kind === 'del' ? 'bg-red-500/[0.09]' : ''
        return (
          <Fragment key={i}>
            <tr className={`group ${bg}`}>
              <td className="w-10 select-none px-1 text-right align-top text-zinc-600">{l.oldNo ?? ''}</td>
              <td className="w-10 select-none px-1 text-right align-top text-zinc-600">{l.newNo ?? ''}</td>
              <td className="relative w-5 select-none align-top">
                <button
                  onClick={() => setComposer(open ? null : { key })}
                  className="absolute left-0 top-0 hidden h-[1.45em] w-5 items-center justify-center rounded bg-emerald-600 text-white group-hover:flex"
                  title="Add a note on this line"
                >
                  <MessageSquarePlus className="h-3 w-3" />
                </button>
                <span className={`block text-center ${l.kind === 'add' ? 'text-emerald-400' : l.kind === 'del' ? 'text-red-400' : 'text-zinc-700'}`}>
                  {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}
                </span>
              </td>
              <td className="whitespace-pre pr-4 text-zinc-300">{l.text || ' '}</td>
            </tr>
            {pinned.map((n) => (
              <tr key={n.id}>
                <td colSpan={3} />
                <td className="py-1 pr-4">
                  <div className="flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 font-sans text-xs text-amber-100">
                    <span className="min-w-0 flex-1 whitespace-pre-wrap">{n.text}</span>
                    <button onClick={() => onRemove(n.id)} className="shrink-0 text-amber-300/60 hover:text-amber-200" title="Remove note">
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {open && (
              <tr>
                <td colSpan={3} />
                <td className="py-1 pr-4">
                  <NoteComposer
                    onCancel={() => setComposer(null)}
                    onSave={(text) => onSave(file.path, l, text)}
                  />
                </td>
              </tr>
            )}
          </Fragment>
        )
      })}
    </>
  )
}

function NoteComposer({ onSave, onCancel }: { onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState('')
  return (
    <div className="rounded border border-emerald-600/40 bg-zinc-900 p-1.5 font-sans">
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSave(text) }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel() }
        }}
        rows={2}
        placeholder="What should the agent change here?"
        className="w-full resize-y bg-transparent text-xs text-zinc-100 outline-none placeholder:text-zinc-600"
      />
      <div className="flex items-center justify-end gap-1.5">
        <span className="mr-auto text-[10px] text-zinc-600">Ctrl+Enter to save</span>
        <button onClick={onCancel} className="rounded px-2 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-800">Cancel</button>
        <button
          onClick={() => onSave(text)}
          disabled={!text.trim()}
          className="rounded bg-emerald-600 px-2 py-0.5 text-[11px] text-white hover:bg-emerald-500 disabled:bg-zinc-800 disabled:text-zinc-500"
        >
          Add note
        </button>
      </div>
    </div>
  )
}
