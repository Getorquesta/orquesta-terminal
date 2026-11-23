'use client'

// ── Floor: orchestra theme ───────────────────────────────────────────────────
// The panes drawn as a stage plot: each agent is a seat card on a curved riser,
// grouped into one section per owner, the way an orchestra seats its sections
// around the podium. The owners are the conductors, listed at the podium.
// State lives on the card: level bars while playing (working), an amber pulse
// when the agent needs its owner, green when its part is done, dimmed at rest.
// Styled after getorquesta's Studio: zinc rail with people, agents, activity.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
interface FeedItem { key: number; at: number; id: string; name: string; owner: string; to: QueueState }

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


// ── rail ──
function Rail({ agents, looks, owners, feed, selected, onSelect, onOpen }: {
  agents: FloorAgent[]
  looks: Map<string, OtLook>
  owners: { name: string }[]
  feed: FeedItem[]
  selected: FloorAgent | undefined
  onSelect: (id: string) => void
  onOpen: (id: string) => void
}) {
  const sorted = [...agents].sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || (a.since ?? 0) - (b.since ?? 0))
  return (
    <aside className="flex w-[300px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-zinc-800 p-3" aria-label="Floor details">
      {selected ? (
        <section className="orc-in rounded-xl border border-zinc-800 bg-zinc-900/60 p-3" key={selected.id} aria-live="polite">
          <div className="flex items-center gap-2.5">
            <span className="rounded-lg bg-zinc-800/80 p-1"><OtThumb look={looks.get(selected.id)!} size={30} /></span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-zinc-100">{selected.name}</div>
              <div className="truncate font-mono text-[11px] text-zinc-500">{selected.cli}{selected.branch ? ` · ⎇ ${selected.branch}` : ''}</div>
            </div>
            <StateChip state={selected.state} />
          </div>
          <div className="mt-3 flex items-center gap-2 text-xs text-zinc-400">
            <Avatar name={ownerOf(selected)} size={18} />
            <span className="text-zinc-300">{ownerOf(selected)}</span>
            <span className="text-zinc-600">responsible</span>
            <span className="flex-1" />
            {selected.since && selected.state !== 'idle' && <span className="tabular-nums text-zinc-500">{timeAgo(selected.since)}</span>}
          </div>
          {selected.note && (
            <p className={`mt-3 rounded-lg border px-2.5 py-2 text-[12.5px] leading-snug ${selected.state === 'blocked' ? 'border-amber-400/30 bg-amber-400/[0.07] text-amber-100' : 'border-zinc-800 bg-zinc-950/60 text-zinc-300'}`}>
              {selected.note}
            </p>
          )}
          <button
            onClick={() => onOpen(selected.id)}
            className="mt-3 w-full rounded-lg bg-zinc-100 px-3 py-1.5 text-[13px] font-medium text-zinc-900 transition-colors duration-[120ms] hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-400"
          >
            {selected.state === 'blocked' ? 'Answer in terminal' : selected.state === 'done' ? 'Review in terminal' : 'Open terminal'}
          </button>
        </section>
      ) : (
        <section className="rounded-xl border border-dashed border-zinc-800 p-3 text-xs text-zinc-500">
          Select an agent to see what it is doing and who is responsible for it.
        </section>
      )}

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
        <Eyebrow>People</Eyebrow>
        <ul className="space-y-1.5">
          {owners.map((o) => {
            const mine = agents.filter((a) => ownerOf(a) === o.name)
            const waiting = mine.filter((a) => a.state === 'blocked').length
            const working = mine.filter((a) => a.state === 'working').length
            return (
              <li key={o.name} className="flex items-center gap-2 text-[13px]">
                <Avatar name={o.name} />
                <span className="min-w-0 flex-1 truncate text-zinc-200">{o.name}</span>
                <span className="shrink-0 text-[11px] tabular-nums text-zinc-500" title={`${mine.length} agents, ${working} working`}>
                  {mine.length} · <span style={{ color: working ? STATE_HEX.working : undefined }}>{working} busy</span>
                </span>
                {waiting > 0 && <span className="rounded-full px-1.5 text-[11px] font-semibold text-zinc-900" style={{ background: STATE_HEX.blocked }}>{waiting} waiting</span>}
              </li>
            )
          })}
        </ul>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
        <Eyebrow>Agents</Eyebrow>
        <ul className="-mx-1.5 space-y-0.5">
          {sorted.map((a) => (
            <li key={a.id}>
              <button
                onClick={() => onSelect(a.id)}
                onDoubleClick={() => onOpen(a.id)}
                aria-pressed={selected?.id === a.id}
                className={`flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors duration-[120ms] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-400 ${selected?.id === a.id ? 'bg-zinc-800/80' : 'hover:bg-zinc-800/40'}`}
              >
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: STATE_HEX[a.state] }} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-zinc-200">{a.name}</span>
                  {a.note && a.state !== 'idle' && <span className="block truncate text-[11px] text-zinc-500">{a.note}</span>}
                </span>
                <Avatar name={ownerOf(a)} size={18} />
                <span className="w-8 shrink-0 text-right text-[11px] tabular-nums text-zinc-500">{a.state !== 'idle' ? timeAgo(a.since) : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
        <Eyebrow>Activity</Eyebrow>
        {feed.length === 0 ? (
          <p className="text-xs text-zinc-600">State changes show up here.</p>
        ) : (
          <ul className="space-y-1.5">
            {feed.map((f) => (
              <li key={f.key} className="orc-in flex items-start gap-2 text-[12px] leading-snug">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: STATE_HEX[f.to] }} aria-hidden />
                <span className="min-w-0 flex-1 text-zinc-400">
                  <button onClick={() => onSelect(f.id)} className="text-zinc-200 hover:underline">{f.name}</button>
                  {f.to === 'blocked' ? ` needs ${f.owner === ME ? 'you' : f.owner}` : f.to === 'done' ? ' finished' : f.to === 'working' ? ' started working' : ' went idle'}
                </span>
                <span className="shrink-0 tabular-nums text-zinc-600">{timeAgo(f.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
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
export function OrchestraScene({ agents, onOpen }: { agents: FloorAgent[]; onOpen: (id: string) => void }) {
    const { arc, radii, span, seatOf, sections, cardScale, W, pitW, height } = useMemo(() => stage(agents), [agents])
  const looks = useMemo(() => new Map(agents.map((a) => [a.id, otLook(a.id, a.cli)])), [agents])

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = agents.find((a) => a.id === selectedId)

  // activity feed from state transitions
  const prev = useRef(new Map<string, QueueState>())
  const feedKey = useRef(0)
  const [feed, setFeed] = useState<FeedItem[]>([])
  useEffect(() => {
    const items: FeedItem[] = []
    for (const a of agents) {
      const was = prev.current.get(a.id)
      if (was && was !== a.state) items.push({ key: ++feedKey.current, at: a.since ?? Date.now(), id: a.id, name: a.name, owner: ownerOf(a), to: a.state })
      prev.current.set(a.id, a.state)
    }
    if (items.length) setFeed((f) => [...items.reverse(), ...f].slice(0, 8))
  }, [agents])

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
              {sections.map((s) => {
                const mine = agents.filter((a) => ownerOf(a) === s.name)
                const waiting = mine.filter((a) => a.state === 'blocked').length
                const playing = mine.filter((a) => a.state === 'working').length
                return (
                  <span key={s.name} className="inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-[#0e0f12]/90 py-1 pl-1 pr-2.5 text-[12px] text-zinc-200"
                    style={{ boxShadow: `inset 0 -2px 0 ${s.hue}b0` }}>
                    <Avatar name={s.name} size={20} />
                    {s.name}
                    {waiting > 0
                      ? <span className="rounded-full px-1.5 text-[10.5px] font-semibold text-zinc-900" style={{ background: STATE_HEX.blocked }}>{waiting}</span>
                      : <span className="text-[11px] tabular-nums text-zinc-500">{playing}/{mine.length}</span>}
                  </span>
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
          <span className="ml-auto">One section per owner · click selects · double-click or Enter opens</span>
        </div>
      </div>

      {mounted && <Rail agents={agents} looks={looks} owners={sections} feed={feed} selected={selected} onSelect={setSelectedId} onOpen={onOpen} />}
    </div>
  )
}
