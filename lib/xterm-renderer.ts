import type { Terminal } from '@xterm/xterm'

/**
 * Which painter xterm.js uses for a pane.
 *
 * Without an addon xterm falls back to its DOM renderer, which builds a
 * `<span>` per styled run per row on every repaint. That is fine for a shell
 * echoing lines, and expensive for a TUI agent (claude, orquesta) that redraws
 * its whole frame several times a second — times however many panes the grid
 * has open. On this app it showed up as the webview process pinning a core
 * while the Rust side sat near idle.
 *
 * WebGL is the fastest of the three; canvas is the safe middle ground when
 * there is no GL context to be had — which is a real possibility on Linux,
 * where we force `WEBKIT_DISABLE_DMABUF_RENDERER=1` to dodge the black-window
 * bug and WebKitGTK ends up compositing in software.
 */
export type TerminalRenderer = 'webgl' | 'canvas' | 'dom'

/**
 * Escape hatch: `localStorage.setItem('orquesta-renderer', 'canvas')` pins a
 * painter without a rebuild. Useful when a driver reports a GL context it then
 * fails to draw with — the symptom is blank panes rather than an exception, so
 * automatic detection can't catch it.
 */
const OVERRIDE_KEY = 'orquesta-renderer'

function readOverride(): TerminalRenderer | null {
  try {
    const v = localStorage.getItem(OVERRIDE_KEY)
    if (v === 'webgl' || v === 'canvas' || v === 'dom') return v
  } catch {}
  return null
}

async function attachCanvas(term: Terminal): Promise<TerminalRenderer> {
  try {
    const { CanvasAddon } = await import('@xterm/addon-canvas')
    term.loadAddon(new CanvasAddon())
    return 'canvas'
  } catch {
    return 'dom'
  }
}

/**
 * Load the best available renderer addon onto an already-`open()`ed terminal.
 *
 * Must run after `term.open()` — both addons need the element to attach their
 * canvas to. Failures are never fatal: every path ends with a working pane,
 * just a slower one. The addons are disposed along with the terminal, so
 * callers don't need to unwind anything.
 */
export async function attachRenderer(term: Terminal): Promise<TerminalRenderer> {
  const forced = readOverride()
  if (forced === 'dom') return 'dom'
  if (forced === 'canvas') return attachCanvas(term)

  try {
    const { WebglAddon } = await import('@xterm/addon-webgl')
    const webgl = new WebglAddon()
    // Throws synchronously when there's no WebGL2 context to be had.
    term.loadAddon(webgl)
    // A lost context (GPU reset, driver update, the tab being backgrounded on
    // some drivers) leaves the pane frozen mid-frame. Drop to canvas rather
    // than trying to restore it, which xterm's addon deliberately doesn't do.
    webgl.onContextLoss(() => {
      try { webgl.dispose() } catch {}
      void attachCanvas(term)
    })
    return 'webgl'
  } catch {
    return attachCanvas(term)
  }
}
