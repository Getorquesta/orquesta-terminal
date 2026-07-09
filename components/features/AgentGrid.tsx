'use client'

import { useState, useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react'
import { ResponsiveGridLayout, useContainerWidth } from 'react-grid-layout'
import type { LayoutItem, ResponsiveLayouts } from 'react-grid-layout'
import { Socket } from 'socket.io-client'
import { GeistMono } from 'geist/font/mono'
import { Button } from '@/components/ui/button'
import { Plus, X, Maximize2, GitBranch, LayoutGrid, Pencil, Cloud } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'

export interface HostedProject {
  id: string
  name: string
}

interface GridCell {
  id: string
  cliType: CliType
  name: string
  /** Each pane can target a different hosted project for hook reporting. */
  hostedProjectId?: string
}

// On-brand terminal theme — cohesive with the app palette (globals.css):
// slate-black ground, refined-emerald cursor, a tuned, legible ANSI ramp.
// `background` is transparent so the pane wrapper's tint (and the wallpaper
// behind it) shows through when the user dials down terminal opacity.
const ORQ_TERM_THEME = {
  background: 'transparent',
  foreground: '#e8ebf1',
  cursor: '#14c48a',
  cursorAccent: '#0a0c10',
  selectionBackground: 'rgba(20, 196, 138, 0.28)',
  black: '#0a0c10',
  red: '#ff6b6b',
  green: '#14c48a',
  yellow: '#f2c94c',
  blue: '#4c8dff',
  magenta: '#b892ff',
  cyan: '#3bc9db',
  white: '#cfd4de',
  brightBlack: '#545c69',
  brightRed: '#ff8787',
  brightGreen: '#34d399',
  brightYellow: '#ffd866',
  brightBlue: '#74a8ff',
  brightMagenta: '#d0bcff',
  brightCyan: '#66d9e8',
  brightWhite: '#f5f7fa',
}

// CLIs a pane can host. The agent resolves each to a local binary and falls
// back to the shell if it isn't installed.
const CLI_OPTIONS = [
  { value: 'shell', label: 'Shell' },
  { value: 'claude', label: 'Claude' },
  { value: 'orquesta', label: 'Orquesta' },
  { value: 'kimi', label: 'Kimi' },
  { value: 'opencode', label: 'OpenCode' },
] as const

type CliType = (typeof CLI_OPTIONS)[number]['value']

const MIN_FONT = 9
const MAX_FONT = 24

interface CellApi {
  clear: () => void
  fit: () => void
}

interface TerminalCellProps {
  cellId: string
  socket: Socket | null
  cliType: CliType
  name: string
  fontSize: number
  /** 0..1 — pane translucency so the wallpaper shows through. */
  opacity: number
  /** When set, this pane's CLI is pointed at a hosted Orquesta project. */
  hostedApiUrl?: string
  hostedToken?: string
  /** Available hosted projects for the per-pane selector. */
  hostedProjects?: HostedProject[]
  /** This pane's selected hosted project. */
  hostedProjectId?: string
  onClose: () => void
  onCliTypeChange: (v: CliType) => void
  onRename: (v: string) => void
  onHostedProjectChange: (projectId: string | undefined) => void
  onFocusCell: () => void
  onNew: () => void
  onArrange: () => void
  onZoom: (delta: number) => void
  registerApi: (api: CellApi | null) => void
}

function TerminalCell({
  cellId, socket, cliType, name, fontSize, opacity, hostedApiUrl, hostedToken,
  hostedProjects, hostedProjectId,
  onClose, onCliTypeChange, onRename, onHostedProjectChange, onFocusCell, onNew, onArrange, onZoom, registerApi,
}: TerminalCellProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<import('@xterm/xterm').Terminal | null>(null)
  const fitAddonRef = useRef<import('@xterm/addon-fit').FitAddon | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const [branch, setBranch] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)

  // Latest callbacks in refs so the (heavy) init effect never re-runs when a
  // parent handler's identity changes — only cellId/socket/cliType restart it.
  const cbRef = useRef({ onClose, onFocusCell, onNew, onArrange, onZoom, registerApi })
  cbRef.current = { onClose, onFocusCell, onNew, onArrange, onZoom, registerApi }
  const fontRef = useRef(fontSize)
  fontRef.current = fontSize
  // Hosted-hook target read live at (re)connect time so toggling it from the
  // panel doesn't restart the terminal — the next session picks it up.
  const hostedRef = useRef({ apiUrl: hostedApiUrl, token: hostedToken })
  hostedRef.current = { apiUrl: hostedApiUrl, token: hostedToken }

  useEffect(() => { setDraft(name) }, [name])

  useEffect(() => {
    if (!containerRef.current || typeof window === 'undefined') return

    let term: import('@xterm/xterm').Terminal
    let mounted = true

    async function initTerminal() {
      const xtermModule = await import('@xterm/xterm')
      const { FitAddon } = await import('@xterm/addon-fit')
      const { WebLinksAddon } = await import('@xterm/addon-web-links')

      // Wait for the self-hosted Geist Mono webface so xterm measures glyph
      // widths against the real font (avoids the misaligned-cursor artifact
      // when the font swaps in after the canvas renderer has measured).
      try { await document.fonts?.ready } catch {}

      if (!mounted || !containerRef.current) return

      term = new xtermModule.Terminal({
        theme: ORQ_TERM_THEME,
        allowTransparency: true,
        fontFamily: `${GeistMono.style.fontFamily}, "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace`,
        fontSize: fontRef.current,
        lineHeight: 1.15,
        letterSpacing: 0,
        cursorBlink: true,
        cursorStyle: 'bar',
        scrollback: 5000,
        // Alt-screen suppression: when claude enters alt-screen mode (TUI),
        // keep the scrollbar and mouse events working in the pane wrapper.
        altClickMovesCursor: false,
      })

      const fitAddon = new FitAddon()
      const webLinksAddon = new WebLinksAddon((e, uri) => {
        window.open(uri, '_blank', 'noopener')
      })
      term.loadAddon(fitAddon)
      term.loadAddon(webLinksAddon)
      term.open(containerRef.current)
      fitAddon.fit()
      termRef.current = term
      fitAddonRef.current = fitAddon

      // ── Resize: push the real pane size to the PTY. Without this the shell
      // stays at 80×24 while the pane is larger, so wrapping + every TUI break.
      let resizeTimer: ReturnType<typeof setTimeout> | undefined
      const emitResize = () => {
        if (sessionIdRef.current) {
          socket?.emit('session:resize', { sessionId: sessionIdRef.current, rows: term.rows, cols: term.cols })
        }
      }
      const resizeObserver = new ResizeObserver(() => {
        try { fitAddon.fit() } catch {}
        clearTimeout(resizeTimer)
        resizeTimer = setTimeout(emitResize, 120)
      })
      resizeObserver.observe(containerRef.current)

      // Expose imperative controls (clear / fit) to the grid.
      cbRef.current.registerApi({
        clear: () => term.clear(),
        fit: () => { try { fitAddon.fit(); emitResize() } catch {} },
      })

      // ── Clipboard: xterm has no copy/paste by default in the browser. ──
      const copySelection = () => {
        const sel = term.getSelection()
        if (sel) navigator.clipboard?.writeText(sel).catch(() => {})
      }
      const paste = () => {
        navigator.clipboard?.readText()
          .then((t) => { if (t) socket?.emit('session:input', { sessionId: sessionIdRef.current, data: t }) })
          .catch(() => {})
      }
      const onMouseUp = () => copySelection()
      const onContextMenu = (ev: MouseEvent) => {
        ev.preventDefault()
        if (term.hasSelection()) copySelection()
        else paste()
      }
      const host = containerRef.current
      host.addEventListener('mouseup', onMouseUp)
      host.addEventListener('contextmenu', onContextMenu)

      // Track focus so grid-level shortcuts know which pane is "active".
      const onFocus = () => cbRef.current.onFocusCell()
      term.textarea?.addEventListener('focus', onFocus)

      // Keyboard: copy/paste, zoom, clear, new/close/arrange. These are handled
      // here (when the terminal is focused) so the keystrokes never reach the
      // shell; we also preventDefault the ones the browser would otherwise eat
      // (Ctrl+P print, Ctrl+± zoom).
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true
        const mod = e.ctrlKey || e.metaKey
        const k = e.key.toLowerCase()
        if (mod && e.shiftKey && k === 'c') { if (term.hasSelection()) { copySelection(); return false } }
        if (mod && e.shiftKey && k === 'v') { paste(); return false }
        if (mod && e.shiftKey && k === 'l') { e.preventDefault(); term.clear(); return false }
        if (mod && !e.shiftKey && (k === '=' || k === '+')) { e.preventDefault(); cbRef.current.onZoom(1); return false }
        if (mod && !e.shiftKey && k === '-') { e.preventDefault(); cbRef.current.onZoom(-1); return false }
        if (mod && !e.shiftKey && k === '0') { e.preventDefault(); cbRef.current.onZoom(0); return false }
        if (mod && !e.shiftKey && k === 'p') { e.preventDefault(); cbRef.current.onArrange(); return false }
        if (e.altKey && k === 't') { e.preventDefault(); cbRef.current.onNew(); return false }
        if (e.altKey && k === 'w') { e.preventDefault(); cbRef.current.onClose(); return false }
        return true
      })

      term.writeln('\x1b[32mOrquesta OSS — Interactive Terminal\x1b[0m')
      term.writeln('\x1b[90mWaiting for agent connection…\x1b[0m')
      term.writeln('')

      const startSession = (reconnect = false) => {
        const sessionId = `sess-${cellId}-${Date.now()}`
        sessionIdRef.current = sessionId
        setBranch(null)
        if (reconnect) term.writeln('\r\n\x1b[32m[reconnected — new session]\x1b[0m')
        socket?.emit('session:start', {
          sessionId, cellId, cliType, rows: term.rows, cols: term.cols,
          hostedApiUrl: hostedRef.current.apiUrl, hostedToken: hostedRef.current.token,
        })
      }
      startSession()

      term.onData((data) => {
        socket?.emit('session:input', { sessionId: sessionIdRef.current, data })
      })

      // ── Reconnection: if the socket drops and comes back, the agent's PTY is
      // gone — spin up a fresh session so the pane keeps working instead of
      // silently dying.
      let dropped = false
      const onDisconnect = () => { dropped = true; term.writeln('\r\n\x1b[90m[disconnected — waiting to reconnect…]\x1b[0m') }
      const onConnect = () => { if (dropped) { dropped = false; startSession(true) } }
      socket?.on('disconnect', onDisconnect)
      socket?.on('connect', onConnect)

      return () => {
        clearTimeout(resizeTimer)
        resizeObserver.disconnect()
        host.removeEventListener('mouseup', onMouseUp)
        host.removeEventListener('contextmenu', onContextMenu)
        term.textarea?.removeEventListener('focus', onFocus)
        socket?.off('disconnect', onDisconnect)
        socket?.off('connect', onConnect)
        cbRef.current.registerApi(null)
      }
    }

    const cleanup = initTerminal()

    return () => {
      mounted = false
      cleanup.then((fn) => fn?.())
      term?.dispose()
      if (sessionIdRef.current) {
        socket?.emit('session:force_end', { sessionId: sessionIdRef.current })
      }
    }
  }, [cellId, socket, cliType])

  // Live font-size (zoom) without recreating the terminal.
  useEffect(() => {
    const t = termRef.current
    if (!t) return
    t.options.fontSize = fontSize
    try { fitAddonRef.current?.fit() } catch {}
    if (sessionIdRef.current) {
      socket?.emit('session:resize', { sessionId: sessionIdRef.current, rows: t.rows, cols: t.cols })
    }
  }, [fontSize, socket])

  useEffect(() => {
    if (!socket) return

    const handleOutput = (data: { sessionId: string; data: string }) => {
      if (data.sessionId !== sessionIdRef.current) return
      termRef.current?.write(data.data)
    }
    const handleEnded = (data: { sessionId: string }) => {
      if (data.sessionId !== sessionIdRef.current) return
      termRef.current?.writeln('\r\n\x1b[90m[Session ended]\x1b[0m')
    }
    const handleError = (data: { sessionId: string; message: string }) => {
      if (data.sessionId !== sessionIdRef.current) return
      termRef.current?.writeln(`\r\n\x1b[31m[Error: ${data.message}]\x1b[0m`)
    }
    const handleMeta = (data: { sessionId: string; branch: string | null }) => {
      if (data.sessionId !== sessionIdRef.current) return
      setBranch(data.branch)
    }

    socket.on('session:output', handleOutput)
    socket.on('session:ended', handleEnded)
    socket.on('session:error', handleError)
    socket.on('session:meta', handleMeta)

    return () => {
      socket.off('session:output', handleOutput)
      socket.off('session:ended', handleEnded)
      socket.off('session:error', handleError)
      socket.off('session:meta', handleMeta)
    }
  }, [socket])

  const commitRename = () => {
    setEditing(false)
    const v = draft.trim()
    if (v !== name) onRename(v)
  }

  const cliLabel = CLI_OPTIONS.find((o) => o.value === cliType)?.label ?? cliType

  return (
    <div
      className="flex h-full flex-col rounded-md border border-zinc-800 overflow-hidden backdrop-blur-sm"
      style={{ backgroundColor: `rgba(10, 12, 16, ${opacity})` }}
    >
      <div className="flex items-center justify-between gap-2 border-b border-zinc-800/80 px-2.5 py-1.5 drag-handle cursor-grab active:cursor-grabbing">
        <div className="flex min-w-0 items-center gap-2">
          {editing ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                else if (e.key === 'Escape') { setDraft(name); setEditing(false) }
              }}
              onMouseDown={(e) => e.stopPropagation()}
              placeholder={cliLabel}
              className="w-24 rounded bg-zinc-800 px-1.5 py-0.5 text-xs font-mono text-zinc-200 outline-none focus:ring-1 focus:ring-green-600/50"
            />
          ) : (
            <button
              onClick={() => setEditing(true)}
              onMouseDown={(e) => e.stopPropagation()}
              className="group flex min-w-0 items-center gap-1 text-xs font-mono text-zinc-300 hover:text-zinc-100"
              title="Rename pane"
            >
              <span className="truncate max-w-[8rem]">{name || cliLabel}</span>
              <Pencil className="h-2.5 w-2.5 shrink-0 text-zinc-600 opacity-0 group-hover:opacity-100" />
            </button>
          )}
          <select
            value={cliType}
            onChange={(e) => onCliTypeChange(e.target.value as CliType)}
            onMouseDown={(e) => e.stopPropagation()}
            className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs font-mono text-zinc-300 outline-none hover:bg-zinc-700 focus:ring-1 focus:ring-green-600/50"
            title="CLI hosted in this pane"
          >
            {CLI_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          {branch && (
            <span
              className="flex min-w-0 items-center gap-1 rounded bg-zinc-800/70 px-1.5 py-0.5 text-xs font-mono text-green-400"
              title={`git branch: ${branch}`}
            >
              <GitBranch className="h-3 w-3 shrink-0" />
              <span className="truncate">{branch}</span>
            </span>
          )}
          {hostedProjects && hostedProjects.length > 0 && (
            <select
              value={hostedProjectId || ''}
              onChange={(e) => onHostedProjectChange(e.target.value || undefined)}
              onMouseDown={(e) => e.stopPropagation()}
              className="max-w-[7rem] truncate rounded bg-zinc-800/70 px-1.5 py-0.5 text-[10px] font-mono text-cyan-300 outline-none hover:bg-zinc-700 focus:ring-1 focus:ring-cyan-500/40"
              title="Hosted project (hooks report here)"
            >
              <option value="">No project</option>
              {hostedProjects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          )}
          {hostedProjectId && (
            <span title="Reporting to hosted">
              <Cloud className="h-3 w-3 shrink-0 text-cyan-400" />
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          onMouseDown={(e) => e.stopPropagation()}
          className="shrink-0 text-zinc-600 hover:text-zinc-400"
          title="Close pane (Alt+W)"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div ref={containerRef} className="flex-1 px-1 pt-1 pb-0 overflow-hidden" />
    </div>
  )
}

const STORAGE_KEY = 'orquesta-grid-layout-v2'
const FONT_KEY = 'orquesta-term-fontsize'
const DEFAULT_FONT = 13

export interface AgentGridHandle {
  addTerminal: () => void
  arrange: () => void
  closeActive: () => void
}

interface AgentGridProps {
  socket: Socket | null
  /** Namespaced localStorage key so pane layouts persist per project. */
  storageKey?: string
  /** 0..1 pane translucency so the wallpaper shows through. Default 1 (opaque). */
  terminalOpacity?: number
  /** When the hosted hook is enabled, point every pane's CLI at that backend. */
  hostedApiUrl?: string
  hostedToken?: string
  /** Available hosted projects (from useHostedAuth) for per-pane selector. */
  hostedProjects?: HostedProject[]
}

interface PersistShape {
  v: number
  cells: GridCell[]
  layouts: ResponsiveLayouts
}

function buildTidyLayout(cells: GridCell[]): LayoutItem[] {
  const n = cells.length
  if (!n) return []
  const cols = Math.ceil(Math.sqrt(n))
  const rows = Math.ceil(n / cols)
  const w = Math.max(1, Math.floor(12 / cols))
  const h = Math.max(4, Math.floor(24 / rows))
  return cells.map((c, i) => ({
    i: c.id,
    x: (i % cols) * w,
    y: Math.floor(i / cols) * h,
    w,
    h,
    minW: 2,
    minH: 3,
  }))
}

function AgentGridInner({
  socket, containerWidth, storageKey, terminalOpacity = 1, hostedApiUrl, hostedToken, hostedProjects,
  apiRef,
}: AgentGridProps & { containerWidth: number; apiRef: React.MutableRefObject<AgentGridHandle> }) {
  const key = storageKey || STORAGE_KEY
  const [cells, setCells] = useState<GridCell[]>([])
  const [layouts, setLayouts] = useState<ResponsiveLayouts>({ lg: [] })
  const [fontSize, setFontSize] = useState(DEFAULT_FONT)
  const loadedRef = useRef(false)
  const activeCellIdRef = useRef<string | null>(null)
  const cellApiRef = useRef<Map<string, CellApi>>(new Map())
  const cellsRef = useRef<GridCell[]>([])
  cellsRef.current = cells

  // ── Load persisted state (per-project) + global font size. ──
  useEffect(() => {
    loadedRef.current = false
    try {
      const saved = localStorage.getItem(key)
      if (saved) {
        const p = JSON.parse(saved)
        if (p && Array.isArray(p.cells)) {
          const loadedCells: GridCell[] = p.cells
          setCells(loadedCells)
          const lg = (p.layouts?.lg as LayoutItem[] | undefined) || []
          // Reconcile: every restored pane needs a layout item.
          if (lg.length === loadedCells.length && loadedCells.every((c) => lg.some((l) => l.i === c.id))) {
            setLayouts(p.layouts)
          } else {
            setLayouts({ lg: buildTidyLayout(loadedCells) })
          }
        } else if (p && (p.lg || p.md || p.sm)) {
          setLayouts(p) // legacy layouts-only shape — no panes to restore
        }
      }
    } catch {}
    try {
      const f = parseInt(localStorage.getItem(FONT_KEY) || '', 10)
      if (f >= MIN_FONT && f <= MAX_FONT) setFontSize(f)
    } catch {}
    loadedRef.current = true
  }, [key])

  // Persist cells + layouts whenever they change (after initial load).
  useEffect(() => {
    if (!loadedRef.current) return
    try {
      const payload: PersistShape = { v: 3, cells, layouts }
      localStorage.setItem(key, JSON.stringify(payload))
    } catch {}
  }, [key, cells, layouts])

  const addCell = useCallback(() => {
    const id = `cell-${Date.now()}`
    setCells((prev) => [...prev, { id, cliType: 'shell', name: '' }])
    setLayouts((prev) => {
      const lg = (prev.lg || []) as LayoutItem[]
      const col = lg.length % 2
      const newItem: LayoutItem = { i: id, x: col * 6, y: Infinity, w: 6, h: 8, minW: 2, minH: 3 }
      return { ...prev, lg: [...lg, newItem] }
    })
  }, [])

  const removeCell = useCallback((id: string) => {
    cellApiRef.current.delete(id)
    if (activeCellIdRef.current === id) activeCellIdRef.current = null
    setCells((prev) => prev.filter((c) => c.id !== id))
    setLayouts((prev) => ({
      ...prev,
      lg: ((prev.lg || []) as LayoutItem[]).filter((l) => l.i !== id),
    }))
  }, [])

  const closeActive = useCallback(() => {
    const target = activeCellIdRef.current || cellsRef.current[cellsRef.current.length - 1]?.id
    if (target) removeCell(target)
  }, [removeCell])

  const setCellCli = useCallback((id: string, cliType: CliType) => {
    setCells((prev) => prev.map((c) => (c.id === id ? { ...c, cliType } : c)))
  }, [])

  const setCellName = useCallback((id: string, name: string) => {
    setCells((prev) => prev.map((c) => (c.id === id ? { ...c, name } : c)))
  }, [])

  const setCellHostedProject = useCallback((id: string, hostedProjectId: string | undefined) => {
    setCells((prev) => prev.map((c) => (c.id === id ? { ...c, hostedProjectId } : c)))
    // When a hosted project is selected, configure the hook on the agent so
    // the working directory has .orquesta.json pointing at that project.
    if (hostedProjectId && hostedToken && socket) {
      const project = hostedProjects?.find(p => p.id === hostedProjectId)
      socket.emit('hook:init-project', {
        token: hostedToken,
        apiUrl: hostedApiUrl,
        projectId: hostedProjectId,
        projectName: project?.name,
      })
    }
  }, [socket, hostedToken, hostedApiUrl, hostedProjects])

  // Ctrl+P — reflow every pane into a tidy near-square grid and refit all.
  const arrange = useCallback(() => {
    setLayouts((prev) => ({ ...prev, lg: buildTidyLayout(cellsRef.current) }))
    setTimeout(() => cellApiRef.current.forEach((a) => a.fit()), 80)
  }, [])

  const zoom = useCallback((delta: number) => {
    setFontSize((prev) => {
      const next = delta === 0 ? DEFAULT_FONT : Math.min(MAX_FONT, Math.max(MIN_FONT, prev + delta))
      try { localStorage.setItem(FONT_KEY, String(next)) } catch {}
      return next
    })
  }, [])

  // Expose imperative controls to the host page (palette / buttons).
  useEffect(() => {
    apiRef.current = { addTerminal: addCell, arrange, closeActive }
  }, [apiRef, addCell, arrange, closeActive])

  // Grid-level keyboard shortcuts for when NO terminal is focused (the focused
  // case is handled inside the pane so the keys don't reach the shell).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (activeCellIdRef.current) return // pane handles it
      const mod = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      if (e.altKey && k === 't') { e.preventDefault(); addCell() }
      else if (e.altKey && k === 'w') { e.preventDefault(); closeActive() }
      else if (mod && !e.shiftKey && k === 'p') { e.preventDefault(); arrange() }
      else if (mod && !e.shiftKey && (k === '=' || k === '+')) { e.preventDefault(); zoom(1) }
      else if (mod && !e.shiftKey && k === '-') { e.preventDefault(); zoom(-1) }
      else if (mod && !e.shiftKey && k === '0') { e.preventDefault(); zoom(0) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [addCell, closeActive, arrange, zoom])

  const handleLayoutChange = (_layout: unknown, allLayouts: ResponsiveLayouts) => {
    setLayouts(allLayouts)
  }

  if (cells.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="rounded-full bg-zinc-800 p-4 mb-4">
          <Maximize2 className="h-8 w-8 text-zinc-500" />
        </div>
        <p className="text-zinc-400 font-medium">Terminal Grid</p>
        <p className="mt-1 text-sm text-zinc-600 max-w-xs">
          Add terminal panes to run CLIs side by side. <span className="font-mono text-zinc-500">Alt+T</span> new · <span className="font-mono text-zinc-500">Ctrl+P</span> arrange.
        </p>
        <Button onClick={addCell} className="mt-6" size="sm">
          <Plus className="h-4 w-4" /> Add Terminal
        </Button>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-3 flex justify-end gap-2">
        <Button onClick={arrange} size="sm" variant="outline" title="Auto-arrange & fit all panes (Ctrl+P)">
          <LayoutGrid className="h-4 w-4" /> Arrange
        </Button>
        <Button onClick={addCell} size="sm" variant="outline" title="New terminal (Alt+T)">
          <Plus className="h-4 w-4" /> Add Terminal
        </Button>
      </div>

      <ResponsiveGridLayout
        width={containerWidth}
        layouts={layouts}
        breakpoints={{ lg: 1200, md: 996, sm: 768 }}
        cols={{ lg: 12, md: 8, sm: 4 }}
        rowHeight={40}
        onLayoutChange={handleLayoutChange}
        dragConfig={{ enabled: true, handle: '.drag-handle', bounded: true }}
        resizeConfig={{ enabled: true }}
      >
        {cells.map((cell) => (
          <div key={cell.id} className="h-full">
            <TerminalCell
              cellId={cell.id}
              socket={socket}
              cliType={cell.cliType}
              name={cell.name}
              fontSize={fontSize}
              opacity={terminalOpacity}
              hostedApiUrl={hostedApiUrl}
              hostedToken={hostedToken}
              hostedProjects={hostedProjects}
              hostedProjectId={cell.hostedProjectId}
              onClose={() => removeCell(cell.id)}
              onCliTypeChange={(v) => setCellCli(cell.id, v)}
              onRename={(v) => setCellName(cell.id, v)}
              onHostedProjectChange={(v) => setCellHostedProject(cell.id, v)}
              onFocusCell={() => { activeCellIdRef.current = cell.id }}
              onNew={addCell}
              onArrange={arrange}
              onZoom={zoom}
              registerApi={(api) => {
                if (api) cellApiRef.current.set(cell.id, api)
                else cellApiRef.current.delete(cell.id)
              }}
            />
          </div>
        ))}
      </ResponsiveGridLayout>
    </div>
  )
}

export const AgentGrid = forwardRef<AgentGridHandle, AgentGridProps>(function AgentGrid(
  { socket, storageKey, terminalOpacity, hostedApiUrl, hostedToken, hostedProjects }, ref,
) {
  const { containerRef, width } = useContainerWidth()
  const apiRef = useRef<AgentGridHandle>({ addTerminal() {}, arrange() {}, closeActive() {} })
  useImperativeHandle(ref, () => ({
    addTerminal: () => apiRef.current.addTerminal(),
    arrange: () => apiRef.current.arrange(),
    closeActive: () => apiRef.current.closeActive(),
  }), [])

  return (
    <div ref={containerRef}>
      {width > 0 && (
        <AgentGridInner
          socket={socket}
          containerWidth={width}
          storageKey={storageKey}
          terminalOpacity={terminalOpacity}
          hostedApiUrl={hostedApiUrl}
          hostedToken={hostedToken}
          hostedProjects={hostedProjects}
          apiRef={apiRef}
        />
      )}
    </div>
  )
})
