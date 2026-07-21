'use client'

// ── Terminal Dock ────────────────────────────────────────────────────────────
// Two presentational pieces that power the new layout modes for the grid:
//   • TerminalListSidebar — a left rail listing every open terminal as a
//     draggable "tab" (CLI icon + title + live status dot). Click focuses,
//     ✕ closes, drag reorders. Purely props-driven; all state lives in the grid.
// It owns no terminal state, so reordering / focusing never restarts a PTY.
// (Overlay mode is handled by the grid engine itself — no floating wrapper here.)

import { useRef, useState, useEffect } from 'react'
import { Plus, X, GripVertical, PanelLeftClose, Terminal as TerminalIcon, Circle } from 'lucide-react'

export type CellStatus = 'running' | 'idle'

/** Pixel rectangle for an absolutely-positioned terminal window. */
export interface Geom {
  x: number
  y: number
  w: number
  h: number
  /** Turntable angle (deg) of this card around the shared ring. Carousel only. */
  rotY?: number
  /** Ring radius (px). With rotY, places the card on a common cylinder via
   *  `translateZ(-R) rotateY(θ) translateZ(R)` so the whole reel turns as one. */
  zDepth?: number
  /** Where the rotateY hinge sits horizontally ('left' | 'right' | 'center'). */
  originX?: 'left' | 'right' | 'center'
  /** Pane opacity — carousel dims the side cards and hides the off-stage ones. */
  opacity?: number
  /** Explicit stacking order (carousel needs the centre card on top). */
  z?: number
  /** Off-stage carousel pane: kept mounted (PTY alive) but invisible & inert. */
  hidden?: boolean
}

const MIN_W = 260
const MIN_H = 150

// ── FloatingWindow ───────────────────────────────────────────────────────────
// One absolutely-positioned terminal window. Powers BOTH layout modes:
//   • Grid mode  — `geom` is derived from the tidy grid; drag/resize is bounded
//     to the workspace and snaps to the grid on release (parent decides).
//   • Overlay mode — `geom` is free pixel geometry; windows overlap freely and
//     never shove each other (that's the "scattered desktop terminals" feel).
// Dragging works on the pane's `.drag-handle` (its header); a corner grip
// resizes. All movement happens in local px state so it's pixel-precise and
// smooth; the parent is told the final rect once on release (onCommit) — grid
// mode snaps it, overlay mode stores it verbatim. Because the window element is
// never re-parented across modes, the terminal (and its PTY) is never remounted.
export function FloatingWindow({
  id, geom, z, bounded, containerW, containerH, active, overlay, animate, onFocus, onCommit, children,
}: {
  id: string
  geom: Geom
  z: number
  /** Clamp fully inside the workspace (grid mode). Overlay keeps a title strip reachable. */
  bounded: boolean
  containerW: number
  containerH: number
  active: boolean
  overlay: boolean
  /** Animate position/size changes (lighting mode reflow). Off while dragging. */
  animate?: boolean
  onFocus: (id: string) => void
  onCommit: (id: string, geom: Geom) => void
  children: React.ReactNode
}) {
  // While dragging/resizing we own the geometry locally (px, precise). When idle
  // (`live` null) we follow the `geom` prop, so grid re-derivation on width change
  // and grid-snap after commit both flow straight through.
  const [live, setLive] = useState<Geom | null>(null)
  // Mirror of `live` so the mouseup handler can read the final rect and commit
  // it WITHOUT calling the parent's setState from inside a setLive updater
  // (which React runs during render → "setState while rendering" error).
  const liveRef = useRef<Geom | null>(null)
  const setLiveGeom = (g: Geom | null) => { liveRef.current = g; setLive(g) }
  const drag = useRef<
    | null
    | { mode: 'move' | 'resize'; sx: number; sy: number; orig: Geom }
  >(null)
  const cur = live ?? geom

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = drag.current
      if (!d) return
      const dx = e.clientX - d.sx
      const dy = e.clientY - d.sy
      if (d.mode === 'move') {
        let x = d.orig.x + dx
        let y = d.orig.y + dy
        if (bounded) {
          x = Math.max(0, Math.min(x, containerW - d.orig.w))
          y = Math.max(0, Math.min(y, containerH - d.orig.h))
        } else {
          // Keep at least a grabbable strip of the title bar on-screen.
          x = Math.max(60 - d.orig.w, Math.min(x, containerW - 60))
          y = Math.max(0, Math.min(y, containerH - 32))
        }
        setLiveGeom({ ...d.orig, x, y })
      } else {
        let w = Math.max(MIN_W, d.orig.w + dx)
        let h = Math.max(MIN_H, d.orig.h + dy)
        if (bounded) {
          w = Math.min(w, containerW - d.orig.x)
          h = Math.min(h, containerH - d.orig.y)
        }
        setLiveGeom({ ...d.orig, w, h })
      }
    }
    const onUp = () => {
      const d = drag.current
      if (!d) return
      drag.current = null
      document.body.style.userSelect = ''
      const l = liveRef.current
      if (l) onCommit(id, l)
      setLiveGeom(null)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [id, bounded, containerW, containerH, onCommit])

  const startMove = (e: React.MouseEvent) => {
    // Ignore drags that begin on interactive header controls (buttons, inputs,
    // the rename field) so clicking them never moves the window.
    if ((e.target as HTMLElement).closest('button, input, select, textarea, a')) return
    e.preventDefault()
    onFocus(id)
    drag.current = { mode: 'move', sx: e.clientX, sy: e.clientY, orig: { ...cur } }
    document.body.style.userSelect = 'none'
  }
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onFocus(id)
    drag.current = { mode: 'resize', sx: e.clientX, sy: e.clientY, orig: { ...cur } }
    document.body.style.userSelect = 'none'
  }

  return (
    <div
      id={`cell-wrap-${id}`}
      className="absolute"
      style={{
        left: cur.x, top: cur.y, width: cur.w, height: cur.h, zIndex: z,
        // Turntable: every card sits on ONE shared cylinder and the whole ring
        // rotates as a single body. `translateZ(-R) rotateY(θ) translateZ(R)`
        // orbits the card around a common vertical axis R behind the stage — the
        // front card (θ=0) resolves to the base plane (no zoom), neighbours swing
        // back and aside. Because every card is the same box and only θ differs,
        // easing θ together on one curve turns the reel one notch as a rigid
        // whole. Off-stage panes stay mounted (PTY alive) but invisible + inert.
        transform: (cur.zDepth != null && cur.rotY != null)
          ? `translateZ(${-cur.zDepth}px) rotateY(${cur.rotY}deg) translateZ(${cur.zDepth}px)`
          : cur.rotY ? `rotateY(${cur.rotY}deg)` : undefined,
        transformOrigin: (cur.rotY != null || cur.zDepth != null) ? 'center center' : undefined,
        opacity: cur.hidden ? 0 : cur.opacity,
        pointerEvents: cur.hidden ? 'none' : undefined,
        // Smoothly glide to the new rect when lighting reflows the stage, but
        // never while the user is actively dragging (that must track 1:1). A
        // single eased curve for position + rotation + fade keeps the whole
        // carousel turning together.
        transition: animate && !live
          ? 'left .5s cubic-bezier(.4,0,.2,1), top .5s cubic-bezier(.4,0,.2,1), width .5s cubic-bezier(.4,0,.2,1), height .5s cubic-bezier(.4,0,.2,1), transform .5s cubic-bezier(.4,0,.2,1), opacity .42s ease'
          : undefined,
      }}
      onMouseDownCapture={overlay ? () => onFocus(id) : undefined}
    >
      {/* Capture drags on the pane header (which carries `.drag-handle`). Using a
          bubble-phase handler on a wrapper lets the header's own buttons still
          receive their clicks (see startMove's interactive-target guard). */}
      <div className="h-full" onMouseDown={(e) => { if ((e.target as HTMLElement).closest('.drag-handle')) startMove(e) }}>
        {children}
      </div>
      {/* Corner resize grip. */}
      <div
        onMouseDown={startResize}
        className={`absolute bottom-0 right-0 h-4 w-4 cursor-se-resize ${active ? 'opacity-100' : 'opacity-0 hover:opacity-100'}`}
        title="Resize"
        style={{
          background:
            'linear-gradient(135deg, transparent 0 50%, rgba(140,147,161,0.55) 50% 60%, transparent 60% 70%, rgba(140,147,161,0.55) 70% 80%, transparent 80%)',
        }}
      />
    </div>
  )
}

export interface DockItem {
  id: string
  name: string
  cliType: string
  label: string
}

// ── PluginDock ───────────────────────────────────────────────────────────────
// A macOS-style dock pinned to the bottom of the workspace, listing the
// "activated" companion plugins. Each tile magnifies on hover (Mac feel) and,
// when clicked, seeds its prompt into the currently-active terminal for
// review-before-send. Purely presentational: the launch behaviour lives in the
// grid, handed in via onLaunch.
export interface PluginDockItem {
  id: string
  label: string
  color: string // hex accent
  icon: React.ReactNode
  hint: string // shown under the label in the tooltip
}

export function PluginDock({
  items, onLaunch,
}: {
  items: PluginDockItem[]
  onLaunch: (id: string) => void
}) {
  const [hovered, setHovered] = useState<string | null>(null)
  return (
    <div
      className="pointer-events-auto flex items-end gap-1.5 rounded-2xl border border-white/10 bg-zinc-900/70 px-2.5 py-1.5 shadow-2xl backdrop-blur-md"
      style={{ boxShadow: '0 8px 30px rgba(0,0,0,0.45)' }}
    >
        {items.map((it) => {
          const active = hovered === it.id
          return (
            <button
              key={it.id}
              onClick={() => onLaunch(it.id)}
              onMouseEnter={() => setHovered(it.id)}
              onMouseLeave={() => setHovered((h) => (h === it.id ? null : h))}
              className="group relative flex flex-col items-center"
              title={`${it.label} — ${it.hint}`}
            >
              {/* Tooltip bubble (Mac dock label) */}
              <span
                className={`pointer-events-none absolute -top-9 whitespace-nowrap rounded-md border border-white/10 bg-zinc-950/95 px-2 py-1 text-[11px] font-medium text-zinc-100 shadow-lg transition-all duration-150 ${
                  active ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'
                }`}
              >
                {it.label}
              </span>
              {/* Icon tile — magnifies on hover */}
              <span
                className="flex items-center justify-center rounded-xl border transition-all duration-150 ease-out"
                style={{
                  width: active ? 52 : 40,
                  height: active ? 52 : 40,
                  transform: active ? 'translateY(-6px)' : 'translateY(0)',
                  color: it.color,
                  borderColor: active ? `${it.color}66` : 'rgba(255,255,255,0.08)',
                  background: active ? `${it.color}1f` : 'rgba(255,255,255,0.04)',
                }}
              >
                {it.icon}
              </span>
              {/* Running/active dot could go here later */}
            </button>
          )
        })}
    </div>
  )
}

// ── TerminalSwitcherDock ──────────────────────────────────────────────────────
// A macOS-style dock, twin of PluginDock, but listing the OPEN TERMINALS instead
// of plugins. Each tile is the CLI's 2-letter code on its accent colour; click to
// switch to that terminal (focus + spotlight it). The active terminal is filled,
// a just-finished one pulses amber, a running one shows a live dot. This is the
// deterministic way to move between panes — no reliance on auto-spotlight.
export function TerminalSwitcherDock({
  items, activeId, statuses, finishedIds, onSwitch, onAdd,
}: {
  items: DockItem[]
  activeId: string | null
  statuses: Record<string, CellStatus>
  finishedIds: Set<string>
  onSwitch: (id: string) => void
  onAdd: () => void
}) {
  const [hovered, setHovered] = useState<string | null>(null)
  if (items.length === 0) return null
  return (
    <div
      className="pointer-events-auto flex items-end gap-1.5 rounded-2xl border border-white/10 bg-zinc-900/70 px-2.5 py-1.5 shadow-2xl backdrop-blur-md"
      style={{ boxShadow: '0 8px 30px rgba(0,0,0,0.45)' }}
    >
      {items.map((it) => {
        const active = activeId === it.id
        const hover = hovered === it.id
        const big = active || hover
        const attention = finishedIds.has(it.id)
        const status = statuses[it.id] ?? 'idle'
        const accent = accentFor(it.cliType)
        const code = cliLabelFor(it.cliType).slice(0, 2).toUpperCase()
        return (
          <button
            key={it.id}
            onClick={() => onSwitch(it.id)}
            onMouseEnter={() => setHovered(it.id)}
            onMouseLeave={() => setHovered((h) => (h === it.id ? null : h))}
            className="group relative flex flex-col items-center"
            title={it.name || it.label}
          >
            {/* Tooltip bubble */}
            <span
              className={`pointer-events-none absolute -top-9 z-10 max-w-[180px] truncate whitespace-nowrap rounded-md border border-white/10 bg-zinc-950/95 px-2 py-1 text-[11px] font-medium text-zinc-100 shadow-lg transition-all duration-150 ${
                hover ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'
              }`}
            >
              {it.name || it.label}
            </span>
            {/* Tile — CLI code on accent, magnifies on hover / when active */}
            <span
              className="relative flex items-center justify-center rounded-xl border font-semibold transition-all duration-150 ease-out"
              style={{
                width: big ? 52 : 40,
                height: big ? 52 : 40,
                fontSize: big ? 15 : 13,
                transform: big ? 'translateY(-6px)' : 'translateY(0)',
                color: accent,
                borderColor: active ? accent : attention ? 'rgba(251,191,36,0.6)' : `${accent}55`,
                background: active ? `${accent}2b` : 'rgba(255,255,255,0.04)',
                boxShadow: active ? `0 0 0 1px ${accent}` : undefined,
              }}
            >
              {code}
              {/* Status dot bottom-right */}
              {attention ? (
                <span className="absolute -bottom-0.5 -right-0.5 flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full border border-zinc-900 bg-amber-400" />
                </span>
              ) : status === 'running' ? (
                <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border border-zinc-900 bg-emerald-400" />
              ) : null}
            </span>
          </button>
        )
      })}
      {/* Add-terminal tile */}
      <button
        onClick={onAdd}
        onMouseEnter={() => setHovered('__add__')}
        onMouseLeave={() => setHovered((h) => (h === '__add__' ? null : h))}
        className="group relative flex flex-col items-center"
        title="New terminal"
      >
        <span
          className="flex items-center justify-center rounded-xl border border-dashed border-white/15 bg-white/[0.03] text-zinc-400 transition-all duration-150 ease-out group-hover:text-zinc-100"
          style={{
            width: hovered === '__add__' ? 52 : 40,
            height: hovered === '__add__' ? 52 : 40,
            transform: hovered === '__add__' ? 'translateY(-6px)' : 'translateY(0)',
          }}
        >
          <Plus className="h-5 w-5" />
        </span>
      </button>
    </div>
  )
}

// Accent per CLI so the rail reads at a glance which agent is which.
const CLI_ACCENT: Record<string, string> = {
  claude: '#d0752b',
  orquesta: '#14c48a',
  kimi: '#b892ff',
  kiro: '#4c8dff',
  opencode: '#3bc9db',
  shell: '#8b93a1',
}

function accentFor(cli: string): string {
  return CLI_ACCENT[cli] ?? CLI_ACCENT.shell
}

// Human-readable CLI name for the rail badge.
const CLI_LABEL: Record<string, string> = {
  claude: 'Claude',
  orquesta: 'Orquesta',
  kimi: 'Kimi',
  kiro: 'Kiro',
  opencode: 'OpenCode',
  shell: 'Shell',
}

function cliLabelFor(cli: string): string {
  return CLI_LABEL[cli] ?? cli
}

export function TerminalListSidebar({
  items, activeId, statuses, finishedIds, onFocus, onClose, onReorder, onAdd, onCollapse,
}: {
  items: DockItem[]
  activeId: string | null
  statuses: Record<string, CellStatus>
  finishedIds: Set<string>
  onFocus: (id: string) => void
  onClose: (id: string) => void
  onReorder: (fromId: string, toId: string) => void
  onAdd: () => void
  onCollapse: () => void
}) {
  const dragId = useRef<string | null>(null)

  return (
    <aside className="flex h-full w-full flex-col overflow-hidden rounded-md border border-zinc-800 bg-zinc-950/60 backdrop-blur-sm">
      <div className="flex items-center justify-between border-b border-zinc-800/80 px-2.5 py-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Terminals</span>
        <div className="flex items-center gap-1">
          <button
            onClick={onAdd}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            title="New terminal (Alt+T)"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={onCollapse}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            title="Collapse sidebar"
          >
            <PanelLeftClose className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {items.length === 0 && (
          <p className="px-3 py-4 text-center text-xs text-zinc-600">No terminals yet.</p>
        )}
        {items.map((it) => {
          const active = it.id === activeId
          const status = statuses[it.id] ?? 'idle'
          const attention = finishedIds.has(it.id)
          return (
            <div
              key={it.id}
              draggable
              onDragStart={() => { dragId.current = it.id }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                if (dragId.current && dragId.current !== it.id) onReorder(dragId.current, it.id)
                dragId.current = null
              }}
              onClick={() => onFocus(it.id)}
              className={`group mx-1 mb-0.5 flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors ${
                active
                  ? 'bg-zinc-800/90 text-zinc-100'
                  : attention
                    ? 'bg-emerald-500/10 text-emerald-100 ring-1 ring-emerald-500/40'
                    : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
              }`}
              title={it.label}
            >
              <GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab text-zinc-700 opacity-0 group-hover:opacity-100 active:cursor-grabbing" />
              <span className="shrink-0" style={{ color: accentFor(it.cliType) }}>
                <TerminalIcon className="h-3.5 w-3.5" />
              </span>
              {/* Name on top, the CLI running in this terminal underneath. */}
              <span className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate">{it.name || it.label}</span>
                <span
                  className="truncate text-[10px] font-medium uppercase tracking-wide opacity-80"
                  style={{ color: accentFor(it.cliType) }}
                >
                  {cliLabelFor(it.cliType)}
                </span>
              </span>
              {/* Status: pulsing emerald = just finished a prompt (needs attention),
                  solid amber = actively producing output, hollow = idle. */}
              {attention ? (
                <span className="relative flex h-2 w-2 shrink-0">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
                </span>
              ) : status === 'running' ? (
                <Circle className="h-2 w-2 shrink-0 fill-amber-400 text-amber-400" />
              ) : (
                <Circle className="h-2 w-2 shrink-0 text-zinc-700" />
              )}
              <button
                onClick={(e) => { e.stopPropagation(); onClose(it.id) }}
                className="shrink-0 rounded p-0.5 text-zinc-600 opacity-0 hover:bg-zinc-700 hover:text-zinc-200 group-hover:opacity-100"
                title="Close terminal"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )
        })}
      </div>
    </aside>
  )
}

