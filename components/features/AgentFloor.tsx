'use client'

// ── Floor view ────────────────────────────────────────────────────────────────
// Every pane as a little robot at its own workbench, so you can see at a glance
// who is busy, who finished and who is waiting on you. Purely presentational:
// the grid owns the queue (lib/agentQueue.ts) and passes it in. Stations keep
// the grid's order so an agent never jumps desks when its state changes.
//
// Same idea as the open-source "pixel office" visualizers (Pixel Agents,
// pixtuoid, Agentis), drawn here with plain SVG + CSS so it adds no deps.

import { useEffect, useId, useState } from 'react'
import { X } from 'lucide-react'
import { QUEUE_SECTIONS, timeAgo, type QueueState } from '@/lib/agentQueue'
import { OrchestraScene } from './FloorOrchestra'

type FloorTheme = 'orchestra' | 'robots'
const THEME_KEY = 'orq-floor-theme'

function loadTheme(): FloorTheme {
  try { return localStorage.getItem(THEME_KEY) === 'robots' ? 'robots' : 'orchestra' } catch { return 'orchestra' }
}

export interface FloorAgent {
  /** Person responsible for this terminal; the local user when unset. */
  owner?: string
  id: string
  name: string
  cli: string
  state: QueueState
  since?: number
  note?: string
  branch?: string
}

const TONE: Record<QueueState, { body: string; glow: string; screen: string; ring: string }> = {
  working: { body: '#f59e0b', glow: 'rgba(245,158,11,0.18)', screen: '#fbbf24', ring: 'border-amber-500/40' },
  blocked: { body: '#ef4444', glow: 'rgba(239,68,68,0.28)', screen: '#f87171', ring: 'border-red-500/70' },
  done: { body: '#10b981', glow: 'rgba(16,185,129,0.20)', screen: '#34d399', ring: 'border-emerald-500/60' },
  idle: { body: '#71717a', glow: 'transparent', screen: '#3f3f46', ring: 'border-zinc-800' },
}

const CSS = `
@keyframes flr-bob { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-2px) } }
@keyframes flr-type-l { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-3px) } }
@keyframes flr-type-r { 0%,100% { transform: translateY(-3px) } 50% { transform: translateY(0) } }
@keyframes flr-wave { 0%,100% { transform: rotate(-12deg) } 50% { transform: rotate(18deg) } }
@keyframes flr-hop { 0%,100% { transform: translateY(0) } 30% { transform: translateY(-7px) } 60% { transform: translateY(0) } }
@keyframes flr-zzz { 0% { opacity: 0; transform: translate(0,0) scale(.7) } 30% { opacity: 1 } 100% { opacity: 0; transform: translate(10px,-18px) scale(1.1) } }
@keyframes flr-scroll { from { transform: translateY(0) } to { transform: translateY(-12px) } }
@keyframes flr-bubble { 0%,100% { transform: translateY(0) scale(1) } 50% { transform: translateY(-4px) scale(1.06) } }
@keyframes flr-blink { 0%,92%,100% { transform: scaleY(1) } 95% { transform: scaleY(.1) } }
.flr-bob { animation: flr-bob 1.1s ease-in-out infinite }
.flr-type-l { animation: flr-type-l .28s ease-in-out infinite }
.flr-type-r { animation: flr-type-r .28s ease-in-out infinite }
.flr-wave { transform-box: fill-box; transform-origin: 50% 100%; animation: flr-wave .5s ease-in-out infinite }
.flr-hop { animation: flr-hop 1.6s ease-in-out infinite }
.flr-zzz { animation: flr-zzz 2.4s ease-out infinite }
.flr-scroll { animation: flr-scroll .9s linear infinite }
.flr-bubble { animation: flr-bubble 1s ease-in-out infinite }
.flr-eye { transform-box: fill-box; transform-origin: center; animation: flr-blink 4s infinite }
@media (prefers-reduced-motion: reduce) {
  .flr-bob,.flr-type-l,.flr-type-r,.flr-wave,.flr-hop,.flr-zzz,.flr-scroll,.flr-bubble,.flr-eye { animation: none }
}
`

/** The robot, its workbench and its monitor. 120×96 viewBox. */
function Station({ state }: { state: QueueState }) {
  const t = TONE[state]
  const working = state === 'working'
  const blocked = state === 'blocked'
  const done = state === 'done'
  const idle = state === 'idle'
  const clip = `flr-scr-${useId().replace(/:/g, '')}`
  return (
    <svg viewBox="0 0 120 96" className="h-full w-full" aria-hidden>
      {/* floor glow */}
      <ellipse cx="60" cy="88" rx="50" ry="7" fill={t.glow} />
      {/* monitor */}
      <rect x="62" y="30" width="40" height="28" rx="3" fill="#18181b" stroke="#3f3f46" />
      <clipPath id={clip}><rect x="65" y="33" width="34" height="22" rx="1" /></clipPath>
      <g clipPath={`url(#${clip})`}>
        <rect x="65" y="33" width="34" height="22" fill={idle ? '#0c0c0e' : '#0f172a'} />
        {(working || blocked) && (
          <g className={working ? 'flr-scroll' : undefined}>
            {[0, 1, 2, 3, 4, 5, 6].map((i) => (
              <rect key={i} x={68 + (i % 3) * 3} y={36 + i * 4} width={10 + ((i * 7) % 15)} height="1.6" rx=".8" fill={t.screen} opacity={0.75} />
            ))}
          </g>
        )}
        {done && <path d="M74 44 l5 5 l10 -10" stroke="#34d399" strokeWidth="3" fill="none" strokeLinecap="round" />}
      </g>
      <rect x="79" y="58" width="6" height="6" fill="#27272a" />
      {/* desk */}
      <rect x="40" y="64" width="72" height="5" rx="1.5" fill="#3f3f46" />
      <rect x="46" y="69" width="4" height="17" fill="#27272a" />
      <rect x="102" y="69" width="4" height="17" fill="#27272a" />
      {/* robot */}
      <g className={working ? 'flr-bob' : done ? 'flr-hop' : undefined}>
        {/* antenna */}
        <line x1="32" y1="26" x2="32" y2="18" stroke="#a1a1aa" strokeWidth="1.5" />
        <circle cx="32" cy="16" r="3" fill={t.body}>
          {(working || blocked) && <animate attributeName="opacity" values="1;.3;1" dur={blocked ? '.6s' : '1.2s'} repeatCount="indefinite" />}
        </circle>
        {/* head */}
        <rect x="18" y="26" width="28" height="22" rx="7" fill="#e4e4e7" />
        <rect x="22" y="31" width="20" height="11" rx="4" fill="#18181b" />
        {idle ? (
          <>
            <line x1="25" y1="37" x2="30" y2="37" stroke="#71717a" strokeWidth="1.6" strokeLinecap="round" />
            <line x1="34" y1="37" x2="39" y2="37" stroke="#71717a" strokeWidth="1.6" strokeLinecap="round" />
          </>
        ) : (
          <g className="flr-eye">
            <circle cx={working ? 31 : 28} cy="36.5" r="2" fill={t.screen} />
            <circle cx={working ? 38 : 36} cy="36.5" r="2" fill={t.screen} />
          </g>
        )}
        {/* body */}
        <rect x="20" y="49" width="24" height="22" rx="5" fill={t.body} opacity={idle ? 0.55 : 1} />
        <rect x="27" y="54" width="10" height="6" rx="1.5" fill="#fafafa" opacity=".35" />
        {/* arms */}
        {working ? (
          <>
            <rect className="flr-type-l" x="42" y="57" width="12" height="4" rx="2" fill="#d4d4d8" />
            <rect className="flr-type-r" x="40" y="61" width="14" height="4" rx="2" fill="#d4d4d8" />
          </>
        ) : blocked ? (
          <>
            <rect className="flr-wave" x="44" y="34" width="4" height="16" rx="2" fill="#d4d4d8" />
            <rect x="14" y="54" width="4" height="12" rx="2" fill="#d4d4d8" />
          </>
        ) : done ? (
          <>
            <rect x="44" y="38" width="4" height="13" rx="2" fill="#d4d4d8" transform="rotate(25 46 50)" />
            <rect x="16" y="38" width="4" height="13" rx="2" fill="#d4d4d8" transform="rotate(-25 18 50)" />
          </>
        ) : (
          <>
            <rect x="44" y="54" width="4" height="12" rx="2" fill="#a1a1aa" />
            <rect x="16" y="54" width="4" height="12" rx="2" fill="#a1a1aa" />
          </>
        )}
        {/* legs / stool */}
        <rect x="24" y="71" width="5" height="10" rx="2" fill="#52525b" />
        <rect x="35" y="71" width="5" height="10" rx="2" fill="#52525b" />
      </g>
      <rect x="18" y="81" width="28" height="4" rx="2" fill="#27272a" />
      {/* idle zzz */}
      {idle && (
        <g fill="#71717a" fontSize="9" fontWeight="700" fontFamily="ui-monospace,monospace">
          <text x="46" y="26" className="flr-zzz">z</text>
          <text x="46" y="26" className="flr-zzz" style={{ animationDelay: '1.2s' }}>z</text>
        </g>
      )}
    </svg>
  )
}

function Bubble({ state }: { state: QueueState }) {
  if (state === 'blocked') {
    return (
      <span className="flr-bubble absolute left-[8%] top-0 flex h-7 w-7 items-center justify-center rounded-full bg-red-500 text-sm font-black text-white shadow-lg shadow-red-500/40">
        !
      </span>
    )
  }
  if (state === 'done') {
    return (
      <span className="absolute left-[8%] top-0 flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500 text-xs font-black text-white shadow-lg shadow-emerald-500/30">
        ✓
      </span>
    )
  }
  return null
}

export function AgentFloor({ agents, onOpen, onClose }: {
  agents: FloorAgent[]
  onOpen: (id: string) => void
  onClose: () => void
}) {
  // Re-render each 30s so "waiting 4m" labels stay honest.
  const [, setTick] = useState(0)
  const [theme, setTheme] = useState<FloorTheme>('orchestra')
  useEffect(() => { setTheme(loadTheme()) }, [])
  const pickTheme = (t: FloorTheme) => {
    setTheme(t)
    try { localStorage.setItem(THEME_KEY, t) } catch { /* per-viewer nicety only */ }
  }
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const counts = QUEUE_SECTIONS.map((s) => ({ ...s, n: agents.filter((a) => a.state === s.state).length }))
  const blocked = agents.filter((a) => a.state === 'blocked')

  return (
    <div className="absolute inset-0 z-[150] flex flex-col overflow-hidden bg-zinc-950/97 backdrop-blur-sm">
      <style>{CSS}</style>
      <div className="flex shrink-0 items-center gap-4 border-b border-zinc-800/80 px-4 py-2">
        <span className="text-sm font-medium text-zinc-200">Floor</span>
        {theme !== 'orchestra' && <><div className="flex items-center gap-3 text-xs">
          {counts.map((c) => (
            <span key={c.state} className={c.n ? c.tone : 'text-zinc-600'}>
              {c.n} {c.label.toLowerCase()}
            </span>
          ))}
        </div>
        {blocked.length > 0 && (
          <button
            onClick={() => onOpen(blocked[0].id)}
            className="ml-2 rounded-md bg-amber-400/10 px-2 py-0.5 text-xs font-medium text-amber-200 hover:bg-amber-400/20"
            title="Jump to the agent that has waited longest"
          >
            Go to {blocked[0].name} →
          </button>
        )}</>}
        <span className="flex-1" />
        <div className="flex rounded-md border border-zinc-800 p-0.5 text-[11px]">
          {(['orchestra', 'robots'] as const).map((t) => (
            <button
              key={t}
              onClick={() => pickTheme(t)}
              className={`rounded px-2 py-0.5 capitalize ${theme === t ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              {t}
            </button>
          ))}
        </div>
        <span className="text-[11px] text-zinc-500">Click an agent to open its terminal · Esc closes</span>
        <button onClick={onClose} className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" title="Close floor">
          <X className="h-4 w-4" />
        </button>
      </div>

      {agents.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">No terminals open yet.</div>
      ) : theme === 'orchestra' ? (
        <OrchestraScene agents={agents} onOpen={onOpen} />
      ) : (
        <div
          className="grid flex-1 auto-rows-min gap-4 overflow-auto p-5"
          style={{
            gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
            backgroundImage: 'linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px)',
            backgroundSize: '32px 32px',
          }}
        >
          {agents.map((a) => {
            const t = TONE[a.state]
            const section = QUEUE_SECTIONS.find((s) => s.state === a.state)
            return (
              <button
                key={a.id}
                onClick={() => onOpen(a.id)}
                className={`group relative flex flex-col rounded-xl border bg-zinc-900/60 p-3 text-left transition hover:-translate-y-0.5 hover:bg-zinc-900 ${t.ring} ${a.state === 'blocked' ? 'shadow-lg shadow-red-500/10' : ''}`}
                title={a.note ?? `Open ${a.name}`}
              >
                <div className="relative h-28 w-full">
                  <Station state={a.state} />
                  <Bubble state={a.state} />
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-100">{a.name}</span>
                  <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">{a.cli}</span>
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[11px]">
                  <span className={section?.tone}>{section?.label}</span>
                  {a.since && a.state !== 'idle' && <span className="text-zinc-500">{timeAgo(a.since)}</span>}
                  {a.branch && <span className="min-w-0 truncate font-mono text-zinc-500">⎇ {a.branch}</span>}
                </div>
                {a.note && <div className="mt-1 line-clamp-2 text-[11px] text-zinc-400">{a.note}</div>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
