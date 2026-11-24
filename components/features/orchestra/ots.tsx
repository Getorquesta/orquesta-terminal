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
const BODIES = ['#6d5dfc', '#f97316', '#14b8a6', '#ec4899', '#eab308', '#3b82f6', '#84cc16', '#a855f7', '#ef6f5e', '#06b6d4', '#f43f5e', '#10b981']
// Curated from the 7ots part catalogue: friendly enough for a work tool, and
// different enough that no two musicians on stage read as the same ot.
const SHAPES = ['squircle', 'round', 'egg', 'bean', 'ghost', 'cat', 'blob', 'robot', 'bear', 'gem', 'owl', 'slime', 'alien', 'bun', 'onigiri', 'capsule', 'pear', 'drop', 'potato']
const PATTERNS = ['belly', 'none', 'spots', 'twotone', 'stripes', 'polka', 'stars', 'socks', 'galaxy']
const EYES = ['round', 'kawaii', 'anime', 'happy', 'sparkle', 'puppy', 'almond', 'button', 'glow', 'dot', 'focused', 'star']
const MOUTHS = ['smile', 'grin', 'cat', 'tiny', 'uwu', 'dgrin', 'smallgrin', 'vee', 'dimples', 'smirk', 'whistle']
const CHEEKS = ['blush', 'freckles', 'none', 'whiskers', 'stars', 'heartblush', 'shy']
const BROWS = ['soft', 'none', 'thin', 'arched', 'fluffy', 'raised']
const HATS = ['headphones', 'beret', 'tophat', 'beanie', null, 'catears', 'flowercrown', 'minitophat', 'sprout', 'hairbow', 'antenna', 'bearears', 'curls', 'chullo', 'laurel']
const FACE = [null, 'glasses', null, 'monocle', null, 'nerd', null, 'heartglasses', null, 'mustache']
const NECK = ['bowtie', 'scarf', 'bowtie', 'tie', 'pearls', 'bowtie', 'medal']
const IRIS = ['#22d3ee', '#7c3aed', '#16a34a', '#0ea5e9', '#f59e0b', '#db2777', '#2563eb']

export interface OtLook { color: string; spec: OtsSpec }

const shadeHex = (hex: string, f: number) => '#' + [1, 3, 5].map((i) => Math.round(Math.min(255, Math.max(0, parseInt(hex.slice(i, i + 2), 16) * (1 + f))))).map((v) => v.toString(16).padStart(2, '0')).join('')

/**
 * The look for one musician. Pass `slot` (its position on stage) so every seat
 * steps through each part list with a different stride and neighbours differ in
 * shape, colour, face and outfit at once; without it the id's hash picks.
 */
export function otLook(id: string, cli: string, slot?: number): OtLook {
  const h = hash(id)
  const k = slot ?? h
  const at = <T,>(xs: readonly T[], stride: number, salt: number) => xs[(k * stride + (slot === undefined ? h >>> salt : h % 3)) % xs.length]
  void cli
  const color = at(BODIES, 5, 3)
  const pattern = at(PATTERNS, 4, 7)
  const accessories = [at(HATS, 7, 11), at(FACE, 3, 13), at(NECK, 2, 17)]
    .filter((x): x is string => !!x)
    .map((a) => ({ id: a, color: a === 'bowtie' || a === 'tie' ? '#18181b' : undefined }))
  return {
    color,
    spec: {
      body: { shape: at(SHAPES, 11, 5), color, pattern, patternColor: pattern === 'belly' || pattern === 'socks' ? '#fff7ed' : shadeHex(color, 0.35) },
      finish: 'soft3d',
      outline: 'auto',
      eyes: { type: at(EYES, 5, 9), size: 1 + ((k * 7) % 5) * 0.05, iris: at(IRIS, 3, 15) },
      brows: { type: at(BROWS, 5, 19), color: '#332a88' },
      mouth: { type: at(MOUTHS, 7, 21) },
      cheeks: { type: at(CHEEKS, 3, 23), color: '#ff7eb6' },
      accessories,
    } as OtsSpec,
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
