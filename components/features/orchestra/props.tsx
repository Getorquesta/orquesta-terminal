// ── Orchestra stage plot ─────────────────────────────────────────────────────
// The Floor drawn the way a hall drafts its seating: a top-down stage plot with
// concentric risers and one tinted section per owner, with its colour bar on the rim.
// Thin zinc lines, no illustration; colour is reserved for state and owners.

/** Studio desk-state palette (lib/studio/office.ts in orquesta). */
export const STATE_HEX = {
  blocked: '#fbbf24',
  working: '#60a5fa',
  done: '#4ade80',
  idle: '#71717a',
} as const

export const STAGE_CSS = `
@keyframes orc-ring { 0% { opacity: .55; transform: scale(1) } 100% { opacity: 0; transform: scale(1.12, 1.35) } }
@keyframes orc-eq { 0%,100% { transform: scaleY(.3) } 50% { transform: scaleY(1) } }
@keyframes orc-in { from { opacity: 0; transform: translateY(4px) } to { opacity: 1; transform: none } }
.orc-ring { animation: orc-ring 2s cubic-bezier(.2,.7,.3,1) infinite }
.orc-eq > i { display: block; width: 2px; height: 12px; border-radius: 1px; transform-origin: 50% 100%; animation: orc-eq .9s ease-in-out infinite }
.orc-eq > i:nth-child(2) { animation-duration: .7s; animation-delay: -.2s }
.orc-eq > i:nth-child(3) { animation-duration: 1.1s; animation-delay: -.5s }
.orc-in { animation: orc-in .32s cubic-bezier(.3,.8,.3,1) both }
.orc-paused * { animation-play-state: paused !important }
@media (prefers-reduced-motion: reduce) { .orc-root *, .orc-in { animation: none !important } }
`

export interface Pt { x: number; y: number }

/** Arc centre (the podium); angle t is measured from straight up, positive to the right. */
export interface Arc { cx: number; cy: number; ky: number }
export const onArc = (a: Arc, r: number, t: number): Pt => ({ x: a.cx + r * Math.sin(t), y: a.cy - r * Math.cos(t) * a.ky })

const arcTo = (a: Arc, r: number, t: number, sweep: 0 | 1) => { const q = onArc(a, r, t); return `A${r} ${r * a.ky} 0 0 ${sweep} ${q.x.toFixed(1)} ${q.y.toFixed(1)}` }

function sector(a: Arc, r0: number, r1: number, t0: number, t1: number) {
  const p = (r: number, t: number) => { const q = onArc(a, r, t); return `${q.x.toFixed(1)} ${q.y.toFixed(1)}` }
  return `M${p(r1, t0)} ${arcTo(a, r1, t1, 1)} L${p(r0, t1)} ${arcTo(a, r0, t0, 0)} Z`
}

export interface Section { name: string; t0: number; t1: number; mid: number; hue: string }

/** Risers, owner sections and the podium, as a single flat SVG layer. */
export function StagePlot({ arc, radii, band, span, sections }: {
  arc: Arc; radii: number[]; band: number; span: number; sections: Section[]
}) {
  const rIn = radii[0] - band / 2 - 14
  const rOut = radii[radii.length - 1] + band / 2 + 14 // rim bar sits 6px beyond: keep in step with RIM
  const edge = span + 0.06
  return (
    <g>
      {/* owner sections */}
      {sections.map((s) => (
        <g key={s.name}>
          <path d={sector(arc, rIn, rOut, s.t0, s.t1)} fill={s.hue} opacity=".05" />
          <path d={`M${onArc(arc, rOut + 6, s.t0 + 0.012).x} ${onArc(arc, rOut + 6, s.t0 + 0.012).y} ${arcTo(arc, rOut + 6, s.t1 - 0.012, 1)}`}
            fill="none" stroke={s.hue} strokeWidth="3" strokeLinecap="round" opacity=".75" />
        </g>
      ))}

      {/* risers */}
      {radii.map((r, k) => (
        <path key={k} d={sector(arc, r - band / 2, r + band / 2, -edge, edge)}
          fill="#ffffff" opacity={k % 2 ? 0.018 : 0.03} />
      ))}
      {[rIn, ...radii.map((r) => r + band / 2)].map((r, k) => (
        <path key={k} d={`M${onArc(arc, r, -edge).x} ${onArc(arc, r, -edge).y} ${arcTo(arc, r, edge, 1)}`}
          fill="none" stroke="#2a2d34" strokeWidth={k === 0 ? 1.5 : 1} />
      ))}

      {/* section dividers */}
      {sections.slice(1).map((s) => {
        const a = onArc(arc, rIn, s.t0), b = onArc(arc, rOut, s.t0)
        return <line key={s.name} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#3f434c" strokeWidth="1" strokeDasharray="3 4" />
      })}

    </g>
  )
}

/** Three level bars: the musician is playing. */
export function Equalizer({ color }: { color: string }) {
  return (
    <span className="orc-eq flex h-3 shrink-0 items-end gap-[2px]" aria-hidden>
      <i style={{ background: color }} /><i style={{ background: color }} /><i style={{ background: color }} />
    </span>
  )
}
