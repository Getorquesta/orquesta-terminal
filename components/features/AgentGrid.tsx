'use client'

import { writeText as clipboardWrite, readText as clipboardRead } from '@tauri-apps/plugin-clipboard-manager'
import { useState, useEffect, useMemo, useRef, useCallback, forwardRef, useImperativeHandle } from 'react'
import type { TauriHandle } from '@/hooks/useTauri'
import { FloatingWindow, type Geom } from './TerminalDock'

// ── Layout model (custom absolute-positioning engine) ────────────────────────
// One grid-unit layout item per pane. Grid mode stores positions in these grid
// units (12 cols × GRID_ROWS rows) and derives pixel rects from the live width;
// overlay mode uses free pixel geometry (see FloatGeom) instead. We dropped
// react-grid-layout entirely: it shoves items on collision (no free overlap) and
// re-parents children across modes, which would tear down PTYs. This engine
// renders BOTH modes through the same absolutely-positioned windows, so a mode
// toggle never remounts a cell.
interface LayoutItem {
  i: string
  x: number
  y: number
  w: number
  h: number
  minW?: number
  minH?: number
}
interface ResponsiveLayouts {
  lg: LayoutItem[]
  md?: LayoutItem[]
  sm?: LayoutItem[]
}
/** Free-floating pixel geometry for a pane in overlay mode. `z` = stack order. */
interface FloatGeom {
  x: number
  y: number
  w: number
  h: number
  z: number
}

/** Measure a container's live width via ResizeObserver (RGL replacement). */
function useContainerWidth<T extends HTMLElement = HTMLDivElement>() {
  const containerRef = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => setWidth(el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return { containerRef, width }
}
import { GeistMono } from 'geist/font/mono'
import { Button } from '@/components/ui/button'
import { Plus, X, Maximize2, GitBranch, LayoutGrid, Pencil, Cloud, Share2, Eye, Keyboard, Search, Check, ChevronDown, Link2, Users, Cpu, AlertTriangle, Folder, FolderOpen, Home, CornerLeftUp, PanelLeft, Loader2 } from 'lucide-react'
import { TerminalSidebar } from './TerminalSidebar'
import { TerminalListSidebar, PluginDock, TerminalSwitcherDock } from './TerminalDock'
import type { CellStatus, DockItem, PluginDockItem } from './TerminalDock'
import { PanelLeftOpen, Layers, Zap, Mail, MonitorSmartphone, Video, Radar, Mic, Dices, Shuffle, Skull, Settings } from 'lucide-react'
import { SettingsPanel } from './SettingsPanel'
import { launchConfigFor, loadSettings } from '@/lib/cliSettings'
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
  focus: () => void
  /** Type text into the live PTY as one bracketed paste (no auto-submit). */
  seed: (text: string) => void
  /**
   * Same as seed(), then press Enter — dispatches the prompt for real.
   * False when this pane has no live PTY to write to (it registers its API on
   * mount but the session only starts ~100ms later, and a session can end),
   * so the caller can refuse instead of losing the prompt into the void.
   */
  run: (text: string) => boolean
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

// A terminal's default name is the folder its agent runs in — more meaningful
// than "shell 2". Handles both / and \ and trailing slashes.
function folderLabel(cwd?: string): string {
  if (!cwd) return ''
  const clean = cwd.replace(/[/\\]+$/, '')
  return clean.split(/[/\\]/).pop() || ''
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

/**
 * Rebuild the line the human is typing from xterm's raw keystroke stream, so a
 * prompt sent by hand can show up on the board like a dispatched one.
 *
 * We only ever see what the user *sends*, never what the CLI echoes back, so
 * this has to reconstruct the line itself: honour backspace, drop escape
 * sequences (arrows, history recall, function keys), strip the paste brackets
 * xterm frames a paste with, and treat CR/LF as submit. Ctrl-C abandons the
 * line, same as the shell would.
 *
 * Returns the new buffer; `submit` fires once per completed line.
 */
export function feedTypedBuffer(buf: string, data: string, submit: (line: string) => void): string {
  let out = buf
  const clean = data.replace(/\x1b\[20[01]~/g, '')
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]
    if (ch === '\r' || ch === '\n') { submit(out); out = ''; continue }
    if (ch === '\x7f' || ch === '\b') { out = out.slice(0, -1); continue }
    if (ch === '\x03') { out = ''; continue }
    if (ch === '\x1b') {
      // Skip to the sequence terminator rather than trying to parse it.
      while (i < clean.length && !/[a-zA-Z~]/.test(clean[i])) i++
      continue
    }
    if (ch < ' ') continue
    out += ch
  }
  return out
}

/**
 * Below this, a submitted line is an answer rather than a prompt — "y", "no",
 * a menu pick. Cheap heuristic, and a wrong guess only costs a card you delete.
 */
const MIN_TYPED_PROMPT = 4

interface TerminalCellProps {
  cellId: string
  socket: TauriHandle | null
  cliType: CliType
  name: string
  fontSize: number
  /** 0..1 — pane translucency so the wallpaper shows through. */
  opacity: number
  /** When set, this pane's CLI is pointed at a hosted Orquesta project. */
  hostedApiUrl?: string
  hostedToken?: string
  /** The logged-in user's id — attributes self-reported prompts to them. */
  hostedUserId?: string
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
  /** Fired on every chunk of PTY output — marks the pane "running". */
  onActivity: () => void
  /** Fired when the pane looks done: a terminal bell, or ~2.5s of quiet after
   *  activity. Drives the sidebar attention dot and lighting mode. */
  onFinished: () => void
  /** Fired when the user types into this pane (real keyboard input). Lighting
   *  mode reads this as "engaged" so it won't auto-advance away from it. */
  onUserInput: () => void
  /** Fired when the user presses Enter (i.e. actually SENDS a prompt/line).
   *  Sudden-death reads this — you defuse by sending a prompt, not by typing. */
  onSubmit: () => void
  /** Fired with the text of a prompt the user typed straight into this pane —
   *  the board turns it into a card so hand-sent work shows as running too. */
  onPromptTyped: (text: string) => void
  /** Highlight this pane (lighting mode just surfaced it). */
  attention?: boolean
}

function TerminalCell({
  cellId, socket, cliType, name, fontSize, opacity, hostedApiUrl, hostedToken, hostedUserId,
  hostedProjects, hostedProjectId, cwd, resumeId, daemonRunning,
  onClose, onCliTypeChange, onRename, onHostedProjectChange, onMakeAgent, onPickFolder, onFocusCell, onNew, onArrange, onZoom, registerApi,
  onActivity, onFinished, onUserInput, onSubmit, onPromptTyped, attention,
}: TerminalCellProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<import('@xterm/xterm').Terminal | null>(null)
  const fitAddonRef = useRef<import('@xterm/addon-fit').FitAddon | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Prompt-completion detection (feeds the sidebar dot + lighting mode).
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const busyRef = useRef(false)
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

  // Kanban dispatch: same paste, then Enter. The newline goes in a separate
  // write a beat later — bundled into the same chunk, interactive CLIs tend to
  // swallow it as part of the paste body instead of submitting.
  // Returns false when there is nothing to write to: the pane registers this
  // API on mount but startSession() only runs ~100ms later, and a session can
  // end. Reporting that honestly lets the board keep the card instead of
  // parking it in Running against a prompt that was never sent.
  /** In-progress line the user is typing (see feedTypedBuffer). */
  const typedRef = useRef('')

  const runInput = useCallback((text: string) => {
    const sid = sessionIdRef.current
    if (!sid || !socket || !text) return false
    socket.emit('session:input', { sessionId: sid, data: `\x1b[200~${text}\x1b[201~` })
    setTimeout(() => {
      if (sessionIdRef.current !== sid) return // pane restarted mid-flight
      socket.emit('session:input', { sessionId: sid, data: '\r' })
    }, 160)
    try { termRef.current?.focus() } catch {}
    return true
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
  const cbRef = useRef({ onClose, onFocusCell, onNew, onArrange, onZoom, registerApi, onActivity, onFinished, onUserInput, onSubmit, onPromptTyped })
  cbRef.current = { onClose, onFocusCell, onNew, onArrange, onZoom, registerApi, onActivity, onFinished, onUserInput, onSubmit, onPromptTyped }
  const fontRef = useRef(fontSize)
  fontRef.current = fontSize
  // Hosted-hook target read live at (re)connect time so toggling it from the
  // panel doesn't restart the terminal — the next session picks it up.
  const hostedRef = useRef({ apiUrl: hostedApiUrl, token: hostedToken, userId: hostedUserId })
  hostedRef.current = { apiUrl: hostedApiUrl, token: hostedToken, userId: hostedUserId }
  const importRef = useRef({ cwd, resumeId })
  importRef.current = { cwd, resumeId }

  // The project the READ-ONLY rail (tasks/timeline/chat/coordination/files)
  // targets. When exactly one hosted project exists, default to it so the rail
  // is reachable without a manual per-pane cloud pick — the #1 "I'm logged in
  // but see no left panel" confusion. Share / Make-agent still require an
  // explicit pick (they have side effects), so they keep using hostedProjectId.
  const soleHostedProjectId = hostedProjects && hostedProjects.length === 1 ? hostedProjects[0].id : undefined
  const railProjectId = hostedProjectId || soleHostedProjectId
  // Show the rail button whenever logged in with a resolvable project, or with
  // multiple projects (the rail then shows a picker to choose one).
  const canOpenRail = !!(hostedApiUrl && hostedToken && (railProjectId || (hostedProjects && hostedProjects.length > 1)))

  useEffect(() => { setDraft(name) }, [name])

  useEffect(() => {
    if (!containerRef.current || typeof window === 'undefined') return

    let term: import('@xterm/xterm').Terminal
    let mounted = true
    let startTimer: ReturnType<typeof setTimeout> | null = null

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

      // ── Prompt-done: many CLIs ring the terminal bell (BEL) when they finish
      // and hand the prompt back. Treat that as an immediate "finished" signal.
      term.onBell(() => {
        if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
        busyRef.current = false
        cbRef.current.onFinished()
      })

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
        // Use xterm's own focus() (not raw textarea.focus) so its internal
        // focused-state is set and keystrokes actually route to the pane.
        focus: () => { try { term.focus() } catch {} },
        // Paste a plugin prompt into this pane for review-before-send.
        seed: (text: string) => seedInput(text),
        // Paste AND submit — how the Kanban board dispatches a card.
        run: (text: string) => runInput(text),
      })

      // ── Clipboard: xterm has no copy/paste by default in the browser. ──
      const copySelection = () => {
        const sel = term.getSelection()
        if (!sel) return
        // Try Tauri plugin first (most reliable in Tauri webview)
        clipboardWrite(sel)
          .then(() => { /* success */ })
          .catch((err: unknown) => {
            console.warn('[copy] tauri clipboard failed:', err)
            // Fallback 1: navigator.clipboard (requires secure context + user gesture)
            if (navigator.clipboard?.writeText) {
              navigator.clipboard.writeText(sel).catch((err2: unknown) => {
                console.warn('[copy] navigator.clipboard failed:', err2)
                // Fallback 2: execCommand (works in WebKit even without HTTPS)
                const ta = document.createElement('textarea')
                ta.value = sel
                ta.style.position = 'fixed'
                ta.style.opacity = '0'
                document.body.appendChild(ta)
                ta.focus()
                ta.select()
                const ok = document.execCommand('copy')
                document.body.removeChild(ta)
                if (!ok) console.error('[copy] execCommand also failed')
              })
            } else {
              const ta = document.createElement('textarea')
              ta.value = sel
              ta.style.position = 'fixed'
              ta.style.opacity = '0'
              document.body.appendChild(ta)
              ta.focus()
              ta.select()
              document.execCommand('copy')
              document.body.removeChild(ta)
            }
          })
      }
      const paste = () => {
        clipboardRead()
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
        // Ctrl+Tab / Ctrl+Shift+Tab cycle terminals (handled at window level) —
        // swallow here so xterm doesn't also send a literal tab to the shell.
        if (e.ctrlKey && !e.altKey && !e.metaKey && k === 'tab') return false
        if (mod && e.shiftKey && k === 'c') { if (term.hasSelection()) { copySelection(); return false } }
        if (mod && e.shiftKey && k === 'v') { paste(); return false }
        if (mod && e.shiftKey && k === 'l') { e.preventDefault(); term.clear(); return false }
        if (mod && !e.shiftKey && (k === '=' || k === '+')) { e.preventDefault(); cbRef.current.onZoom(1); return false }
        if (mod && !e.shiftKey && k === '-') { e.preventDefault(); cbRef.current.onZoom(-1); return false }
        if (mod && !e.shiftKey && k === '0') { e.preventDefault(); cbRef.current.onZoom(0); return false }
        if (mod && !e.shiftKey && k === 'p') { e.preventDefault(); cbRef.current.onArrange(); return false }
        if (e.altKey && k === 't') { e.preventDefault(); cbRef.current.onNew(); return false }
        if (e.altKey && k === 'w') { e.preventDefault(); cbRef.current.onClose(); return false }
        // Genuine user keystroke that will reach the shell → Lighting "engagement"
        // signal ("seguir = escribir"). Uses real KeyboardEvents (not term.onData,
        // which also fires for the terminal's own auto-replies to CLI queries).
        // Skip bare modifier presses.
        if (k !== 'shift' && k !== 'control' && k !== 'alt' && k !== 'meta') cbRef.current.onUserInput()
        // Enter = the prompt is actually SENT → this is what defuses sudden-death.
        if (k === 'enter') cbRef.current.onSubmit()
        return true
      })

      term.writeln('\x1b[32mOrquesta Terminal\x1b[0m')
      term.writeln('\x1b[90mConnecting…\x1b[0m')
      term.writeln('')

      const startSession = (reconnect = false) => {
        const sessionId = `sess-${cellId}-${Date.now()}`
        sessionIdRef.current = sessionId
        setBranch(null)
        if (reconnect) {
          importRef.current.resumeId = undefined  // don't retry a dead resume
          term.writeln('\r\n\x1b[32m[new session]\x1b[0m')
        }
        // Per-CLI launch config from Settings (skip-permissions flag + extra args).
        const launch = launchConfigFor(cliType)
        socket?.emit('session:start', {
          sessionId, cellId, cliType, rows: term.rows, cols: term.cols,
          skipPermissions: launch.skipPermissions, extraArgs: launch.extraArgs,
          hostedApiUrl: hostedRef.current.apiUrl, hostedToken: hostedRef.current.token,
          hostedUserId: hostedRef.current.userId,
          cwd: importRef.current.cwd, resumeId: importRef.current.resumeId,
        })
      }
      // Delay session start slightly so the container has its final size
      // (prevents orquesta-cli/Ink from getting 24x80 when pane is larger)
      startTimer = setTimeout(() => {
        startTimer = null
        try { fitAddon.fit() } catch {}
        startSession()
      }, 100)

      term.onData((data) => {
        if (!sessionIdRef.current) {
          // session ended — restart on any keypress
          startSession(true)
          return
        }
        // Reconstruct what's being typed so a hand-sent prompt can reach the
        // board. Board dispatches go straight to socket.emit and never pass
        // through here, so they can't double-count.
        typedRef.current = feedTypedBuffer(typedRef.current, data, (line) => {
          const body = line.trim()
          if (body.length >= MIN_TYPED_PROMPT) cbRef.current.onPromptTyped(body)
        })
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
        if (startTimer) clearTimeout(startTimer)
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
      // Activity → running. Arm/rearm an idle timer; when output goes quiet for
      // ~2.5s we call it "finished". Kept generous so the frequent mid-work
      // pauses agents take (thinking, tool calls) don't read as "done" and
      // yank Lighting mode's stage around.
      cbRef.current.onActivity()
      busyRef.current = true
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
      idleTimerRef.current = setTimeout(() => {
        if (busyRef.current) { busyRef.current = false; cbRef.current.onFinished() }
      }, 2500)
    }
    const handleEnded = (data: { sessionId: string }) => {
      if (data.sessionId !== sessionIdRef.current) return
      termRef.current?.writeln('\r\n\x1b[90m[session ended — press Enter to restart]\x1b[0m\r\n')
      sessionIdRef.current = null
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
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
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
      await clipboardWrite(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      // Fallback if clipboard unavailable.
      window.prompt('Copy this link to share the terminal:', link)
    }
  }, [hostedProjectId, hostedApiUrl])

  const commitRename = () => {
    setEditing(false)
    const v = draft.trim()
    if (v !== name) onRename(v)
  }

  const cliLabel = CLI_OPTIONS.find((o) => o.value === cliType)?.label ?? cliType
  // Display name precedence: user-set name → folder the agent runs in → CLI name.
  const folderName = folderLabel(cwd)
  const displayName = name || folderName || cliLabel

  return (
    <div
      className={`flex h-full flex-col rounded-md border overflow-hidden backdrop-blur-sm ${
        attention ? 'border-emerald-500/60 ring-1 ring-emerald-500/40' : 'border-zinc-800'
      }`}
      style={{ backgroundColor: `rgba(10, 12, 16, ${opacity})` }}
      // Focus-follows-mouse: once the cursor settles on a pane (~150ms) it
      // becomes active for the keyboard — no click needed. The delay avoids
      // stealing focus while merely passing over, and we never steal it mid-
      // selection so dragging to copy text across panes still works.
      onMouseEnter={() => {
        if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
        hoverTimerRef.current = setTimeout(() => {
          if (!window.getSelection()?.isCollapsed) return
          // Don't yank focus away from the rename box (an <input>); xterm's own
          // input helper is a <textarea>, so this never blocks real terminal focus.
          if (document.activeElement instanceof HTMLInputElement) return
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
              placeholder={folderName || cliLabel}
              className="w-24 rounded bg-zinc-800 px-1.5 py-0.5 text-xs font-mono text-zinc-200 outline-none focus:ring-1 focus:ring-green-600/50"
            />
          ) : (
            <button
              onClick={() => setEditing(true)}
              onMouseDown={(e) => e.stopPropagation()}
              className="group flex min-w-0 items-center gap-1 text-xs font-mono text-zinc-300 hover:text-zinc-100"
              title="Rename pane"
            >
              <span className="truncate max-w-[8rem]">{displayName}</span>
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
          {canOpenRail && (
            <button
              onClick={() => setSidebarOpen((v) => !v)}
              onMouseDown={(e) => e.stopPropagation()}
              className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono transition-colors ${
                sidebarOpen ? 'bg-green-500/15 text-green-300 hover:bg-green-500/25' : 'bg-zinc-800/70 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
              }`}
              title={sidebarOpen ? 'Hide panel' : 'Panel: tasks, timeline, chat, coordination, files'}
            >
              <PanelLeft className="h-3 w-3 shrink-0" />
              Panel
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
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {sidebarOpen && hostedApiUrl && hostedToken && (
          <>
            {/* Transparent backdrop — click closes the panel */}
            <div className="absolute inset-0 z-10" onClick={() => setSidebarOpen(false)} />
            <div className="absolute left-0 top-0 h-full z-20 shadow-2xl">
              <TerminalSidebar
                apiUrl={hostedApiUrl}
                token={hostedToken}
                projectId={railProjectId}
                projects={hostedProjects}
                onPickProject={onHostedProjectChange}
                onSeed={seedInput}
                onClose={() => setSidebarOpen(false)}
              />
            </div>
          </>
        )}
        <div className="absolute inset-0 overflow-hidden">
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
  /** Flip between the tiling grid and free-floating overlay windows. */
  toggleOverlay: () => void
  /** Toggle "lighting": auto-surface whichever terminal last finished a prompt. */
  toggleLighting: () => void
  /** Show/hide the left terminal-list sidebar. */
  toggleSidebar: () => void
  /** Cycle keyboard focus to the next (+1) / previous (-1) terminal. */
  cycleTerminal: (dir: 1 | -1) => void
  /**
   * Paste `text` into pane `cellId` and press Enter. Returns false when that
   * pane has no live PTY yet (still booting, or the id is stale) so the caller
   * can leave the card queued instead of pretending it ran.
   */
  dispatchPrompt: (cellId: string, text: string) => boolean
}

/** Human label for a pane: its given name, else its folder, else its CLI. */
function paneLabel(c: GridCell): string {
  return (c.name && c.name.trim())
    || folderLabel(c.cwd)
    || (CLI_OPTIONS.find((o) => o.value === c.cliType)?.label ?? c.cliType)
}

/** A live terminal pane, as the Kanban board sees it. */
export interface PaneInfo {
  id: string
  name: string
  cliType: CliType
  /** 'running' = PTY is producing output right now. */
  status: 'running' | 'idle'
}

type ViewMode = 'grid' | 'overlay'

interface AgentGridProps {
  socket: TauriHandle | null
  /** Namespaced localStorage key so pane layouts persist per project. */
  storageKey?: string
  /** 0..1 pane translucency so the wallpaper shows through. Default 1 (opaque). */
  terminalOpacity?: number
  /** When the hosted hook is enabled, point every pane's CLI at that backend. */
  hostedApiUrl?: string
  hostedToken?: string
  /** The logged-in user's id — attributes self-reported prompts to them. */
  hostedUserId?: string
  /** Available hosted projects (from useHostedAuth) for per-pane selector. */
  hostedProjects?: HostedProject[]
  /**
   * Fires whenever the pane roster or any pane's busy/idle status changes.
   * Kanban mode reads this to know which agent a card is running on and when
   * that agent went quiet (→ move the card to Review). Must be stable.
   */
  onPanesChange?: (panes: PaneInfo[]) => void
  /** A prompt was typed by hand into a pane (not dispatched by the board). */
  onPromptTyped?: (cellId: string, text: string) => void
}

interface PersistShape {
  v: number
  cells: GridCell[]
  layouts: ResponsiveLayouts
  viewMode?: ViewMode
  /** Free-floating pixel geometry used by overlay mode (grid mode keeps `layouts`). */
  floatGeom?: Record<string, FloatGeom>
  lighting?: boolean
  sidebarOpen?: boolean
}

// Total grid-row budget a tidy layout spans. Combined with a dynamic rowHeight
// (see AgentGridInner), the grid always fills exactly the visible viewport.
const GRID_ROWS = 12
// Gap between panes (px) and estimated height of the Arrange/Add toolbar above.
const GRID_MARGIN = 6
const TOOLBAR_H = 44
// Left terminal-list sidebar width (px) and the gap to the workspace.
const SIDEBAR_W = 208
const SIDEBAR_GAP = 8
// How long a finished pane keeps its attention highlight (ms). Also how long it
// stays promoted on Lighting mode's big stage before demoting to the calm grid —
// long enough to actually read and reply before it moves.
const ATTENTION_MS = 10000
// Minimum time (ms) a pane holds Lighting mode's big stage before it can hand
// off to the next waiting pane — only if you haven't engaged it by then.
const DWELL_MS = 5000

// Number of columns the tidy grid spans (matches GRID_ROWS for the row budget).
const GRID_COLS = 12

// Height (px) reserved at the bottom of the workspace for the plugin dock.
const DOCK_H = 66

// The "activated" companion plugins shown in the macOS-style bottom dock.
// Clicking a tile pastes its prompt into the currently-active terminal for
// review-before-send (never auto-submitted). Icons rendered at dock size.
//
// Each prompt names the plugin's CANONICAL daemon explicitly — its MCP server /
// tool and service endpoint — instead of a loose description. A pane's CLI agent
// otherwise interprets a vague ask ("open a remote-control link") its own way and
// never hits the real integration; pinning the concrete tool makes it act.
const PLUGIN_DOCK: Array<PluginDockItem & { prompt: string }> = [
  {
    id: 'mail',
    label: 'Mail',
    hint: 'Agent inbox (Apumail)',
    color: '#22c55e',
    icon: <Mail className="h-6 w-6" strokeWidth={1.5} />,
    prompt: 'Use the Apumail daemon (MCP server for apumail.com, REST at https://apumail.com/api/inbox, address agent@apumail.com) to read my agent inbox. Summarize new messages and flag anything that needs a reply.',
  },
  {
    id: 'remote',
    label: 'Remote control',
    hint: 'Drive this terminal from your phone (RogerThat)',
    color: '#38bdf8',
    icon: <MonitorSmartphone className="h-6 w-6" strokeWidth={1.5} />,
    prompt: 'Use the RogerThat daemon (rogerthat MCP server, https://rogerthat.chat): call its open_remote_control tool to create a phone remote-control channel for this terminal, then give me the link.',
  },
  {
    id: 'coordination',
    label: 'Coordination',
    hint: 'Coordinate agents on a channel (RogerThat)',
    color: '#a78bfa',
    icon: <Users className="h-6 w-6" strokeWidth={1.5} />,
    prompt: 'Use the RogerThat daemon (rogerthat MCP server, https://rogerthat.chat): call create_channel to open a coordination channel for this task, post my current status with send, and listen for teammates.',
  },
  {
    id: 'voice',
    label: 'Voice control',
    hint: 'Drive the terminal by voice (RogerThat)',
    color: '#2dd4bf',
    icon: <Mic className="h-6 w-6" strokeWidth={1.5} />,
    prompt: 'Use the RogerThat daemon (rogerthat MCP server, https://meet.rogerthat.chat): call open_video_call to start a voice session for this terminal so I can dictate prompts, and give me the join link.',
  },
  {
    id: 'meet',
    label: 'Agent meet',
    hint: 'Start a voice / video meet (RogerThat)',
    color: '#f472b6',
    icon: <Video className="h-6 w-6" strokeWidth={1.5} />,
    prompt: 'Use the RogerThat daemon (rogerthat MCP server, https://meet.rogerthat.chat): call open_video_call to start an agent meet (voice/video) for this session and give me the join link.',
  },
  {
    id: 'prowl',
    label: 'Bench prowl',
    hint: 'Discover & benchmark agents (Prowl)',
    color: '#fbbf24',
    icon: <Radar className="h-6 w-6" strokeWidth={1.5} />,
    prompt: 'Use the Prowl daemon (Agent Discovery Network — MCP server at https://prowl.world/mcp, REST at https://prowl.world/api) to discover and benchmark the available agents for this task, then recommend the best fit.',
  },
]

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

// ── Lighting layout ───────────────────────────────────────────────────────────
// Lighting mode stages ONE terminal at a time: the current spotlight fills the
// top of the workspace, every other pane sits in a single filmstrip row along
// the bottom. With no spotlight it's a calm, even tidy grid. Returns pixel rects
// keyed by cell id. The spotlight only changes on promote/hand-off (see the
// controller in AgentGridInner), so this layout stays put between those events.
function computeLightingGeoms(
  cells: GridCell[],
  spotlightId: string | null,
  W: number,
  H: number,
): Record<string, Geom> {
  const M = GRID_MARGIN
  const spot = spotlightId ? cells.find((c) => c.id === spotlightId) : undefined
  const rest = cells.filter((c) => c.id !== spot?.id)

  const out: Record<string, Geom> = {}

  // Tidy-grid a set of cells inside a pixel box (x0,y0,boxW,boxH).
  const packGrid = (list: GridCell[], x0: number, y0: number, boxW: number, boxH: number) => {
    const n = list.length
    if (!n) return
    const cols = Math.ceil(Math.sqrt(n))
    const rows = Math.ceil(n / cols)
    const cw = (boxW - (cols - 1) * M) / cols
    const ch = (boxH - (rows - 1) * M) / rows
    list.forEach((c, i) => {
      const cx = i % cols
      const cy = Math.floor(i / cols)
      out[c.id] = {
        x: Math.round(x0 + cx * (cw + M)),
        y: Math.round(y0 + cy * (ch + M)),
        w: Math.round(cw),
        h: Math.round(ch),
      }
    })
  }

  if (!spot) {
    // No spotlight → a calm, even tidy grid of everything. This is Lighting's
    // stable baseline: we still own the geometry (never handing back to the
    // react-grid layout), so a pane finishing later is one smooth promotion
    // instead of a whole-workspace snap between two different layout engines.
    packGrid(cells, 0, 0, W, H)
  } else if (rest.length === 0) {
    // Spotlight is the only pane → it fills the whole stage.
    packGrid([spot], 0, 0, W, H)
  } else {
    // ── Turntable carousel ─────────────────────────────────────────────────────
    // Every pane is mounted on ONE shared cylinder (a turntable) and we rotate the
    // whole ring as a single body — no pane spins on its own axis. Each card keeps
    // an IDENTICAL centred box; its only difference is its angle around the ring.
    // The card is placed with `translateZ(-R) rotateY(θ) translateZ(R)` (see
    // FloatingWindow) so it orbits a common vertical axis R behind the stage: the
    // front card (θ=0) lands dead-centre at the base plane (never zoomed), its
    // neighbours swing back and to the sides. A promote just re-labels every
    // card's θ by the same step, and since they all ease together on one curve the
    // entire turntable appears to rotate one notch as a rigid whole.
    const idx = cells.findIndex((c) => c.id === spot.id)
    const n = cells.length

    // Identical box for all cards — the ring, not the box, does the work.
    const cardW = Math.round(Math.min(W * 0.62, 1180))
    const cardH = Math.round(H * 0.99)
    const cardX = Math.round((W - cardW) / 2)
    const cardY = Math.round((H - cardH) / 2)

    const STEP = 52               // angular gap between adjacent panes (deg) — small gap, no overlap
    const R = Math.round(cardW * 1.05)   // ring radius (px)
    const VISIBLE = 95            // panes past this angle face away → hidden

    cells.forEach((c, i) => {
      // Signed ring distance from the spotlight, wrapped to the short way round so
      // the reel is a closed loop (rotating past the last pane wraps to the first).
      let rel = i - idx
      if (rel > n / 2) rel -= n
      // Strict `<` (not `<=`) so an exact-opposite pane stays on its own side.
      // With `<=`, the 2-terminal case collapsed both panes onto the same side —
      // switching then slid them across each other instead of rotating the ring
      // as one body. Strict keeps them antipodal → every pane shifts by the same
      // delta on a promote, so the whole turntable turns rigidly.
      if (rel < -n / 2) rel += n
      const angle = rel * STEP
      if (Math.abs(angle) > VISIBLE) {
        // On the far side of the ring: mounted (PTY alive) but invisible & inert.
        out[c.id] = { x: cardX, y: cardY, w: cardW, h: cardH, rotY: angle, zDepth: R, z: 0, hidden: true }
        return
      }
      const front = angle === 0
      out[c.id] = {
        x: cardX, y: cardY, w: cardW, h: cardH,
        rotY: angle, zDepth: R,
        opacity: front ? 1 : 0.7,
        z: Math.round(100 - Math.abs(angle)),   // nearer the front → stacked higher
      }
    })
  }
  return out
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
  socket: TauriHandle | null
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
  const [nativeBusy, setNativeBusy] = useState(false)
  const [nativeGone, setNativeGone] = useState(false)

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
    const onNative = (r: any = {}) => {
      setNativeBusy(false)
      if (r.ok && r.path) { onChoose(r.path); return }
      // available:false => no native dialog binary; keep the browser list and
      // hide the button. A cancel (available:true) just closes the dialog.
      if (r.available === false) setNativeGone(true)
    }
    socket.on('fs:list-dir-result', onResult)
    socket.on('fs:native-pick-result', onNative)
    socket.emit('fs:list-dir', { path: initialPath })
    // If the server never answers (e.g. an older cockpit build without the
    // fs:list-dir handler), don't spin forever — surface a hint and fall back
    // to the editable path field / native picker.
    const stall = setTimeout(() => {
      setLoading((l) => {
        if (l) {
          setError('Folder list didn’t load — type a path above, use Browse…, or restart the cockpit (its server needs a restart to pick up new handlers).')
          setNativeBusy(false)
        }
        return false
      })
    }, 4000)
    return () => {
      clearTimeout(stall)
      socket.off('fs:list-dir-result', onResult)
      socket.off('fs:native-pick-result', onNative)
    }
  }, [socket, initialPath, onChoose])

  const browseNative = () => {
    if (!socket) return
    setNativeBusy(true)
    socket.emit('fs:native-pick', { startDir: path || home || undefined })
    // Don't spin forever if the running server predates the fs:native-pick
    // handler (needs a cockpit restart) — release the button after 8s.
    setTimeout(() => setNativeBusy((b) => {
      if (b) setError('Native picker didn’t respond — the cockpit server needs a restart to enable it. For now, type or paste a path above.')
      return false
    }), 8000)
  }

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
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && path) go(path) }}
            spellCheck={false}
            placeholder="Type or paste a folder path…"
            className="min-w-0 flex-1 rounded bg-zinc-800/60 px-2 py-1 font-mono text-[11px] text-zinc-300 outline-none focus:bg-zinc-800 focus:ring-1 focus:ring-amber-500/40"
            title={path}
          />
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
            {!nativeGone && (
              <Button variant="outline" size="sm" onClick={browseNative} disabled={nativeBusy} title="Open your OS folder picker">
                {nativeBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderOpen className="h-3.5 w-3.5" />}
                <span className="ml-1">Browse…</span>
              </Button>
            )}
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
  socket, containerWidth, containerHeight, storageKey, terminalOpacity = 1, hostedApiUrl, hostedToken, hostedUserId, hostedProjects,
  onPanesChange, onPromptTyped, apiRef,
}: AgentGridProps & { containerWidth: number; containerHeight: number; apiRef: React.MutableRefObject<AgentGridHandle> }) {
  const key = storageKey || STORAGE_KEY
  // Held in a ref so a new callback identity can't restart a pane's terminal.
  const onPromptTypedRef = useRef(onPromptTyped)
  onPromptTypedRef.current = onPromptTyped
  const [cells, setCells] = useState<GridCell[]>([])
  const [layouts, setLayouts] = useState<ResponsiveLayouts>({ lg: [] })
  const [fontSize, setFontSize] = useState(DEFAULT_FONT)
  const loadedRef = useRef(false)

  // ── Layout modes ───────────────────────────────────────────────────────────
  const [viewMode, setViewMode] = useState<ViewMode>('grid')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [lighting, setLighting] = useState(false)
  // Overlay mode's own free-floating pixel geometry (kept apart from the tiled
  // `layouts` so switching modes doesn't destroy either arrangement).
  const [floatGeom, setFloatGeom] = useState<Record<string, FloatGeom>>({})
  // Per-pane live status + "just finished" attention set (drives sidebar + rings).
  const [statuses, setStatuses] = useState<Record<string, CellStatus>>({})
  const [finishedIds, setFinishedIds] = useState<Set<string>>(new Set())
  const attentionTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const lightingRef = useRef(lighting)
  lightingRef.current = lighting
  const viewModeRef = useRef(viewMode)
  viewModeRef.current = viewMode
  // The storageKey the persist effect last committed under. Lets it skip the one
  // commit where `key` changes (stale cells closure) before re-persisting.
  const persistKeyRef = useRef(key)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const activeCellIdRef = useRef<string | null>(null)
  // Mirror of the active-cell ref as state so the sidebar/overlay highlight
  // updates reactively (the ref alone wouldn't re-render on focus changes).
  const [activeCellId, setActiveCellId] = useState<string | null>(null)
  const setActive = useCallback((id: string | null) => {
    activeCellIdRef.current = id
    setActiveCellId(id)
  }, [])
  const cellApiRef = useRef<Map<string, CellApi>>(new Map())
  const cellsRef = useRef<GridCell[]>([])
  cellsRef.current = cells

  // ── Lighting spotlight controller ───────────────────────────────────────────
  // Exactly ONE terminal holds the big stage at a time (the rest sit in the
  // bottom filmstrip). A CLI pane that finishes is promoted onto the stage and
  // stays there for a MINIMUM dwell; after that, if you haven't engaged it
  // (typed into it), it hands the stage to the next waiting pane. This is what
  // keeps Lighting calm: motion happens ONLY on promote / hand-off, never on the
  // constant finish↔resume churn that made the old whole-grid reflow thrash.
  const [spotlightId, setSpotlightId] = useState<string | null>(null)
  const spotlightRef = useRef<string | null>(null)   // mirror for callbacks
  const lightQueueRef = useRef<string[]>([])          // FIFO of CLI panes waiting
  const engagedRef = useRef(false)                    // user typed into spotlight
  const dwellRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // True while promote() is doing its own fit()/focus() + carousel reflow. The
  // reflow can bounce DOM focus onto a neighbouring pane, whose focus event would
  // otherwise re-promote it → an endless round-robin. Focus-driven promotion is
  // suppressed during this window so only genuine user focus stages a pane.
  const suppressFocusPromoteRef = useRef(false)
  // Late-bound so promote/advance (mutually recursive) can call each other.
  const spotCtl = useRef<{ promote: (id: string | null, opts?: { silent?: boolean }) => void; advance: () => void }>({
    promote: () => {}, advance: () => {},
  })

  // A short, warm "orchestra" swell played when a new pane takes the spotlight —
  // a rising major triad on a soft triangle voice. Synthesised (no asset needed)
  // and gracefully no-ops if WebAudio is unavailable or blocked.
  const audioCtxRef = useRef<AudioContext | null>(null)
  const playSpotlightChime = useCallback(() => {
    try {
      let ctx = audioCtxRef.current
      if (!ctx) {
        const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        if (!AC) return
        ctx = new AC(); audioCtxRef.current = ctx
      }
      if (ctx.state === 'suspended') void ctx.resume()
      const now = ctx.currentTime
      const notes = [392.0, 523.25, 659.25, 783.99] // G4 · C5 · E5 · G5 (arpeggio up)
      notes.forEach((f, i) => {
        const osc = ctx!.createOscillator()
        const gain = ctx!.createGain()
        osc.type = 'triangle'
        osc.frequency.value = f
        const t0 = now + i * 0.055
        gain.gain.setValueAtTime(0, t0)
        gain.gain.linearRampToValueAtTime(0.11, t0 + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5)
        osc.connect(gain).connect(ctx!.destination)
        osc.start(t0)
        osc.stop(t0 + 0.55)
      })
    } catch { /* audio unavailable — silent */ }
  }, [])

  const promoteSpotlight = useCallback((id: string | null, opts?: { silent?: boolean }) => {
    if (dwellRef.current) { clearTimeout(dwellRef.current); dwellRef.current = null }
    if (id) {
      const q = lightQueueRef.current
      const i = q.indexOf(id); if (i >= 0) q.splice(i, 1)
    }
    spotlightRef.current = id
    setSpotlightId(id)
    engagedRef.current = false
    if (!id) return
    setActive(id)
    // Silent hop: used by the roulette spin to rotate the ring one notch without
    // the chime / focus-grab / dwell-handoff — those only fire when a pane truly
    // takes the stage (the spin's final landing, or any normal promote).
    if (opts?.silent) return
    playSpotlightChime()  // orchestra swell as the new pane takes the stage
    // Fit + focus once the reflow to the big stage has settled, so you can reply.
    // Guard the whole reflow window: the geometry change can hand DOM focus to a
    // neighbour, and that focus event must NOT promote (it'd loop forever).
    suppressFocusPromoteRef.current = true
    setTimeout(() => {
      cellApiRef.current.get(id)?.fit()
      cellApiRef.current.get(id)?.focus()
      // Release on the next tick, after the focus event this triggers has fired.
      setTimeout(() => { suppressFocusPromoteRef.current = false }, 60)
    }, 320)
    // Minimum dwell, then hand off unless you've engaged it.
    dwellRef.current = setTimeout(() => {
      dwellRef.current = null
      if (engagedRef.current) return   // you're typing in it → it's yours, keep it
      spotCtl.current.advance()
    }, DWELL_MS)
  }, [setActive, playSpotlightChime])

  const advanceSpotlight = useCallback(() => {
    // Current spotlight's turn lapsed unattended → promote the next waiting pane.
    const next = lightQueueRef.current.shift() ?? null
    if (next && next !== spotlightRef.current) spotCtl.current.promote(next)
    // Nothing waiting → leave the current pane up (no better candidate), no timer.
  }, [])

  useEffect(() => {
    spotCtl.current = { promote: promoteSpotlight, advance: advanceSpotlight }
  }, [promoteSpotlight, advanceSpotlight])

  // Tear down all spotlight state (leaving Lighting, or on unmount).
  const resetSpotlight = useCallback(() => {
    if (dwellRef.current) { clearTimeout(dwellRef.current); dwellRef.current = null }
    spotlightRef.current = null
    setSpotlightId(null)
    lightQueueRef.current = []
    engagedRef.current = false
  }, [])
  // Live grid→pixel projector, refreshed each render (see the geometry section
  // below). Lets non-render callbacks (e.g. seeding overlay geometry) read the
  // current pixel rect of a pane's grid slot without re-plumbing width/height.
  const gridPxRef = useRef<(id: string) => Geom | null>(() => null)
  const floatGeomRef = useRef<Record<string, FloatGeom>>({})
  floatGeomRef.current = floatGeom

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

  // Toolbar dropdowns: the View menu (Overlay/Lighting/Arrange) and the Add
  // split-button menu (new terminal vs. open in a folder). Kept lightweight —
  // a click-away backdrop closes them.
  const [viewMenuOpen, setViewMenuOpen] = useState(false)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

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
    let nextViewMode: ViewMode = 'grid'
    let nextFloatGeom: Record<string, FloatGeom> = {}
    let nextLighting = false
    let nextSidebar = true
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
          if (p.viewMode === 'overlay' || p.viewMode === 'grid') nextViewMode = p.viewMode
          // Keep only geometry for panes that still exist; missing ones get
          // seeded lazily when overlay mode is (re)entered.
          if (p.floatGeom && typeof p.floatGeom === 'object') {
            for (const c of nextCells) {
              const g = p.floatGeom[c.id]
              if (g && typeof g.x === 'number') nextFloatGeom[c.id] = g
            }
          }
          if (typeof p.lighting === 'boolean') nextLighting = p.lighting
          if (typeof p.sidebarOpen === 'boolean') nextSidebar = p.sidebarOpen
        } else if (p && (p.lg || p.md || p.sm)) {
          nextLayouts = p // legacy layouts-only shape — no panes to restore
        }
      }
    } catch {}
    setCells(nextCells)
    setLayouts(nextLayouts)
    setViewMode(nextViewMode)
    setFloatGeom(nextFloatGeom)
    setLighting(nextLighting)
    setSidebarOpen(nextSidebar)
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
      const payload: PersistShape = { v: 5, cells, layouts, viewMode, floatGeom, lighting, sidebarOpen }
      localStorage.setItem(key, JSON.stringify(payload))
    } catch {}
  }, [key, cells, layouts, viewMode, floatGeom, lighting, sidebarOpen])

  const addCell = useCallback((init?: Partial<Omit<GridCell, 'id'>>) => {
    const id = `cell-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    // New terminals open with the CLI chosen in Settings (falls back to Shell).
    const defaultCli = (loadSettings().defaultCli ?? 'shell') as CliType
    const newCell: GridCell = { id, cliType: defaultCli, name: '', ...init }
    const newCells = [...cellsRef.current, newCell]
    setCells(newCells)
    setLayouts((prev) => ({ ...prev, lg: buildTidyLayout(newCells) }))
    // In overlay mode the new pane needs a floating slot right away; grid mode
    // seeds lazily on the next overlay entry.
    if (viewModeRef.current === 'overlay') setTimeout(() => ensureFloatGeoms(), 0)
    setTimeout(() => cellApiRef.current.forEach((a) => a?.fit()), 80)
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
    if (activeCellIdRef.current === id) { activeCellIdRef.current = null; setActiveCellId(null) }
    // Drop from the Lighting stage/queue; if it held the spotlight, hand off.
    const q = lightQueueRef.current
    const qi = q.indexOf(id); if (qi >= 0) q.splice(qi, 1)
    if (spotlightRef.current === id) {
      if (dwellRef.current) { clearTimeout(dwellRef.current); dwellRef.current = null }
      spotlightRef.current = null; setSpotlightId(null); engagedRef.current = false
      const next = q.shift() ?? null
      if (next && lightingRef.current) spotCtl.current.promote(next)
    }
    setCells((prev) => prev.filter((c) => c.id !== id))
    setLayouts((prev) => ({
      ...prev,
      lg: ((prev.lg || []) as LayoutItem[]).filter((l) => l.i !== id),
    }))
    setFloatGeom((prev) => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  }, [])

  const closeActive = useCallback(() => {
    const target = activeCellIdRef.current || cellsRef.current[cellsRef.current.length - 1]?.id
    if (target) removeCell(target)
  }, [removeCell])

  // ── Russian roulette (just for fun) ─────────────────────────────────────────
  // Spins the turntable like a wheel and lands on a random terminal. Two modes:
  //   • 'gentle'   — harmless: it just becomes the spotlight, nothing dies.
  //   • 'death' — the chosen one gets a 5s countdown; type a prompt into it to
  //                  survive, or it closes (PTY killed) when the timer hits zero.
  const spinningRef = useRef(false)
  const [spinning, setSpinning] = useState(false)
  const rouletteTargetRef = useRef<string | null>(null)
  const rouletteTimersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const [roulette, setRoulette] = useState<{ id: string; count: number } | null>(null)

  const clearRouletteTimers = useCallback(() => {
    rouletteTimersRef.current.forEach(clearTimeout)
    rouletteTimersRef.current = []
  }, [])

  // Cancel a pending death countdown (the player typed in time, or a new spin/
  // close superseded it). Safe to call when nothing is armed.
  const defuseRoulette = useCallback(() => {
    if (!rouletteTargetRef.current) return
    rouletteTargetRef.current = null
    clearRouletteTimers()
    setRoulette(null)
  }, [clearRouletteTimers])

  const startDeathCountdown = useCallback((id: string) => {
    rouletteTargetRef.current = id
    let n = 5
    setRoulette({ id, count: n })
    const tick = () => {
      n -= 1
      if (n <= 0) {
        const doomed = rouletteTargetRef.current   // nobody typed → BANG 💀
        rouletteTargetRef.current = null
        clearRouletteTimers()
        setRoulette(null)
        if (doomed) removeCell(doomed)
        return
      }
      setRoulette({ id, count: n })
      rouletteTimersRef.current.push(setTimeout(tick, 1000))
    }
    rouletteTimersRef.current.push(setTimeout(tick, 1000))
  }, [clearRouletteTimers, removeCell])

  const russianRoulette = useCallback((mode: 'gentle' | 'death') => {
    const list = cellsRef.current
    if (spinningRef.current || list.length < 2) return
    defuseRoulette()                              // drop any prior countdown
    if (!lightingRef.current) setLighting(true)   // the turntable needs Lighting on
    spinningRef.current = true
    setSpinning(true)
    const startIdx = Math.max(0, list.findIndex((c) => c.id === spotlightRef.current))
    const winnerIdx = Math.floor(Math.random() * list.length)
    const LOOPS = 2                               // full turns before it settles
    const total = LOOPS * list.length + ((winnerIdx - startIdx + list.length) % list.length)
    let step = 1
    const hop = () => {
      const idx = (startIdx + step) % list.length
      const last = step >= total
      spotCtl.current.promote(list[idx].id, { silent: !last })   // rotate one notch
      if (last) {
        spinningRef.current = false
        setSpinning(false)
        if (mode === 'death') startDeathCountdown(list[idx].id)
        return
      }
      step += 1
      // Ease-out: the wheel slows as it nears the winner (delay grows with p²).
      const p = step / total
      rouletteTimersRef.current.push(setTimeout(hop, 55 + p * p * 470))
    }
    // Small kick so Lighting has flipped on before the first hop.
    rouletteTimersRef.current.push(setTimeout(hop, lightingRef.current ? 0 : 140))
  }, [defuseRoulette, startDeathCountdown])

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

  // ── Overlay window helpers ─────────────────────────────────────────────────
  // Overlay windows overlap freely; stacking is a pure z-index. "Bring to front"
  // just bumps this pane above the current max — the cells array (and thus the
  // render order / sidebar order) never changes, so nothing remounts and the
  // terminal's PTY survives untouched.
  const bringToFront = useCallback((id: string) => {
    setFloatGeom((prev) => {
      const g = prev[id]
      if (!g) return prev
      const maxZ = Math.max(0, ...Object.values(prev).map((v) => v.z))
      if (g.z >= maxZ) return prev
      return { ...prev, [id]: { ...g, z: maxZ + 1 } }
    })
  }, [])

  // Ensure every current cell has a floating rect (entering overlay / new pane).
  // Seed from the pane's current grid slot so toggling into overlay keeps windows
  // exactly where they were — then the user scatters them from there.
  const ensureFloatGeoms = useCallback(() => {
    setFloatGeom((prev) => {
      let maxZ = Math.max(0, ...Object.values(prev).map((v) => v.z))
      let changed = false
      const next = { ...prev }
      cellsRef.current.forEach((c, i) => {
        if (next[c.id]) return
        const seed = gridPxRef.current(c.id) || {
          x: 40 + (i % 4) * 48,
          y: 40 + (i % 4) * 40,
          w: 480,
          h: 320,
        }
        next[c.id] = { ...seed, z: ++maxZ }
        changed = true
      })
      return changed ? next : prev
    })
  }, [])

  // ── Sidebar: focus / reorder ────────────────────────────────────────────────
  const focusCellFromList = useCallback((id: string) => {
    setActive(id)
    if (viewModeRef.current === 'overlay') bringToFront(id)
    // In Lighting, explicitly switching to a pane stages it (moves it to the
    // spotlight) — including a bare shell. The "shells never grab the stage" rule
    // only governs AUTOMATIC staging (markFinished / reflow-bounced focus); when
    // you deliberately pick a pane, you want to see it centre-stage regardless of
    // its CLI. Without this you can't switch to a shell while Lighting is on.
    if (lightingRef.current && id !== spotlightRef.current) {
      spotCtl.current.promote(id)
    }
    // Give keyboard focus to that pane's terminal. Focus AFTER a tick so any
    // z-order/geometry re-render from setActive has settled first (otherwise the
    // pane is selected but the keyboard focus doesn't stick and you can't type).
    const el = document.getElementById(`cell-wrap-${id}`)
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    setTimeout(() => {
      cellApiRef.current.get(id)?.fit()
      cellApiRef.current.get(id)?.focus()
    }, 0)
  }, [bringToFront, setActive])

  // Cycle keyboard focus through the open terminals (Ctrl+Tab / Ctrl+Shift+Tab),
  // in sidebar order, wrapping around. In overlay the target is also raised.
  const cycleActive = useCallback((dir: 1 | -1) => {
    const list = cellsRef.current
    if (list.length === 0) return
    const cur = activeCellIdRef.current
    const i = list.findIndex((c) => c.id === cur)
    const nextIdx = i < 0
      ? (dir === 1 ? 0 : list.length - 1)
      : (i + dir + list.length) % list.length
    focusCellFromList(list[nextIdx].id)
  }, [focusCellFromList])

  const reorderCells = useCallback((fromId: string, toId: string) => {
    setCells((prev) => {
      const from = prev.findIndex((c) => c.id === fromId)
      const to = prev.findIndex((c) => c.id === toId)
      if (from < 0 || to < 0 || from === to) return prev
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }, [])

  // ── Prompt-completion signals from panes ────────────────────────────────────
  const markActivity = useCallback((id: string) => {
    setStatuses((prev) => (prev[id] === 'running' ? prev : { ...prev, [id]: 'running' }))
    // A newly-active pane is no longer "waiting for attention".
    setFinishedIds((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev); next.delete(id); return next
    })
    const t = attentionTimers.current.get(id)
    if (t) { clearTimeout(t); attentionTimers.current.delete(id) }
    // Lighting: a queued pane that started working again is no longer "waiting".
    // The spotlight itself is left alone if it resumes — we keep watching it.
    const q = lightQueueRef.current
    const qi = q.indexOf(id); if (qi >= 0) q.splice(qi, 1)
  }, [])

  const markFinished = useCallback((id: string) => {
    setStatuses((prev) => ({ ...prev, [id]: 'idle' }))
    setFinishedIds((prev) => { const next = new Set(prev); next.add(id); return next })
    const prevT = attentionTimers.current.get(id)
    if (prevT) clearTimeout(prevT)
    attentionTimers.current.set(id, setTimeout(() => {
      setFinishedIds((prev) => { const next = new Set(prev); next.delete(id); return next })
      attentionTimers.current.delete(id)
    }, ATTENTION_MS))
    // Lighting spotlight: only panes actually running a CLI are eligible (a bare
    // shell never grabs the stage). Empty stage → take it; busy stage → queue
    // WITHOUT moving anything (the current spotlight keeps the keyboard).
    if (lightingRef.current) {
      const cell = cellsRef.current.find((c) => c.id === id)
      const isCli = !!cell && cell.cliType !== 'shell'
      if (isCli) {
        if (spotlightRef.current === null) {
          spotCtl.current.promote(id)
        } else if (id !== spotlightRef.current && !lightQueueRef.current.includes(id)) {
          // If the current spotlight's dwell already lapsed unattended (no timer
          // pending, never engaged), a freshly-finished pane takes the stage now
          // instead of waiting forever. Otherwise it queues without moving anything.
          if (dwellRef.current === null && !engagedRef.current) {
            spotCtl.current.promote(id)
          } else {
            lightQueueRef.current.push(id)
          }
        }
      }
    }
  }, [])

  // User typed into a pane → in Lighting, if it's the spotlight, mark it engaged
  // so the dwell hand-off never pulls it out from under you ("seguir = escribir").
  const markUserInput = useCallback((id: string) => {
    if (lightingRef.current && spotlightRef.current === id) {
      engagedRef.current = true
      if (dwellRef.current) { clearTimeout(dwellRef.current); dwellRef.current = null }
    }
  }, [])

  // Sending a prompt (Enter) into the doomed pane defuses the countdown. 💥→😌
  // Typing alone isn't enough — you have to actually fire off a prompt.
  const markUserSubmit = useCallback((id: string) => {
    if (rouletteTargetRef.current === id) defuseRoulette()
  }, [defuseRoulette])

  // Clean up any pending attention/dwell/roulette timers on unmount.
  useEffect(() => () => {
    attentionTimers.current.forEach((t) => clearTimeout(t))
    if (dwellRef.current) clearTimeout(dwellRef.current)
    rouletteTimersRef.current.forEach(clearTimeout)
  }, [])

  // ── Mode toggles ────────────────────────────────────────────────────────────
  const toggleOverlay = useCallback(() => {
    setViewMode((m) => {
      const next = m === 'overlay' ? 'grid' : 'overlay'
      if (next === 'overlay') ensureFloatGeoms()
      setTimeout(() => cellApiRef.current.forEach((a) => a?.fit()), 90)
      return next
    })
  }, [ensureFloatGeoms])

  const toggleLighting = useCallback(() => setLighting((v) => {
    if (v) resetSpotlight()  // leaving Lighting → drop the stage state
    return !v
  }), [resetSpotlight])
  const toggleSidebar = useCallback(() => setSidebarOpen((v) => !v), [])

  // While in overlay mode, any pane added later still needs a floating geometry.
  useEffect(() => {
    if (viewMode === 'overlay') ensureFloatGeoms()
  }, [viewMode, cells, ensureFloatGeoms])

  // Global shortcuts for the layout modes — these work even while a pane has
  // keyboard focus (unlike the grid nav keys, which the focused pane consumes).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      // Alt+Tab cycles focus across terminals (Alt+Shift+Tab goes back), per the
      // user's request. NOTE: most Linux window managers grab Alt+Tab for their
      // own app switcher before the app ever sees it — if that happens here it
      // simply won't fire. Ctrl+Tab is kept as a guaranteed-reachable fallback.
      if ((e.altKey || e.ctrlKey) && !e.metaKey && k === 'tab') {
        // Runs in the CAPTURE phase (below), so it fires BEFORE the focused
        // pane's xterm handler ever sees the key. stopImmediatePropagation makes
        // Ctrl+Tab always "win": no other listener acts, the shell gets no tab,
        // and focus can't drift. (Alt+Tab is usually eaten by the WM upstream.)
        e.preventDefault(); e.stopImmediatePropagation(); cycleActive(e.shiftKey ? -1 : 1); return
      }
      if (mod && e.shiftKey && k === 'o') { e.preventDefault(); toggleOverlay() }
      else if (mod && e.shiftKey && k === 'y') { e.preventDefault(); toggleLighting() }
      else if (mod && e.shiftKey && k === 'b') { e.preventDefault(); toggleSidebar() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [toggleOverlay, toggleLighting, toggleSidebar, cycleActive])

  // Expose imperative controls to the host page (palette / buttons).
  useEffect(() => {
    apiRef.current = {
      addTerminal: () => addCell(), arrange, closeActive, importSessions,
      toggleOverlay, toggleLighting, toggleSidebar, cycleTerminal: cycleActive,
      dispatchPrompt: (cellId, text) => {
        const api = cellApiRef.current.get(cellId)
        if (!api) return false
        // run() reports whether the pty actually took the prompt — don't focus
        // or steal the active pane for a write that didn't happen.
        const sent = api.run(text)
        if (!sent) return false
        setActive(cellId)
        api.focus()
        return true
      },
    }
  }, [apiRef, addCell, arrange, closeActive, importSessions, toggleOverlay, toggleLighting, toggleSidebar, cycleActive, setActive])

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

  // ── Geometry: grid units ⇄ pixels ──────────────────────────────────────────
  // Width available for the workspace once the terminal-list rail is subtracted.
  const gridWidth = Math.max(240, sidebarOpen ? containerWidth - SIDEBAR_W - SIDEBAR_GAP : containerWidth)
  // Height of the absolutely-positioned workspace (below the toolbar).
  const contentH = useMemo(() => {
    const toolbarH = toolbarRef.current ? toolbarRef.current.offsetHeight + 12 : TOOLBAR_H
    return Math.max(200, containerHeight - toolbarH - DOCK_H)
  }, [containerHeight, sidebarOpen, viewMode, cells])

  // Dynamic row height: divide the visible area by the current layout's row span
  // so the whole grid always fits the viewport — no page scroll to lose panes.
  const rowHeight = useMemo(() => {
    const items = (layouts.lg || []) as LayoutItem[]
    const span = items.length ? Math.max(GRID_ROWS, ...items.map((it) => it.y + it.h)) : GRID_ROWS
    if (span <= 0) return 40
    return Math.max(16, Math.floor((contentH - (span - 1) * GRID_MARGIN) / span))
  }, [layouts, contentH])

  // One grid column's width in px (12 columns + inter-column margins).
  const colW = Math.max(1, (gridWidth - (GRID_COLS - 1) * GRID_MARGIN) / GRID_COLS)
  const colStep = colW + GRID_MARGIN
  const rowStep = rowHeight + GRID_MARGIN

  // Project a pane's grid slot to a pixel rectangle.
  const gridPx = useCallback((id: string): Geom | null => {
    const it = ((layouts.lg || []) as LayoutItem[]).find((l) => l.i === id)
    if (!it) return null
    return {
      x: Math.round(it.x * colStep),
      y: Math.round(it.y * rowStep),
      w: Math.round(it.w * colW + (it.w - 1) * GRID_MARGIN),
      h: Math.round(it.h * rowHeight + (it.h - 1) * GRID_MARGIN),
    }
  }, [layouts, colStep, rowStep, colW, rowHeight])
  gridPxRef.current = gridPx

  // Commit a dragged/resized pixel rect back to the grid: snap to the nearest
  // grid cell. Overlapping is allowed (Arrange re-tidies); we never shove peers.
  const commitGridGeom = useCallback((id: string, g: Geom) => {
    const x = Math.max(0, Math.round(g.x / colStep))
    const y = Math.max(0, Math.round(g.y / rowStep))
    const w = Math.max(2, Math.round((g.w + GRID_MARGIN) / colStep))
    const h = Math.max(2, Math.round((g.h + GRID_MARGIN) / rowStep))
    setLayouts((prev) => ({
      ...prev,
      lg: ((prev.lg || []) as LayoutItem[]).map((l) =>
        l.i === id ? { ...l, x: Math.min(x, GRID_COLS - w), y, w, h } : l,
      ),
    }))
    setTimeout(() => cellApiRef.current.get(id)?.fit(), 60)
  }, [colStep, rowStep])

  // Commit a dragged/resized pixel rect in overlay mode: store it verbatim.
  const commitFloatGeom = useCallback((id: string, g: Geom) => {
    setFloatGeom((prev) => {
      const cur = prev[id]
      return { ...prev, [id]: { ...g, z: cur?.z ?? 1 } }
    })
    setTimeout(() => cellApiRef.current.get(id)?.fit(), 60)
  }, [])

  // Lighting mode: the spotlight pane fills the stage, everyone else a bottom
  // filmstrip; with no spotlight it's a calm even grid. spotlightId only moves
  // on promote/hand-off, so this never yanks around on finish/resume churn.
  const lightingGeoms = useMemo(
    () => (lighting ? computeLightingGeoms(cells, spotlightId, gridWidth, contentH) : {}),
    [lighting, cells, spotlightId, gridWidth, contentH],
  )
  const lightingActive = lighting && Object.keys(lightingGeoms).length > 0

  // Dock launch: paste the plugin's prompt into the active terminal for
  // review-before-send. Falls back to the most-recent pane if none is focused,
  // focusing it first so the paste lands somewhere visible.
  const launchDock = useCallback((pluginId: string) => {
    const item = PLUGIN_DOCK.find((p) => p.id === pluginId)
    if (!item) return
    const target = activeCellIdRef.current || cellsRef.current[cellsRef.current.length - 1]?.id
    if (!target) return
    setActive(target)
    const api = cellApiRef.current.get(target)
    api?.focus()
    api?.seed(item.prompt)
  }, [setActive])

  // Publish the pane roster + busy/idle to the host page (Kanban mode).
  useEffect(() => {
    if (!onPanesChange) return
    onPanesChange(cells.map((c) => ({
      id: c.id,
      name: paneLabel(c),
      cliType: c.cliType,
      status: statuses[c.id] === 'running' ? 'running' : 'idle',
    })))
  }, [cells, statuses, onPanesChange])

  // Shared cell renderer so grid + overlay modes stay in lockstep on props.
  const renderTerminalCell = (cell: GridCell) => (
    <TerminalCell
      cellId={cell.id}
      socket={socket}
      cliType={cell.cliType}
      name={cell.name}
      fontSize={fontSize}
      opacity={terminalOpacity}
      hostedApiUrl={hostedApiUrl}
      hostedToken={hostedToken}
      hostedUserId={hostedUserId}
      hostedProjects={hostedProjects}
      hostedProjectId={cell.hostedProjectId}
      cwd={cell.cwd}
      resumeId={cell.resumeId}
      daemonRunning={!!(cell.hostedProjectId && daemonStatus[cell.hostedProjectId]?.running)}
      attention={finishedIds.has(cell.id)}
      onClose={() => removeCell(cell.id)}
      onCliTypeChange={(v) => setCellCli(cell.id, v)}
      onRename={(v) => setCellName(cell.id, v)}
      onHostedProjectChange={(v) => setCellHostedProject(cell.id, v)}
      onMakeAgent={() => openDaemonModal(cell.id)}
      onPickFolder={() => setFolderPicker({ cellId: cell.id, initialPath: cell.cwd })}
      onFocusCell={() => {
        setActive(cell.id)
        // In Lighting/carousel, focusing a side pane's terminal must also bring
        // it to centre stage — otherwise the "active" pane wouldn't match the one
        // shown front-and-centre in the carousel. This fires for shells too: a
        // deliberate click is explicit selection, so you can stage a shell (the
        // "shells never grab the stage" rule only blocks AUTOMATIC staging via
        // markFinished). Guarded so it only fires on genuine user focus:
        //   • not the current spotlight (promote's own focus() of the centre pane)
        //   • not during a promote reflow (focus bouncing to a neighbour would
        //     otherwise re-promote it → endless round-robin)
        if (
          lightingRef.current &&
          cell.id !== spotlightRef.current &&
          !suppressFocusPromoteRef.current
        ) {
          spotCtl.current.promote(cell.id)
        }
      }}
      onNew={() => addCell()}
      onArrange={arrange}
      onZoom={zoom}
      onActivity={() => markActivity(cell.id)}
      onFinished={() => markFinished(cell.id)}
      onUserInput={() => markUserInput(cell.id)}
      onSubmit={() => markUserSubmit(cell.id)}
      onPromptTyped={(text) => onPromptTypedRef.current?.(cell.id, text)}
      registerApi={(api) => {
        if (api) cellApiRef.current.set(cell.id, api)
        else cellApiRef.current.delete(cell.id)
      }}
    />
  )

  // Left rail as tabs — shown alongside both modes.
  const dockItems: DockItem[] = cells.map((c) => {
    const disp = paneLabel(c)
    return { id: c.id, name: disp, cliType: c.cliType, label: disp }
  })
  const sidebarEl = sidebarOpen ? (
    <div style={{ width: SIDEBAR_W }} className="shrink-0">
      <TerminalListSidebar
        items={dockItems}
        activeId={activeCellId}
        statuses={statuses}
        finishedIds={finishedIds}
        onFocus={focusCellFromList}
        onClose={removeCell}
        onReorder={reorderCells}
        onAdd={() => addCell()}
        onCollapse={() => setSidebarOpen(false)}
      />
    </div>
  ) : null

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
    <div className="flex gap-2 overflow-hidden" style={{ height: containerHeight || '100%' }}>
      {sidebarEl}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div ref={toolbarRef} className="mb-3 flex items-center gap-2">
        {!sidebarOpen && (
          <Button onClick={() => setSidebarOpen(true)} size="sm" variant="outline" title="Show terminals (Ctrl+Shift+B)">
            <PanelLeftOpen className="h-4 w-4" />
          </Button>
        )}
        <div className="flex-1" />

        {/* Roulette — only meaningful in Lighting; sits just left of the View menu. */}
        {lighting && cells.length >= 2 && (
          <div className="flex items-center gap-0.5 rounded-md border border-white/10 bg-zinc-900/70 px-1 py-0.5">
            <Dices className="mx-0.5 h-4 w-4 text-zinc-400" strokeWidth={1.75} />
            <button
              onClick={() => russianRoulette('gentle')}
              disabled={spinning}
              className="flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium text-emerald-300 hover:bg-emerald-500/15 disabled:opacity-40"
              title="Spin and land on a random terminal (harmless)"
            >
              <Shuffle className="h-3.5 w-3.5" strokeWidth={1.75} /> Spin
            </button>
            <button
              onClick={() => russianRoulette('death')}
              disabled={spinning}
              className="flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium text-red-300 hover:bg-red-500/20 disabled:opacity-40"
              title="Spin; if you don't type a prompt within 5s, the terminal closes"
            >
              <Skull className="h-3.5 w-3.5" strokeWidth={1.75} /> Sudden death
            </button>
          </div>
        )}

        {/* View menu — the three layout modes (Overlay / Lighting / Arrange) in one place. */}
        <div className="relative">
          <Button
            onClick={() => { setViewMenuOpen((v) => !v); setAddMenuOpen(false) }}
            size="sm"
            variant={viewMode === 'overlay' || lighting ? 'default' : 'outline'}
            title="Layout modes"
          >
            {lighting ? <Zap className="h-4 w-4 text-amber-300" /> : viewMode === 'overlay' ? <Layers className="h-4 w-4" /> : <LayoutGrid className="h-4 w-4" />}
            {lighting ? 'Lighting' : viewMode === 'overlay' ? 'Overlay' : 'View'}
            <ChevronDown className="h-3.5 w-3.5 opacity-70" />
          </Button>
          {viewMenuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setViewMenuOpen(false)} />
              <div className="absolute right-0 top-full z-50 mt-1 w-56 overflow-hidden rounded-lg border border-white/10 bg-zinc-900/95 py-1 shadow-2xl backdrop-blur">
                <button
                  onClick={() => { toggleOverlay(); setViewMenuOpen(false) }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-white/5 ${viewMode === 'overlay' ? 'text-sky-300' : 'text-zinc-200'}`}
                >
                  <Layers className="h-4 w-4" /> <span className="flex-1">Overlay windows</span>
                  {viewMode === 'overlay' && <Check className="h-3.5 w-3.5" />}
                  <span className="font-mono text-[10px] text-zinc-500">⌘⇧O</span>
                </button>
                <button
                  onClick={() => { toggleLighting(); setViewMenuOpen(false) }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-white/5 ${lighting ? 'text-amber-300' : 'text-zinc-200'}`}
                >
                  <Zap className="h-4 w-4" /> <span className="flex-1">Lighting</span>
                  {lighting && <Check className="h-3.5 w-3.5" />}
                  <span className="font-mono text-[10px] text-zinc-500">⌘⇧Y</span>
                </button>
                <button
                  onClick={() => { arrange(); setViewMenuOpen(false) }}
                  disabled={viewMode !== 'grid'}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-white/5 disabled:opacity-40"
                >
                  <LayoutGrid className="h-4 w-4" /> <span className="flex-1">Arrange &amp; fit</span>
                  <span className="font-mono text-[10px] text-zinc-500">⌘P</span>
                </button>
              </div>
            </>
          )}
        </div>

        {/* Add split-button — click adds a terminal; caret offers "open in a folder". */}
        <div className="relative flex items-center">
          <Button onClick={() => addCell()} size="sm" title="New terminal (Alt+T)" className="rounded-r-none">
            <Plus className="h-4 w-4" /> Add Terminal
          </Button>
          <Button
            onClick={() => { setAddMenuOpen((v) => !v); setViewMenuOpen(false) }}
            size="sm"
            title="More ways to add a terminal"
            className="rounded-l-none border-l border-white/20 px-1.5"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
          {addMenuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setAddMenuOpen(false)} />
              <div className="absolute right-0 top-full z-50 mt-1 w-56 overflow-hidden rounded-lg border border-white/10 bg-zinc-900/95 py-1 shadow-2xl backdrop-blur">
                <button
                  onClick={() => { addCell(); setAddMenuOpen(false) }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-white/5"
                >
                  <Plus className="h-4 w-4" /> <span className="flex-1">New terminal</span>
                  <span className="font-mono text-[10px] text-zinc-500">Alt+T</span>
                </button>
                <button
                  onClick={() => { setFolderPicker({ cellId: null }); setAddMenuOpen(false) }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-white/5"
                >
                  <FolderOpen className="h-4 w-4" /> <span className="flex-1">Open in a folder…</span>
                </button>
              </div>
            </>
          )}
        </div>

        {/* Settings — per-CLI launch flags (skip-permissions, extra args) & more. */}
        <Button
          onClick={() => setSettingsOpen(true)}
          size="sm"
          variant="ghost"
          title="Settings"
          className="px-2"
        >
          <Settings className="h-4 w-4" strokeWidth={1.75} />
        </Button>
      </div>

      <SettingsPanel
        open={settingsOpen}
        clis={CLI_OPTIONS.filter((o) => o.value !== 'shell')}
        onClose={() => setSettingsOpen(false)}
      />

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

      {/* One absolute-positioning engine for both modes. Grid mode derives each
          window's rect from its tidy grid slot (snap on drop); overlay mode uses
          free pixel geometry that overlaps without shoving. The SAME window nodes
          render in both modes, so a toggle never re-parents a pane — terminals
          (and their PTYs) are never torn down. */}
      <div
        className="relative min-h-0 flex-1 overflow-hidden"
        style={{
          width: gridWidth,
          height: contentH,
          // Cover-flow depth: give the stage a vanishing point so the carousel's
          // angled side cards read as turned-in-3D rather than merely skewed.
          perspective: lightingActive ? 2600 : undefined,
          perspectiveOrigin: lightingActive ? '50% 46%' : undefined,
        }}
      >
        {cells.map((cell) => {
          const overlay = viewMode === 'overlay' && !lightingActive
          const fg = floatGeom[cell.id]
          const attention = finishedIds.has(cell.id)
          // Lighting mode overrides geometry to stage the attention pane(s).
          // Otherwise: grid slot (grid mode) or stored free rect (overlay).
          const rect: Geom = (lightingActive ? lightingGeoms[cell.id] : undefined)
            || (overlay ? fg : gridPx(cell.id))
            || gridPx(cell.id)
            || { x: 0, y: 0, w: Math.min(480, gridWidth), h: 320 }
          const z = lightingActive
            ? (rect?.z ?? (activeCellId === cell.id ? 4 : attention ? 3 : 1))
            : overlay ? (fg?.z ?? 1) : (activeCellId === cell.id ? 2 : 1)
          return (
            <FloatingWindow
              key={cell.id}
              id={cell.id}
              geom={rect}
              z={z}
              overlay={overlay}
              active={activeCellId === cell.id}
              bounded={!overlay}
              animate={lightingActive}
              containerW={gridWidth}
              containerH={contentH}
              onFocus={(fid) => {
                setActive(fid)
                if (viewModeRef.current === 'overlay') bringToFront(fid)
                // In Lighting, clicking a filmstrip pane promotes it to the stage.
                if (lightingRef.current && fid !== spotlightRef.current) spotCtl.current.promote(fid)
              }}
              onCommit={overlay ? commitFloatGeom : commitGridGeom}
            >
              {renderTerminalCell(cell)}
            </FloatingWindow>
          )
        })}

        {/* (Roulette controls live in the toolbar now — see the View-menu row.) */}

        {/* Death countdown — pointer-events-none so keystrokes still reach the
            doomed terminal (you defuse by actually SENDING a prompt / Enter). */}
        {roulette && (
          <div className="pointer-events-none absolute inset-0 z-[200] flex items-center justify-center">
            <div className="animate-pulse rounded-2xl border-2 border-red-500/70 bg-black/70 px-10 py-6 text-center shadow-2xl backdrop-blur-sm">
              <div className="flex items-center justify-center gap-3 text-red-400">
                <Skull className="h-12 w-12" strokeWidth={1.5} />
                <span className="text-6xl font-black leading-none tabular-nums">{roulette.count}</span>
              </div>
              <div className="mt-3 text-sm font-semibold text-red-200">Send a prompt or it closes!</div>
            </div>
          </div>
        )}
      </div>

      {/* Bottom docks: LEFT = open terminals (click to switch/stage), RIGHT =
          activated plugins (click seeds its prompt into the active terminal). */}
      <div className="pointer-events-none flex w-full shrink-0 flex-wrap items-end justify-center gap-3 pb-2 pt-1">
        <TerminalSwitcherDock
          items={dockItems}
          activeId={activeCellId}
          statuses={statuses}
          finishedIds={finishedIds}
          onSwitch={focusCellFromList}
          onAdd={() => addCell()}
        />
        <PluginDock items={PLUGIN_DOCK} onLaunch={launchDock} />
      </div>
      </div>
    </div>
  )
}

export const AgentGrid = forwardRef<AgentGridHandle, AgentGridProps>(function AgentGrid(
  { socket, storageKey, terminalOpacity, hostedApiUrl, hostedToken, hostedUserId, hostedProjects, onPanesChange, onPromptTyped }, ref,
) {
  const { containerRef, width } = useContainerWidth()
  const [height, setHeight] = useState(0)
  const apiRef = useRef<AgentGridHandle>({
    addTerminal() {}, arrange() {}, closeActive() {}, importSessions() {},
    toggleOverlay() {}, toggleLighting() {}, toggleSidebar() {}, cycleTerminal() {},
    dispatchPrompt: () => false,
  })
  useImperativeHandle(ref, () => ({
    addTerminal: () => apiRef.current.addTerminal(),
    arrange: () => apiRef.current.arrange(),
    closeActive: () => apiRef.current.closeActive(),
    importSessions: (specs) => apiRef.current.importSessions(specs),
    toggleOverlay: () => apiRef.current.toggleOverlay(),
    toggleLighting: () => apiRef.current.toggleLighting(),
    toggleSidebar: () => apiRef.current.toggleSidebar(),
    cycleTerminal: (dir) => apiRef.current.cycleTerminal(dir),
    dispatchPrompt: (cellId, text) => apiRef.current.dispatchPrompt(cellId, text),
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
          hostedUserId={hostedUserId}
          hostedProjects={hostedProjects}
          onPanesChange={onPanesChange}
          onPromptTyped={onPromptTyped}
          apiRef={apiRef}
        />
      )}
    </div>
  )
})
