// ── Agent queue ───────────────────────────────────────────────────────────────
// What each pane wants from you, reduced to four states: it needs you, it
// finished and you haven't looked, it's working, or there's nothing to do. Pure
// logic only, so the grid owns the state and this file owns the rules.
//
// Two sources feed it. A program that speaks OSC 7501 (the Program Status
// Protocol) is taken at its word. Everything else falls back to the grid's
// output heuristics, plus looksBlocked() for prompts that wait for an answer.

export type QueueState = 'blocked' | 'done' | 'working' | 'idle'

export interface QueueEntry {
  state: QueueState
  /** Epoch ms of the last state change. Drives the "4m" label and the order. */
  since: number
  /** Why, in the program's own words (OSC 7501 `msg`). */
  note?: string
}

export type ProgramState = 'idle' | 'working' | 'done' | 'blocked' | 'error' | 'clear'

export interface ProgramStatus {
  state: ProgramState
  note?: string
}

/** How many sections the rail shows, most urgent first. */
export const QUEUE_SECTIONS: { state: QueueState; label: string; tone: string }[] = [
  { state: 'blocked', label: 'Needs you', tone: 'text-red-400' },
  { state: 'done', label: 'Done', tone: 'text-emerald-400' },
  { state: 'working', label: 'Working', tone: 'text-amber-400' },
  { state: 'idle', label: 'Idle', tone: 'text-zinc-500' },
]

const MAX_NOTE = 140

function decodeNote(b64: string): string | undefined {
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const text = new TextDecoder().decode(bytes).trim()
    return text ? text.slice(0, MAX_NOTE) : undefined
  } catch {
    return undefined
  }
}

const PROGRAM_STATES: ReadonlySet<string> = new Set(['idle', 'working', 'done', 'blocked', 'error', 'clear'])

/**
 * Parse the payload of an OSC 7501 report, e.g. `state=working:app=claude-code`
 * or `state=blocked:kind=permission:msg=QXBwbHk/`. Records with an `id` other
 * than the root describe sub-tasks and aren't the pane's own state, so they're
 * ignored, as is the `?` query. Unknown states return null.
 */
export function parseProgramStatus(payload: string): ProgramStatus | null {
  const fields = new Map<string, string>()
  for (const part of payload.split(':')) {
    const eq = part.indexOf('=')
    if (eq > 0) fields.set(part.slice(0, eq), part.slice(eq + 1))
  }
  const state = fields.get('state')
  if (!state || !PROGRAM_STATES.has(state) || fields.has('id')) return null
  const msg = fields.get('msg')
  return { state: state as ProgramState, note: msg ? decodeNote(msg) : undefined }
}

// Wordings the common CLIs use when they stop for an answer. Only consulted when
// a turn the user started goes quiet, so a stray match in old scrollback can't
// raise a false alarm on its own.
const WAITING_FOR_ANSWER = new RegExp(
  [
    String.raw`do you want to (proceed|make this edit|create|run|allow)`,
    String.raw`\[y(es)?/n(o)?\]`,
    String.raw`\(y(es)?/n(o)?\)`,
    String.raw`allow (this|execution|command)`,
    String.raw`password( for [^:]*)?:\s*$`,
  ].join('|'),
  'im',
)

/** True when the bottom of the screen is a question waiting for an answer. */
export function looksBlocked(screen: string): boolean {
  const lines = screen.split('\n').map((l) => l.trimEnd()).filter(Boolean)
  return WAITING_FOR_ANSWER.test(lines.slice(-12).join('\n'))
}

export function timeAgo(since: number | undefined, now = Date.now()): string {
  if (!since) return ''
  const minutes = Math.floor((now - since) / 60000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export interface QueueGroup<T> {
  key: string
  label: string
  tone: string
  items: T[]
}

/**
 * Pinned panes first, then one group per state. Within a group the pane that has
 * waited longest comes first; ties keep the caller's order.
 */
export function groupQueue<T extends { id: string; pinned?: boolean }>(
  items: T[],
  queue: Record<string, QueueEntry>,
): QueueGroup<T>[] {
  const stateOf = (it: T) => queue[it.id]?.state ?? 'idle'
  const oldestFirst = (a: T, b: T) => (queue[a.id]?.since ?? 0) - (queue[b.id]?.since ?? 0)
  const groups: QueueGroup<T>[] = []
  const pinned = items.filter((it) => it.pinned)
  if (pinned.length) groups.push({ key: 'pinned', label: 'Pinned', tone: 'text-zinc-400', items: pinned })
  for (const s of QUEUE_SECTIONS) {
    const inState = items.filter((it) => !it.pinned && stateOf(it) === s.state).sort(oldestFirst)
    if (inState.length) groups.push({ key: s.state, label: s.label, tone: s.tone, items: inState })
  }
  return groups
}
