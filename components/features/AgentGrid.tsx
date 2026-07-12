'use client'

import { useState, useEffect, useMemo, useRef, useCallback, forwardRef, useImperativeHandle } from 'react'
import { ResponsiveGridLayout, useContainerWidth } from 'react-grid-layout'
import type { LayoutItem, ResponsiveLayouts } from 'react-grid-layout'
import { Socket } from 'socket.io-client'
import { GeistMono } from 'geist/font/mono'
import { Button } from '@/components/ui/button'
import { Plus, X, Maximize2, GitBranch, LayoutGrid, Pencil, Cloud, Share2, Eye, Keyboard, Search, Check, ChevronDown, Link2, Users, Cpu, AlertTriangle, Folder, FolderOpen, Home, CornerLeftUp, PanelLeft } from 'lucide-react'
import { TerminalSidebar } from './TerminalSidebar'
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
  /** Imported panes start their PTY in this working directory. */
  cwd?: string
  /** For imported CLI sessions: resume this session id (e.g. `claude --resume <id>`). */
  resumeId?: string
}

/** One external session to import as a live terminal pane. */
export interface ImportSpec {
  cliType: CliType
  cwd?: string
  resumeId?: string
  name?: string
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
  { value: 'kiro', label: 'Kiro' },
  { value: 'opencode', label: 'OpenCode' },
] as const

type CliType = (typeof CLI_OPTIONS)[number]['value']

const MIN_FONT = 9
const MAX_FONT = 24

interface CellApi {
  clear: () => void
  fit: () => void
}

/**
 * Searchable hosted-project picker for a pane header. A plain <select> is
 * unusable once an org has dozens of projects (the user has 43), so this is a
 * compact combobox: a chip that opens a popover with a filter input + a
 * scrollable, keyboard-friendly list. Commits via onChange (undefined = none).
 */
function HostedProjectPicker({
  projects, value, onChange,
}: {
  projects: HostedProject[]
  value?: string
  onChange: (projectId: string | undefined) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const selected = projects.find((p) => p.id === value)
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return projects
    return projects.filter((p) => p.name.toLowerCase().includes(q))
  }, [projects, query])

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Focus the filter as soon as the popover opens.
  useEffect(() => {
    if (open) { setQuery(''); requestAnimationFrame(() => inputRef.current?.focus()) }
  }, [open])

  const pick = (id: string | undefined) => { onChange(id); setOpen(false) }

  return (
    <div ref={rootRef} className="relative" onMouseDown={(e) => e.stopPropagation()}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex max-w-[8rem] items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono outline-none transition-colors focus:ring-1 focus:ring-cyan-500/40 ${
          selected ? 'bg-zinc-800/70 text-cyan-300 hover:bg-zinc-700' : 'bg-zinc-800/70 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
        }`}
        title="Hosted project (hooks report here) — click to search"
      >
        <span className="truncate">{selected ? selected.name : 'No project'}</span>
        <ChevronDown className="h-2.5 w-2.5 shrink-0 opacity-70" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-56 overflow-hidden rounded-md border border-zinc-700 bg-zinc-900/95 shadow-xl backdrop-blur">
          <div className="flex items-center gap-1.5 border-b border-zinc-800 px-2 py-1.5">
            <Search className="h-3 w-3 shrink-0 text-zinc-500" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${projects.length} projects…`}
              className="w-full bg-transparent text-xs font-mono text-zinc-200 outline-none placeholder:text-zinc-600"
            />
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            <button
              onClick={() => pick(undefined)}
              className="flex w-full items-center justify-between px-2 py-1 text-left text-[11px] font-mono text-zinc-400 hover:bg-zinc-800"
            >
              <span>No project</span>
              {!value && <Check className="h-3 w-3 text-cyan-400" />}
            </button>
            {filtered.map((p) => (
              <button
                key={p.id}
                onClick={() => pick(p.id)}
                className="flex w-full items-center justify-between gap-2 px-2 py-1 text-left text-[11px] font-mono text-zinc-300 hover:bg-zinc-800"
                title={p.name}
              >
                <span className="truncate">{p.name}</span>
                {value === p.id && <Check className="h-3 w-3 shrink-0 text-cyan-400" />}
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="px-2 py-2 text-center text-[11px] font-mono text-zinc-600">No matches</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Live multiplayer cursors ─────────────────────────────────────────────
// Every participant (this cockpit + each dashboard viewer) broadcasts its mouse
// position over the shared channel as a fraction (0..1) of the terminal
// viewport. Receivers map that fraction onto their own terminal. A fraction
// outside [0,1] means the pointer is off the terminal for that person → we draw
// a directional arrow on the nearest edge instead of a pointer.
interface RemoteCursor { id: string; name: string; color: string; x: number; y: number; ts: number }

function cursorColor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return `hsl(${h % 360} 85% 62%)`
}

// Stable per-browser identity for this cockpit's own cursor.
function localParticipant(): { id: string; name: string; color: string } {
  let id = ''
  try {
    id = localStorage.getItem('orq-term-participant-id') || ''
    if (!id) { id = 'host-' + Math.random().toString(36).slice(2, 9); localStorage.setItem('orq-term-participant-id', id) }
  } catch { id = 'host-local' }
  return { id, name: 'Host', color: cursorColor(id) }
}

function CursorOverlay({ cursors }: { cursors: RemoteCursor[] }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      {cursors.map((c) => {
        const inside = c.x >= 0 && c.x <= 1 && c.y >= 0 && c.y <= 1
        if (inside) {
          return (
            <div
              key={c.id}
              className="absolute flex items-start gap-1"
              style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%`, color: c.color, transition: 'left 90ms linear, top 90ms linear' }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style={{ filter: 'drop-shadow(0 1px 1px rgba(0,0,0,.6))' }}>
                <path d="M1 1 L1 13 L4.6 9.6 L7 14.5 L9.2 13.5 L6.8 8.8 L12 8.6 Z" />
              </svg>
              <span className="rounded px-1 py-px text-[9px] font-medium leading-none text-black" style={{ background: c.color }}>{c.name}</span>
            </div>
          )
        }
        // Off-terminal → directional edge arrow pointing toward the real point.
        const ex = Math.min(0.97, Math.max(0.03, c.x))
        const ey = Math.min(0.97, Math.max(0.03, c.y))
        const angle = (Math.atan2(c.y - ey, c.x - ex) * 180) / Math.PI
        return (
          <div
            key={c.id}
            className="absolute flex items-center gap-1"
            style={{ left: `${ex * 100}%`, top: `${ey * 100}%`, transform: 'translate(-50%, -50%)', color: c.color, transition: 'left 90ms linear, top 90ms linear' }}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" style={{ transform: `rotate(${angle}deg)`, filter: 'drop-shadow(0 1px 1px rgba(0,0,0,.6))' }}>
              <path d="M2 8 L11 8 M11 8 L7 4.5 M11 8 L7 11.5" stroke="currentColor" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="rounded px-1 py-px text-[9px] font-medium leading-none text-black" style={{ background: c.color }}>{c.name}</span>
          </div>
        )
      })}
    </div>
  )
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
  /** Imported panes: working directory to spawn the PTY in. */
  cwd?: string
  /** Imported panes: resume this CLI session id (e.g. claude --resume). */
  resumeId?: string
  /** This pane's project already has a local daemon (this machine is its agent). */
  daemonRunning?: boolean
  onClose: () => void
  onCliTypeChange: (v: CliType) => void
  onRename: (v: string) => void
  onHostedProjectChange: (projectId: string | undefined) => void
  /** Open the "make this the project agent" (daemon takeover) confirm modal. */
  onMakeAgent: () => void
  /** Open the folder picker to change this pane's working directory. */
  onPickFolder: () => void
  onFocusCell: () => void
  onNew: () => void
  onArrange: () => void
  onZoom: (delta: number) => void
  registerApi: (api: CellApi | null) => void
}

function TerminalCell({
  cellId, socket, cliType, name, fontSize, opacity, hostedApiUrl, hostedToken,
  hostedProjects, hostedProjectId, cwd, resumeId, daemonRunning,
  onClose, onCliTypeChange, onRename, onHostedProjectChange, onMakeAgent, onPickFolder, onFocusCell, onNew, onArrange, onZoom, registerApi,
}: TerminalCellProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<import('@xterm/xterm').Terminal | null>(null)
  const fitAddonRef = useRef<import('@xterm/addon-fit').FitAddon | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [branch, setBranch] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  // Per-terminal task/timeline rail (Phase 1 of the Prompt Loop).
  const [sidebarOpen, setSidebarOpen] = useState(false)

  // Type a picked task's story into the LIVE pty for review-before-send. Wrap
  // in bracketed-paste markers so multi-line bodies land as ONE paste (claude/
  // orquesta interactive enable DECSET 2004) instead of each newline submitting.
  const seedInput = useCallback((text: string) => {
    const sid = sessionIdRef.current
    if (!sid || !socket || !text) return
    const wrapped = `\x1b[200~${text}\x1b[201~`
    socket.emit('session:input', { sessionId: sid, data: wrapped })
    try { termRef.current?.focus() } catch {}
  }, [socket])
  // Share-to-Orquesta state for this pane.
  const [shared, setShared] = useState(false)
  const [allowControl, setAllowControl] = useState(false)
  const [sharing, setSharing] = useState(false)
  // Dashboard viewers currently watching this shared terminal (presence).
  const [viewers, setViewers] = useState<{ id: string; name: string }[]>([])
  const [copied, setCopied] = useState(false)
  // Live cursors of the people watching this shared terminal.
  const [remoteCursors, setRemoteCursors] = useState<RemoteCursor[]>([])
  const cursorsRef = useRef<Map<string, RemoteCursor>>(new Map())
  const sharedRef = useRef(false)
  sharedRef.current = shared

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
  const importRef = useRef({ cwd, resumeId })
  importRef.current = { cwd, resumeId }

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

      term.writeln('\x1b[32mOrquesta Terminal\x1b[0m')
      term.writeln('\x1b[90mConnecting…\x1b[0m')
      term.writeln('')

      const startSession = (reconnect = false) => {
        const sessionId = `sess-${cellId}-${Date.now()}`
        sessionIdRef.current = sessionId
        setBranch(null)
        if (reconnect) term.writeln('\r\n\x1b[32m[reconnected — new session]\x1b[0m')
        socket?.emit('session:start', {
          sessionId, cellId, cliType, rows: term.rows, cols: term.cols,
          hostedApiUrl: hostedRef.current.apiUrl, hostedToken: hostedRef.current.token,
          cwd: importRef.current.cwd, resumeId: importRef.current.resumeId,
        })
      }
      // Delay session start slightly so the container has its final size
      // (prevents orquesta-cli/Ink from getting 24x80 when pane is larger)
      setTimeout(() => {
        try { fitAddon.fit() } catch {}
        startSession()
      }, 100)

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
    // `cwd` is in the deps so changing the pane's working directory tears down
    // the PTY and starts a fresh session in the new folder.
  }, [cellId, socket, cliType, cwd])

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
    const handleShareStatus = (data: { sessionId: string; shared?: boolean; allowControl?: boolean }) => {
      if (data.sessionId !== sessionIdRef.current) return
      setSharing(false)
      if (typeof data.shared === 'boolean') { setShared(data.shared); if (!data.shared) setViewers([]) }
      if (typeof data.allowControl === 'boolean') setAllowControl(data.allowControl)
    }
    const handleViewers = (data: { sessionId: string; viewers: { id: string; name: string }[] }) => {
      if (data.sessionId !== sessionIdRef.current) return
      setViewers(Array.isArray(data.viewers) ? data.viewers : [])
    }

    socket.on('session:output', handleOutput)
    socket.on('session:ended', handleEnded)
    socket.on('session:error', handleError)
    socket.on('session:meta', handleMeta)
    socket.on('terminal:share-status', handleShareStatus)
    socket.on('terminal:viewers', handleViewers)

    return () => {
      socket.off('session:output', handleOutput)
      socket.off('session:ended', handleEnded)
      socket.off('session:error', handleError)
      socket.off('session:meta', handleMeta)
      socket.off('terminal:share-status', handleShareStatus)
      socket.off('terminal:viewers', handleViewers)
    }
  }, [socket])

  // Ended sessions can't stay shared.
  useEffect(() => {
    const handleEnded = (data: { sessionId: string }) => {
      if (data.sessionId === sessionIdRef.current) { setShared(false); setAllowControl(false) }
    }
    socket?.on('session:ended', handleEnded)
    return () => { socket?.off('session:ended', handleEnded) }
  }, [socket])

  // ── Live cursors: broadcast this cockpit's own mouse over the shared PTY. ──
  // Tracks on window so we still report a position (as an out-of-bounds
  // fraction) when the pointer drifts just off the terminal → the far side
  // draws an edge arrow. Throttled; only while the pane is actually shared.
  useEffect(() => {
    if (!socket || !shared) return
    const me = localParticipant()
    let last = 0
    const onMove = (e: MouseEvent) => {
      const el = containerRef.current
      const sid = sessionIdRef.current
      if (!el || !sid || !sharedRef.current) return
      const now = Date.now()
      if (now - last < 45) return
      const r = el.getBoundingClientRect()
      if (r.width < 4 || r.height < 4) return
      const x = (e.clientX - r.left) / r.width
      const y = (e.clientY - r.top) / r.height
      // Ignore when the pointer is way off this pane (keeps other panes quiet).
      if (x < -0.4 || x > 1.4 || y < -0.4 || y > 1.4) return
      last = now
      socket.emit('terminal:cursor', { sessionId: sid, id: me.id, name: me.name, color: me.color, x, y })
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [socket, shared])

  // ── Live cursors: receive the watchers' pointers (relayed by the server). ──
  useEffect(() => {
    if (!socket) return
    const me = localParticipant()
    const onCursor = (p: any) => {
      if (!p || p.sessionId !== sessionIdRef.current || p.id === me.id) return
      cursorsRef.current.set(p.id, {
        id: p.id, name: p.name || 'Someone', color: p.color || cursorColor(p.id),
        x: p.x, y: p.y, ts: Date.now(),
      })
      setRemoteCursors(Array.from(cursorsRef.current.values()))
    }
    socket.on('terminal:cursor', onCursor)
    const sweep = setInterval(() => {
      const now = Date.now()
      let changed = false
      for (const [id, c] of cursorsRef.current) {
        if (now - c.ts > 4000) { cursorsRef.current.delete(id); changed = true }
      }
      if (changed) setRemoteCursors(Array.from(cursorsRef.current.values()))
    }, 1500)
    return () => { socket.off('terminal:cursor', onCursor); clearInterval(sweep) }
  }, [socket])

  // Drop everyone's cursor the moment this pane stops being shared.
  useEffect(() => {
    if (!shared) { cursorsRef.current.clear(); setRemoteCursors([]) }
  }, [shared])

  const toggleShare = useCallback(() => {
    if (!socket || !sessionIdRef.current) return
    if (shared) {
      socket.emit('terminal:unshare', { sessionId: sessionIdRef.current })
      setShared(false)
      setAllowControl(false)
      return
    }
    if (!hostedProjectId || !hostedToken) return
    setSharing(true)
    socket.emit('terminal:share', {
      sessionId: sessionIdRef.current,
      projectId: hostedProjectId,
      apiUrl: hostedApiUrl,
      cliToken: hostedToken,
      cliType,
      cwd,
      allowControl: false,
    })
  }, [socket, shared, hostedProjectId, hostedToken, hostedApiUrl, cliType, cwd])

  const toggleControl = useCallback(() => {
    if (!socket || !sessionIdRef.current || !shared) return
    const next = !allowControl
    setAllowControl(next)
    socket.emit('terminal:share-control', { sessionId: sessionIdRef.current, allowControl: next })
  }, [socket, shared, allowControl])

  // Copy a deep-link that opens THIS shared terminal in the Orquesta dashboard
  // (Prompts view → Shared Terminals sub-tab → auto-opens the viewer). Paste it
  // to a teammate; they land straight on the live terminal.
  const copyShareLink = useCallback(async () => {
    const sid = sessionIdRef.current
    if (!sid || !hostedProjectId) return
    let origin = ''
    try { origin = hostedApiUrl ? new URL(hostedApiUrl).origin : window.location.origin }
    catch { origin = typeof window !== 'undefined' ? window.location.origin : '' }
    const link = `${origin}/dashboard/projects/${hostedProjectId}?view=cli-integration&sharedSession=${encodeURIComponent(sid)}`
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard blocked (insecure context / permissions) — surface the link.
      window.prompt('Copy this link to share the terminal:', link)
    }
  }, [hostedProjectId, hostedApiUrl])

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
      // Focus-follows-mouse: once the cursor settles on a pane (~150ms) it
      // becomes active for the keyboard — no click needed. The delay avoids
      // stealing focus while merely passing over, and we never steal it mid-
      // selection so dragging to copy text across panes still works.
      onMouseEnter={() => {
        if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
        hoverTimerRef.current = setTimeout(() => {
          if (!window.getSelection()?.isCollapsed) return
          try { termRef.current?.focus() } catch {}
        }, 150)
      }}
      onMouseLeave={() => {
        if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null }
      }}
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
          {hostedProjectId && hostedApiUrl && hostedToken && (
            <button
              onClick={() => setSidebarOpen((v) => !v)}
              onMouseDown={(e) => e.stopPropagation()}
              className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono transition-colors ${
                sidebarOpen ? 'bg-green-500/15 text-green-300 hover:bg-green-500/25' : 'bg-zinc-800/70 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
              }`}
              title={sidebarOpen ? 'Hide task sidebar' : 'Tasks: pick a ticket/plan to start a prompt'}
            >
              <PanelLeft className="h-3 w-3 shrink-0" />
              Tasks
            </button>
          )}
          <button
            onClick={onPickFolder}
            onMouseDown={(e) => e.stopPropagation()}
            className={`flex min-w-0 shrink items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono transition-colors ${
              cwd ? 'bg-zinc-800/70 text-amber-300/90 hover:bg-zinc-700' : 'bg-zinc-800/70 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
            }`}
            title={cwd ? `Working dir: ${cwd} — click to change (restarts the session)` : 'Choose a working folder for this terminal'}
          >
            <Folder className="h-3 w-3 shrink-0" />
            <span className="truncate max-w-[7rem]">{cwd ? cwd.replace(/\/+$/, '').split('/').pop() || cwd : 'Folder'}</span>
          </button>
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
            <HostedProjectPicker
              projects={hostedProjects}
              value={hostedProjectId}
              onChange={onHostedProjectChange}
            />
          )}
          {hostedProjectId && (
            <span title="Reporting to hosted">
              <Cloud className="h-3 w-3 shrink-0 text-cyan-400" />
            </span>
          )}
          {/* Daemon takeover: promote this terminal into the project's agent so
              it receives dispatched prompts from the dashboard. */}
          {hostedProjectId && (
            <button
              onClick={onMakeAgent}
              onMouseDown={(e) => e.stopPropagation()}
              className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono transition-colors ${
                daemonRunning
                  ? 'bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30'
                  : 'bg-zinc-800/70 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
              }`}
              title={daemonRunning ? 'This terminal is the project agent — click to manage/stop' : 'Make this terminal the project agent (receive dispatched prompts)'}
            >
              <Cpu className="h-3 w-3 shrink-0" />
              {daemonRunning ? 'Agent ●' : 'Make agent'}
            </button>
          )}
          {/* Share terminal: stream this live PTY to the selected Orquesta
              project so teammates can watch (and, if allowed, drive) it. */}
          {hostedProjectId && (
            <button
              onClick={toggleShare}
              onMouseDown={(e) => e.stopPropagation()}
              disabled={sharing}
              className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono transition-colors disabled:opacity-50 ${
                shared
                  ? 'bg-cyan-500/20 text-cyan-300 hover:bg-cyan-500/30'
                  : 'bg-zinc-800/70 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
              }`}
              title={shared ? 'Stop sharing this terminal' : 'Share this terminal to the team'}
            >
              <Share2 className="h-3 w-3 shrink-0" />
              {sharing ? 'Sharing…' : shared ? 'Shared' : 'Share'}
            </button>
          )}
          {shared && (
            <button
              onClick={toggleControl}
              onMouseDown={(e) => e.stopPropagation()}
              className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono transition-colors ${
                allowControl
                  ? 'bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30'
                  : 'bg-zinc-800/70 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
              }`}
              title={allowControl ? 'Teammates can type — click for view-only' : 'View-only — click to let teammates type'}
            >
              {allowControl ? <Keyboard className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              {allowControl ? 'Control' : 'View-only'}
            </button>
          )}
          {shared && (
            <button
              onClick={copyShareLink}
              onMouseDown={(e) => e.stopPropagation()}
              className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono transition-colors ${
                copied ? 'bg-emerald-500/20 text-emerald-300' : 'bg-zinc-800/70 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
              }`}
              title="Copy a link to this shared terminal"
            >
              {copied ? <Check className="h-3 w-3" /> : <Link2 className="h-3 w-3" />}
              {copied ? 'Copied' : 'Copy link'}
            </button>
          )}
          {shared && (
            <span
              className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono ${
                viewers.length > 0 ? 'bg-cyan-500/15 text-cyan-300' : 'text-zinc-500'
              }`}
              title={
                viewers.length > 0
                  ? `Watching now: ${viewers.map((v) => v.name).join(', ')}`
                  : 'No one is watching yet'
              }
            >
              <Users className="h-3 w-3 shrink-0" />
              {viewers.length}
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
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {sidebarOpen && hostedProjectId && hostedApiUrl && hostedToken && (
          <TerminalSidebar
            apiUrl={hostedApiUrl}
            token={hostedToken}
            projectId={hostedProjectId}
            onSeed={seedInput}
            onClose={() => setSidebarOpen(false)}
          />
        )}
        <div className="relative min-w-0 flex-1 overflow-hidden">
          <div ref={containerRef} className="h-full px-1 pt-1 pb-0 overflow-hidden" />
          {shared && remoteCursors.length > 0 && <CursorOverlay cursors={remoteCursors} />}
        </div>
      </div>
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
  /** Create one live terminal pane per external session, then tidy the grid. */
  importSessions: (specs: ImportSpec[]) => void
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

// Total grid-row budget a tidy layout spans. Combined with a dynamic rowHeight
// (see AgentGridInner), the grid always fills exactly the visible viewport.
const GRID_ROWS = 12
// Gap between panes (px) and estimated height of the Arrange/Add toolbar above.
const GRID_MARGIN = 6
const TOOLBAR_H = 44

function buildTidyLayout(cells: GridCell[]): LayoutItem[] {
  const n = cells.length
  if (!n) return []
  const cols = Math.ceil(Math.sqrt(n))
  const rows = Math.ceil(n / cols)
  const w = Math.max(1, Math.floor(12 / cols))
  const h = Math.max(2, Math.floor(GRID_ROWS / rows))
  return cells.map((c, i) => ({
    i: c.id,
    x: (i % cols) * w,
    y: Math.floor(i / cols) * h,
    w,
    h,
    minW: 2,
    minH: 2,
  }))
}

/**
 * Directory browser modal — pick a working folder for a terminal. Talks to the
 * server's `fs:list-dir` handler (read-only, dirs only) to walk the local
 * filesystem. Used both to open a new terminal in a folder and to change an
 * existing pane's working directory (which restarts its session there).
 */
function FolderPicker({
  socket, initialPath, title, onChoose, onClose,
}: {
  socket: Socket | null
  initialPath?: string
  title: string
  onChoose: (dir: string) => void
  onClose: () => void
}) {
  const [path, setPath] = useState(initialPath || '')
  const [parent, setParent] = useState<string | null>(null)
  const [home, setHome] = useState<string>('')
  const [entries, setEntries] = useState<{ name: string; path: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!socket) return
    const onResult = (r: any = {}) => {
      setLoading(false)
      if (!r.ok) { setError(r.error || 'Could not read folder'); return }
      setError(null)
      setPath(r.path)
      setParent(r.parent || null)
      if (r.home) setHome(r.home)
      setEntries(Array.isArray(r.entries) ? r.entries : [])
    }
    socket.on('fs:list-dir-result', onResult)
    socket.emit('fs:list-dir', { path: initialPath })
    return () => { socket.off('fs:list-dir-result', onResult) }
  }, [socket, initialPath])

  const go = (p?: string | null) => {
    if (p === undefined || p === null) return
    setLoading(true)
    socket?.emit('fs:list-dir', { path: p })
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4" onMouseDown={onClose}>
      <div
        className="flex max-h-[70vh] w-full max-w-lg flex-col rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-100">
            <FolderOpen className="h-4 w-4 text-amber-400" />
            {title}
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex items-center gap-1.5 border-b border-zinc-800 px-3 py-2">
          <button
            onClick={() => go(home)}
            disabled={!home}
            className="flex shrink-0 items-center gap-1 rounded bg-zinc-800 px-1.5 py-1 text-[11px] text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
            title="Home"
          >
            <Home className="h-3 w-3" />
          </button>
          <button
            onClick={() => go(parent)}
            disabled={!parent}
            className="flex shrink-0 items-center gap-1 rounded bg-zinc-800 px-1.5 py-1 text-[11px] text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
            title="Up one level"
          >
            <CornerLeftUp className="h-3 w-3" />
          </button>
          <div className="min-w-0 flex-1 truncate rounded bg-zinc-800/60 px-2 py-1 font-mono text-[11px] text-zinc-400" title={path}>
            {path || '…'}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {loading ? (
            <div className="px-4 py-6 text-center text-xs text-zinc-500">Loading…</div>
          ) : error ? (
            <div className="px-4 py-6 text-center text-xs text-amber-300">{error}</div>
          ) : entries.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-zinc-600">No sub-folders here</div>
          ) : (
            entries.map((e) => (
              <button
                key={e.path}
                onDoubleClick={() => go(e.path)}
                onClick={() => go(e.path)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800"
                title={`Open ${e.name}`}
              >
                <Folder className="h-3.5 w-3.5 shrink-0 text-amber-400/80" />
                <span className="truncate font-mono">{e.name}</span>
              </button>
            ))
          )}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-zinc-800 px-4 py-3">
          <span className="truncate font-mono text-[11px] text-zinc-500">Use: {path || '…'}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" onClick={() => path && onChoose(path)} disabled={!path}>Open here</Button>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Pre-flight confirmation for daemon takeover. Shows any agents already online
 * for the project (so the user knows they'd add a second executor — untargeted
 * dispatch would double-run) and confirms before spawning the local daemon. If a
 * local daemon is already running for the project, offers to stop it instead.
 */
function DaemonTakeoverModal({
  modal, busy, onConfirm, onStop, onClose,
}: {
  modal: { projectId: string; projectName?: string; cwd?: string; loading: boolean; online: { id: string; name: string; lastSeen: string | null }[]; localRunning: boolean; error?: string }
  busy: boolean
  onConfirm: () => void
  onStop: () => void
  onClose: () => void
}) {
  const label = modal.projectName || modal.projectId
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4" onMouseDown={onClose}>
      <div
        className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-100">
            <Cpu className="h-4 w-4 text-emerald-400" />
            {modal.localRunning ? 'Project agent (running)' : 'Make this the project agent'}
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300"><X className="h-4 w-4" /></button>
        </div>
        <div className="space-y-3 px-4 py-4 text-xs text-zinc-300">
          <p>
            This spawns <span className="font-mono text-zinc-100">orquesta-agent --daemon</span> on this machine for{' '}
            <span className="font-mono text-cyan-300">{label}</span>. It will receive prompts dispatched from the dashboard and run them here.
          </p>
          <p className="text-zinc-500">
            Working dir: <span className="font-mono">{modal.cwd || '$HOME'}</span>
          </p>

          {modal.loading ? (
            <div className="text-zinc-500">Checking for agents already online…</div>
          ) : modal.error ? (
            <div className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-200">
              Couldn’t check existing agents: {modal.error}. You can still proceed.
            </div>
          ) : modal.online.length > 0 ? (
            <div className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-200">
              <div className="mb-1 flex items-center gap-1.5 font-medium">
                <AlertTriangle className="h-3.5 w-3.5" />
                {modal.online.length} agent{modal.online.length > 1 ? 's' : ''} already online for this project
              </div>
              <ul className="ml-1 list-inside list-disc space-y-0.5 text-amber-200/90">
                {modal.online.map((a) => <li key={a.id} className="font-mono">{a.name}</li>)}
              </ul>
              <p className="mt-1.5 text-amber-200/70">
                Dispatched prompts go to every online agent, so adding this one means both would run each prompt. Stop the other agent first if you don’t want double execution.
              </p>
            </div>
          ) : (
            <div className="rounded border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-emerald-300/90">
              No other agent is online for this project — safe to take over.
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-zinc-800 px-4 py-3">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
          {modal.localRunning ? (
            <Button size="sm" variant="danger" onClick={onStop} disabled={busy}>
              {busy ? 'Stopping…' : 'Stop agent'}
            </Button>
          ) : (
            <Button size="sm" onClick={onConfirm} disabled={busy || modal.loading}>
              {busy ? 'Starting…' : 'Start agent'}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function AgentGridInner({
  socket, containerWidth, containerHeight, storageKey, terminalOpacity = 1, hostedApiUrl, hostedToken, hostedProjects,
  apiRef,
}: AgentGridProps & { containerWidth: number; containerHeight: number; apiRef: React.MutableRefObject<AgentGridHandle> }) {
  const key = storageKey || STORAGE_KEY
  const [cells, setCells] = useState<GridCell[]>([])
  const [layouts, setLayouts] = useState<ResponsiveLayouts>({ lg: [] })
  const [fontSize, setFontSize] = useState(DEFAULT_FONT)
  const loadedRef = useRef(false)
  // The storageKey the persist effect last committed under. Lets it skip the one
  // commit where `key` changes (stale cells closure) before re-persisting.
  const persistKeyRef = useRef(key)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const activeCellIdRef = useRef<string | null>(null)
  const cellApiRef = useRef<Map<string, CellApi>>(new Map())
  const cellsRef = useRef<GridCell[]>([])
  cellsRef.current = cells

  // ── Daemon takeover state ──────────────────────────────────────────────
  // Which projects currently have a local daemon running (this machine is their
  // agent), keyed by projectId. Populated from daemon:status broadcasts.
  const [daemonStatus, setDaemonStatus] = useState<Record<string, { running: boolean; pid?: number }>>({})
  // The pre-flight confirmation modal (populated by daemon:preflight-result).
  const [daemonModal, setDaemonModal] = useState<
    | null
    | {
        projectId: string
        projectName?: string
        cwd?: string
        loading: boolean
        online: { id: string; name: string; lastSeen: string | null }[]
        localRunning: boolean
        error?: string
      }
  >(null)
  const [daemonBusy, setDaemonBusy] = useState(false)
  const [daemonMsg, setDaemonMsg] = useState<{ ok: boolean; message: string } | null>(null)

  // Folder picker: choose a working directory for a new terminal ('new') or an
  // existing pane (cellId set → changing it restarts that pane's session there).
  const [folderPicker, setFolderPicker] = useState<{ cellId: string | null; initialPath?: string } | null>(null)

  useEffect(() => {
    if (!socket) return
    const onStatus = (s: { projectId?: string; running?: boolean; pid?: number } = {}) => {
      if (!s.projectId) return
      setDaemonStatus((prev) => ({ ...prev, [s.projectId!]: { running: !!s.running, pid: s.pid } }))
    }
    const onStatusAll = (list: { projectId: string; running?: boolean; pid?: number }[] = []) => {
      setDaemonStatus(() => {
        const next: Record<string, { running: boolean; pid?: number }> = {}
        for (const d of list) next[d.projectId] = { running: d.running !== false, pid: d.pid }
        return next
      })
    }
    const onPreflight = (r: any = {}) => {
      setDaemonModal((m) =>
        m && m.projectId === r.projectId
          ? {
              ...m,
              loading: false,
              online: Array.isArray(r.online) ? r.online : [],
              localRunning: !!r.localDaemon?.running,
              error: r.ok ? undefined : r.error || 'Pre-flight failed',
            }
          : m,
      )
    }
    const onResult = (r: { ok?: boolean; message?: string } = {}) => {
      setDaemonBusy(false)
      setDaemonMsg({ ok: !!r.ok, message: r.message || (r.ok ? 'Done.' : 'Failed.') })
      if (r.ok) setDaemonModal(null)
    }
    socket.on('daemon:status', onStatus)
    socket.on('daemon:status-all', onStatusAll)
    socket.on('daemon:preflight-result', onPreflight)
    socket.on('daemon:result', onResult)
    socket.emit('daemon:status-request', {})
    return () => {
      socket.off('daemon:status', onStatus)
      socket.off('daemon:status-all', onStatusAll)
      socket.off('daemon:preflight-result', onPreflight)
      socket.off('daemon:result', onResult)
    }
  }, [socket])

  useEffect(() => {
    if (!daemonMsg) return
    const t = setTimeout(() => setDaemonMsg(null), 8000)
    return () => clearTimeout(t)
  }, [daemonMsg])

  // Open the takeover confirm modal for a pane: run pre-flight (list agents
  // already online for the project) so the user sees what they'd compete with.
  const openDaemonModal = useCallback((cellId: string) => {
    const cell = cellsRef.current.find((c) => c.id === cellId)
    if (!cell?.hostedProjectId || !hostedToken || !socket) return
    const project = hostedProjects?.find((p) => p.id === cell.hostedProjectId)
    setDaemonModal({
      projectId: cell.hostedProjectId,
      projectName: project?.name,
      cwd: cell.cwd,
      loading: true,
      online: [],
      localRunning: !!daemonStatus[cell.hostedProjectId]?.running,
    })
    socket.emit('daemon:preflight', { apiUrl: hostedApiUrl, cliToken: hostedToken, projectId: cell.hostedProjectId })
  }, [socket, hostedToken, hostedApiUrl, hostedProjects, daemonStatus])

  const confirmDaemonStart = useCallback(() => {
    if (!daemonModal || !socket || !hostedToken) return
    setDaemonBusy(true)
    socket.emit('daemon:start', {
      apiUrl: hostedApiUrl, cliToken: hostedToken,
      projectId: daemonModal.projectId, projectName: daemonModal.projectName, cwd: daemonModal.cwd,
    })
  }, [daemonModal, socket, hostedToken, hostedApiUrl])

  const stopDaemon = useCallback((projectId: string) => {
    if (!socket) return
    setDaemonBusy(true)
    socket.emit('daemon:stop', { projectId })
    setTimeout(() => setDaemonBusy(false), 500)
  }, [socket])

  // Surface hook-enrollment outcome (success / home-dir guard / missing bin) —
  // otherwise binding a pane to a project gives the user no feedback.
  const [enrollMsg, setEnrollMsg] = useState<{ ok: boolean; message: string } | null>(null)
  useEffect(() => {
    if (!socket) return
    const onResult = (r: { ok?: boolean; message?: string } = {}) => {
      setEnrollMsg({ ok: !!r.ok, message: r.message || (r.ok ? 'Hook configured.' : 'Hook failed.') })
    }
    socket.on('hook:result', onResult)
    return () => { socket.off('hook:result', onResult) }
  }, [socket])
  useEffect(() => {
    if (!enrollMsg) return
    const t = setTimeout(() => setEnrollMsg(null), 8000)
    return () => clearTimeout(t)
  }, [enrollMsg])

  // ── Load persisted state (per-project) + global font size. ──
  // `key` can change AFTER mount (e.g. the page restores the last-selected
  // project a tick after render), so this always fully reconciles cells+layouts
  // for the new key — including resetting to empty when the new key has nothing
  // saved, so a fresh project never shows the previous project's panes.
  useEffect(() => {
    loadedRef.current = false
    let nextCells: GridCell[] = []
    let nextLayouts: ResponsiveLayouts = { lg: [] }
    try {
      const saved = localStorage.getItem(key)
      if (saved) {
        const p = JSON.parse(saved)
        if (p && Array.isArray(p.cells)) {
          nextCells = p.cells
          const lg = (p.layouts?.lg as LayoutItem[] | undefined) || []
          // Reconcile: every restored pane needs a layout item.
          if (lg.length === nextCells.length && nextCells.every((c) => lg.some((l) => l.i === c.id))) {
            nextLayouts = p.layouts
          } else {
            nextLayouts = { lg: buildTidyLayout(nextCells) }
          }
        } else if (p && (p.lg || p.md || p.sm)) {
          nextLayouts = p // legacy layouts-only shape — no panes to restore
        }
      }
    } catch {}
    setCells(nextCells)
    setLayouts(nextLayouts)
    try {
      const f = parseInt(localStorage.getItem(FONT_KEY) || '', 10)
      if (f >= MIN_FONT && f <= MAX_FONT) setFontSize(f)
    } catch {}
    loadedRef.current = true
  }, [key])

  // Persist cells + layouts whenever they change (after initial load). Skips the
  // render where `key` just changed so we never clobber the new key with the
  // previous project's cells (stale closure) before the load effect reconciles.
  useEffect(() => {
    if (!loadedRef.current) return
    if (persistKeyRef.current !== key) { persistKeyRef.current = key; return }
    try {
      const payload: PersistShape = { v: 3, cells, layouts }
      localStorage.setItem(key, JSON.stringify(payload))
    } catch {}
  }, [key, cells, layouts])

  const addCell = useCallback((init?: Partial<Omit<GridCell, 'id'>>) => {
    const id = `cell-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    setCells((prev) => [...prev, { id, cliType: 'shell', name: '', ...init }])
    setLayouts((prev) => {
      const lg = (prev.lg || []) as LayoutItem[]
      const col = lg.length % 2
      const newItem: LayoutItem = { i: id, x: col * 6, y: Infinity, w: 6, h: 6, minW: 2, minH: 2 }
      return { ...prev, lg: [...lg, newItem] }
    })
    return id
  }, [])

  // Import external sessions: one live pane each, resumed in its own cwd.
  const importSessions = useCallback((specs: ImportSpec[]) => {
    for (const s of specs) {
      addCell({ cliType: s.cliType, name: s.name || '', cwd: s.cwd, resumeId: s.resumeId })
    }
    // Reflow into a tidy grid once the new cells have mounted.
    setTimeout(() => {
      setLayouts((prev) => ({ ...prev, lg: buildTidyLayout(cellsRef.current) }))
      setTimeout(() => cellApiRef.current.forEach((a) => a.fit()), 80)
    }, 60)
  }, [addCell])

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

  const setCellCwd = useCallback((id: string, cwd: string) => {
    setCells((prev) => prev.map((c) => (c.id === id ? { ...c, cwd } : c)))
  }, [])

  const setCellHostedProject = useCallback((id: string, hostedProjectId: string | undefined) => {
    setCells((prev) => prev.map((c) => (c.id === id ? { ...c, hostedProjectId } : c)))
    // When a hosted project is selected, configure the hook on the agent so
    // the working directory has .orquesta.json pointing at that project.
    if (hostedProjectId && hostedToken && socket) {
      const project = hostedProjects?.find(p => p.id === hostedProjectId)
      // Enrol the pane's OWN working directory (not the server cwd) so the hook
      // files land where this terminal's CLI actually runs.
      const cell = cellsRef.current.find(c => c.id === id)
      socket.emit('hook:init-project', {
        token: hostedToken,
        apiUrl: hostedApiUrl,
        projectId: hostedProjectId,
        projectName: project?.name,
        cwd: cell?.cwd,
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
    apiRef.current = { addTerminal: () => addCell(), arrange, closeActive, importSessions }
  }, [apiRef, addCell, arrange, closeActive, importSessions])

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

  // Dynamic row height: divide the visible area by the current layout's row span
  // so the whole grid always fits the viewport — no page scroll to lose panes.
  const rowHeight = useMemo(() => {
    const items = (layouts.lg || []) as LayoutItem[]
    const span = items.length ? Math.max(...items.map((it) => it.y + it.h)) : GRID_ROWS
    // Measured toolbar height (incl. its bottom margin) when mounted; estimate otherwise.
    const toolbarH = toolbarRef.current ? toolbarRef.current.offsetHeight + 12 : TOOLBAR_H
    const avail = containerHeight - toolbarH
    if (avail <= 0 || span <= 0) return 40
    return Math.max(16, Math.floor((avail - (span - 1) * GRID_MARGIN) / span))
  }, [layouts, containerHeight])

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
        <div className="mt-6 flex gap-2">
          <Button onClick={() => addCell()} size="sm">
            <Plus className="h-4 w-4" /> Add Terminal
          </Button>
          <Button onClick={() => setFolderPicker({ cellId: null })} size="sm" variant="outline">
            <FolderOpen className="h-4 w-4" /> Open in folder…
          </Button>
        </div>
        {folderPicker && (
          <FolderPicker
            socket={socket}
            initialPath={folderPicker.initialPath}
            title="Open a terminal in…"
            onChoose={(dir) => { addCell({ cwd: dir }); setFolderPicker(null) }}
            onClose={() => setFolderPicker(null)}
          />
        )}
      </div>
    )
  }

  return (
    <div>
      <div ref={toolbarRef} className="mb-3 flex justify-end gap-2">
        <Button onClick={arrange} size="sm" variant="outline" title="Auto-arrange & fit all panes (Ctrl+P)">
          <LayoutGrid className="h-4 w-4" /> Arrange
        </Button>
        <Button onClick={() => setFolderPicker({ cellId: null })} size="sm" variant="outline" title="New terminal in a chosen folder">
          <FolderOpen className="h-4 w-4" /> Open in folder…
        </Button>
        <Button onClick={() => addCell()} size="sm" variant="outline" title="New terminal (Alt+T)">
          <Plus className="h-4 w-4" /> Add Terminal
        </Button>
      </div>

      {enrollMsg && (
        <div
          className={`mb-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
            enrollMsg.ok
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              : 'border-amber-500/30 bg-amber-500/10 text-amber-200'
          }`}
        >
          {enrollMsg.ok ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <Cloud className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
          <span className="flex-1">{enrollMsg.message}</span>
          <button onClick={() => setEnrollMsg(null)} className="shrink-0 text-current/60 hover:text-current" title="Dismiss">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {daemonMsg && (
        <div
          className={`mb-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
            daemonMsg.ok
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              : 'border-amber-500/30 bg-amber-500/10 text-amber-200'
          }`}
        >
          {daemonMsg.ok ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
          <span className="flex-1">{daemonMsg.message}</span>
          <button onClick={() => setDaemonMsg(null)} className="shrink-0 text-current/60 hover:text-current" title="Dismiss">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {daemonModal && (
        <DaemonTakeoverModal
          modal={daemonModal}
          busy={daemonBusy}
          onConfirm={confirmDaemonStart}
          onStop={() => stopDaemon(daemonModal.projectId)}
          onClose={() => setDaemonModal(null)}
        />
      )}

      {folderPicker && (
        <FolderPicker
          socket={socket}
          initialPath={folderPicker.initialPath}
          title={folderPicker.cellId ? 'Change working folder' : 'Open a terminal in…'}
          onChoose={(dir) => {
            if (folderPicker.cellId) setCellCwd(folderPicker.cellId, dir)
            else addCell({ cwd: dir })
            setFolderPicker(null)
          }}
          onClose={() => setFolderPicker(null)}
        />
      )}

      <ResponsiveGridLayout
        width={containerWidth}
        layouts={layouts}
        breakpoints={{ lg: 1200, md: 996, sm: 768 }}
        cols={{ lg: 12, md: 8, sm: 4 }}
        rowHeight={rowHeight}
        margin={[GRID_MARGIN, GRID_MARGIN]}
        containerPadding={[0, 0]}
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
              cwd={cell.cwd}
              resumeId={cell.resumeId}
              daemonRunning={!!(cell.hostedProjectId && daemonStatus[cell.hostedProjectId]?.running)}
              onClose={() => removeCell(cell.id)}
              onCliTypeChange={(v) => setCellCli(cell.id, v)}
              onRename={(v) => setCellName(cell.id, v)}
              onHostedProjectChange={(v) => setCellHostedProject(cell.id, v)}
              onMakeAgent={() => openDaemonModal(cell.id)}
              onPickFolder={() => setFolderPicker({ cellId: cell.id, initialPath: cell.cwd })}
              onFocusCell={() => { activeCellIdRef.current = cell.id }}
              onNew={() => addCell()}
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
  const [height, setHeight] = useState(0)
  const apiRef = useRef<AgentGridHandle>({ addTerminal() {}, arrange() {}, closeActive() {}, importSessions() {} })
  useImperativeHandle(ref, () => ({
    addTerminal: () => apiRef.current.addTerminal(),
    arrange: () => apiRef.current.arrange(),
    closeActive: () => apiRef.current.closeActive(),
    importSessions: (specs) => apiRef.current.importSessions(specs),
  }), [])

  // Available height for the grid = the scroll container's inner content box
  // (its clientHeight minus vertical padding). Keeps the grid fitting exactly
  // what the user sees so panes never fall below the fold.
  useEffect(() => {
    const el = containerRef.current
    const parent = el?.parentElement
    if (!parent) return
    const measure = () => {
      const cs = getComputedStyle(parent)
      const padY = parseFloat(cs.paddingTop || '0') + parseFloat(cs.paddingBottom || '0')
      setHeight(Math.max(240, parent.clientHeight - padY))
    }
    measure()
    window.addEventListener('resize', measure)
    const ro = new ResizeObserver(measure)
    ro.observe(parent)
    return () => { window.removeEventListener('resize', measure); ro.disconnect() }
  }, [containerRef])

  return (
    <div ref={containerRef}>
      {width > 0 && (
        <AgentGridInner
          socket={socket}
          containerWidth={width}
          containerHeight={height}
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
