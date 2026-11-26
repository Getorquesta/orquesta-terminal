'use client'

// ── Floor: orchestra theme ───────────────────────────────────────────────────
// The panes drawn as a stage plot: each agent is a seat card on a curved riser,
// grouped into one section per owner, the way an orchestra seats its sections
// around the podium. The owners are the conductors, listed at the podium.
// State lives on the card: level bars while playing (working), an amber pulse
// when the agent needs its owner, green when its part is done, dimmed at rest.
// Styled after getorquesta's Studio: zinc rail with people, agents, activity.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Mic, Plus, SendHorizontal, Users, Video, X } from 'lucide-react'
import { QUEUE_SECTIONS, timeAgo, type QueueState } from '@/lib/agentQueue'
import type { FloorAgent } from './AgentFloor'
import { OtThumb, otLook, type OtLook } from './orchestra/ots'
import { Equalizer, StagePlot, STAGE_CSS, STATE_HEX, onArc, type Arc, type Section } from './orchestra/props'

// ── stage layout (scene px before fit scaling) ──
const R0 = 360 // front riser radius
const BAND = 140 // riser depth
const KY = 0.9 // slight squash: the plot seen from the hall
const CARD_W = 172
const CARD_H = 54
const HALF = (60 * Math.PI) / 180 // widest seat angle either side of centre
const MAX_ROWS = 4
const RIM = BAND / 2 + 24 // back riser centre to the rim colour bar
const TOP = RIM * KY + 14 // room above the back riser for the rim
const ME = 'You'

const ownerOf = (a: FloorAgent) => a.owner?.trim() || ME

interface Seat { x: number; y: number; row: number; t: number }

/** Angle between neighbours on a riser of radius r so their cards just clear. */
const pitchAt = (r: number) => 2 * Math.asin(Math.min(1, (CARD_W + 20) / 2 / r))

/**
 * Seats on concentric risers. Outer risers are longer and hold more seats, like
 * a real orchestra; each person's agents form one contiguous section.
 */
function stage(agents: FloorAgent[]) {
  const n = Math.max(1, agents.length)
  const capOf = (r: number) => Math.max(1, Math.floor((2 * HALF) / pitchAt(r)) + 1)
  let rows = 1
  while (rows < MAX_ROWS && Array.from({ length: rows }, (_, k) => capOf(R0 + k * BAND)).reduce((a, b) => a + b, 0) < n) rows++
  const radii = Array.from({ length: rows }, (_, k) => R0 + k * BAND)
  const caps = radii.map(capOf)
  const capSum = caps.reduce((a, b) => a + b, 0)
  const counts = caps.map((c) => Math.max(1, Math.floor((n * c) / capSum)))
  for (let k = rows - 1, left = n - counts.reduce((a, b) => a + b, 0); left > 0; k = (k - 1 + rows) % rows, left--) counts[k]++
  while (counts.reduce((a, b) => a + b, 0) > n) counts[counts.indexOf(Math.max(...counts))]--
  const rMax = radii[rows - 1]
  const pitches = radii.map((r, k) => (counts[k] > 1 ? Math.min(pitchAt(r) * 1.12, (2 * HALF) / (counts[k] - 1)) : 0))
  const span = Math.max(...radii.map((r, k) => ((counts[k] - 1) / 2) * pitches[k] + pitchAt(r) / 2))
  const xs = radii.map((r, k) => r * Math.sin(((counts[k] - 1) / 2) * pitches[k]))
  const W = Math.ceil(2 * Math.max(Math.max(...xs) + CARD_W / 2 + 28, (rMax + RIM) * Math.sin(Math.min(span + 0.06, Math.PI / 2)) + 16))
  const arc: Arc = { cx: W / 2, cy: TOP + rMax * KY, ky: KY }
  const seats: Seat[] = []
  radii.forEach((r, k) => {
    for (let i = 0; i < counts[k]; i++) {
      const t = pitches[k] * (i - (counts[k] - 1) / 2)
      seats.push({ ...onArc(arc, r, t), row: k, t })
    }
  })
  seats.sort((a, b) => a.t - b.t || a.row - b.row)
  // cards shrink only as much as needed for no two to touch
  let cardScale = 1
  for (let i = 0; i < seats.length; i++) for (let j = i + 1; j < seats.length; j++) {
    const dx = Math.abs(seats[i].x - seats[j].x) - 10, dy = Math.abs(seats[i].y - seats[j].y) - 8
    cardScale = Math.min(cardScale, Math.max(dx / CARD_W, dy / CARD_H))
  }
  cardScale = Math.max(0.55, cardScale)
  const names: string[] = []
  for (const a of agents) { const o = ownerOf(a); if (!names.includes(o)) names.push(o) }
  const ordered = [...agents].sort((a, b) => names.indexOf(ownerOf(a)) - names.indexOf(ownerOf(b)))
  const seatOf = new Map<string, Seat>()
  ordered.forEach((a, i) => seatOf.set(a.id, seats[i]))
  const ts = names.map((name) => ordered.filter((a) => ownerOf(a) === name).map((a) => seatOf.get(a.id)!.t))
  const edge = span + 0.06
  const sections: Section[] = names.map((name, i) => {
    const t0 = i === 0 ? -edge : (Math.max(...ts[i - 1]) + Math.min(...ts[i])) / 2
    const t1 = i === names.length - 1 ? edge : (Math.max(...ts[i]) + Math.min(...ts[i + 1])) / 2
    return { name, t0, t1, mid: (t0 + t1) / 2, hue: hueOf(name) }
  })
  // the podium sits in the open pit in front of the first riser
  const pitW = 2 * (R0 - BAND / 2 - 14) * 0.9
  return { arc, radii, span, seatOf, sections, cardScale, W, pitW, height: arc.cy + 14 }
}

// ── shared bits ──
interface FeedItem { key: number; at: number; id: string; name: string; owner: string; to: QueueState; note?: string; seeded?: boolean; said?: boolean }

/** Who a message or a meet goes to: one agent, one person, or a room of both. */
export interface Room { agents: string[]; people: string[] }
export interface OrchestraActions {
  /** Type a prompt into the agent's terminal and submit it. False when it has no live session. */
  onSend?: (agentId: string, text: string) => boolean | void
  /** Message people (team chat). */
  onMessage?: (people: string[], text: string) => void
  /** Start a voice/video meet with these agents and people. */
  onMeet?: (room: Room) => void
}
type Pick = { kind: 'agent' | 'person'; id: string } | { kind: 'room' }
interface Said { at: number; text: string; ok: boolean }

const LABEL: Record<QueueState, string> = Object.fromEntries(QUEUE_SECTIONS.map((s) => [s.state, s.label])) as Record<QueueState, string>
const ORDER: QueueState[] = ['blocked', 'done', 'working', 'idle']
const HUES = ['#86efac', '#7dd3fc', '#c4b5fd', '#fcd34d', '#fda4af', '#5eead4', '#fdba74', '#f0abfc']

function hueOf(name: string) {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return HUES[h % HUES.length]
}
const initials = (name: string) => name.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?'

function Avatar({ name, size = 22 }: { name: string; size?: number }) {
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-zinc-900"
      style={{ width: size, height: size, background: hueOf(name), fontSize: size * 0.42 }} aria-hidden>
      {initials(name)}
    </span>
  )
}

function StateChip({ state }: { state: QueueState }) {
  const c = STATE_HEX[state]
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ background: `${c}26`, color: c }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: c }} />
      {LABEL[state]}
    </span>
  )
}

const Eyebrow = ({ children }: { children: React.ReactNode }) => (
  <div className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.16em] text-zinc-500">{children}</div>
)


// ── rail: who you are looking at, and talking to them ──
function Composer({ placeholder, disabled, hint, onSay }: { placeholder: string; disabled?: boolean; hint?: string; onSay: (text: string) => void }) {
  const [text, setText] = useState('')
  const [listening, setListening] = useState(false)
  const rec = useRef<{ stop: () => void } | null>(null)
  type SR = new () => { lang: string; interimResults: boolean; continuous: boolean; start: () => void; stop: () => void; onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void; onend: () => void }
  const SpeechRec = typeof window !== 'undefined' ? ((window as unknown as { SpeechRecognition?: SR; webkitSpeechRecognition?: SR }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: SR }).webkitSpeechRecognition) : undefined
  useEffect(() => () => rec.current?.stop(), [])
  const say = () => { const t = text.trim(); if (!t || disabled) return; onSay(t); setText('') }
  const talk = () => {
    if (!SpeechRec) return
    if (listening) { rec.current?.stop(); return }
    const r = new SpeechRec()
    r.lang = navigator.language || 'en-US'
    r.interimResults = true
    r.continuous = false
    const base = text ? text.replace(/\s*$/, ' ') : ''
    r.onresult = (e) => setText(base + Array.from(e.results).map((x) => x[0].transcript).join(''))
    r.onend = () => { setListening(false); rec.current = null }
    rec.current = r
    setListening(true)
    r.start()
  }
  return (
    <div className="mt-3">
      <div className={`flex items-end gap-1 rounded-lg border bg-zinc-950/70 p-1 focus-within:border-zinc-600 ${listening ? 'border-red-400/50' : 'border-zinc-800'}`}>
        <textarea value={text} rows={1} disabled={disabled} placeholder={placeholder} aria-label={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); say() } }}
          className="max-h-28 min-h-[30px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[12.5px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none disabled:opacity-50" />
        {SpeechRec && (
          <button onClick={talk} disabled={disabled} title={listening ? 'Stop dictation' : 'Talk (dictate)'} aria-pressed={listening}
            className={`grid h-7 w-7 place-items-center rounded-md transition-colors duration-[120ms] disabled:opacity-40 ${listening ? 'bg-red-500/20 text-red-300' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100'}`}>
            <Mic className="h-3.5 w-3.5" />
          </button>
        )}
        <button onClick={say} disabled={disabled || !text.trim()} title="Send (Enter)"
          className="grid h-7 w-7 place-items-center rounded-md bg-zinc-100 text-zinc-900 transition-colors duration-[120ms] hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-600">
          <SendHorizontal className="h-3.5 w-3.5" />
        </button>
      </div>
      {hint && <p className="mt-1 px-1 text-[10.5px] text-zinc-600">{hint}</p>}
    </div>
  )
}

function Thread({ items }: { items: { at: number; text: string; mine: boolean; ok?: boolean; tone?: string }[] }) {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => end.current?.scrollIntoView({ block: 'nearest' }), [items.length])
  if (!items.length) return null
  return (
    <div className="mt-3 max-h-56 space-y-1.5 overflow-y-auto pr-0.5">
      {items.map((m, i) => (
        <div key={i} className={`flex ${m.mine ? 'justify-end' : 'justify-start'}`}>
          <div className={`max-w-[85%] rounded-xl px-2.5 py-1.5 text-[12px] leading-snug ${m.mine ? 'rounded-br-sm bg-zinc-100 text-zinc-900' : 'rounded-bl-sm border border-zinc-800 bg-zinc-950/70 text-zinc-300'}`}
            style={m.tone ? { borderColor: `${m.tone}55` } : undefined}>
            {m.text}
            <span className={`ml-1.5 text-[10px] tabular-nums ${m.mine ? 'text-zinc-500' : 'text-zinc-600'}`}>{clock(m.at)}{m.mine && !m.ok ? ' · not delivered' : ''}</span>
          </div>
        </div>
      ))}
      <div ref={end} />
    </div>
  )
}

const ghostBtn = 'inline-flex items-center justify-center gap-1.5 rounded-lg border border-zinc-800 px-2.5 py-1.5 text-[12px] text-zinc-300 transition-colors duration-[120ms] hover:border-zinc-700 hover:bg-zinc-800/60 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-400 disabled:opacity-40'

function Workflow({ steps }: { steps: { label: string; state: 'done' | 'active' | 'todo' }[] }) {
  return (
    <ol className="relative mt-1 space-y-2 pl-4">
      <span className="absolute bottom-1.5 left-[4.5px] top-1.5 w-px bg-zinc-800" aria-hidden />
      {steps.map((st, i) => (
        <li key={i} className="relative text-[12px] leading-snug">
          <span className="absolute -left-4 top-1 grid h-2.5 w-2.5 place-items-center rounded-full border"
            style={st.state === 'done' ? { background: STATE_HEX.done, borderColor: STATE_HEX.done }
              : st.state === 'active' ? { background: '#08090b', borderColor: STATE_HEX.working, boxShadow: `0 0 0 3px ${STATE_HEX.working}33` }
              : { background: '#08090b', borderColor: '#3f434c' }} aria-hidden />
          <span className={st.state === 'todo' ? 'text-zinc-600' : st.state === 'active' ? 'text-zinc-100' : 'text-zinc-400'}>{st.label}</span>
        </li>
      ))}
    </ol>
  )
}

function Rail({ agents, looks, people, pick, onPick, onOpen, history, threads, room, onToggleRoom, onClearRoom, onSay, actions }: {
  agents: FloorAgent[]
  looks: Map<string, OtLook>
  people: string[]
  pick: Pick | null
  onPick: (p: Pick | null) => void
  onOpen: (id: string) => void
  history: FeedItem[]
  threads: Record<string, Said[]>
  room: Room
  onToggleRoom: (kind: 'agents' | 'people', id: string) => void
  onClearRoom: () => void
  onSay: (key: string, text: string) => void
  actions: OrchestraActions
}) {
  const sorted = [...agents].sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || (a.since ?? 0) - (b.since ?? 0))
  const agent = pick?.kind === 'agent' ? agents.find((a) => a.id === pick.id) : undefined
  const person = pick?.kind === 'person' ? pick.id : undefined
  const roomSize = room.agents.length + room.people.length
  const inRoom = (kind: 'agents' | 'people', id: string) => room[kind].includes(id)
  const mine = (key: string) => (threads[key] ?? []).map((m) => ({ ...m, mine: true }))

  const RoomBtn = ({ kind, id }: { kind: 'agents' | 'people'; id: string }) => (
    <button className={ghostBtn} onClick={() => onToggleRoom(kind, id)} aria-pressed={inRoom(kind, id)}>
      {inRoom(kind, id) ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}{inRoom(kind, id) ? 'In room' : 'Room'}
    </button>
  )
  const MeetBtn = ({ r }: { r: Room }) => actions.onMeet ? (
    <button className={ghostBtn} onClick={() => actions.onMeet!(r)}><Video className="h-3.5 w-3.5" />Meet</button>
  ) : null

  let panel: React.ReactNode
  if (agent) {
    const own = history.filter((f) => f.id === agent.id && !f.said).sort((x, y) => x.at - y.at)
    const steps = agent.steps?.length ? agent.steps
      : own.map((f, i) => ({ label: f.note || verbOf(f), state: (i === own.length - 1 && (agent.state === 'working' || agent.state === 'blocked') ? 'active' : 'done') as 'done' | 'active' }))
    const replies = own.filter((f) => f.note && !f.seeded).map((f) => ({ at: f.at, text: f.note!, mine: false, tone: STATE_HEX[f.to] }))
    const thread = [...mine(`a:${agent.id}`), ...replies].sort((x, y) => x.at - y.at)
    panel = (
      <section className="orc-in rounded-xl border border-zinc-800 bg-zinc-900/60 p-3" key={agent.id} aria-live="polite">
        <div className="flex items-center gap-2.5">
          <span className="rounded-lg bg-zinc-800/80 p-1"><OtThumb look={looks.get(agent.id)!} size={30} /></span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-zinc-100">{agent.name}</div>
            <div className="truncate font-mono text-[11px] text-zinc-500">{agent.cli}{agent.branch ? ` · ⎇ ${agent.branch}` : ''}</div>
          </div>
          <StateChip state={agent.state} />
        </div>
        <button onClick={() => onPick({ kind: 'person', id: ownerOf(agent) })} className="mt-3 flex w-full items-center gap-2 rounded-md text-left text-xs text-zinc-400 hover:text-zinc-200">
          <Avatar name={ownerOf(agent)} size={18} />
          <span className="text-zinc-300">{ownerOf(agent)}</span>
          <span className="text-zinc-600">responsible</span>
          <span className="flex-1" />
          {agent.since && agent.state !== 'idle' && <span className="tabular-nums text-zinc-500">{timeAgo(agent.since)}</span>}
        </button>

        {agent.goal && (
          <div className="mt-3">
            <Eyebrow>Goal</Eyebrow>
            <p className="text-[12.5px] leading-snug text-zinc-200">{agent.goal}</p>
          </div>
        )}
        {agent.note && (agent.state === 'blocked' || !replies.length) && (
          <p className={`mt-3 rounded-lg border px-2.5 py-2 text-[12.5px] leading-snug ${agent.state === 'blocked' ? 'border-amber-400/30 bg-amber-400/[0.07] text-amber-100' : 'border-zinc-800 bg-zinc-950/60 text-zinc-300'}`}>
            {agent.note}
          </p>
        )}
        {steps.length > 0 && (
          <div className="mt-3">
            <Eyebrow>Workflow</Eyebrow>
            <Workflow steps={steps} />
          </div>
        )}
        {!agent.goal && !steps.length && <p className="mt-3 text-[11.5px] text-zinc-600">No goal or workflow reported yet.</p>}

        <Thread items={thread} />
        <Composer placeholder={`Talk to ${agent.name}…`} disabled={!actions.onSend}
          hint={actions.onSend ? (agent.state === 'blocked' ? 'Your answer goes straight to its terminal.' : 'Sent to its terminal as a prompt.') : undefined}
          onSay={(t) => onSay(`a:${agent.id}`, t)} />
        <div className="mt-2 grid grid-cols-3 gap-1.5">
          <button onClick={() => onOpen(agent.id)} className="col-span-1 rounded-lg bg-zinc-800 px-2 py-1.5 text-[12px] font-medium text-zinc-100 transition-colors duration-[120ms] hover:bg-zinc-700">Terminal</button>
          <MeetBtn r={{ agents: [agent.id], people: [] }} />
          <RoomBtn kind="agents" id={agent.id} />
        </div>
      </section>
    )
  } else if (person) {
    const theirs = agents.filter((a) => ownerOf(a) === person)
    const waiting = theirs.filter((a) => a.state === 'blocked').length
    panel = (
      <section className="orc-in rounded-xl border border-zinc-800 bg-zinc-900/60 p-3" key={`p:${person}`} aria-live="polite">
        <div className="flex items-center gap-2.5">
          <Avatar name={person} size={36} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-zinc-100">{person}</div>
            <div className="text-[11px] text-zinc-500">{theirs.length} agent{theirs.length === 1 ? '' : 's'}{waiting ? <span style={{ color: STATE_HEX.blocked }}> · {waiting} waiting on them</span> : ''}</div>
          </div>
        </div>
        {theirs.length > 0 && (
          <ul className="-mx-1.5 mt-2 space-y-0.5">
            {theirs.map((a) => (
              <li key={a.id}>
                <button onClick={() => onPick({ kind: 'agent', id: a.id })} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] hover:bg-zinc-800/50">
                  <span className="h-2 w-2 rounded-full" style={{ background: STATE_HEX[a.state] }} aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-zinc-200">{a.name}</span>
                  <span className="text-[11px] text-zinc-500">{LABEL[a.state]}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {person === ME ? <p className="mt-3 text-[11.5px] text-zinc-600">That is you.</p> : <>
          <Thread items={mine(`p:${person}`)} />
          <Composer placeholder={`Message ${firstName(person)}…`} disabled={!actions.onMessage}
            hint={actions.onMessage ? 'Opens in team chat with them @mentioned.' : 'Connect to a project to message people.'}
            onSay={(t) => onSay(`p:${person}`, t)} />
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            <MeetBtn r={{ agents: [], people: [person] }} />
            <RoomBtn kind="people" id={person} />
          </div>
        </>}
      </section>
    )
  } else if (pick?.kind === 'room' && roomSize) {
    panel = (
      <section className="orc-in rounded-xl border border-zinc-800 bg-zinc-900/60 p-3" aria-live="polite">
        <div className="flex items-center gap-2 text-sm font-semibold text-zinc-100"><Users className="h-4 w-4 text-zinc-400" />Room<span className="text-[11px] font-normal text-zinc-500">{roomSize} in it</span></div>
        <Thread items={mine('room')} />
        <Composer placeholder="Message everyone in the room…" onSay={(t) => onSay('room', t)}
          hint="Agents get it as a prompt; people get it in team chat." />
        <div className="mt-2 grid grid-cols-1"><MeetBtn r={room} /></div>
      </section>
    )
  } else {
    panel = (
      <section className="rounded-xl border border-dashed border-zinc-800 p-3 text-xs leading-relaxed text-zinc-500">
        Select a musician or a person to see their goal and workflow and talk to them. Add several to a room to talk to all of them at once or start a meet.
      </section>
    )
  }

  return (
    <aside className="flex w-[320px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-zinc-800 p-3" aria-label="Floor details">
      {roomSize > 0 && (
        <section className="rounded-xl border border-zinc-700 bg-zinc-900/80 p-2.5">
          <div className="flex items-center gap-2">
            <Users className="h-3.5 w-3.5 text-zinc-400" />
            <span className="text-[12px] font-medium text-zinc-200">Room</span>
            <span className="flex-1" />
            <button onClick={() => onPick({ kind: 'room' })} className="rounded-md bg-zinc-100 px-2 py-0.5 text-[11.5px] font-medium text-zinc-900 hover:bg-white">Talk</button>
            {actions.onMeet && <button onClick={() => actions.onMeet!(room)} className="inline-flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-0.5 text-[11.5px] text-zinc-200 hover:bg-zinc-800"><Video className="h-3 w-3" />Meet</button>}
            <button onClick={onClearRoom} title="Close room" className="grid h-5 w-5 place-items-center rounded text-zinc-500 hover:text-zinc-200"><X className="h-3.5 w-3.5" /></button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {room.people.map((n) => (
              <span key={n} className="inline-flex items-center gap-1 rounded-full bg-zinc-800 py-0.5 pl-0.5 pr-1.5 text-[11px] text-zinc-200"><Avatar name={n} size={16} />{firstName(n)}
                <button onClick={() => onToggleRoom('people', n)} aria-label={`Remove ${n}`} className="text-zinc-500 hover:text-zinc-200"><X className="h-3 w-3" /></button></span>
            ))}
            {room.agents.map((id) => { const a = agents.find((x) => x.id === id); return a ? (
              <span key={id} className="inline-flex items-center gap-1 rounded-full bg-zinc-800 py-0.5 pl-1.5 pr-1.5 text-[11px] text-zinc-200"><span className="h-1.5 w-1.5 rounded-full" style={{ background: STATE_HEX[a.state] }} />{a.name}
                <button onClick={() => onToggleRoom('agents', id)} aria-label={`Remove ${a.name}`} className="text-zinc-500 hover:text-zinc-200"><X className="h-3 w-3" /></button></span>
            ) : null })}
          </div>
        </section>
      )}

      {panel}

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
        <Eyebrow>People</Eyebrow>
        <ul className="-mx-1.5 space-y-0.5">
          {people.map((name) => {
            const theirs = agents.filter((a) => ownerOf(a) === name)
            const waiting = theirs.filter((a) => a.state === 'blocked').length
            const working = theirs.filter((a) => a.state === 'working').length
            return (
              <li key={name} className="group flex items-center gap-1">
                <button onClick={() => onPick({ kind: 'person', id: name })} aria-pressed={person === name}
                  className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1 text-left text-[13px] transition-colors duration-[120ms] ${person === name ? 'bg-zinc-800/80' : 'hover:bg-zinc-800/40'}`}>
                  <Avatar name={name} />
                  <span className="min-w-0 flex-1 truncate text-zinc-200">{name}</span>
                  {waiting > 0
                    ? <span className="rounded-full px-1.5 text-[11px] font-semibold text-zinc-900" style={{ background: STATE_HEX.blocked }}>{waiting} waiting</span>
                    : <span className="shrink-0 text-[11px] tabular-nums text-zinc-500">{theirs.length ? <>{working}/{theirs.length} busy</> : 'no agents'}</span>}
                </button>
                {name !== ME && (
                  <button onClick={() => onToggleRoom('people', name)} title={inRoom('people', name) ? 'Remove from room' : 'Add to room'} aria-pressed={inRoom('people', name)}
                    className={`grid h-6 w-6 shrink-0 place-items-center rounded-md transition-opacity ${inRoom('people', name) ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 opacity-0 hover:bg-zinc-800 hover:text-zinc-100 group-hover:opacity-100 focus-visible:opacity-100'}`}>
                    {inRoom('people', name) ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
        <Eyebrow>Agents</Eyebrow>
        <ul className="-mx-1.5 space-y-0.5">
          {sorted.map((a) => (
            <li key={a.id} className="group flex items-center gap-1">
              <button
                onClick={() => onPick({ kind: 'agent', id: a.id })}
                onDoubleClick={() => onOpen(a.id)}
                aria-pressed={agent?.id === a.id}
                className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors duration-[120ms] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-400 ${agent?.id === a.id ? 'bg-zinc-800/80' : 'hover:bg-zinc-800/40'}`}
              >
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: STATE_HEX[a.state] }} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-zinc-200">{a.name}</span>
                  {(a.note || a.goal) && <span className="block truncate text-[11px] text-zinc-500">{a.state !== 'idle' && a.note ? a.note : a.goal}</span>}
                </span>
                <Avatar name={ownerOf(a)} size={18} />
                <span className="w-8 shrink-0 text-right text-[11px] tabular-nums text-zinc-500">{a.state !== 'idle' ? timeAgo(a.since) : ''}</span>
              </button>
              <button onClick={() => onToggleRoom('agents', a.id)} title={inRoom('agents', a.id) ? 'Remove from room' : 'Add to room'} aria-pressed={inRoom('agents', a.id)}
                className={`grid h-6 w-6 shrink-0 place-items-center rounded-md transition-opacity ${inRoom('agents', a.id) ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 opacity-0 hover:bg-zinc-800 hover:text-zinc-100 group-hover:opacity-100 focus-visible:opacity-100'}`}>
                {inRoom('agents', a.id) ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  )
}

// ── live feed (left) ──
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function verbOf(f: FeedItem) {
  if (f.to === 'blocked') return `needs ${f.owner === ME ? 'you' : f.owner}`
  if (f.to === 'done') return 'finished'
  if (f.to === 'working') return f.seeded ? 'is working' : 'is working on'
  return 'went idle'
}

function LiveFeed({ feed, looks, selectedId, onSelect }: {
  feed: FeedItem[]; looks: Map<string, OtLook>; selectedId: string | null; onSelect: (id: string) => void
}) {
  const now = Date.now()
  return (
    <aside className="flex w-[290px] shrink-0 flex-col border-r border-zinc-800" aria-label="What is happening">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
        <span className="relative flex h-2 w-2" aria-hidden>
          <span className="absolute inset-0 animate-ping rounded-full bg-green-400/60" />
          <span className="relative h-2 w-2 rounded-full bg-green-400" />
        </span>
        <span className="text-[13px] font-semibold text-zinc-100">Live</span>
        <span className="text-[11px] text-zinc-500">what the orchestra is doing</span>
      </div>
      <ol className="min-h-0 flex-1 overflow-y-auto px-2 py-2" aria-live="polite">
        {feed.length === 0 && <li className="px-2 py-3 text-xs text-zinc-600">Nothing is playing yet.</li>}
        {feed.map((f) => {
          if (f.said) return (
            <li key={f.key} className="orc-in flex gap-2.5 px-2 py-2">
              <Avatar name={ME} size={28} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-1.5 text-[12.5px] leading-snug">
                  <span className="font-medium text-zinc-100">You</span>
                  <span className="truncate text-zinc-500">→ {f.name}</span>
                  <span className="ml-auto shrink-0 pl-1 text-[10.5px] tabular-nums text-zinc-600">{now - f.at < 60000 ? 'now' : timeAgo(f.at, now)}</span>
                </span>
                <span className="mt-1 block rounded-md bg-zinc-100 px-2 py-1 text-[12px] leading-snug text-zinc-900">{f.note}</span>
              </span>
            </li>
          )
          const c = STATE_HEX[f.to]
          const look = looks.get(f.id)
          const fresh = !f.seeded && now - f.at < 60000
          return (
            <li key={f.key} className="orc-in">
              <button onClick={() => onSelect(f.id)}
                className={`flex w-full gap-2.5 rounded-lg px-2 py-2 text-left transition-colors duration-[120ms] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-400 ${selectedId === f.id ? 'bg-zinc-800/70' : 'hover:bg-zinc-800/40'}`}>
                <span className="relative mt-0.5 h-7 w-7 shrink-0 rounded-md bg-zinc-800/70 p-0.5">
                  {look && <OtThumb look={look} size={24} />}
                  <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[#08090b]" style={{ background: c }} aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5 text-[12.5px] leading-snug">
                    <span className="truncate font-medium text-zinc-100">{f.name}</span>
                    <span className="shrink-0" style={{ color: f.to === 'idle' ? '#71717a' : c }}>{verbOf(f)}</span>
                    <span className="ml-auto shrink-0 pl-1 text-[10.5px] tabular-nums text-zinc-600" title={f.at ? clock(f.at) : undefined}>
                      {fresh ? 'now' : f.at ? timeAgo(f.at, now) : ''}
                    </span>
                  </span>
                  {f.note && f.to !== 'idle' && (
                    <span className={`mt-1 block text-[12px] leading-snug ${f.to === 'blocked' ? 'rounded-md border border-amber-400/25 bg-amber-400/[0.06] px-2 py-1 text-amber-100' : 'line-clamp-2 text-zinc-400'}`}>
                      {f.note}
                    </span>
                  )}
                </span>
              </button>
            </li>
          )
        })}
      </ol>
    </aside>
  )
}

// ── seat card ──
const firstName = (o: string) => (o === ME ? 'you' : o.split(/\s+/)[0])

function SeatCard({ a, look, x, y, k, selected, onSelect, onOpen }: {
  a: FloorAgent; look: OtLook; x: number; y: number; k: number; selected: boolean
  onSelect: () => void; onOpen: () => void
}) {
  const owner = ownerOf(a)
  const c = STATE_HEX[a.state]
  const status = a.state === 'blocked' ? `Needs ${firstName(owner)}` : a.state === 'working' ? 'Playing' : a.state === 'done' ? 'Done' : 'Idle'
  const tone = a.state === 'blocked'
    ? 'border-amber-400/60 bg-[#1c1708]'
    : a.state === 'done' ? 'border-green-400/35 bg-[#0f1311]'
    : a.state === 'working' ? 'border-sky-400/25 bg-[#0f1217]'
    : 'border-zinc-800 bg-[#0e0f12] opacity-60'
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${a.name}, ${a.cli}, owned by ${owner}: ${LABEL[a.state]}${a.note ? `. ${a.note}` : ''}. Enter opens the terminal`}
      title={a.note || undefined}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); onOpen() }
        else if (e.key === ' ') { e.preventDefault(); onSelect() }
      }}
      className="absolute left-0 top-0 cursor-pointer outline-none [&:focus-visible>div]:ring-2 [&:focus-visible>div]:ring-green-400"
      style={{ width: CARD_W, height: CARD_H, transform: `translate(${x - CARD_W / 2}px, ${y - CARD_H / 2}px) scale(${k})` }}
    >
      {a.state === 'blocked' && <span className="orc-ring pointer-events-none absolute inset-0 rounded-xl border border-amber-400" aria-hidden />}
      <div className={`relative flex h-full items-center gap-2.5 rounded-xl border pl-2 pr-2.5 shadow-[0_8px_20px_-12px_#000] transition-[background-color,border-color,box-shadow] duration-[160ms] hover:border-zinc-500 ${tone} ${selected ? 'ring-2 ring-zinc-200/80' : ''}`}>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-800/70">
          <OtThumb look={look} size={30} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium leading-tight text-zinc-100">{a.name}</span>
          <span className="mt-0.5 flex items-center gap-1.5 text-[11px] leading-tight">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: c }} aria-hidden />
            <span className="min-w-0 flex-1 truncate" style={{ color: a.state === 'idle' ? '#71717a' : c }}>{status}</span>
            {a.state !== 'idle' && a.since && <span className="shrink-0 tabular-nums text-zinc-500">{timeAgo(a.since)}</span>}
          </span>
        </span>
        {a.state === 'working' && <Equalizer color={c} />}
      </div>
    </div>
  )
}

// ── scene ──
export function OrchestraScene({ agents, people: members = [], onOpen, ...actions }: { agents: FloorAgent[]; people?: string[]; onOpen: (id: string) => void } & OrchestraActions) {
    const { arc, radii, span, seatOf, sections, cardScale, W, pitW, height } = useMemo(() => stage(agents), [agents])
  // each agent keeps the slot it first got, so looks never shuffle as others come and go
  const slots = useRef(new Map<string, number>())
  const looks = useMemo(() => new Map(agents.map((a) => {
    if (!slots.current.has(a.id)) slots.current.set(a.id, slots.current.size)
    return [a.id, otLook(a.id, a.cli, slots.current.get(a.id))]
  })), [agents])

  const [pick, setPick] = useState<Pick | null>(null)
  const selectedId = pick?.kind === 'agent' ? pick.id : null
  const setSelectedId = useCallback((id: string | null) => setPick(id ? { kind: 'agent', id } : null), [])
  const selectedPerson = pick?.kind === 'person' ? pick.id : null
  // everyone on the podium: owners with agents first, then members without any
  const people = useMemo(() => {
    const out: string[] = []
    for (const a of agents) { const o = ownerOf(a); if (!out.includes(o)) out.push(o) }
    for (const m of members) if (m.trim() && !out.includes(m.trim())) out.push(m.trim())
    return out
  }, [agents, members])

  // rooms and what you said
  const [room, setRoom] = useState<Room>({ agents: [], people: [] })
  const toggleRoom = useCallback((kind: 'agents' | 'people', id: string) =>
    setRoom((r) => ({ ...r, [kind]: r[kind].includes(id) ? r[kind].filter((x) => x !== id) : [...r[kind], id] })), [])
  const [threads, setThreads] = useState<Record<string, Said[]>>({})

  // live feed: seeded with where every agent is now, then every state or note change
  const prev = useRef<Map<string, string> | null>(null)
  const feedKey = useRef(0)
  const [feed, setFeed] = useState<FeedItem[]>([])
  useEffect(() => {
    const item = (a: FloorAgent, seeded = false): FeedItem => ({
      key: ++feedKey.current, at: seeded ? a.since ?? 0 : Date.now(), id: a.id, name: a.name, owner: ownerOf(a), to: a.state, note: a.note, seeded,
    })
    const sig = (a: FloorAgent) => `${a.state}|${a.note ?? ''}`
    if (!prev.current) {
      prev.current = new Map(agents.map((a) => [a.id, sig(a)]))
      setFeed(agents.filter((a) => a.state !== 'idle').map((a) => item(a, true)).sort((x, y) => y.at - x.at))
      return
    }
    const items: FeedItem[] = []
    for (const a of agents) {
      const was = prev.current.get(a.id)
      if (was !== undefined && was !== sig(a)) items.push(item(a))
      prev.current.set(a.id, sig(a))
    }
    if (items.length) setFeed((f) => [...items.reverse(), ...f].slice(0, 60))
  }, [agents])

  const say = (key: string, text: string) => {
    let ok = true
    const sendTo = (id: string) => (actions.onSend ? actions.onSend(id, text) !== false : false)
    let label = ''
    if (key.startsWith('a:')) { const id = key.slice(2); ok = sendTo(id); label = agents.find((a) => a.id === id)?.name ?? id }
    else if (key.startsWith('p:')) { const n = key.slice(2); ok = !!actions.onMessage; actions.onMessage?.([n], text); label = n }
    else {
      const res = room.agents.map(sendTo)
      if (room.people.length) actions.onMessage?.(room.people, text)
      ok = res.every(Boolean) && (!room.people.length || !!actions.onMessage)
      label = 'the room'
    }
    setThreads((t) => ({ ...t, [key]: [...(t[key] ?? []), { at: Date.now(), text, ok }] }))
    setFeed((f) => [{ key: ++feedKey.current, at: Date.now(), id: key.startsWith('a:') ? key.slice(2) : '', name: label, owner: ME, to: 'idle' as QueueState, note: text, said: true }, ...f].slice(0, 60))
  }

  // relative times in the feed keep moving
  const [, setTick] = useState(0)
  useEffect(() => { const id = setInterval(() => setTick((t) => t + 1), 20000); return () => clearInterval(id) }, [])

  // fit the fixed-size stage into the available box
  const box = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const fit = () => setScale(Math.max(0.3, Math.min(1.3, (el.clientWidth - 48) / W, (el.clientHeight - 48) / height)))
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [W, height])

  const [paused, setPaused] = useState(false)
  useEffect(() => {
    const onVis = () => setPaused(document.visibilityState === 'hidden')
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const count = (s: QueueState) => agents.filter((a) => a.state === s).length
  const oldest = agents.filter((a) => a.state === 'blocked' && a.since).sort((a, b) => a.since! - b.since!)[0]

  return (
    <div className="flex min-h-0 min-w-0 flex-1 bg-[#08090b] text-zinc-300">
      <style>{STAGE_CSS}</style>
      {mounted && <LiveFeed feed={feed} looks={looks} selectedId={selectedId} onSelect={setSelectedId} />}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* KPI bar */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-2.5">
          {ORDER.map((s) => (
            <span key={s} className="inline-flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/50 px-2.5 py-1 text-xs">
              <span className="h-2 w-2 rounded-full" style={{ background: STATE_HEX[s] }} aria-hidden />
              <span className="font-semibold tabular-nums text-zinc-100">{count(s)}</span>
              <span className="text-zinc-500">{LABEL[s].toLowerCase()}</span>
            </span>
          ))}
          {mounted && oldest && (
            <button onClick={() => setSelectedId(oldest.id)}
              className="ml-auto inline-flex items-center gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-2.5 py-1 text-xs text-amber-200 transition-colors duration-[120ms] hover:bg-amber-400/15">
              Longest wait: <span className="font-semibold">{oldest.name}</span>
              <span className="tabular-nums text-amber-300/80">{timeAgo(oldest.since)}</span>
              <span className="text-amber-300/60">· {ownerOf(oldest)}</span>
            </button>
          )}
        </div>

        <div ref={box} className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden"
          style={{ background: 'radial-gradient(circle, #ffffff0d 0.8px, transparent 1.2px) 0 0 / 18px 18px, radial-gradient(ellipse 70% 60% at 50% 55%, #15171c, #08090b)' }}>
          {mounted && <div
            className={`orc-root relative ${paused ? 'orc-paused' : ''}`}
            style={{ width: W, height, transform: `scale(${scale})`, transformOrigin: 'center', flex: 'none' }}
            role="group"
            aria-label="Orchestra: every seat is a terminal, grouped into one section per owner"
          >
            <svg className="absolute inset-0" width={W} height={height} viewBox={`0 0 ${W} ${height}`} aria-hidden>
              <StagePlot arc={arc} radii={radii} band={BAND} span={span} sections={sections} />
            </svg>

            {/* seats */}
            {agents.map((a) => {
              const p = seatOf.get(a.id)!
              return (
                <SeatCard key={a.id} a={a} look={looks.get(a.id)!} x={p.x} y={p.y} k={cardScale}
                  selected={selectedId === a.id} onSelect={() => setSelectedId(a.id)} onOpen={() => onOpen(a.id)} />
              )
            })}

            {/* podium: the conductors */}
            <div className="absolute flex flex-col items-center gap-2.5" style={{ left: arc.cx - pitW / 2, width: pitW, bottom: height - arc.cy + 34 }}>
              <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-600">Podium</span>
              <div className="flex flex-wrap justify-center gap-2">
              {people.map((name) => {
                const mine = agents.filter((a) => ownerOf(a) === name)
                const waiting = mine.filter((a) => a.state === 'blocked').length
                const playing = mine.filter((a) => a.state === 'working').length
                return (
                  <button key={name} onClick={() => setPick({ kind: 'person', id: name })} aria-pressed={selectedPerson === name}
                    className={`inline-flex items-center gap-2 rounded-full border bg-[#0e0f12]/90 py-1 pl-1 pr-2.5 text-[12px] text-zinc-200 transition-colors duration-[120ms] hover:border-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-400 ${selectedPerson === name ? 'border-zinc-300' : 'border-zinc-800'}`}
                    style={{ boxShadow: `inset 0 -2px 0 ${hueOf(name)}b0`, opacity: mine.length ? 1 : 0.75 }}>
                    <Avatar name={name} size={20} />
                    {name}
                    {waiting > 0
                      ? <span className="rounded-full px-1.5 text-[10.5px] font-semibold text-zinc-900" style={{ background: STATE_HEX.blocked }}>{waiting}</span>
                      : <span className="text-[11px] tabular-nums text-zinc-500">{mine.length ? `${playing}/${mine.length}` : '—'}</span>}
                  </button>
                )
              })}
              </div>
            </div>
          </div>}
        </div>

        {/* legend */}
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-zinc-800 px-4 py-2 text-[11px] text-zinc-500">
          {ORDER.map((s) => (
            <span key={s} className="inline-flex items-center gap-1.5">
              <span className="h-1.5 w-3 rounded-full" style={{ background: STATE_HEX[s] }} aria-hidden />
              {s === 'blocked' ? 'Needs its owner' : s === 'done' ? 'Part finished' : s === 'working' ? 'Playing' : 'Resting'}
            </span>
          ))}
          <span className="ml-auto">One section per owner · click a seat or a person to talk · double-click opens the terminal</span>
        </div>
      </div>

      {mounted && <Rail agents={agents} looks={looks} people={people} pick={pick} onPick={setPick} onOpen={onOpen} history={feed}
        threads={threads} room={room} onToggleRoom={toggleRoom} onClearRoom={() => { setRoom({ agents: [], people: [] }); if (pick?.kind === 'room') setPick(null) }}
        onSay={say} actions={actions} />}
    </div>
  )
}
