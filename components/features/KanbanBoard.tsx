'use client'

/**
 * Kanban mode — the prompt board.
 *
 * Every card IS a prompt. Drag it into Running and it is actually pasted into
 * its terminal and submitted; while the agent works the card pulses; when the
 * agent goes quiet the card lands in Review, which is a human gate — Approve
 * ships it, Rework sends it back round with your feedback appended.
 *
 * All board state is local (see hooks/useKanban.ts). The only thing this needs
 * from the rest of the app is the pane roster and a way to type into a pane.
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import {
  Plus, X, Play, Check, RotateCcw, Trash2, Loader2, CornerDownLeft,
  Terminal as TerminalIcon, Sparkles, ChevronDown, ListPlus, Lightbulb, Pencil,
} from 'lucide-react'
import { COLUMNS, COLUMN_META, type ColumnId, type KanbanCard, type UseKanban } from '@/hooks/useKanban'
import type { PaneInfo } from './AgentGrid'

/** Per-column chrome. Kept as literal class strings so Tailwind can see them. */
const COLUMN_STYLE: Record<ColumnId, { dot: string; text: string; ring: string; over: string }> = {
  backlog: { dot: 'bg-zinc-500', text: 'text-zinc-400', ring: 'border-zinc-800', over: 'border-zinc-500/50 bg-zinc-500/5' },
  queued: { dot: 'bg-amber-400', text: 'text-amber-300', ring: 'border-amber-500/20', over: 'border-amber-500/50 bg-amber-500/5' },
  running: { dot: 'bg-cyan-400 animate-pulse', text: 'text-cyan-300', ring: 'border-cyan-500/20', over: 'border-cyan-500/50 bg-cyan-500/5' },
  review: { dot: 'bg-violet-400', text: 'text-violet-300', ring: 'border-violet-500/20', over: 'border-violet-500/50 bg-violet-500/5' },
  done: { dot: 'bg-emerald-500', text: 'text-emerald-300', ring: 'border-emerald-500/20', over: 'border-emerald-500/50 bg-emerald-500/5' },
}

/**
 * The card currently being dragged. HTML5 DnD only exposes dataTransfer VALUES
 * on drop (dragover sees types but not payloads, and some engines expose
 * neither for custom MIME types), so columns need this to know a drop is even
 * theirs to accept. Module-scoped because only one drag can be in flight.
 */
let draggingCardId: string | null = null

function duration(from: number, to: number): string {
  const s = Math.max(0, Math.floor((to - from) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** Ticking elapsed time for a card that's live right now. */
function LiveClock({ since }: { since: number }) {
  const [, force] = useState(0)
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  return <span className="font-mono tabular-nums">{duration(since, Date.now())}</span>
}

// ── Card ────────────────────────────────────────────────────────────────────

function Card({
  card, panes, board, onToast,
}: {
  card: KanbanCard
  panes: PaneInfo[]
  board: UseKanban
  onToast: (msg: string) => void
}) {
  const [reworking, setReworking] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [assignOpen, setAssignOpen] = useState(false)
  const [outputOpen, setOutputOpen] = useState(false)
  // Editable before it's queued: the agent's wording is a question ("shall I
  // close X or Y?") and what you want to run is the answer.
  const [queueing, setQueueing] = useState(false)
  const [suggestText, setSuggestText] = useState('')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const style = COLUMN_STYLE[card.column]
  const pane = card.paneId ? panes.find((p) => p.id === card.paneId) : undefined
  const long = card.text.length > 150
  // A suggestion arrives in the agent's words ("shall I close Waydroid?"); what
  // you want to send is your answer, so a queued card has to be editable in place.
  const editable = card.column === 'backlog' || card.column === 'queued'

  const startEdit = () => { setDraft(card.text); setEditing(true) }
  const commitEdit = () => {
    const body = draft.trim()
    if (body && body !== card.text) board.update(card.id, { text: body })
    setEditing(false)
  }

  const run = () => {
    const err = board.dispatch(card.id)
    if (err) onToast(err)
  }

  return (
    <div
      draggable={!editing}
      onDragStart={(e) => {
        draggingCardId = card.id
        e.dataTransfer.setData('text/orquesta-card', card.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragEnd={() => { draggingCardId = null }}
      data-testid="kanban-card"
      data-card-id={card.id}
      data-column={card.column}
      className={`group cursor-grab rounded-lg border bg-zinc-900/70 px-2.5 py-2 transition-colors active:cursor-grabbing hover:border-zinc-700 ${
        card.column === 'running' ? 'border-cyan-500/30 shadow-[0_0_18px_-6px_rgba(34,211,238,0.5)]' : 'border-zinc-800'
      }`}
    >
      <div className="flex items-start gap-1.5">
        <span className={`mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`} />
        {editing ? (
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitEdit() }
              if (e.key === 'Escape') { e.stopPropagation(); setEditing(false) }
            }}
            // The card is draggable; without this a text selection starts a drag.
            onDragStart={(e) => e.preventDefault()}
            data-testid="card-edit"
            rows={Math.min(8, Math.max(2, draft.split('\n').length))}
            className="flex-1 resize-none rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1 text-[11px] leading-snug text-zinc-100 outline-none focus:border-cyan-500/40"
          />
        ) : (
          <p
            onClick={() => long && setExpanded((v) => !v)}
            onDoubleClick={() => editable && startEdit()}
            className={`flex-1 whitespace-pre-wrap break-words text-[11px] leading-snug text-zinc-200 ${
              expanded ? '' : 'line-clamp-3'
            } ${long ? 'cursor-pointer' : ''}`}
          >
            {card.text}
          </p>
        )}
        {editable && !editing && (
          <button
            onClick={startEdit}
            data-testid="card-edit-open"
            className="shrink-0 rounded p-0.5 text-zinc-700 opacity-0 transition-opacity hover:text-cyan-300 group-hover:opacity-100"
            title="Edit this prompt"
          >
            <Pencil className="h-3 w-3" />
          </button>
        )}
        <button
          onClick={() => board.remove(card.id)}
          className="shrink-0 rounded p-0.5 text-zinc-700 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
          title="Delete card"
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      {card.feedback && (
        <p className="mt-1 rounded border border-violet-500/20 bg-violet-500/5 px-1.5 py-1 text-[10px] leading-snug text-violet-200/80">
          ↻ {card.feedback}
        </p>
      )}

      {/* Meta row */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-zinc-500">
        {card.paneName && (
          <span className={`inline-flex items-center gap-1 rounded px-1 ${pane ? 'bg-zinc-800 text-zinc-300' : 'bg-zinc-800/50 text-zinc-600 line-through'}`}>
            <TerminalIcon className="h-2.5 w-2.5" />
            {card.paneName}
          </span>
        )}
        {card.column === 'running' && card.dispatchedAt && (
          <span className="inline-flex items-center gap-1 text-cyan-400">
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
            <LiveClock since={card.dispatchedAt} />
          </span>
        )}
        {card.column !== 'running' && card.dispatchedAt && card.finishedAt && (
          <span className="font-mono tabular-nums text-zinc-600">ran {duration(card.dispatchedAt, card.finishedAt)}</span>
        )}
        {card.tags.map((t) => (
          <span key={t} className="rounded bg-zinc-800 px-1 text-zinc-400">{t}</span>
        ))}
      </div>

      {/* Actions — per column */}
      {card.column === 'backlog' || card.column === 'queued' ? (
        <div className="mt-1.5 flex items-center gap-1">
          <button
            onClick={run}
            data-testid="card-run"
            className="inline-flex items-center gap-1 rounded border border-cyan-500/25 bg-cyan-500/10 px-1.5 py-0.5 text-[10px] text-cyan-300 transition-colors hover:bg-cyan-500/20"
            title="Paste into the agent's terminal and press Enter"
          >
            <Play className="h-2.5 w-2.5" /> Run
          </button>
          <div className="relative">
            <button
              onClick={() => setAssignOpen((v) => !v)}
              className="inline-flex items-center gap-1 rounded border border-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
              title="Choose which agent runs this"
            >
              {pane?.name || 'Any agent'} <ChevronDown className="h-2.5 w-2.5" />
            </button>
            {assignOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setAssignOpen(false)} />
                <div className="absolute left-0 top-full z-20 mt-1 max-h-48 w-40 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950 py-1 shadow-xl">
                  <button
                    onClick={() => { board.update(card.id, { paneId: undefined, paneName: undefined }); setAssignOpen(false) }}
                    className="block w-full px-2 py-1 text-left text-[10px] text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
                  >
                    Any idle agent
                  </button>
                  {panes.length === 0 && (
                    <p className="px-2 py-1 text-[10px] text-zinc-600">No terminals open</p>
                  )}
                  {panes.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => { board.update(card.id, { paneId: p.id, paneName: p.name }); setAssignOpen(false) }}
                      className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[10px] text-zinc-300 hover:bg-zinc-900"
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${p.status === 'running' ? 'bg-cyan-400' : 'bg-zinc-600'}`} />
                      <span className="truncate">{p.name}</span>
                      <span className="ml-auto text-zinc-600">{p.cliType}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}

      {/*
        What came back. A Review card that only shows your prompt is half a
        review — the agent's closing words (usually "should I do X or Y?") are
        the thing you're actually deciding on.
      */}
      {card.column === 'review' && card.result && (
        <div className="mt-1.5 rounded border border-zinc-800 bg-zinc-950/60">
          <button
            onClick={() => setOutputOpen((v) => !v)}
            className="flex w-full items-center gap-1 px-1.5 py-1 text-[10px] text-zinc-500 transition-colors hover:text-zinc-300"
          >
            <ChevronDown className={`h-2.5 w-2.5 transition-transform ${outputOpen ? '' : '-rotate-90'}`} />
            Agent output
          </button>
          {outputOpen && (
            <pre
              data-testid="card-result"
              className="max-h-44 overflow-auto whitespace-pre-wrap break-words border-t border-zinc-800/70 px-1.5 py-1 font-mono text-[10px] leading-snug text-zinc-400"
            >
              {card.result}
            </pre>
          )}
        </div>
      )}

      {card.column === 'review' && card.suggestion && (
        <div className="mt-1.5 rounded border border-amber-500/25 bg-amber-500/5 px-1.5 py-1">
          <p data-testid="card-suggestion" className="flex items-start gap-1 text-[10px] leading-snug text-amber-100/90">
            <Lightbulb className="mt-px h-2.5 w-2.5 shrink-0 text-amber-400" />
            <span className="break-words">{card.suggestion}</span>
          </p>
          {queueing ? (
            <div className="mt-1 space-y-1">
              <textarea
                autoFocus
                value={suggestText}
                onChange={(e) => setSuggestText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { board.queueSuggestion(card.id, suggestText); setQueueing(false) }
                  if (e.key === 'Escape') setQueueing(false)
                }}
                rows={2}
                placeholder="What should the agent do next?"
                className="w-full resize-none rounded border border-zinc-800 bg-zinc-950 px-1.5 py-1 text-[10px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-amber-500/40"
              />
              <div className="flex items-center gap-1">
                <button
                  onClick={() => { board.queueSuggestion(card.id, suggestText); setQueueing(false) }}
                  data-testid="card-queue-confirm"
                  className="rounded border border-amber-500/25 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300 hover:bg-amber-500/20"
                >
                  Add to Queued <CornerDownLeft className="ml-0.5 inline h-2.5 w-2.5" />
                </button>
                <button onClick={() => setQueueing(false)} className="px-1 text-[10px] text-zinc-600 hover:text-zinc-400">Cancel</button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => { setSuggestText(card.suggestion ?? ''); setQueueing(true) }}
              data-testid="card-queue-suggestion"
              className="mt-1 inline-flex items-center gap-1 rounded border border-amber-500/25 px-1.5 py-0.5 text-[10px] text-amber-300/90 transition-colors hover:bg-amber-500/10"
              title="Make this its own card in Queued"
            >
              <ListPlus className="h-2.5 w-2.5" /> Queue this
            </button>
          )}
        </div>
      )}

      {card.column === 'review' && (
        <div className="mt-1.5">
          {reworking ? (
            <div className="space-y-1">
              <textarea
                autoFocus
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { board.rework(card.id, feedback); setReworking(false) }
                  if (e.key === 'Escape') setReworking(false)
                }}
                placeholder="What should the agent change?"
                rows={2}
                className="w-full resize-none rounded border border-zinc-800 bg-zinc-950 px-1.5 py-1 text-[10px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-violet-500/40"
              />
              <div className="flex items-center gap-1">
                <button
                  onClick={() => { board.rework(card.id, feedback); setReworking(false) }}
                  className="rounded border border-violet-500/25 bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-300 hover:bg-violet-500/20"
                >
                  Send back <CornerDownLeft className="ml-0.5 inline h-2.5 w-2.5" />
                </button>
                <button onClick={() => setReworking(false)} className="px-1 text-[10px] text-zinc-600 hover:text-zinc-400">Cancel</button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              <button
                onClick={() => board.approve(card.id)}
                data-testid="card-approve"
                className="inline-flex items-center gap-1 rounded border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300 transition-colors hover:bg-emerald-500/20"
              >
                <Check className="h-2.5 w-2.5" /> Approve
              </button>
              <button
                onClick={() => setReworking(true)}
                data-testid="card-rework"
                className="inline-flex items-center gap-1 rounded border border-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:border-violet-500/30 hover:text-violet-300"
              >
                <RotateCcw className="h-2.5 w-2.5" /> Rework
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Column ──────────────────────────────────────────────────────────────────

function Column({
  id, cards, panes, board, onToast, onCompose,
}: {
  id: ColumnId
  cards: KanbanCard[]
  panes: PaneInfo[]
  board: UseKanban
  onToast: (msg: string) => void
  onCompose?: () => void
}) {
  const [over, setOver] = useState(false)
  const meta = COLUMN_META[id]
  const style = COLUMN_STYLE[id]

  return (
    <div
      data-testid={`kanban-column-${id}`}
      onDragOver={(e) => {
        if (!draggingCardId && !e.dataTransfer.types.includes('text/orquesta-card')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const cardId = e.dataTransfer.getData('text/orquesta-card') || draggingCardId
        draggingCardId = null
        if (!cardId) return
        const err = board.move(cardId, id)
        if (err) onToast(err)
      }}
      // Columns share the width on a wide screen but never squeeze below
      // readable — past that the board scrolls sideways instead.
      className={`flex h-full min-w-[264px] max-w-[420px] flex-1 flex-col rounded-xl border bg-zinc-950/60 transition-colors ${
        over ? style.over : style.ring
      }`}
    >
      <div className="flex items-center gap-1.5 border-b border-zinc-800/70 px-2.5 py-2">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${style.dot}`} />
        <span className={`text-[11px] font-medium uppercase tracking-wider ${style.text}`}>{meta.label}</span>
        <span className="rounded bg-zinc-800/70 px-1 font-mono text-[10px] text-zinc-400" data-testid={`count-${id}`}>
          {cards.length}
        </span>
        {onCompose && (
          <button
            onClick={onCompose}
            data-testid="kanban-add"
            className="ml-auto rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            title="New prompt"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
        {id === 'done' && cards.length > 0 && (
          <button
            onClick={board.clearDone}
            className="ml-auto rounded p-0.5 text-zinc-600 hover:bg-zinc-800 hover:text-red-400"
            title="Clear approved cards"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="flex-1 space-y-1.5 overflow-y-auto p-2">
        {cards.length === 0 ? (
          <p className="px-1 py-4 text-center text-[10px] leading-relaxed text-zinc-700">{meta.hint}</p>
        ) : (
          cards.map((c) => <Card key={c.id} card={c} panes={panes} board={board} onToast={onToast} />)
        )}
      </div>
    </div>
  )
}

// ── Board ───────────────────────────────────────────────────────────────────

export function KanbanBoard({
  board, panes, onClose,
}: {
  board: UseKanban
  panes: PaneInfo[]
  onClose: () => void
}) {
  const [composing, setComposing] = useState(false)
  const [draft, setDraft] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 3500)
  }, [])
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current) }, [])

  const submitDraft = () => {
    // Blank lines separate prompts — paste a list, get a card each.
    const chunks = draft.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)
    chunks.forEach((c) => board.add(c))
    setDraft('')
    setComposing(false)
  }

  const running = board.byColumn.running.length
  const waiting = board.byColumn.review.length

  return (
    <div className="flex h-full flex-col" data-testid="kanban-board">
      {/* Board toolbar */}
      <div className="flex items-center gap-3 border-b border-zinc-800/70 px-4 py-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-zinc-200">
          <Sparkles className="h-3.5 w-3.5 text-violet-400" /> Prompt board
        </span>
        <span className="hidden font-mono text-[10px] text-zinc-600 sm:inline">
          {panes.length} agent{panes.length === 1 ? '' : 's'}
          {running > 0 && <span className="text-cyan-400"> · {running} running</span>}
          {waiting > 0 && <span className="text-violet-300"> · {waiting} awaiting approval</span>}
        </span>
        <button
          onClick={() => setComposing(true)}
          data-testid="kanban-new-prompt"
          className="ml-auto flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-white/10 hover:text-white"
        >
          <Plus className="h-3.5 w-3.5" /> New prompt
        </button>
        <button
          onClick={onClose}
          data-testid="kanban-close"
          className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-white/10 hover:text-white"
          title="Back to the terminal grid"
        >
          <TerminalIcon className="h-3.5 w-3.5" /> Grid
        </button>
      </div>

      {/* Columns */}
      <div className="flex flex-1 gap-2.5 overflow-x-auto p-3">
        {COLUMNS.map((id) => (
          <Column
            key={id}
            id={id}
            cards={board.byColumn[id]}
            panes={panes}
            board={board}
            onToast={showToast}
            onCompose={id === 'backlog' ? () => setComposing(true) : undefined}
          />
        ))}
      </div>

      {/* Composer */}
      {composing && (
        <>
          <div className="fixed inset-0 z-40 bg-black/50" onClick={() => setComposing(false)} />
          <div className="fixed left-1/2 top-1/4 z-50 w-[min(36rem,90vw)] -translate-x-1/2 rounded-xl border border-zinc-800 bg-zinc-950 p-3 shadow-2xl">
            <p className="mb-2 text-[11px] text-zinc-400">
              New prompt — one card per paragraph. <kbd className="rounded border border-white/10 bg-white/5 px-1">⌘↵</kbd> to add.
            </p>
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitDraft() }
                if (e.key === 'Escape') setComposing(false)
              }}
              rows={6}
              data-testid="kanban-composer"
              placeholder={'Refactor the auth middleware to use the new session store\n\nAdd tests for the retry path'}
              className="w-full resize-none rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-2 text-xs text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-violet-500/40"
            />
            <div className="mt-2 flex items-center justify-end gap-2">
              <button onClick={() => setComposing(false)} className="px-2 py-1 text-xs text-zinc-500 hover:text-zinc-300">Cancel</button>
              <button
                onClick={submitDraft}
                data-testid="kanban-composer-submit"
                className="rounded-lg border border-violet-500/25 bg-violet-500/10 px-2.5 py-1 text-xs text-violet-300 hover:bg-violet-500/20"
              >
                Add to backlog
              </button>
            </div>
          </div>
        </>
      )}

      {toast && (
        <div
          data-testid="kanban-toast"
          className="pointer-events-none fixed bottom-12 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200 shadow-xl"
        >
          {toast}
        </div>
      )}
    </div>
  )
}
