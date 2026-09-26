'use client'

// ── Remote desktop pane ──────────────────────────────────────────────────────
// A grid pane showing the REAL SCREEN of a machine running orquesta-agent,
// instead of a terminal. Frames arrive as PNGs over the relay's rd:* protocol,
// reassembled in Rust (cloud.rs) and handed here as one base64 image per frame;
// the human's mouse and keyboard go back as computer-use actions.
//
// Watching and driving are separate permissions. This app authenticates with an
// org-scoped `oclt_` — a long-lived string in a config file, not a person who
// just signed in — so the relay accepts it for viewing after checking the
// project's organization, and hands over the keyboard only against the
// project's pairing PIN (set in the dashboard, Project Settings → Agent).
//
// Desktop panes wear WHITE chrome, like remote terminals: what's on screen is
// someone else's machine.

import { useCallback, useEffect, useRef, useState } from 'react'
import { X, Monitor, Pencil, Loader2, KeyRound, Hand, Users } from 'lucide-react'
import type { TauriHandle } from '@/hooks/useTauri'

/** The project whose desktop a pane is watching. */
export interface RemoteDesktopTarget {
  projectId: string
  projectName: string
}

/** What the agent reports about the screen it is sharing. */
interface RdStatus {
  enabled?: boolean
  available?: boolean
  width?: number
  height?: number
  reason?: string
}

// A press that travels further than this is a drag, not a click. Four pixels is
// below what a hand does when it means to click and above what it does when it
// means to hold still.
const DRAG_THRESHOLD_PX = 4
// Moves are a stream; the agent only needs enough of them to keep the cursor
// where the hand is.
const MOUSE_MOVE_INTERVAL_MS = 60

export function RemoteDesktopCell({
  cellId, socket, target, name, opacity, apiUrl, token,
  onClose, onRename, onFocusCell,
}: {
  cellId: string
  socket: TauriHandle | null
  target: RemoteDesktopTarget
  name: string
  opacity: number
  apiUrl?: string
  token?: string
  onClose: () => void
  onRename: (v: string) => void
  onFocusCell: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const [joined, setJoined] = useState(false)
  const [joinError, setJoinError] = useState<string | null>(null)
  const [status, setStatus] = useState<RdStatus>({})
  const [viewers, setViewers] = useState<number | null>(null)
  const [controlEnabled, setControlEnabled] = useState(false)
  const [pinPrompt, setPinPrompt] = useState(false)
  const [pinValue, setPinValue] = useState('')
  const [pinError, setPinError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)

  const displayName = name || target.projectName

  const drawFrame = useCallback((base64Png: string) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const img = new Image()
    img.onload = () => {
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      if (canvas.width !== img.width || canvas.height !== img.height) {
        canvas.width = img.width
        canvas.height = img.height
      }
      ctx.drawImage(img, 0, 0)
    }
    img.src = `data:image/png;base64,${base64Png}`
  }, [])

  // Join on mount, leave on unmount. Leaving matters more than it looks: the
  // agent stops capturing the screen when the viewer count reaches zero, so a
  // pane that closed without leaving would keep a customer's machine encoding
  // frames for nobody.
  useEffect(() => {
    // Without hosted credentials there is nothing to join with — the pane says
    // so through its own overlay rather than firing a join that cannot work.
    if (!socket || !apiUrl || !token) return

    const onFrame = (data: { data?: string }) => {
      if (data?.data) drawFrame(data.data)
    }
    const onStatus = (next: RdStatus) => setStatus(next || {})
    const onViewers = (data: { count?: number }) => setViewers(data?.count ?? null)
    const onJoinResult = (result: { ok?: boolean; error?: string }) => {
      if (result?.ok) {
        setJoined(true)
        setJoinError(null)
      } else {
        setJoined(false)
        setJoinError(result?.error || 'The relay refused the connection')
      }
    }
    const onControlResult = (result: { ok?: boolean; pinRequired?: boolean; error?: string }) => {
      if (result?.ok) {
        setControlEnabled(true)
        setPinPrompt(false)
        setPinError(null)
        setPinValue('')
        return
      }
      if (result?.pinRequired) {
        setPinPrompt(true)
        // An error alongside pinRequired means a PIN was sent and rejected;
        // without one the relay is only saying a PIN is needed.
        setPinError(result?.error || null)
        return
      }
      setPinError(result?.error || 'Could not take control')
    }

    socket.on('remote:rd-frame', onFrame)
    socket.on('remote:rd-status', onStatus)
    socket.on('remote:rd-viewers', onViewers)
    socket.on('rd:join-result', onJoinResult)
    socket.on('rd:control-result', onControlResult)

    socket.emit('rd:join', { apiUrl, token, projectId: target.projectId })

    return () => {
      socket.off('remote:rd-frame', onFrame)
      socket.off('remote:rd-status', onStatus)
      socket.off('remote:rd-viewers', onViewers)
      socket.off('rd:join-result', onJoinResult)
      socket.off('rd:control-result', onControlResult)
      socket.emit('rd:leave', {})
    }
  }, [socket, apiUrl, token, target.projectId, drawFrame])

  const requestControl = useCallback((pin?: string) => {
    setPinError(null)
    socket?.emit('rd:control', pin ? { pin } : {})
  }, [socket])

  const releaseControl = useCallback(() => {
    setControlEnabled(false)
    setPinPrompt(false)
    setPinValue('')
    socket?.emit('rd:control', { release: true })
  }, [socket])

  // Canvas space → the agent's screen resolution. The canvas is drawn at the
  // remote resolution and scaled by CSS to fit the pane, so every coordinate a
  // mouse event reports has to be scaled back up.
  const toAgentCoord = useCallback((clientX: number, clientY: number): [number, number] | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    const scaleX = (status.width || canvas.width) / rect.width
    const scaleY = (status.height || canvas.height) / rect.height
    return [
      Math.round((clientX - rect.left) * scaleX),
      Math.round((clientY - rect.top) * scaleY),
    ]
  }, [status.width, status.height])

  const sendInput = useCallback((input: unknown) => {
    if (!controlEnabled || !joined) return
    socket?.emit('rd:input', { input })
  }, [controlEnabled, joined, socket])

  // ── Pointer gestures ────────────────────────────────────────────────────
  // The press is tracked here rather than sent as it happens, because the same
  // down/up pair is a click or a drag depending on what the pointer did in
  // between, and the agent takes those as two different actions.
  const pressRef = useRef<{ coordinate: [number, number]; button: number } | null>(null)
  const lastMoveRef = useRef(0)

  const onMouseDown = useCallback((event: React.MouseEvent) => {
    onFocusCell()
    if (!controlEnabled) return
    const coordinate = toAgentCoord(event.clientX, event.clientY)
    if (!coordinate) return
    pressRef.current = { coordinate, button: event.button }
  }, [controlEnabled, toAgentCoord, onFocusCell])

  const onMouseUp = useCallback((event: React.MouseEvent) => {
    if (!controlEnabled) return
    const coordinate = toAgentCoord(event.clientX, event.clientY)
    const press = pressRef.current
    pressRef.current = null
    if (!coordinate) return

    if (press && press.button === event.button) {
      const travelled = Math.hypot(coordinate[0] - press.coordinate[0], coordinate[1] - press.coordinate[1])
      if (travelled > DRAG_THRESHOLD_PX) {
        sendInput({ action: 'left_click_drag', start_coordinate: press.coordinate, coordinate })
        return
      }
    }
    // Two of these in quick succession are a double click as far as the remote
    // window manager is concerned, so there is no separate dblclick handler —
    // adding one would send a third click on top of the pair already reported.
    const action = event.button === 1 ? 'middle_click' : event.button === 2 ? 'right_click' : 'left_click'
    sendInput({ action, coordinate })
  }, [controlEnabled, toAgentCoord, sendInput])

  const onMouseMove = useCallback((event: React.MouseEvent) => {
    if (!controlEnabled) return
    const now = Date.now()
    if (now - lastMoveRef.current < MOUSE_MOVE_INTERVAL_MS) return
    lastMoveRef.current = now
    const coordinate = toAgentCoord(event.clientX, event.clientY)
    // Mid-drag the button is down on the remote machine too, so moving the
    // cursor IS the drag; the gesture is closed by the mouseup above.
    if (coordinate) sendInput({ action: 'mouse_move', coordinate })
  }, [controlEnabled, toAgentCoord, sendInput])

  // Wheel must be a native listener: React attaches its own passively, and a
  // passive handler cannot preventDefault, so scrolling the remote desktop
  // would also scroll whatever is under the pane.
  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return
    const onWheel = (event: WheelEvent) => {
      if (!controlEnabled) return
      event.preventDefault()
      const coordinate = toAgentCoord(event.clientX, event.clientY)
      if (!coordinate) return
      const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY)
      const delta = horizontal ? event.deltaX : event.deltaY
      if (delta === 0) return
      sendInput({
        action: 'scroll',
        coordinate,
        scroll_direction: horizontal ? (delta > 0 ? 'right' : 'left') : (delta > 0 ? 'down' : 'up'),
        scroll_amount: Math.min(10, Math.max(1, Math.round(Math.abs(delta) / 40))),
      })
    }
    surface.addEventListener('wheel', onWheel, { passive: false })
    return () => surface.removeEventListener('wheel', onWheel)
  }, [controlEnabled, toAgentCoord, sendInput])

  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (!controlEnabled) return
    event.preventDefault()
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      sendInput({ action: 'type', text: event.key })
    } else {
      const modifiers = [
        event.ctrlKey && 'ctrl',
        event.shiftKey && 'shift',
        event.altKey && 'alt',
        event.metaKey && 'super',
      ].filter(Boolean)
      sendInput({ action: 'key', text: [...modifiers, event.key.toLowerCase()].join('+') })
    }
  }, [controlEnabled, sendInput])

  const commitRename = () => {
    setEditing(false)
    const v = draft.trim()
    if (v !== name) onRename(v)
  }

  const unavailable = status.available === false || status.enabled === false

  return (
    <div
      className="flex h-full flex-col overflow-hidden rounded-md border border-white/45 backdrop-blur-sm"
      style={{ backgroundColor: `rgba(10, 12, 16, ${opacity})` }}
      onMouseDown={onFocusCell}
      data-cell-id={cellId}
    >
      <div className="drag-handle flex cursor-grab items-center justify-between gap-2 border-b border-white/25 bg-white/[0.06] px-2.5 py-1.5 active:cursor-grabbing">
        <div className="flex min-w-0 items-center gap-2">
          <Monitor className="h-3.5 w-3.5 shrink-0 text-white" />
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
              placeholder={target.projectName}
              className="w-28 rounded bg-white/10 px-1.5 py-0.5 text-xs font-mono text-white outline-none focus:ring-1 focus:ring-white/40"
            />
          ) : (
            <button
              onClick={() => setEditing(true)}
              onMouseDown={(e) => e.stopPropagation()}
              className="group flex min-w-0 items-center gap-1 text-xs font-mono text-white hover:text-white"
              title="Rename pane"
            >
              <span className="max-w-[9rem] truncate">{displayName}</span>
              <Pencil className="h-2.5 w-2.5 shrink-0 text-white/40 opacity-0 group-hover:opacity-100" />
            </button>
          )}
          <span className="shrink-0 rounded bg-white/15 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-white">
            Desktop
          </span>
          {status.width && status.height && (
            <span className="shrink-0 text-[10px] font-mono text-white/50">
              {status.width}×{status.height}
            </span>
          )}
          {viewers !== null && viewers > 1 && (
            <span className="flex shrink-0 items-center gap-1 text-[10px] font-mono text-white/60" title="People watching this desktop">
              <Users className="h-3 w-3" /> {viewers}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {controlEnabled ? (
            <button
              onClick={releaseControl}
              onMouseDown={(e) => e.stopPropagation()}
              className="flex items-center gap-1 rounded bg-white/15 px-1.5 py-0.5 text-[10px] font-mono text-white hover:bg-white/25"
              title="Give the keyboard and mouse back"
            >
              <Hand className="h-3 w-3" /> Release
            </button>
          ) : (
            <button
              onClick={() => requestControl()}
              onMouseDown={(e) => e.stopPropagation()}
              disabled={!joined}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono text-white/70 hover:bg-white/10 hover:text-white disabled:opacity-40"
              title="Take the keyboard and mouse (needs the project's pairing PIN)"
            >
              <KeyRound className="h-3 w-3" /> Take control
            </button>
          )}
          <button
            onClick={onClose}
            onMouseDown={(e) => e.stopPropagation()}
            className="text-white/50 hover:text-white"
            title="Close pane (stops watching)"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div
        ref={surfaceRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onMouseMove={onMouseMove}
        onContextMenu={(e) => e.preventDefault()}
        className={`relative min-h-0 flex-1 overflow-hidden bg-black outline-none ${
          controlEnabled ? 'cursor-none ring-1 ring-inset ring-white/40' : 'cursor-default'
        }`}
      >
        <canvas ref={canvasRef} className="h-full w-full object-contain" />

        {(!joined || unavailable || joinError) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 px-6 text-center">
            {!apiUrl || !token ? (
              <p className="text-xs text-zinc-300">Sign in to Orquesta Cloud to watch this desktop.</p>
            ) : joinError ? (
              <p className="text-xs text-red-300">{joinError}</p>
            ) : unavailable ? (
              <>
                <p className="text-xs text-zinc-300">This agent is not sharing its desktop.</p>
                <p className="text-[11px] text-zinc-500">
                  {status.reason || 'Enable Remote Desktop for the project in the dashboard, under Settings → Agent.'}
                </p>
              </>
            ) : (
              <p className="flex items-center gap-2 text-xs text-zinc-400">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Connecting to the relay…
              </p>
            )}
          </div>
        )}

        {pinPrompt && !controlEnabled && (
          <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 border-t border-white/15 bg-zinc-950/95 px-3 py-2">
            <KeyRound className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
            <input
              autoFocus
              type="password"
              inputMode="numeric"
              value={pinValue}
              onChange={(e) => setPinValue(e.target.value.replace(/\D/g, '').slice(0, 12))}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter' && pinValue) requestControl(pinValue)
              }}
              placeholder="Pairing PIN"
              className="w-32 rounded border border-white/10 bg-white/5 px-2 py-1 text-xs font-mono text-zinc-100 outline-none"
            />
            <button
              onClick={() => pinValue && requestControl(pinValue)}
              disabled={!pinValue}
              className="rounded border border-white/25 bg-white/10 px-2.5 py-1 text-[11px] text-white hover:bg-white/20 disabled:opacity-40"
            >
              Unlock
            </button>
            <span className="min-w-0 flex-1 truncate text-[10px] text-zinc-500">
              {pinError || 'Set in the dashboard, Project Settings → Agent.'}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
