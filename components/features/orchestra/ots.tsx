'use client'

// ── Ots musicians ───────────────────────────────────────────────────────────────
// Every agent on the stage is an "ot", the 7ots character, in a concert
// bow tie. The live renderer from @7ots/cli does the acting (breathing,
// blinking, moods, waving arms, confetti, sweat, zzz); the scene only moves the
// box around. The module is loaded lazily so it never runs on the server.

import { useEffect, useRef, useState } from 'react'
import type { OtsCharacter, OtsSpec } from '@7ots/cli/src/character/Character.js'

type OtsModule = typeof import('@7ots/cli/src/character/Character.js')

let modPromise: Promise<OtsModule> | null = null
export function loadOts(): Promise<OtsModule> {
  modPromise ??= import('@7ots/cli/src/character/Character.js')
  return modPromise
}

export function useOts(): OtsModule | null {
  const [mod, setMod] = useState<OtsModule | null>(null)
  useEffect(() => {
    let live = true
    loadOts().then((m) => live && setMod(m)).catch(() => {})
    return () => { live = false }
  }, [])
  return mod
}

/** Fixed frame so the feet always land on the same pixel: body bottom is (100, 172). */
export const OT_VIEWBOX = '-20 -50 240 270'
export const OT_W = 116
export const OT_SCALE = OT_W / 240
export const OT_H = 270 * OT_SCALE
export const OT_FOOT_X = 120 * OT_SCALE
export const OT_FOOT_Y = 222 * OT_SCALE

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}

// 7ots violet first, then companions picked to stay distinct from each other.
const BODIES = ['#6d5dfc', '#f97316', '#14b8a6', '#ec4899', '#eab308', '#3b82f6', '#84cc16', '#a855f7', '#ef6f5e', '#06b6d4']
const SHAPES = ['squircle', 'round']
const IRIS = ['#22d3ee', '#22d3ee', '#7c3aed', '#16a34a', '#0ea5e9']

export interface OtLook { color: string; spec: OtsSpec }

/** Stable look per pane: same id, same ot, everywhere (floor, tickets, grid). */
export function otLook(id: string, cli: string): OtLook {
  const h = hash(id)
  const color = BODIES[h % BODIES.length]
  void cli
  const accessories = [{ id: 'bowtie', color: '#18181b' }]
  return {
    color,
    spec: {
      body: { shape: SHAPES[(h >>> 5) % SHAPES.length], color, pattern: 'belly', patternColor: '#fff7ed' },
      finish: 'soft3d',
      outline: 'auto',
      eyes: { type: 'round', size: 1.05, iris: IRIS[(h >>> 9) % IRIS.length] },
      brows: { type: 'soft', color: '#332a88' },
      mouth: { type: 'smile' },
      cheeks: { type: 'blush', color: '#ff7eb6' },
      accessories,
    },
  }
}

/** What the ot is doing; drives mood, gestures and effects. */
export type OtAct = 'work' | 'call' | 'urgent' | 'serve' | 'sleep' | 'walk' | 'wait'

const WORK_BEATS = ['nod', 'nod', 'bounce']

export function OtPlayer({ look, act, onReady }: {
  look: OtLook
  act: OtAct
  onReady?: (ch: OtsCharacter | null) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const ch = useRef<OtsCharacter | null>(null)
  const [ready, setReady] = useState(0)
  const specKey = JSON.stringify(look.spec)
  const readyRef = useRef(onReady)
  readyRef.current = onReady

  useEffect(() => {
    let dead = false
    let inst: OtsCharacter | null = null
    loadOts().then(({ createCharacter }) => {
      if (dead || !host.current) return
      inst = createCharacter(host.current, look.spec, { fit: OT_VIEWBOX, title: '' })
      inst.svg.setAttribute('aria-hidden', 'true')
      ch.current = inst
      readyRef.current?.(inst)
      setReady((n) => n + 1)
    }).catch(() => {})
    return () => {
      dead = true
      readyRef.current?.(null)
      inst?.destroy()
      ch.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specKey])

  useEffect(() => {
    const c = ch.current
    if (!c) return
    c.clearEffects('state')
    let timer: ReturnType<typeof setTimeout> | undefined
    switch (act) {
      case 'work': {
        c.mood('neutral')
        c.gesture('nod', { ms: 500 })
        c.lookAt(0, 0.75)
        // a small beat every few seconds so a working musician never freezes
        const beat = () => {
          timer = setTimeout(() => {
            c.gesture(WORK_BEATS[Math.floor(Math.random() * WORK_BEATS.length)])
            c.lookAt((Math.random() - 0.5) * 0.6, 0.7)
            beat()
          }, 5000 + Math.random() * 4000)
        }
        beat()
        break
      }
      case 'call':
      case 'urgent': {
        // one wave to get attention, then a calm wait with a raised hand every few seconds
        c.mood(act === 'urgent' ? 'surprised' : 'neutral', { fx: false })
        c.lookAt(0, 0.15)
        c.gesture('wave', { ms: 1600 })
        const again = () => { timer = setTimeout(() => { c.gesture('wave', { ms: 1200 }); again() }, act === 'urgent' ? 5000 : 9000) }
        again()
        break
      }
      case 'serve':
        c.mood('happy', { fx: false })
        c.gesture('thumbsup')
        c.lookAt(0, 0.1)
        break
      case 'wait':
        c.mood('happy', { fx: false })
        c.gesture('nod', { ms: 400 })
        break
      case 'sleep':
        c.mood('sleep')
        break
      case 'walk':
        c.mood('neutral', { fx: false })
        break
    }
    return () => { if (timer) clearTimeout(timer) }
  }, [act, ready])

  return <div ref={host} style={{ width: OT_W, height: OT_H }} />
}

/** Static ot (string SVG) for tickets and other small spots. */
export function OtThumb({ look, mood = 'neutral', size = 22 }: { look: OtLook; mood?: string; size?: number }) {
  const mod = useOts()
  if (!mod) return <span style={{ width: size, height: size, borderRadius: 6, background: look.color, display: 'inline-block' }} />
  const svg = mod.renderCharacter(look.spec, { mood }, { viewBox: '20 -10 160 190' })
  return <span aria-hidden style={{ width: size, height: size, display: 'inline-block' }} className="[&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: svg }} />
}
