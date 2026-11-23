'use client'

// ── Floor: orchestra theme ───────────────────────────────────────────────────
// Every pane is a musician (an "ot", the 7ots character) seated at a music
// stand on a curved stage; the people who own those terminals are the
// conductors on podiums in front of their section. The stand light carries the
// state: blue while playing, amber under a spotlight when the musician stands
// and needs its conductor, green when the part is done, off when resting.
// Styled after getorquesta's Studio: zinc rail with people, agents, activity.
//
// Layers, back to front: hall SVG → for each riser (back first) the ots
// (HTML, live 7ots renderer) then their stands and instruments (SVG) →
// conductors and spotlights → hit targets. Seats never move: a stable map is
// easier to read than walking characters.

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { QUEUE_SECTIONS, timeAgo, type QueueState } from '@/lib/agentQueue'
import type { FloorAgent } from './AgentFloor'
import { OT_FOOT_X, OT_FOOT_Y, OT_H, OT_W, OtPlayer, OtThumb, otLook, type OtAct, type OtLook } from './orchestra/ots'
import { Conductor, Hall, Instrument, Notes, SeatRing, Spot, SpotDefs, STAGE_CSS, STATE_HEX, Stand, onArc, type Arc, type InstrumentKind } from './orchestra/props'

// ── stage layout (scene px before fit scaling) ──
const W = 1000
const R0 = 250 // front riser radius
const RSTEP = 100
const KY = 0.72 // vertical squash of the arcs: the hall's viewpoint
const SPAN = (62 * Math.PI) / 180 // half the angle the seats cover
const TOP_ROOM = 130 // above the back riser: heads, notes, shell
const ME = 'You'

const ownerOf = (a: FloorAgent) => a.owner?.trim() || ME

interface Seat { x: number; y: number; s: number; row: number; t: number; kind: InstrumentKind }

const KINDS: InstrumentKind[][] = [['violin', 'violin'], ['cello', 'violin'], ['horn', 'timpani'], ['horn', 'cello']]

/** Seats on concentric risers; each person's agents form one wedge, like an orchestra section. */
function stage(agents: FloorAgent[]) {
  const n = Math.max(1, agents.length)
  const rows = n <= 5 ? 1 : n <= 12 ? 2 : n <= 21 ? 3 : 4
  const radii = Array.from({ length: rows }, (_, k) => R0 + k * RSTEP)
  const sum = radii.reduce((a, b) => a + b, 0)
  const counts = radii.map((r) => Math.max(1, Math.floor((n * r) / sum)))
  for (let k = rows - 1, left = n - counts.reduce((a, b) => a + b, 0); left > 0; k = (k - 1 + rows) % rows, left--) counts[k]++
  const arc: Arc = { cx: W / 2, cy: TOP_ROOM + radii[rows - 1] * KY, ky: KY }
  const seats: Seat[] = []
  radii.forEach((r, k) => {
    for (let i = 0; i < counts[k]; i++) {
      const t = -SPAN + (2 * SPAN * (i + 0.5)) / counts[k]
      const p = onArc(arc, r, t)
      seats.push({ ...p, s: 0.98 - 0.09 * k, row: k, t, kind: KINDS[k][i % 2] })
    }
  })
  seats.sort((a, b) => a.t - b.t || a.row - b.row)
  const names: string[] = []
  for (const a of agents) { const o = ownerOf(a); if (!names.includes(o)) names.push(o) }
  const ordered = [...agents].sort((a, b) => names.indexOf(ownerOf(a)) - names.indexOf(ownerOf(b)))
  const seatOf = new Map<string, Seat>()
  ordered.forEach((a, i) => seatOf.set(a.id, seats[i]))
  // conductors: in front of the middle of their section, kept apart
  const podY = arc.cy + 8
  const owners = names.map((name) => {
    const mine = ordered.filter((a) => ownerOf(a) === name).map((a) => seatOf.get(a.id)!.t)
    const t = mine.reduce((a, b) => a + b, 0) / mine.length
    return { name, x: names.length === 1 ? W / 2 : W / 2 + Math.sin(t) * 340 }
  })
  const GAP = 150
  for (let i = 1; i < owners.length; i++) owners[i].x = Math.max(owners[i].x, owners[i - 1].x + GAP)
  const over = owners.length ? owners[owners.length - 1].x - (W - 90) : 0
  if (over > 0) owners.forEach((o) => { o.x -= over })
  for (let i = owners.length - 2; i >= 0; i--) owners[i].x = Math.min(owners[i].x, owners[i + 1].x - GAP)
  return { arc, radii, rows, seatOf, owners, podY, height: podY + 56 }
}

const URGENT_MS = 2 * 60000

function actOf(a: FloorAgent, now: number): OtAct {
  if (a.state === 'blocked') return a.since && now - a.since > URGENT_MS ? 'urgent' : 'call'
  if (a.state === 'done') return 'serve'
  if (a.state === 'working') return 'work'
  return 'sleep'
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


// ── scene ──
export function OrchestraScene({ agents, onOpen }: { agents: FloorAgent[]; onOpen: (id: string) => void }) {
  const uid = 'o' + useId().replace(/[^a-zA-Z0-9]/g, '')
  const { arc, radii, rows, seatOf, owners, podY, height } = useMemo(() => stage(agents), [agents])
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
    const fit = () => setScale(Math.max(0.3, Math.min(1.25, (el.clientWidth - 32) / W, (el.clientHeight - 32) / height)))
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [height])

  const [paused, setPaused] = useState(false)
  useEffect(() => {
    const onVis = () => setPaused(document.visibilityState === 'hidden')
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const now = Date.now()
  const count = (s: QueueState) => agents.filter((a) => a.state === s).length
  const oldest = agents.filter((a) => a.state === 'blocked' && a.since).sort((a, b) => a.since! - b.since!)[0]
  const byRow = (k: number) => agents.filter((a) => seatOf.get(a.id)?.row === k)
  const STAND_UP = 12 // a waiting musician stands up

  return (
    <div className="flex min-h-0 flex-1 bg-[#08090b] text-zinc-300">
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

        <div ref={box} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
          {mounted && <div
            className={`orc-root relative overflow-hidden rounded-xl border border-zinc-800 shadow-[0_24px_48px_-24px_#000] ${paused ? 'orc-paused' : ''}`}
            style={{ width: W, height, transform: `scale(${scale})`, transformOrigin: 'center', flex: 'none' }}
            role="group"
            aria-label="Orchestra: every musician is a terminal, the conductors in front own them"
          >
            {/* hall */}
            <svg className="absolute inset-0" width={W} height={height} viewBox={`0 0 ${W} ${height}`} aria-hidden>
              <Hall uid={uid} w={W} h={height} arc={arc} radii={radii} span={SPAN} />
              {agents.map((a) => {
                const p = seatOf.get(a.id)!
                return selectedId === a.id ? <SeatRing key={a.id} x={p.x} y={p.y} s={p.s} /> : null
              })}
            </svg>

            {/* risers, back to front: musicians, then their stands */}
            {Array.from({ length: rows }, (_, i) => rows - 1 - i).map((k) => (
              <div key={k} className="pointer-events-none absolute inset-0">
                {byRow(k).map((a) => {
                  const p = seatOf.get(a.id)!
                  const up = a.state === 'blocked' ? STAND_UP * p.s : 0
                  return (
                    <div key={a.id} className="absolute left-0 top-0"
                      style={{ width: OT_W, height: OT_H, transform: `translate3d(${p.x - OT_FOOT_X}px, ${p.y - OT_FOOT_Y}px, 0)` }}>
                      <div style={{ transformOrigin: `${OT_FOOT_X}px ${OT_FOOT_Y}px`, transform: `translateY(${-up}px) scale(${p.s})`, transition: 'transform .5s cubic-bezier(.3,.8,.3,1)', opacity: a.state === 'idle' ? 0.7 : 1 }}>
                        <OtPlayer look={looks.get(a.id)!} act={actOf(a, now)} />
                      </div>
                    </div>
                  )
                })}
                <svg className="absolute inset-0" width={W} height={height} viewBox={`0 0 ${W} ${height}`} aria-hidden>
                  {byRow(k).map((a, i) => {
                    const p = seatOf.get(a.id)!
                    const busy = a.state === 'working'
                    return (
                      <g key={a.id}>
                        <Instrument kind={p.kind} x={p.x} y={p.y} s={p.s} busy={busy} />
                        <Stand x={p.x} y={p.y} s={p.s} color={STATE_HEX[a.state]} lit={a.state !== 'idle'} name={a.name}
                          selected={selectedId === a.id} />
                        {busy && <Notes x={p.x} y={p.y} s={p.s} seed={i + k * 7} />}
                      </g>
                    )
                  })}
                </svg>
              </div>
            ))}

            {/* conductors and spotlights */}
            <svg className="pointer-events-none absolute inset-0" width={W} height={height} viewBox={`0 0 ${W} ${height}`} aria-hidden>
              <SpotDefs uid={uid} />
              <g style={{ mixBlendMode: 'screen' }}>
                {agents.map((a) => {
                  if (a.state !== 'blocked') return null
                  const p = seatOf.get(a.id)!
                  return <Spot key={a.id} uid={uid} x={p.x} y={p.y} s={p.s} />
                })}
              </g>
              {owners.map((o) => {
                const mine = agents.filter((a) => ownerOf(a) === o.name)
                return (
                  <Conductor key={o.name} x={o.x} y={podY} name={o.name} hue={hueOf(o.name)}
                    waiting={mine.filter((a) => a.state === 'blocked').length}
                    conducting={mine.some((a) => a.state === 'working')} />
                )
              })}
            </svg>

            {/* hit targets with a hover name */}
            <div className="absolute inset-0">
              {agents.map((a) => {
                const p = seatOf.get(a.id)!
                const owner = ownerOf(a)
                const label = `${a.name}, ${a.cli}, owned by ${owner}: ${LABEL[a.state]}${a.note ? `. ${a.note}` : ''}. Enter opens the terminal`
                const sel = selectedId === a.id
                const w = 92 * p.s, h = 110 * p.s
                return (
                  <div
                    key={a.id}
                    role="button"
                    tabIndex={0}
                    aria-label={label}
                    aria-pressed={sel}
                    onClick={() => setSelectedId(a.id)}
                    onDoubleClick={() => onOpen(a.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); onOpen(a.id) }
                      else if (e.key === ' ') { e.preventDefault(); setSelectedId(a.id) }
                    }}
                    className="group absolute cursor-pointer rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-green-400"
                    style={{ left: p.x - w / 2, top: p.y - h + 8 * p.s, width: w, height: h }}
                  >
                    <span className={`pointer-events-none absolute bottom-full left-1/2 mb-1 flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-md border border-zinc-700/80 bg-zinc-900/95 py-0.5 pl-1.5 pr-1 text-[12px] font-medium text-zinc-100 shadow-[0_4px_12px_-4px_#000] transition-opacity duration-[120ms] ${sel ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'}`}>
                      <span className="h-2 w-2 rounded-full" style={{ background: STATE_HEX[a.state] }} aria-hidden />
                      {a.name}
                      <span className="text-zinc-500">· {owner}</span>
                    </span>
                  </div>
                )
              })}
            </div>
          </div>}
        </div>

        {/* legend */}
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-zinc-800 px-4 py-2 text-[11px] text-zinc-500">
          {ORDER.map((s) => (
            <span key={s} className="inline-flex items-center gap-1.5">
              <span className="h-1.5 w-3 rounded-full" style={{ background: STATE_HEX[s] }} aria-hidden />
              {s === 'blocked' ? 'Needs you: stands up in the spotlight' : s === 'done' ? 'Done: part finished' : s === 'working' ? 'Working: playing' : 'Idle: resting'}
            </span>
          ))}
          <span className="ml-auto">Conductors own their section · click selects · double-click or Enter opens</span>
        </div>
      </div>

      {mounted && <Rail agents={agents} looks={looks} owners={owners} feed={feed} selected={selected} onSelect={setSelectedId} onOpen={onOpen} />}
    </div>
  )
}
