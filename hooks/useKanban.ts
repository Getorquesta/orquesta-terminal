'use client'

/**
 * Kanban mode state — prompts as cards moving across a board.
 *
 * Local-first by design: the board lives in localStorage keyed per project, so
 * it works with no backend, no login and no agent running. The only outside
 * signal it consumes is the pane roster from AgentGrid (`PaneInfo[]`), which
 * tells it which terminal a card is running on and when that terminal went
 * quiet — that quiet edge is what auto-promotes a card into Review.
 *
 * Columns:
 *   backlog → queued → running → review → done
 *
 * The interesting one is `review`: an agent finishing is NOT the end of the
 * task, it's a request for a human decision. Cards land there and wait for
 * Approve (→ done) or Rework (→ queued, with the feedback appended so the
 * next dispatch carries it).
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type { PaneInfo } from '@/components/features/AgentGrid'

export const COLUMNS = ['backlog', 'queued', 'running', 'review', 'done'] as const
export type ColumnId = (typeof COLUMNS)[number]

export const COLUMN_META: Record<ColumnId, { label: string; hint: string; accent: string }> = {
  backlog: { label: 'Backlog', hint: 'Prompts you haven’t sent yet', accent: 'zinc' },
  queued: { label: 'Queued', hint: 'Assigned to an agent, waiting', accent: 'amber' },
  running: { label: 'Running', hint: 'Live in a terminal right now', accent: 'cyan' },
  review: { label: 'Review', hint: 'Agent finished — approve or rework', accent: 'violet' },
  done: { label: 'Done', hint: 'Approved', accent: 'emerald' },
}

export interface KanbanCard {
  id: string
  /** The prompt itself — this is the card. */
  text: string
  column: ColumnId
  /** Terminal pane this card targets (a GridCell id). */
  paneId?: string
  /** Snapshot of the pane's label, so a closed pane still reads sensibly. */
  paneName?: string
  tags: string[]
  createdAt: number
  dispatchedAt?: number
  finishedAt?: number
  /**
   * True once we've actually seen the target pane go busy after dispatch.
   * Without it, a pane that's idle for the first few hundred ms after we press
   * Enter would look "already finished" and the card would skip straight to
   * Review having done nothing.
   */
  sawRunning?: boolean
  /** Review feedback from a Rework, carried into the next dispatch. */
  feedback?: string
  /** Manual ordering within a column (lower = higher up). */
  order: number
}

export interface KanbanState {
  cards: KanbanCard[]
  v: number
}

const VERSION = 1
const storageKey = (scope: string) => `orquesta-kanban-${scope || 'standalone'}`

function newId(): string {
  return `k_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Order value that puts a card at the top of `col`. Everything that moves a
 * card automatically (dispatch, finish, approve, rework) lands it at the top;
 * a literal 0 would tie with whatever is already there and let the sort pick
 * the winner arbitrarily.
 */
function topOrder(cards: KanbanCard[], col: ColumnId): number {
  const inCol = cards.filter((c) => c.column === col)
  return inCol.length ? Math.min(...inCol.map((c) => c.order)) - 1 : 0
}

function load(scope: string): KanbanCard[] {
  try {
    const raw = localStorage.getItem(storageKey(scope))
    if (!raw) return []
    const parsed = JSON.parse(raw) as KanbanState
    if (!parsed || !Array.isArray(parsed.cards)) return []
    // A card left mid-flight by a reload can't still be running — no PTY is
    // attached to it any more. Park it in Review so the run isn't lost silently.
    return parsed.cards.map((c) =>
      c.column === 'running' ? { ...c, column: 'review' as ColumnId, finishedAt: c.finishedAt ?? Date.now() } : c,
    )
  } catch {
    return []
  }
}

export interface UseKanban {
  cards: KanbanCard[]
  byColumn: Record<ColumnId, KanbanCard[]>
  add: (text: string, opts?: { paneId?: string; tags?: string[] }) => void
  update: (id: string, patch: Partial<KanbanCard>) => void
  remove: (id: string) => void
  /** Drop a card into a column. Returns a message when the move can't happen. */
  move: (id: string, to: ColumnId, beforeId?: string) => string | null
  /** Send a card's prompt to its pane now (used by Queued → Running and Retry). */
  dispatch: (id: string) => string | null
  approve: (id: string) => void
  rework: (id: string, feedback: string) => void
  clearDone: () => void
}

export function useKanban({
  scope,
  panes,
  dispatchPrompt,
}: {
  /** Namespaces the board — the active project id. */
  scope: string
  panes: PaneInfo[]
  /** Paste + Enter into a pane. False = pane has no live PTY. */
  dispatchPrompt: (paneId: string, text: string) => boolean
}): UseKanban {
  const [cards, setCards] = useState<KanbanCard[]>([])
  const [cardsScope, setCardsScope] = useState<string | null>(null)

  // Latest values in refs — the status-watching effect must not re-subscribe
  // (or re-fire its transitions) just because a callback identity changed.
  const panesRef = useRef<PaneInfo[]>(panes)
  panesRef.current = panes
  const cardsRef = useRef<KanbanCard[]>(cards)
  cardsRef.current = cards
  const dispatchRef = useRef(dispatchPrompt)
  dispatchRef.current = dispatchPrompt

  useEffect(() => {
    // Both pieces in one commit: `cardsScope` is what `cards` was loaded for.
    setCards(load(scope))
    setCardsScope(scope)
  }, [scope])

  // Persist only when the cards in hand belong to the scope we'd write them
  // under. That covers two cases the naive version got wrong: the pre-hydration
  // render (empty board) and the render right after a project switch (project
  // A's cards, project B's key) — both would clobber a stored board.
  useEffect(() => {
    if (cardsScope !== scope) return
    try {
      localStorage.setItem(storageKey(scope), JSON.stringify({ v: VERSION, cards } satisfies KanbanState))
    } catch {}
  }, [cards, scope, cardsScope])

  const byColumn = useMemo(() => {
    const out = Object.fromEntries(COLUMNS.map((c) => [c, [] as KanbanCard[]])) as Record<ColumnId, KanbanCard[]>
    for (const c of cards) (out[c.column] ??= []).push(c)
    for (const c of COLUMNS) out[c].sort((a, b) => a.order - b.order)
    return out
  }, [cards])

  const add = useCallback((text: string, opts?: { paneId?: string; tags?: string[] }) => {
    const body = text.trim()
    if (!body) return
    const pane = opts?.paneId ? panesRef.current.find((p) => p.id === opts.paneId) : undefined
    setCards((prev) => [
      ...prev,
      {
        id: newId(),
        text: body,
        column: 'backlog',
        paneId: pane?.id,
        paneName: pane?.name,
        tags: opts?.tags ?? [],
        createdAt: Date.now(),
        order: prev.filter((c) => c.column === 'backlog').length,
      },
    ])
  }, [])

  const update = useCallback((id: string, patch: Partial<KanbanCard>) => {
    setCards((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)))
  }, [])

  const remove = useCallback((id: string) => {
    setCards((prev) => prev.filter((c) => c.id !== id))
  }, [])

  /** Panes that already have a card of this board mid-run — don't stack on them. */
  const busyPaneIds = useCallback(
    () => new Set(cardsRef.current.filter((c) => c.column === 'running' && c.paneId).map((c) => c.paneId!)),
    [],
  )

  /**
   * Pick the pane a card should run on: its own, else a free one. "Free" means
   * both idle at the terminal AND not already owned by another running card —
   * two prompts pasted into one CLI would interleave into gibberish, and the
   * board couldn't tell which one the pane going quiet belonged to.
   */
  const resolvePane = useCallback((card: KanbanCard): PaneInfo | undefined => {
    const own = card.paneId ? panesRef.current.find((p) => p.id === card.paneId) : undefined
    if (own) return own
    const taken = busyPaneIds()
    const free = panesRef.current.filter((p) => !taken.has(p.id))
    return free.find((p) => p.status === 'idle') || free[0]
  }, [busyPaneIds])

  /** Full prompt text sent to the CLI — rework feedback rides along. */
  const promptBody = (card: KanbanCard) =>
    card.feedback ? `${card.text}\n\nFollow-up from review: ${card.feedback}` : card.text

  const dispatch = useCallback((id: string): string | null => {
    const card = cardsRef.current.find((c) => c.id === id)
    if (!card) return 'Card not found.'
    const pane = resolvePane(card)
    if (!pane) {
      return panesRef.current.length
        ? 'Every terminal is already running a card.'
        : 'No terminal open — add one in Grid view first.'
    }
    // Reachable when the card is pinned to a pane (resolvePane returns `own`
    // unconditionally) that is already mid-run for another card.
    const occupant = cardsRef.current.find((c) => c.column === 'running' && c.paneId === pane.id && c.id !== id)
    if (occupant) return `“${pane.name}” is still running another card.`
    const ok = dispatchRef.current(pane.id, promptBody(card))
    if (!ok) return `“${pane.name}” has no live session yet.`
    setCards((prev) =>
      prev.map((c) =>
        c.id === id
          ? {
              ...c,
              column: 'running',
              paneId: pane.id,
              paneName: pane.name,
              dispatchedAt: Date.now(),
              finishedAt: undefined,
              sawRunning: false,
              order: topOrder(prev, 'running'),
            }
          : c,
      ),
    )
    return null
  }, [resolvePane])

  const move = useCallback((id: string, to: ColumnId, beforeId?: string): string | null => {
    const card = cardsRef.current.find((c) => c.id === id)
    if (!card) return null
    // Dropping into Running is not a label change — it actually fires the prompt.
    if (to === 'running' && card.column !== 'running') return dispatch(id)

    setCards((prev) => {
      const target = prev.find((c) => c.id === id)
      if (!target) return prev
      // Leaving Running/Review resets the run bookkeeping so a re-dispatch is clean.
      const reset: Partial<KanbanCard> =
        to === 'backlog' ? { paneId: undefined, paneName: undefined, dispatchedAt: undefined, finishedAt: undefined, sawRunning: false } : {}
      const others = prev.filter((c) => c.id !== id)
      const col = others.filter((c) => c.column === to).sort((a, b) => a.order - b.order)
      const at = beforeId ? col.findIndex((c) => c.id === beforeId) : -1
      const moved = { ...target, ...reset, column: to }
      const reordered = at >= 0 ? [...col.slice(0, at), moved, ...col.slice(at)] : [...col, moved]
      const orders = new Map(reordered.map((c, i) => [c.id, i]))
      return others
        .map((c) => (orders.has(c.id) ? { ...c, order: orders.get(c.id)! } : c))
        .concat({ ...moved, order: orders.get(moved.id)! })
    })
    return null
  }, [dispatch])

  const approve = useCallback((id: string) => {
    setCards((prev) => {
      const order = topOrder(prev, 'done')
      return prev.map((c) => (c.id === id ? { ...c, column: 'done', order, finishedAt: c.finishedAt ?? Date.now() } : c))
    })
  }, [])

  const rework = useCallback((id: string, feedback: string) => {
    setCards((prev) => {
      const order = topOrder(prev, 'queued')
      return prev.map((c) =>
        c.id === id
          ? { ...c, column: 'queued', feedback: feedback.trim() || undefined, sawRunning: false, order }
          : c,
      )
    })
  }, [])

  const clearDone = useCallback(() => {
    setCards((prev) => prev.filter((c) => c.column !== 'done'))
  }, [])

  // ── The live wire: pane busy/idle drives Running → Review ────────────────
  // Depends on `cards` as well as `panes`: a card dispatched into a pane that
  // was ALREADY busy produces no pane change, so a panes-only effect never got
  // to record sawRunning — and when that pane finally went quiet the card was
  // stranded in Running forever. Re-running on cards is safe because the
  // `changed` guard means a no-op pass writes nothing back.
  useEffect(() => {
    if (!cards.some((c) => c.column === 'running')) return
    const now = Date.now()
    setCards((prev) => {
      let changed = false
      const next = prev.map((c) => {
        if (c.column !== 'running') return c
        const pane = panes.find((p) => p.id === c.paneId)
        if (!pane) {
          // The pane was closed under it — the run is unrecoverable, send it back
          // to Queued (unassigned) rather than leaving a card that can never finish.
          changed = true
          return { ...c, column: 'queued' as ColumnId, paneId: undefined, sawRunning: false }
        }
        if (pane.status === 'running') {
          if (c.sawRunning) return c
          changed = true
          return { ...c, sawRunning: true }
        }
        // Pane is idle. Only counts as "finished" once we saw it actually work.
        if (!c.sawRunning) return c
        changed = true
        return { ...c, column: 'review' as ColumnId, finishedAt: now, order: topOrder(prev, 'review') }
      })
      return changed ? next : prev
    })
  }, [panes, cards])

  return { cards, byColumn, add, update, remove, move, dispatch, approve, rework, clearDone }
}
