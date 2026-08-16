'use client'

// ── Remote terminal pane ─────────────────────────────────────────────────────
// A grid pane whose PTY lives on a CLOUD agent instead of this machine. The
// local panes talk `session:*` to the local agent; this one talks `remote:*`,
// relayed onto the hosted WS channel for the pane's project. Everything else —
// geometry, drag, arrange, the left rail — is the grid's, so a remote session
// behaves exactly like any other terminal once it's open.
//
// Remote panes wear WHITE chrome so they're never confused with local ones.

import { useCallback, useEffect, useRef, useState } from 'react'
import { X, Server, LogOut, Square, Pencil, Loader2 } from 'lucide-react'
import type { TauriHandle } from '@/hooks/useTauri'
import { attachRenderer } from '@/lib/xterm-renderer'
import '@xterm/xterm/css/xterm.css'

/** The cloud agent a remote pane is attached to. */
export interface RemoteTarget {
  /** Agent token id — what remote_start targets. */
  agentId: string
  agentName: string
  projectId: string
  host?: string | null
  cli?: string | null
}

/** Accent for every remote surface (pane chrome, sidebar row, dock tile). */
export const REMOTE_ACCENT = '#f5f7fa'

const REMOTE_TERM_THEME = {
  background: 'transparent',
  foreground: '#f5f7fa',
  cursor: '#ffffff',
  cursorAccent: '#0a0c10',
  selectionBackground: 'rgba(245, 247, 250, 0.25)',
  black: '#0a0c10',
  red: '#ff6b6b',
  green: '#14c48a',
  yellow: '#f2c94c',
  blue: '#4c8dff',
  magenta: '#b892ff',
  cyan: '#3bc9db',
  white: '#e8ebf1',
  brightBlack: '#6b7280',
  brightRed: '#ff8787',
  brightGreen: '#34d399',
  brightYellow: '#ffd866',
  brightBlue: '#74a8ff',
  brightMagenta: '#d0bcff',
  brightCyan: '#66d9e8',
  brightWhite: '#ffffff',
}

const MONO = '"Geist Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace'

export interface RemoteCellApi {
  clear: () => void
  fit: () => void
  focus: () => void
  seed: (text: string) => void
  run: (text: string) => boolean
  tail: () => string
}

export function RemoteCell({
  cellId, socket, target, name, fontSize, opacity, apiUrl, token,
  attention, onClose, onRename, onFocusCell, onActivity, onFinished, registerApi,
}: {
  cellId: string
  socket: TauriHandle | null
  target: RemoteTarget
  name: string
  fontSize: number
  /** 0..1 — pane translucency so the wallpaper shows through. */
  opacity: number
  apiUrl?: string
  token?: string
  attention?: boolean
  onClose: () => void
  onRename: (v: string) => void
  onFocusCell: () => void
  onActivity: () => void
  onFinished: () => void
  registerApi: (api: RemoteCellApi | null) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<import('@xterm/xterm').Terminal | null>(null)
  const fitRef = useRef<import('@xterm/addon-fit').FitAddon | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const startedRef = useRef(false)
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [status, setStatus] = useState<'starting' | 'live' | 'ended' | 'error'>('starting')
  // Mirror of `status` for callbacks created before a state change lands (the
  // 15s "agent never answered" timer reads it from its own closure).
  const statusRef = useRef(status)
  statusRef.current = status
  const [detail, setDetail] = useState<string>('')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)

  const displayName = name || target.agentName

  // ── xterm mount ───────────────────────────────────────────────────────────
  useEffect(() => {
    let disposed = false
    let ro: ResizeObserver | null = null

    async function init() {
      const { Terminal } = await import('@xterm/xterm')
      const { FitAddon } = await import('@xterm/addon-fit')
      try { await document.fonts?.ready } catch {}
      if (disposed || !hostRef.current) return

      const term = new Terminal({
        theme: REMOTE_TERM_THEME,
        allowTransparency: true,
        fontFamily: MONO,
        fontSize,
        lineHeight: 1.15,
        cursorBlink: true,
        cursorStyle: 'bar',
        scrollback: 5000,
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(hostRef.current)
      // Same GPU/canvas upgrade the local panes get — a mirrored remote agent
      // repaints just as often as a local one.
      void attachRenderer(term)
      try { fit.fit() } catch {}
      termRef.current = term
      fitRef.current = fit

      term.onData((d) => {
        const sid = sessionIdRef.current
        if (sid && socket) socket.emit('remote:input', { sessionId: sid, input: d })
      })

      let t: ReturnType<typeof setTimeout> | undefined
      ro = new ResizeObserver(() => {
        try { fit.fit() } catch {}
        clearTimeout(t)
        t = setTimeout(() => {
          const sid = sessionIdRef.current
          if (sid && socket) socket.emit('remote:resize', { sessionId: sid, cols: term.cols, rows: term.rows })
        }, 120)
      })
      ro.observe(hostRef.current)
    }
    init()

    return () => {
      disposed = true
      try { ro?.disconnect() } catch {}
      try { termRef.current?.dispose() } catch {}
      termRef.current = null
      fitRef.current = null
    }
    // Mount once per pane — font size is applied live below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellId, socket])

  // Live font-size changes (⌘+/⌘-) without remounting the terminal.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontSize = fontSize
    try { fitRef.current?.fit() } catch {}
  }, [fontSize])

  // ── Start the remote session (once) ───────────────────────────────────────
  useEffect(() => {
    if (startedRef.current) return
    if (!socket || !apiUrl || !token) return
    startedRef.current = true
    setStatus('starting')
    setDetail('starting…')
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke('remote_start', {
        apiUrl, token, projectId: target.projectId, cols: 120, rows: 34,
        targetAgentTokenId: target.agentId,
      }).then((r: unknown) => {
        const res = r as { ok?: boolean; sessionId?: string; error?: string }
        if (!res?.ok || !res.sessionId) {
          setStatus('error')
          setDetail(res?.error || 'Failed to start')
          termRef.current?.write(`\r\n\x1b[31m[error] ${res?.error || 'failed to start remote session'}\x1b[0m\r\n`)
          return
        }
        sessionIdRef.current = res.sessionId
        setTimeout(() => {
          // The agent never answered — say so instead of leaving a blank pane.
          if (sessionIdRef.current === res.sessionId && statusRef.current === 'starting') {
            termRef.current?.write(`\r\n\x1b[33m[waiting] agent hasn't responded — it may be offline or busy.\x1b[0m\r\n`)
          }
        }, 15000)
      }).catch((e: unknown) => {
        // Rust already phrases connection failures; pass them through.
        const msg = typeof e === 'string' && e ? e : e instanceof Error ? e.message : 'Failed to start remote session'
        setStatus('error')
        setDetail(msg)
        termRef.current?.write(`\r\n\x1b[31m[error] ${msg}\x1b[0m\r\n`)
      })
    })
  }, [socket, apiUrl, token, target.projectId, target.agentId])

  // ── Cloud → terminal stream ───────────────────────────────────────────────
  useEffect(() => {
    if (!socket) return
    const markBusy = () => {
      onActivity()
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
      idleTimerRef.current = setTimeout(() => { onFinished() }, 2500)
    }
    const onOutput = (p: { sessionId: string; data: string }) => {
      if (p.sessionId !== sessionIdRef.current) return
      termRef.current?.write(p.data)
      markBusy()
    }
    const onStarted = (p: { sessionId: string; cliType?: string; workingDirectory?: string }) => {
      if (p.sessionId !== sessionIdRef.current) return
      setStatus('live')
      setDetail([p.cliType, p.workingDirectory].filter(Boolean).join(' · '))
      const term = termRef.current
      if (term) socket.emit('remote:resize', { sessionId: p.sessionId, cols: term.cols, rows: term.rows })
    }
    const onEnded = (p: { sessionId: string; exitCode?: number }) => {
      if (p.sessionId !== sessionIdRef.current) return
      termRef.current?.write(`\r\n\x1b[33m[session ended${p.exitCode != null ? ` · exit ${p.exitCode}` : ''}]\x1b[0m\r\n`)
      setStatus('ended')
      setDetail('')
      sessionIdRef.current = null
    }
    const onError = (p: { sessionId: string; error: string }) => {
      if (p.sessionId !== sessionIdRef.current) return
      termRef.current?.write(`\r\n\x1b[31m[error] ${p.error}\x1b[0m\r\n`)
      setStatus('error')
      setDetail(p.error)
    }
    socket.on('remote:output', onOutput)
    socket.on('remote:started', onStarted)
    socket.on('remote:ended', onEnded)
    socket.on('remote:error', onError)
    return () => {
      socket.off('remote:output', onOutput)
      socket.off('remote:started', onStarted)
      socket.off('remote:ended', onEnded)
      socket.off('remote:error', onError)
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
    }
  }, [socket, onActivity, onFinished])

  // Closing the pane detaches (the PTY keeps running on the agent) — same
  // contract the old modal had, so nothing is killed by accident.
  useEffect(() => {
    return () => {
      const sid = sessionIdRef.current
      if (sid && socket) socket.emit('remote:detach', { sessionId: sid })
      sessionIdRef.current = null
    }
  }, [socket])

  // ── Pane API (arrange/focus/dispatch all go through this) ─────────────────
  const seed = useCallback((text: string) => {
    const sid = sessionIdRef.current
    if (!sid || !socket || !text) return
    socket.emit('remote:input', { sessionId: sid, input: `\x1b[200~${text}\x1b[201~` })
    try { termRef.current?.focus() } catch {}
  }, [socket])

  useEffect(() => {
    registerApi({
      clear: () => termRef.current?.clear(),
      fit: () => { try { fitRef.current?.fit() } catch {} },
      focus: () => { try { termRef.current?.focus() } catch {} },
      seed,
      run: (text: string) => {
        const sid = sessionIdRef.current
        if (!sid || !socket || !text) return false
        seed(text)
        setTimeout(() => socket.emit('remote:input', { sessionId: sid, input: '\r' }), 60)
        return true
      },
      tail: () => {
        const term = termRef.current
        if (!term) return ''
        const buf = term.buffer.active
        const lines: string[] = []
        for (let i = 0; i < buf.length; i++) {
          lines.push(buf.getLine(i)?.translateToString(true) ?? '')
        }
        return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
      },
    })
    return () => registerApi(null)
  }, [registerApi, seed, socket])

  const detach = () => {
    const sid = sessionIdRef.current
    if (sid && socket) socket.emit('remote:detach', { sessionId: sid })
    sessionIdRef.current = null
    setStatus('ended')
    termRef.current?.write(`\r\n\x1b[37m[detached — the session keeps running on the agent]\x1b[0m\r\n`)
  }
  const end = () => {
    const sid = sessionIdRef.current
    if (sid && socket) socket.emit('remote:end', { sessionId: sid })
    sessionIdRef.current = null
    setStatus('ended')
  }

  const commitRename = () => {
    setEditing(false)
    const v = draft.trim()
    if (v !== name) onRename(v)
  }

  return (
    <div
      className={`flex h-full flex-col overflow-hidden rounded-md border backdrop-blur-sm ${
        attention ? 'border-white ring-1 ring-white/50' : 'border-white/45'
      }`}
      style={{ backgroundColor: `rgba(10, 12, 16, ${opacity})` }}
      onMouseDown={onFocusCell}
    >
      <div className="drag-handle flex cursor-grab items-center justify-between gap-2 border-b border-white/25 bg-white/[0.06] px-2.5 py-1.5 active:cursor-grabbing">
        <div className="flex min-w-0 items-center gap-2">
          <Server className="h-3.5 w-3.5 shrink-0 text-white" />
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
              placeholder={target.agentName}
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
            Remote
          </span>
          {target.host && (
            <span className="max-w-[8rem] truncate text-[10px] font-mono text-white/50" title={target.host}>
              {target.host}
            </span>
          )}
          <span className="flex shrink-0 items-center gap-1 text-[10px] font-mono text-white/60" title={detail || status}>
            {status === 'starting' ? (
              <><Loader2 className="h-3 w-3 animate-spin" /> starting…</>
            ) : status === 'live' ? (
              <><span className="h-1.5 w-1.5 rounded-full bg-white" /> live</>
            ) : status === 'error' ? (
              <span className="text-red-300">error</span>
            ) : (
              <span className="text-white/40">ended</span>
            )}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {status === 'live' && (
            <>
              <button
                onClick={detach}
                onMouseDown={(e) => e.stopPropagation()}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono text-white/70 hover:bg-white/10 hover:text-white"
                title="Detach — leave the session running on the agent"
              >
                <LogOut className="h-3 w-3" /> Detach
              </button>
              <button
                onClick={end}
                onMouseDown={(e) => e.stopPropagation()}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono text-red-300 hover:bg-red-500/15"
                title="End the remote session"
              >
                <Square className="h-3 w-3" /> End
              </button>
            </>
          )}
          <button
            onClick={onClose}
            onMouseDown={(e) => e.stopPropagation()}
            className="text-white/50 hover:text-white"
            title="Close pane (detaches, keeps it running)"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div ref={hostRef} className="absolute inset-0 h-full overflow-hidden px-1 pb-0 pt-1" />
      </div>
    </div>
  )
}
