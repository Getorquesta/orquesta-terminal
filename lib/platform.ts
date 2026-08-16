'use client'

import { useEffect, useMemo, useState } from 'react'

/** The glyphs a shortcut is spelled with on the current platform. */
export interface KeyLabels {
  /** ⌘ on macOS, Ctrl elsewhere. */
  mod: string
  /** ⇧ on macOS, Shift elsewhere. */
  shift: string
  /** ⌥ on macOS, Alt elsewhere. */
  alt: string
  /** ↵ on macOS, Enter elsewhere. */
  enter: string
  /** Glue between keys: nothing on macOS (glyphs read fine adjacent), '+' elsewhere. */
  sep: string
  /** `combo(k.mod, k.shift, 'O')` → `⌘⇧O` on macOS, `Ctrl+Shift+O` elsewhere. */
  combo: (...parts: string[]) => string
}

const MAC: KeyLabels = {
  mod: '⌘', shift: '⇧', alt: '⌥', enter: '↵', sep: '',
  combo: (...p) => p.join(''),
}

const PC: KeyLabels = {
  mod: 'Ctrl', shift: 'Shift', alt: 'Alt', enter: 'Enter', sep: '+',
  combo: (...p) => p.join('+'),
}

function isMac(): boolean {
  if (typeof navigator === 'undefined') return false
  // userAgentData is the modern source and the only one not deprecated; the
  // other two are the fallback for WebKitGTK and older webviews.
  const uad = (navigator as { userAgentData?: { platform?: string } }).userAgentData
  const p = uad?.platform || navigator.platform || navigator.userAgent || ''
  return /mac/i.test(p)
}

/**
 * How to *print* this platform's shortcuts.
 *
 * The handlers themselves already accept either modifier (`e.ctrlKey ||
 * e.metaKey`, see AgentGrid) — this is only about the labels, which were
 * hardcoded to ⌘ and so lied to every Linux and Windows user.
 *
 * Resolved in an effect, never during render. The app ships as a static export
 * (`output: 'export'`), so every client component is prerendered on the build
 * machine — Linux, in CI. Reading navigator while rendering would hand React a
 * tree that disagrees with that HTML and break hydration. Starting on the PC
 * labels makes the first paint match the prerender by construction; macOS swaps
 * to the glyphs one tick later, before anyone can read a keycap.
 */
export function useKeyLabels(): KeyLabels {
  const [mac, setMac] = useState(false)
  useEffect(() => { setMac(isMac()) }, [])
  return useMemo(() => (mac ? MAC : PC), [mac])
}
