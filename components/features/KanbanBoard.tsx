'use client'

/**
 * Kanban mode — the prompt board.
 *
 * Every card IS a prompt. Drag it into Running and it is actually pasted into
 * its terminal and submitted; while the agent works the card pulses; when the
 * agent goes quiet the card lands in Review, which is a human gate — Approve
 * ships it, Rework sends it back round with your feedback appended.
 *
 * Cards stay compact on the board (text, agent, one action); everything else —
 * the agent's output, its suggestions, editing, rework — lives in the detail
 * drawer a click opens. Columns render a page at a time so a board with
 * hundreds of cards stays responsive.
 *
 * All board state is local (see hooks/useKanban.ts). The only thing this needs
 * from the rest of the app is the pane roster and a way to type into a pane.
 */

import { useState, useRef, useEffect, useCallback, memo } from 'react'
import {
  Plus, X, Play, Check, RotateCcw, Trash2, Loader2, CornerDownLeft,
  Terminal as TerminalIcon, Sparkles, ChevronDown, ListPlus, Lightbulb, Pencil, Undo2,
} from 'lucide-react'
import { COLUMNS, COLUMN_META, type ColumnId, type KanbanCard, type UseKanban } from '@/hooks/useKanban'
import type { PaneInfo } from './AgentGrid'
import { useKeyLabels } from '@/lib/platform'

/** Per-column chrome. Kept as literal class strings so Tailwind can see them. */
const COLUMN_STYLE: Record<ColumnId, { dot: string; text: string; ring: string; over: string }> = {
  todo: { dot: 'bg-zinc-400', text: 'text-zinc-300', ring: 'border-zinc-800', over: 'border-zinc-500/50 bg-zinc-500/5' },
  running: { dot: 'bg-cyan-400 animate-pulse', text: 'text-cyan-300', ring: 'border-cyan-500/20', over: 'border-cyan-500/50 bg-cyan-500/5' },
  review: { dot: 'bg-violet-400', text: 'text-violet-300', ring: 'border-violet-500/20', over: 'border-violet-500/50 bg-violet-500/5' },
  done: { dot: 'bg-emerald-500', text: 'text-emerald-300', ring: 'border-emerald-500/20', over: 'border-emerald-500/50 bg-emerald-500/5' },
}

/** Cards rendered per column before "Show more"; Done starts shorter. */
const PAGE = 30
const DONE_PAGE = 20

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

// ── Card (compact) ──────────────────────────────────────────────────────────

/**
 * Memoised on purpose: the board re-renders on every pane status tick, and
 * with a few hundred cards re-rendering each one is what made it crawl. Every
 * callback it gets is stable, so a card only renders when it changed.
 */
const CardTile = memo(function CardTile({
  card, paneGone, selected, onSelect, onRun, onApprove, onRemove,
}: {
  card: KanbanCard
  /** The card names a pane that no longer exists. */
  paneGone: boolean
  selected: boolean
  onSelect: (id: string) => void
  onRun: (id: string) => void
  onApprove: (id: string) => void
  onRemove: (id: string) => void
}) {
  const running = card.column === 'running'
  const tags = card.tags.filter((t) => t !== 'typed')

  return (
    <div
      draggable
      onDragStart={(e) => {
        draggingCardId = card.id
        e.dataTransfer.setData('text/orquesta-card', card.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragEnd={() => { draggingCardId = null }}
      onClick={() => onSelect(card.id)}
      data-testid="kanban-card"
      data-card-id={card.id}
      data-column={card.column}
      className={`group cursor-pointer rounded-lg border px-2.5 py-2 transition-colors ${
        selected
          ? 'border-violet-500/50 bg-violet-500/10'
          : running
            ? 'border-cyan-500/30 bg-zinc-900/70 shadow-[0_0_18px_-6px_rgba(34,211,238,0.5)] hover:border-cyan-500/50'
            : 'border-zinc-800 bg-zinc-900/70 hover:border-zinc-700'
      }`}
    >
      <div className="flex items-start gap-1.5">
        <p className="line-clamp-2 flex-1 break-words text-[11px] leading-snug text-zinc-200">{card.text}</p>
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(card.id) }}
          data-testid="card-delete"
          className="shrink-0 rounded p-0.5 text-zinc-700 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
          title="Delete card"
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      {card.feedback && (
        <p className="mt-1 truncate text-[10px] text-violet-300/80" title={card.feedback}>↻ {card.feedback}</p>
      )}

      <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-zinc-500">
        {card.paneName && (
          <span className={`inline-flex min-w-0 items-center gap-1 rounded px-1 ${paneGone ? 'bg-zinc-800/50 text-zinc-500 line-through' : 'bg-zinc-800 text-zinc-300'}`}>
            <TerminalIcon className="h-2.5 w-2.5 shrink-0" />
            <span className="truncate">{card.paneName}</span>
          </span>
        )}
        {running && card.dispatchedAt && (
          <span className="inline-flex items-center gap-1 text-cyan-400">
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
            <LiveClock since={card.dispatchedAt} />
          </span>
        )}
        {!running && card.dispatchedAt && card.finishedAt && (
          <span className="font-mono tabular-nums">{duration(card.dispatchedAt, card.finishedAt)}</span>
        )}
        {card.column === 'review' && card.suggestions?.length ? (
          <span className="inline-flex items-center gap-0.5 text-amber-300/90" title="The agent suggested next steps">
            <Lightbulb className="h-2.5 w-2.5" />{card.suggestions.length}
          </span>
        ) : null}
        {tags.map((t) => (
          <span key={t} className="rounded bg-zinc-800 px-1 text-zinc-400">{t}</span>
        ))}

        {/* The one action a column is for — everything else is in the drawer. */}
        {card.column === 'todo' && (
          <button
            onClick={(e) => { e.stopPropagation(); onRun(card.id) }}
            data-testid="card-run"
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded border border-cyan-500/25 bg-cyan-500/10 px-1.5 py-0.5 text-cyan-300 transition-colors hover:bg-cyan-500/20"
            title="Paste into the agent's terminal and press Enter"
          >
            <Play className="h-2.5 w-2.5" /> Run
          </button>
        )}
        {card.column === 'review' && (
          <button
            onClick={(e) => { e.stopPropagation(); onApprove(card.id) }}
            data-testid="card-approve"
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 text-emerald-300 transition-colors hover:bg-emerald-500/20"
          >
            <Check className="h-2.5 w-2.5" /> Approve
          </button>
        )}
      </div>
    </div>
  )
})

// ── Detail drawer ───────────────────────────────────────────────────────────

function CardDrawer({
  card, panes, board, onRun, onClose,
}: {
  card: KanbanCard
  panes: PaneInfo[]
  board: UseKanban
  onRun: (id: string) => void
  onClose: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [reworking, setReworking] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [queueing, setQueueing] = useState(false)
  const [suggestText, setSuggestText] = useState('')
  const [outputOpen, setOutputOpen] = useState(true)

  // A different card in the same drawer starts clean.
  useEffect(() => {
    setEditing(false); setReworking(false); setQueueing(false); setFeedback(''); setOutputOpen(true)
  }, [card.id])

  const style = COLUMN_STYLE[card.column]
  const pane = card.paneId ? panes.find((p) => p.id === card.paneId) : undefined
  // A suggestion arrives in the agent's words ("shall I close Waydroid?"); what
  // you want to send is your answer, so a waiting card has to be editable in place.
  const editable = card.column === 'todo'

  const startEdit = () => { setDraft(card.text); setEditing(true) }
  const commitEdit = () => {
    const body = draft.trim()
    if (body && body !== card.text) board.update(card.id, { text: body })
    setEditing(false)
  }
  const sendRework = () => { board.rework(card.id, feedback); setReworking(false); onClose() }
  const queue = (text: string) => { board.queueSuggestion(card.id, text); setQueueing(false) }

  const btn = 'inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] transition-colors'

  return (
    <aside
      data-testid="kanban-drawer"
      className="absolute inset-y-0 right-0 z-20 flex w-[min(440px,100%)] flex-col border-l border-zinc-800 bg-zinc-950 shadow-2xl"
    >
      <div className="flex items-center gap-2 border-b border-zinc-800/70 px-3 py-2">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${style.dot}`} />
        <span className={`text-[11px] font-medium uppercase tracking-wider ${style.text}`}>{COLUMN_META[card.column].label}</span>
        {card.column === 'running' && card.dispatchedAt && (
          <span className="text-[10px] text-cyan-400"><LiveClock since={card.dispatchedAt} /></span>
        )}
        {card.column !== 'running' && card.dispatchedAt && card.finishedAt && (
          <span className="font-mono text-[10px] text-zinc-500">ran {duration(card.dispatchedAt, card.finishedAt)}</span>
        )}
        <button onClick={onClose} data-testid="kanban-drawer-close" className="ml-auto rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" title="Close (Esc)">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {/* The prompt */}
        <section>
          <div className="mb-1 flex items-center text-[10px] uppercase tracking-wider text-zinc-500">
            Prompt
            {editable && !editing && (
              <button onClick={startEdit} data-testid="card-edit-open" className="ml-auto inline-flex items-center gap-1 normal-case tracking-normal text-zinc-500 hover:text-cyan-300">
                <Pencil className="h-3 w-3" /> Edit
              </button>
            )}
          </div>
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
              data-testid="card-edit"
              rows={Math.min(12, Math.max(3, draft.split('\n').length))}
              className="w-full resize-none rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs leading-snug text-zinc-100 outline-none focus:border-cyan-500/40"
            />
          ) : (
            <p
              onDoubleClick={() => editable && startEdit()}
              className="whitespace-pre-wrap break-words rounded-lg border border-zinc-800 bg-zinc-900/60 px-2 py-1.5 text-xs leading-snug text-zinc-200"
            >
              {card.text}
            </p>
          )}
          {card.feedback && (
            <p className="mt-1.5 rounded border border-violet-500/20 bg-violet-500/5 px-2 py-1 text-[11px] leading-snug text-violet-200/80">
              ↻ {card.feedback}
            </p>
          )}
        </section>

        {/* Which agent */}
        <section>
          <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">Agent</div>
          {editable ? (
            <select
              value={card.paneId ?? ''}
              onChange={(e) => {
                const p = panes.find((x) => x.id === e.target.value)
                board.update(card.id, { paneId: p?.id, paneName: p?.name })
              }}
              data-testid="card-assign"
              className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 outline-none focus:border-cyan-500/40"
            >
              <option value="">Any idle agent</option>
              {panes.map((p) => (
                <option key={p.id} value={p.id}>{p.name} · {p.cliType}{p.status === 'running' ? ' (busy)' : ''}</option>
              ))}
            </select>
          ) : (
            <p className="text-xs text-zinc-300">
              {card.paneName ? (
                <span className={pane ? '' : 'text-zinc-500 line-through'}>{card.paneName}</span>
              ) : <span className="text-zinc-500">Not sent yet</span>}
            </p>
          )}
        </section>

        {/*
          What came back. A Review card that only shows your prompt is half a
          review — the agent's closing words (usually "should I do X or Y?") are
          the thing you're actually deciding on.
        */}
        {card.result && (
          <section className="rounded-lg border border-zinc-800 bg-zinc-900/40">
            <button
              onClick={() => setOutputOpen((v) => !v)}
              className="flex w-full items-center gap-1 px-2 py-1.5 text-[10px] uppercase tracking-wider text-zinc-500 transition-colors hover:text-zinc-300"
            >
              <ChevronDown className={`h-3 w-3 transition-transform ${outputOpen ? '' : '-rotate-90'}`} />
              Agent output
            </button>
            {outputOpen && (
              <pre
                data-testid="card-result"
                className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-zinc-800/70 px-2 py-1.5 font-mono text-[10px] leading-snug text-zinc-400"
              >
                {card.result}
              </pre>
            )}
          </section>
        )}

        {card.suggestions?.length ? (
          <section className="space-y-1.5 rounded-lg border border-amber-500/25 bg-amber-500/5 p-2">
            <div className="flex items-center text-[10px] uppercase tracking-wider text-amber-300/80">
              Suggested next
              {!queueing && card.suggestions.length > 1 && (
                <button
                  onClick={() => card.suggestions?.forEach((s) => board.queueSuggestion(card.id, s))}
                  data-testid="card-queue-all"
                  className="ml-auto inline-flex items-center gap-1 normal-case tracking-normal text-amber-300/90 hover:text-amber-200"
                >
                  <ListPlus className="h-3 w-3" /> Queue all {card.suggestions.length}
                </button>
              )}
            </div>
            {card.suggestions.map((s, i) => (
              <div key={i} className="flex items-start gap-1.5">
                <Lightbulb className="mt-0.5 h-3 w-3 shrink-0 text-amber-400" />
                <span data-testid="card-suggestion" className="flex-1 break-words text-[11px] leading-snug text-amber-100/90">{s}</span>
                <button
                  onClick={() => { setSuggestText(s); setQueueing(true) }}
                  data-testid="card-queue-suggestion"
                  className="shrink-0 rounded border border-amber-500/25 p-0.5 text-amber-300/90 transition-colors hover:bg-amber-500/20"
                  title="Make this its own card in To do"
                >
                  <ListPlus className="h-3 w-3" />
                </button>
              </div>
            ))}
            {queueing && (
              <div className="space-y-1 pt-0.5">
                <textarea
                  autoFocus
                  value={suggestText}
                  onChange={(e) => setSuggestText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) queue(suggestText)
                    if (e.key === 'Escape') { e.stopPropagation(); setQueueing(false) }
                  }}
                  rows={2}
                  placeholder="What should the agent do next?"
                  className="w-full resize-none rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-200 outline-none placeholder:text-zinc-500 focus:border-amber-500/40"
                />
                <div className="flex items-center gap-1">
                  <button onClick={() => queue(suggestText)} data-testid="card-queue-confirm" className={`${btn} border-amber-500/25 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20`}>
                    Add to To do <CornerDownLeft className="h-3 w-3" />
                  </button>
                  <button onClick={() => setQueueing(false)} className="px-1 text-[11px] text-zinc-500 hover:text-zinc-300">Cancel</button>
                </div>
              </div>
            )}
          </section>
        ) : null}

        {reworking && (
          <section className="space-y-1">
            <textarea
              autoFocus
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendRework()
                if (e.key === 'Escape') { e.stopPropagation(); setReworking(false) }
              }}
              placeholder="What should the agent change?"
              rows={3}
              className="w-full resize-none rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 outline-none placeholder:text-zinc-500 focus:border-violet-500/40"
            />
            <div className="flex items-center gap-1">
              <button onClick={sendRework} className={`${btn} border-violet-500/25 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20`}>
                Send back <CornerDownLeft className="h-3 w-3" />
              </button>
              <button onClick={() => setReworking(false)} className="px-1 text-[11px] text-zinc-500 hover:text-zinc-300">Cancel</button>
            </div>
          </section>
        )}
      </div>

      {/* Actions for where the card is now */}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-zinc-800/70 px-3 py-2">
        {card.column === 'todo' && (
          <button onClick={() => onRun(card.id)} className={`${btn} border-cyan-500/25 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20`}>
            <Play className="h-3 w-3" /> Run
          </button>
        )}
        {card.column === 'review' && !reworking && (
          <>
            <button onClick={() => { board.approve(card.id); onClose() }} className={`${btn} border-emerald-500/25 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20`}>
              <Check className="h-3 w-3" /> Approve
            </button>
            <button onClick={() => setReworking(true)} data-testid="card-rework" className={`${btn} border-zinc-800 text-zinc-400 hover:border-violet-500/30 hover:text-violet-300`}>
              <RotateCcw className="h-3 w-3" /> Rework
            </button>
          </>
        )}
        {(card.column === 'running' || card.column === 'done') && (
          <button onClick={() => { board.move(card.id, 'todo'); onClose() }} className={`${btn} border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200`} title="Put the prompt back in To do">
            <Undo2 className="h-3 w-3" /> Back to To do
          </button>
        )}
        <button
          onClick={() => { board.remove(card.id); onClose() }}
          className={`${btn} ml-auto border-zinc-800 text-zinc-500 hover:border-red-500/30 hover:text-red-400`}
        >
          <Trash2 className="h-3 w-3" /> Delete
        </button>
      </div>
    </aside>
  )
}

// ── Column ──────────────────────────────────────────────────────────────────

function Column({
  id, cards, panes, selectedId, onSelect, onRun, onApprove, onRemove, onMove, onClear, onCompose,
}: {
  id: ColumnId
  cards: KanbanCard[]
  panes: PaneInfo[]
  selectedId: string | null
  onSelect: (id: string) => void
  onRun: (id: string) => void
  onApprove: (id: string) => void
  onRemove: (id: string) => void
  onMove: (cardId: string, to: ColumnId) => void
  onClear?: () => void
  onCompose?: () => void
}) {
  const [over, setOver] = useState(false)
  const [limit, setLimit] = useState(id === 'done' ? DONE_PAGE : PAGE)
  // Bulk clear is two clicks — no browser confirm() in a webview.
  const [confirmClear, setConfirmClear] = useState(false)
  useEffect(() => {
    if (!confirmClear) return
    const t = setTimeout(() => setConfirmClear(false), 3000)
    return () => clearTimeout(t)
  }, [confirmClear])

  const meta = COLUMN_META[id]
  const style = COLUMN_STYLE[id]
  const paneIds = new Set(panes.map((p) => p.id))
  const shown = cards.slice(0, limit)
  const hidden = cards.length - shown.length

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
        if (cardId) onMove(cardId, id)
      }}
      // min-h-0 lets the column body scroll on its own instead of stretching
      // the whole board when a column holds hundreds of cards.
      className={`flex min-h-0 min-w-[240px] flex-col rounded-xl border bg-zinc-950/60 transition-colors ${
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
        {onClear && cards.length > 0 && (
          <button
            onClick={() => (confirmClear ? (onClear(), setConfirmClear(false)) : setConfirmClear(true))}
            data-testid={`kanban-clear-${id}`}
            className={`ml-auto inline-flex items-center gap-1 rounded px-1 py-0.5 text-[10px] transition-colors ${
              confirmClear ? 'bg-red-500/15 text-red-300' : 'text-zinc-500 hover:bg-zinc-800 hover:text-red-400'
            }`}
            title={id === 'done' ? 'Clear approved cards' : `Remove all ${cards.length} cards`}
          >
            <Trash2 className="h-3 w-3" />
            {confirmClear ? `Clear ${cards.length}?` : id === 'review' && cards.length > 1 ? 'Clear all' : null}
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
        {cards.length === 0 ? (
          <p className="px-1 py-4 text-center text-[10px] leading-relaxed text-zinc-500">{meta.hint}</p>
        ) : (
          shown.map((c) => (
            <CardTile
              key={c.id}
              card={c}
              paneGone={!!c.paneId && !paneIds.has(c.paneId)}
              selected={c.id === selectedId}
              onSelect={onSelect}
              onRun={onRun}
              onApprove={onApprove}
              onRemove={onRemove}
            />
          ))
        )}
        {hidden > 0 && (
          <button
            onClick={() => setLimit((n) => n + 50)}
            data-testid={`kanban-more-${id}`}
            className="w-full rounded-lg border border-dashed border-zinc-800 py-1.5 text-[10px] text-zinc-500 transition-colors hover:border-zinc-700 hover:text-zinc-300"
          >
            Show {Math.min(50, hidden)} more · {hidden} hidden
          </button>
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
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const keys = useKeyLabels()
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 3500)
  }, [])
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current) }, [])

  // `board` is a fresh object every render; the card callbacks read it through
  // a ref so they stay stable and the memoised cards don't all re-render.
  const boardRef = useRef(board)
  boardRef.current = board
  const onRun = useCallback((id: string) => {
    const err = boardRef.current.dispatch(id)
    if (err) showToast(err)
  }, [showToast])
  const onApprove = useCallback((id: string) => boardRef.current.approve(id), [])
  const onRemove = useCallback((id: string) => {
    boardRef.current.remove(id)
    setSelectedId((s) => (s === id ? null : s))
  }, [])
  const onMove = useCallback((cardId: string, to: ColumnId) => {
    const err = boardRef.current.move(cardId, to)
    if (err) showToast(err)
  }, [showToast])
  const onSelect = useCallback((id: string) => setSelectedId((s) => (s === id ? null : id)), [])

  const selected = selectedId ? board.cards.find((c) => c.id === selectedId) : undefined

  // Esc closes the drawer first; it never reaches the grid underneath.
  useEffect(() => {
    if (!selected || composing) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelectedId(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, composing])

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
    <div className="relative flex h-full flex-col" data-testid="kanban-board">
      {/* Board toolbar */}
      <div className="flex items-center gap-3 border-b border-zinc-800/70 px-4 py-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-zinc-200">
          <Sparkles className="h-3.5 w-3.5 text-violet-400" /> Prompt board
        </span>
        <span className="hidden font-mono text-[10px] text-zinc-500 sm:inline">
          {panes.length} agent{panes.length === 1 ? '' : 's'}
          {running > 0 && <span className="text-cyan-400"> · {running} running</span>}
          {waiting > 0 && <span className="text-violet-300"> · {waiting} awaiting approval</span>}
        </span>
        <label
          className="ml-auto flex cursor-pointer items-center gap-1.5 text-[11px] text-zinc-400 hover:text-zinc-200"
          title="Also add a card for every prompt you type straight into a terminal"
        >
          <input
            type="checkbox"
            checked={board.captureEnabled}
            onChange={(e) => board.setCaptureEnabled(e.target.checked)}
            data-testid="kanban-capture-toggle"
            className="h-3 w-3 accent-violet-500"
          />
          Capture typed prompts
        </label>
        <button
          onClick={() => setComposing(true)}
          data-testid="kanban-new-prompt"
          className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-white/10 hover:text-white"
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

      {/* Columns — each scrolls on its own; past four readable widths the board scrolls sideways. */}
      <div className="relative min-h-0 flex-1">
        <div
          className="grid h-full gap-2.5 overflow-x-auto p-3"
          style={{ gridTemplateColumns: `repeat(${COLUMNS.length}, minmax(240px, 1fr))` }}
        >
          {COLUMNS.map((id) => (
            <Column
              key={id}
              id={id}
              cards={board.byColumn[id]}
              panes={panes}
              selectedId={selectedId}
              onSelect={onSelect}
              onRun={onRun}
              onApprove={onApprove}
              onRemove={onRemove}
              onMove={onMove}
              onClear={id === 'done' || id === 'review' ? () => board.clearColumn(id) : undefined}
              onCompose={id === 'todo' ? () => setComposing(true) : undefined}
            />
          ))}
        </div>

        {selected && (
          <CardDrawer card={selected} panes={panes} board={board} onRun={onRun} onClose={() => setSelectedId(null)} />
        )}
      </div>

      {/* Composer */}
      {composing && (
        <>
          <div className="fixed inset-0 z-40 bg-black/50" onClick={() => setComposing(false)} />
          <div className="fixed left-1/2 top-1/4 z-50 w-[min(36rem,90vw)] -translate-x-1/2 rounded-xl border border-zinc-800 bg-zinc-950 p-3 shadow-2xl">
            <p className="mb-2 text-[11px] text-zinc-400">
              New prompt — one card per paragraph. <kbd className="rounded border border-white/10 bg-white/5 px-1">{keys.combo(keys.mod, keys.enter)}</kbd> to add.
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
              className="w-full resize-none rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-2 text-xs text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-violet-500/40"
            />
            <div className="mt-2 flex items-center justify-end gap-2">
              <button onClick={() => setComposing(false)} className="px-2 py-1 text-xs text-zinc-500 hover:text-zinc-300">Cancel</button>
              <button
                onClick={submitDraft}
                data-testid="kanban-composer-submit"
                className="rounded-lg border border-violet-500/25 bg-violet-500/10 px-2.5 py-1 text-xs text-violet-300 hover:bg-violet-500/20"
              >
                Add to To do
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
