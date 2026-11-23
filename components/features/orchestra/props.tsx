// ── Orchestra stage props ────────────────────────────────────────────────────
// The Floor drawn as a concert stage: a wooden acoustic shell, curved risers,
// musicians behind lit music stands and conductors on podiums at the front.
// Flat, outline-free shapes in muted wood and zinc; colour is kept for state
// (the stand light). Everything is in scene pixels at scale `s` per riser.

/** Studio desk-state palette (lib/studio/office.ts in orquesta). */
export const STATE_HEX = {
  blocked: '#fbbf24',
  working: '#60a5fa',
  done: '#4ade80',
  idle: '#71717a',
} as const

export const STAGE_CSS = `
.orc-bow, .orc-bowh, .orc-mallet, .orc-baton, .orc-note, .orc-ring { transform-box: fill-box }
@keyframes orc-bow { 0%,100% { transform: translate(0,0) } 50% { transform: translate(12px,-7px) } }
@keyframes orc-bowh { 0%,100% { transform: translateX(-9px) } 50% { transform: translateX(9px) } }
@keyframes orc-mallet { 0%,100% { transform: rotate(0) } 40% { transform: rotate(-18deg) } }
@keyframes orc-baton { 0%,100% { transform: rotate(0) } 30% { transform: rotate(-20deg) } 60% { transform: rotate(8deg) } }
@keyframes orc-note { 0% { opacity: 0; transform: translate(0,0) } 25% { opacity: .7 } 100% { opacity: 0; transform: translate(10px,-26px) } }
@keyframes orc-lamp { 0%,100% { opacity: .7 } 50% { opacity: 1 } }
@keyframes orc-ring { 0% { opacity: .6; transform: scale(.8) } 100% { opacity: 0; transform: scale(1.3) } }
@keyframes orc-in { from { opacity: 0; transform: translateY(4px) } to { opacity: 1; transform: none } }
.orc-bow { animation: orc-bow 1.3s ease-in-out infinite }
.orc-bowh { animation: orc-bowh 1.5s ease-in-out infinite }
.orc-mallet { transform-origin: 0% 0%; animation: orc-mallet .9s cubic-bezier(.5,0,.5,1) infinite }
.orc-baton { transform-origin: 0% 100%; animation: orc-baton 1.6s ease-in-out infinite }
.orc-note { animation: orc-note 3s ease-out infinite }
.orc-lamp { animation: orc-lamp 2.4s ease-in-out infinite }
.orc-ring { transform-origin: 50% 50%; animation: orc-ring 2.2s cubic-bezier(.2,.7,.3,1) infinite }
.orc-in { animation: orc-in .32s cubic-bezier(.3,.8,.3,1) both }
.orc-paused * { animation-play-state: paused !important }
@media (prefers-reduced-motion: reduce) { .orc-root *, .orc-in { animation: none !important } }
`

export interface Pt { x: number; y: number }
const pts = (p: Pt[]) => p.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')

/** Stage geometry: concentric arcs around the conductors, squashed by ky for the hall's viewpoint. */
export interface Arc { cx: number; cy: number; ky: number }
export const onArc = (a: Arc, r: number, t: number): Pt => ({ x: a.cx + r * Math.sin(t), y: a.cy - r * Math.cos(t) * a.ky })
const arcPts = (a: Arc, r: number, t0: number, t1: number, n = 36) =>
  Array.from({ length: n + 1 }, (_, i) => onArc(a, r, t0 + ((t1 - t0) * i) / n))

const RISER = ['#3a2e24', '#3f3228', '#45372c', '#4a3b2f']

/** Background, acoustic shell, stage floor and one riser per row. */
export function Hall({ uid, w, h, arc, radii, span }: { uid: string; w: number; h: number; arc: Arc; radii: number[]; span: number }) {
  const rMax = radii[radii.length - 1] + 70
  const shellN = 16
  const shell = Array.from({ length: shellN }, (_, i) => {
    const t0 = -1.45 + (2.9 * i) / shellN, t1 = -1.45 + (2.9 * (i + 1)) / shellN
    const b0 = onArc(arc, rMax, t0), b1 = onArc(arc, rMax, t1)
    const top = (p: Pt) => ({ x: p.x, y: Math.max(0, p.y - 200) })
    return { poly: pts([b0, b1, top(b1), top(b0)]), x: b0.x, y0: top(b0).y, y1: b0.y, dark: i % 2 === 1 }
  })
  const floor = [...arcPts(arc, rMax, -Math.PI / 2, Math.PI / 2, 48), { x: w, y: arc.cy }, { x: w, y: h }, { x: 0, y: h }, { x: 0, y: arc.cy }]
  const tSide = span + 0.16
  return (
    <g>
      <defs>
        <linearGradient id={`${uid}-bg`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0a0a0d" />
          <stop offset="1" stopColor="#131216" />
        </linearGradient>
        <linearGradient id={`${uid}-shellfade`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0a0a0d" stopOpacity=".95" />
          <stop offset=".6" stopColor="#0a0a0d" stopOpacity=".2" />
          <stop offset="1" stopColor="#0a0a0d" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`${uid}-floor`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2a221c" />
          <stop offset="1" stopColor="#342a21" />
        </linearGradient>
        <radialGradient id={`${uid}-wash`} cx="50%" cy="40%" r="60%">
          <stop offset="0" stopColor="#fff7ed" stopOpacity=".08" />
          <stop offset="1" stopColor="#fff7ed" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${uid}-pit`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#09090b" stopOpacity="0" />
          <stop offset="1" stopColor="#09090b" stopOpacity=".75" />
        </linearGradient>
      </defs>
      <rect width={w} height={h} fill={`url(#${uid}-bg)`} />
      {/* acoustic shell: vertical wood panels following the stage curve */}
      {shell.map((p, i) => (
        <g key={i}>
          <polygon points={p.poly} fill={p.dark ? '#211a15' : '#29201a'} />
          <line x1={p.x} y1={p.y0} x2={p.x} y2={p.y1} stroke="#382c23" strokeWidth="1" />
        </g>
      ))}
      <rect width={w} height={h * 0.75} fill={`url(#${uid}-shellfade)`} />
      {/* stage floor and risers, back to front */}
      <polygon points={pts(floor)} fill={`url(#${uid}-floor)`} />
      {radii.map((r, k) => k).reverse().map((k) => {
        const inner = radii[k] - 50, outer = radii[k] + 50
        const band = [...arcPts(arc, outer, -tSide, tSide), ...arcPts(arc, inner, tSide, -tSide)]
        const lipTop = arcPts(arc, inner, -tSide, tSide)
        const lip = [...lipTop, ...lipTop.slice().reverse().map((p) => ({ x: p.x, y: p.y + 7 }))]
        return (
          <g key={k}>
            <polygon points={pts(band)} fill={RISER[radii.length - 1 - k] ?? RISER[3]} />
            {[0.33, 0.66].map((f) => (
              <polyline key={f} points={pts(arcPts(arc, inner + 100 * f, -tSide, tSide))} fill="none" stroke="#2c231c" strokeWidth="1" />
            ))}
            <polygon points={pts(lip)} fill="#1c1612" />
          </g>
        )
      })}
      <rect y={h - 44} width={w} height="44" fill={`url(#${uid}-pit)`} />
      <rect width={w} height={h} fill={`url(#${uid}-wash)`} />
    </g>
  )
}

export type InstrumentKind = 'violin' | 'cello' | 'horn' | 'timpani'

/** Chair, music stand with a nameplate and its state light. Seat (feet) at (x, y). */
export function Stand({ x, y, s, color, lit, name, selected }: {
  x: number; y: number; s: number; color: string; lit: boolean; name: string; selected: boolean
}) {
  const dw = 40 * s, top = y - 20 * s, bot = y + 2 * s
  const label = name.length > 12 ? `${name.slice(0, 11)}…` : name
  return (
    <g>
      {/* light spill on the musician */}
      <ellipse cx={x} cy={top - 8 * s} rx={34 * s} ry={14 * s} fill={color} opacity={lit ? 0.16 : 0.05} />
      {/* chair legs */}
      <path d={`M${x - 22 * s} ${y - 6 * s} l-3 ${22 * s} M${x + 22 * s} ${y - 6 * s} l3 ${22 * s}`} stroke="#3f3f46" strokeWidth={2.4 * s} strokeLinecap="round" />
      {/* stand: tripod, pole, desk */}
      <path d={`M${x} ${bot} V${y + 18 * s} M${x} ${y + 16 * s} l${-14 * s} ${7 * s} M${x} ${y + 16 * s} l${14 * s} ${7 * s}`} stroke="#27272a" strokeWidth={2.6 * s} strokeLinecap="round" fill="none" />
      <polygon points={pts([{ x: x - dw, y: top }, { x: x + dw, y: top }, { x: x + dw - 4 * s, y: bot }, { x: x - dw + 4 * s, y: bot }])}
        fill="#131316" stroke={selected ? '#f4f4f5' : '#26262b'} strokeWidth={selected ? 1.8 : 1} />
      <rect className={lit ? 'orc-lamp' : undefined} x={x - dw + 3 * s} y={top - 1.5 * s} width={dw * 2 - 6 * s} height={3 * s} rx={1.5 * s} fill={color} />
      <text x={x} y={(top + bot) / 2 + 3.8 * s} textAnchor="middle" fontSize={11 * s} fontWeight="500" fill="#d4d4d8">{label}</text>
    </g>
  )
}

/** The instrument beside the musician; animated while working. */
export function Instrument({ kind, x, y, s, busy }: { kind: InstrumentKind; x: number; y: number; s: number; busy: boolean }) {
  if (kind === 'violin') {
    const cx = x - 34 * s, cy = y - 34 * s
    return (
      <g>
        <g transform={`rotate(-30 ${cx} ${cy})`}>
          <rect x={cx + 10 * s} y={cy - 1.8 * s} width={20 * s} height={3.6 * s} rx={1.8 * s} fill="#1c1917" />
          <ellipse cx={cx - 5 * s} cy={cy} rx={7 * s} ry={8.5 * s} fill="#8a4f2c" />
          <ellipse cx={cx + 5 * s} cy={cy} rx={6 * s} ry={7 * s} fill="#8a4f2c" />
          <rect x={cx - 3 * s} y={cy - 1 * s} width={10 * s} height={2 * s} fill="#1c1917" />
        </g>
        <g className={busy ? 'orc-bow' : undefined}>
          <line x1={x - 50 * s} y1={y - 18 * s} x2={x - 22 * s} y2={y - 44 * s} stroke="#a8a29e" strokeOpacity=".7" strokeWidth={1.1 * s} strokeLinecap="round" />
        </g>
      </g>
    )
  }
  if (kind === 'cello') {
    const cx = x + 36 * s, b = y + 4 * s
    return (
      <g>
        <line x1={cx} y1={b} x2={cx} y2={b + 14 * s} stroke="#a1a1aa" strokeWidth={1.4 * s} />
        <line x1={cx} y1={b - 58 * s} x2={cx} y2={b - 94 * s} stroke="#1c1917" strokeWidth={3.6 * s} strokeLinecap="round" />
        <ellipse cx={cx} cy={b - 44 * s} rx={11 * s} ry={14 * s} fill="#7c4527" />
        <ellipse cx={cx} cy={b - 16 * s} rx={14 * s} ry={17 * s} fill="#7c4527" />
        <ellipse cx={cx - 5 * s} cy={b - 20 * s} rx={5 * s} ry={12 * s} fill="#000" opacity=".12" />
        <path d={`M${cx - 4 * s} ${b - 34 * s} v${10 * s} M${cx + 4 * s} ${b - 34 * s} v${10 * s}`} stroke="#1c1917" strokeWidth={1.2 * s} />
        <g className={busy ? 'orc-bowh' : undefined}>
          <line x1={cx - 30 * s} y1={b - 24 * s} x2={cx + 22 * s} y2={b - 28 * s} stroke="#a8a29e" strokeOpacity=".7" strokeWidth={1.1 * s} strokeLinecap="round" />
        </g>
      </g>
    )
  }
  if (kind === 'horn') {
    const cx = x + 26 * s, cy = y - 50 * s
    return (
      <g>
        <circle cx={cx} cy={cy} r={10 * s} fill="none" stroke="#b08d3c" strokeWidth={3.2 * s} />
        <circle cx={cx} cy={cy} r={5 * s} fill="none" stroke="#c9a54e" strokeWidth={1.6 * s} />
        <path d={`M${cx + 8 * s} ${cy + 6 * s} q${10 * s} ${4 * s} ${16 * s} ${-2 * s}`} fill="none" stroke="#b08d3c" strokeWidth={3 * s} />
        <ellipse cx={cx + 25 * s} cy={cy + 1 * s} rx={5 * s} ry={9 * s} fill="#d4b062" />
        <ellipse cx={cx + 26 * s} cy={cy + 1 * s} rx={2.6 * s} ry={6 * s} fill="#6b5320" />
      </g>
    )
  }
  const cx = x + 40 * s, cy = y - 8 * s
  return (
    <g>
      <path d={`M${cx - 22 * s} ${cy} q0 ${24 * s} ${22 * s} ${24 * s} q${22 * s} 0 ${22 * s} ${-24 * s}z`} fill="#8b5a32" />
      <path d={`M${cx - 22 * s} ${cy} q0 ${24 * s} ${22 * s} ${24 * s} l0 ${-24 * s}z`} fill="#000" opacity=".15" />
      <ellipse cx={cx} cy={cy} rx={22 * s} ry={6.5 * s} fill="#e7e5e4" />
      <path d={`M${cx - 16 * s} ${cy + 21 * s} l-4 ${10 * s} M${cx + 16 * s} ${cy + 21 * s} l4 ${10 * s}`} stroke="#3f3f46" strokeWidth={2 * s} />
      <g className={busy ? 'orc-mallet' : undefined}>
        <line x1={cx - 30 * s} y1={cy - 26 * s} x2={cx - 6 * s} y2={cy - 3 * s} stroke="#a8a29e" strokeWidth={1.6 * s} />
        <circle cx={cx - 6 * s} cy={cy - 3 * s} r={3 * s} fill="#e7e5e4" />
      </g>
    </g>
  )
}

/** Rising notes over a musician who is playing. */
export function Notes({ x, y, s, seed }: { x: number; y: number; s: number; seed: number }) {
  return (
    <g fill={STATE_HEX.working} fontSize={13 * s} fontWeight="600">
      {['♪', '♫'].map((g, i) => (
        <text key={i} className="orc-note" style={{ animationDelay: `${((seed * 0.37 + i * 1.5) % 3).toFixed(2)}s` }} x={x + (10 + i * 10) * s} y={y - 86 * s}>{g}</text>
      ))}
    </g>
  )
}

/** Spotlight on a musician who is waiting for a person. */
export function Spot({ x, y, s, uid }: { x: number; y: number; s: number; uid: string }) {
  return (
    <g>
      <polygon points={pts([{ x: x - 6, y: 0 }, { x: x + 6, y: 0 }, { x: x + 48 * s, y: y + 8 * s }, { x: x - 48 * s, y: y + 8 * s }])} fill={`url(#${uid}-spot)`} />
      <ellipse cx={x} cy={y + 8 * s} rx={50 * s} ry={13 * s} fill={STATE_HEX.blocked} opacity=".16" />
      <ellipse className="orc-ring" cx={x} cy={y + 8 * s} rx={50 * s} ry={13 * s} fill="none" stroke={STATE_HEX.blocked} strokeWidth="1.6" />
    </g>
  )
}

export function SpotDefs({ uid }: { uid: string }) {
  return (
    <defs>
      <linearGradient id={`${uid}-spot`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor={STATE_HEX.blocked} stopOpacity="0" />
        <stop offset="1" stopColor={STATE_HEX.blocked} stopOpacity=".2" />
      </linearGradient>
    </defs>
  )
}

/** Selection ring on the riser under a seat. */
export function SeatRing({ x, y, s }: { x: number; y: number; s: number }) {
  return <ellipse cx={x} cy={y + 10 * s} rx={52 * s} ry={14 * s} fill="none" stroke="#f4f4f5" strokeWidth="1.6" opacity=".85" />
}

const SKIN = ['#f1c7a5', '#d9a77f', '#b07b55', '#8a5a3c', '#e8b896']
const HAIR = ['#1f1b18', '#3b2a20', '#6b4a2f', '#9ca3af', '#2a2320']

function hash(str: string) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}

/** A conductor on a podium, seen from the hall. Podium base at (x, y). The baton moves while their section plays. */
export function Conductor({ x, y, name, hue, waiting, conducting }: {
  x: number; y: number; name: string; hue: string; waiting: number; conducting: boolean
}) {
  const h = hash(name)
  const skin = SKIN[h % SKIN.length], hair = HAIR[(h >>> 4) % HAIR.length]
  const long = (h >>> 9) % 3 === 0
  const f = y - 16 // feet on the podium top
  const tag = name.length > 14 ? `${name.slice(0, 13)}…` : name
  const tagW = 30 + tag.length * 6.9 + (waiting ? 30 : 0)
  const ini = name.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?'
  const k = 0.74
  return (
    <g>
      <g transform={`translate(${x} ${y}) scale(${k}) translate(${-x} ${-y})`}>
      {/* podium */}
      <ellipse cx={x} cy={y + 4} rx="46" ry="8" fill="#000" opacity=".35" />
      <rect x={x - 38} y={y - 14} width="76" height="16" rx="2" fill="#241c16" />
      <rect x={x - 38} y={y - 18} width="76" height="5" rx="2" fill="#4a3a2d" />
      {waiting > 0 && <rect x={x - 38} y={y - 2} width="76" height="2" fill={STATE_HEX.blocked} />}
      {/* legs */}
      <rect x={x - 11} y={f - 38} width="9" height="38" rx="2" fill="#0e0e11" />
      <rect x={x + 2} y={f - 38} width="9" height="38" rx="2" fill="#0e0e11" />
      {/* left arm, relaxed */}
      <path d={`M${x - 19} ${f - 90} q-9 18 -7 40`} stroke="#141417" strokeWidth="9" strokeLinecap="round" fill="none" />
      {/* tailcoat */}
      <path d={`M${x - 22} ${f - 96} q22 -8 44 0 l2 52 l-6 20 l-8 -14 l-12 0 l-8 14 l-6 -20z`} fill="#1b1b1f" />
      <path d={`M${x} ${f - 99} v44`} stroke="#0b0b0d" strokeWidth="1.4" />
      <rect x={x - 6} y={f - 104} width="12" height="8" rx="2" fill="#e4e4e7" />
      {/* head, from behind */}
      <circle cx={x} cy={f - 116} r="13" fill={skin} />
      <path d={long ? `M${x - 14} ${f - 118} q0 -15 14 -15 q14 0 14 15 l1 14 q-15 4 -30 0z` : `M${x - 13.5} ${f - 112} q-1 -19 13.5 -19 q14.5 0 13.5 19 q-13 -4 -27 0z`} fill={hair} />
      {/* baton arm */}
      <g className={conducting ? 'orc-baton' : undefined}>
        <path d={`M${x + 20} ${f - 92} q14 -2 22 -22`} stroke="#141417" strokeWidth="9" strokeLinecap="round" fill="none" />
        <circle cx={x + 42} cy={f - 115} r="4" fill={skin} />
        <line x1={x + 43} y1={f - 117} x2={x + 62} y2={f - 140} stroke="#fafafa" strokeWidth="1.6" strokeLinecap="round" />
      </g>
      </g>
      {/* name tag */}
      <g transform={`translate(${x - tagW / 2} ${y + 12})`}>
        <rect width={tagW} height="24" rx="12" fill="#18181b" stroke={waiting ? STATE_HEX.blocked : '#3f3f46'} strokeWidth="1.2" />
        <circle cx="13" cy="12" r="8" fill={hue} />
        <text x="13" y="15.2" textAnchor="middle" fontSize="8" fontWeight="700" fill="#18181b">{ini}</text>
        <text x="27" y="16" fontSize="12" fontWeight="500" fill="#e4e4e7">{tag}</text>
        {waiting > 0 && (
          <g transform={`translate(${tagW - 28} 4)`}>
            <rect width="22" height="16" rx="8" fill={STATE_HEX.blocked} />
            <text x="11" y="12" textAnchor="middle" fontSize="10.5" fontWeight="700" fill="#18181b">{waiting}</text>
          </g>
        )}
      </g>
    </g>
  )
}
