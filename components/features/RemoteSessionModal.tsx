'use client'

// Open an interactive session on a project's CLOUD agent.
//
// The cockpit normally drives LOCAL PTYs; this is the inverse — it lists the
// online agents (daemons on customer VMs / self-host) for a hosted project and
// streams a live interactive PTY from the chosen one into an xterm here. The
// wire protocol is relayed by server.ts (remote:* events) onto the hosted WS
// channel agent:project-{id}, authenticated with the cockpit's oclt_ token.

import { useState, useEffect, useRef, useCallback } from 'react'
import { X, Server, RefreshCw, Loader2, Play, Circle, Square, LogOut, Terminal as TerminalIcon, ChevronLeft } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import type { Socket } from 'socket.io-client'
import type { HostedAuth } from '@/hooks/useHostedAuth'

interface RemoteAgent {
  id: string
  name: string
  online: boolean
  lastSeen: string | null
  host: string | null
  cli: string | null
  cwd: string | null
}

const TERM_THEME = {
  background: 'rgba(0,0,0,0)',
  foreground: '#e4e4e7',
  cursor: '#22c55e',
  selectionBackground: 'rgba(34,197,94,0.25)',
  black: '#18181b', red: '#f87171', green: '#4ade80', yellow: '#fbbf24',
  blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#e4e4e7',
}

const MONO = '"Geist Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace'

function relativeTime(iso: string | null): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0 || Number.isNaN(ms)) return 'just now'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function RemoteSessionModal({
  socket,
  auth,
  onClose,
}: {
  socket: Socket | null
  auth: HostedAuth
  onClose: () => void
}) {
  const projects = auth.projects || []
  const [projectId, setProjectId] = useState<string>(projects.length === 1 ? projects[0].id : '')
  const [agents, setAgents] = useState<RemoteAgent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Live session state
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [status, setStatus] = useState<string>('')
  const [activeAgent, setActiveAgent] = useState<RemoteAgent | null>(null)

  const termHostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<import('@xterm/xterm').Terminal | null>(null)
  const fitRef = useRef<import('@xterm/addon-fit').FitAddon | null>(null)
  const sessionIdRef = useRef<string | null>(null)

  const listAgents = useCallback((pid: string) => {
    if (!socket || !pid) return
    setLoading(true)
    setError(null)
    socket.emit('remote:list-agents', { apiUrl: auth.apiUrl, token: auth.token, projectId: pid }, (r: any) => {
      setLoading(false)
      if (!r?.ok) { setError(r?.error || 'Failed to list agents'); setAgents([]); return }
      // Online first, then by most-recent heartbeat.
      const sorted = [...(r.agents || [])].sort((a: RemoteAgent, b: RemoteAgent) => {
        if (a.online !== b.online) return a.online ? -1 : 1
        return (new Date(b.lastSeen || 0).getTime()) - (new Date(a.lastSeen || 0).getTime())
      })
      setAgents(sorted)
    })
  }, [socket, auth.apiUrl, auth.token])

  useEffect(() => {
    if (projectId) listAgents(projectId)
  }, [projectId, listAgents])

  // ── Live PTY wiring ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!sessionId || !socket) return
    const sock = socket
    let disposed = false

    async function init() {
      const { Terminal } = await import('@xterm/xterm')
      const { FitAddon } = await import('@xterm/addon-fit')
      try { await document.fonts?.ready } catch {}
      if (disposed || !termHostRef.current) return

      const term = new Terminal({
        theme: TERM_THEME,
        allowTransparency: true,
        fontFamily: MONO,
        fontSize: 13,
        lineHeight: 1.15,
        cursorBlink: true,
        cursorStyle: 'bar',
        scrollback: 5000,
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(termHostRef.current)
      try { fit.fit() } catch {}
      term.focus()
      termRef.current = term
      fitRef.current = fit

      term.onData((d) => {
        if (sessionIdRef.current) sock.emit('remote:input', { sessionId: sessionIdRef.current, input: d })
      })

      let t: ReturnType<typeof setTimeout> | undefined
      const ro = new ResizeObserver(() => {
        try { fit.fit() } catch {}
        clearTimeout(t)
        t = setTimeout(() => {
          if (sessionIdRef.current) sock.emit('remote:resize', { sessionId: sessionIdRef.current, cols: term.cols, rows: term.rows })
        }, 120)
      })
      if (termHostRef.current) ro.observe(termHostRef.current)
      ;(term as any).__ro = ro
    }
    init()

    return () => {
      disposed = true
      const term = termRef.current
      const ro = (term as any)?.__ro as ResizeObserver | undefined
      try { ro?.disconnect() } catch {}
      try { term?.dispose() } catch {}
      termRef.current = null
      fitRef.current = null
    }
  }, [sessionId, socket])

  // Cloud → terminal stream
  useEffect(() => {
    if (!socket) return
    const onOutput = (p: { sessionId: string; data: string }) => {
      if (p.sessionId !== sessionIdRef.current) return
      termRef.current?.write(p.data)
    }
    const onStarted = (p: { sessionId: string; cliType?: string; workingDirectory?: string }) => {
      if (p.sessionId !== sessionIdRef.current) return
      setStarting(false)
      setStatus(`live${p.cliType ? ` · ${p.cliType}` : ''}${p.workingDirectory ? ` · ${p.workingDirectory}` : ''}`)
      // Push our real size now that the PTY exists.
      const term = termRef.current
      if (term) socket.emit('remote:resize', { sessionId: p.sessionId, cols: term.cols, rows: term.rows })
    }
    const onEnded = (p: { sessionId: string; exitCode?: number }) => {
      if (p.sessionId !== sessionIdRef.current) return
      termRef.current?.write(`\r\n\x1b[33m[session ended${p.exitCode != null ? ` · exit ${p.exitCode}` : ''}]\x1b[0m\r\n`)
      setStatus('ended')
      setStarting(false)
    }
    const onError = (p: { sessionId: string; error: string }) => {
      if (p.sessionId !== sessionIdRef.current) return
      termRef.current?.write(`\r\n\x1b[31m[error] ${p.error}\x1b[0m\r\n`)
      setStarting(false)
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
    }
  }, [socket])

  const startSession = (agent: RemoteAgent) => {
    if (!socket || !projectId || starting) return
    setStarting(true)
    setActiveAgent(agent)
    setStatus('starting…')
    const cols = 120, rows = 34
    socket.emit('remote:start', {
      apiUrl: auth.apiUrl, token: auth.token, projectId, cols, rows, targetAgentTokenId: agent.id,
    }, (r: any) => {
      if (!r?.ok) { setError(r?.error || 'Failed to start'); setStarting(false); setActiveAgent(null); setStatus(''); return }
      sessionIdRef.current = r.sessionId
      setSessionId(r.sessionId)
      // Safety: if no session:started within 15s, surface a hint.
      setTimeout(() => {
        if (sessionIdRef.current === r.sessionId && starting) {
          termRef.current?.write(`\r\n\x1b[33m[waiting] agent hasn't responded — it may be offline or busy.\x1b[0m\r\n`)
        }
      }, 15000)
    })
  }

  const detach = () => {
    if (sessionIdRef.current) socket?.emit('remote:detach', { sessionId: sessionIdRef.current })
    resetSession()
  }
  const endSession = () => {
    if (sessionIdRef.current) socket?.emit('remote:end', { sessionId: sessionIdRef.current })
    resetSession()
  }
  const resetSession = () => {
    sessionIdRef.current = null
    setSessionId(null)
    setActiveAgent(null)
    setStatus('')
    setStarting(false)
  }

  // Detach (keep PTY alive) if the modal is closed mid-session.
  const handleClose = () => {
    if (sessionIdRef.current) socket?.emit('remote:detach', { sessionId: sessionIdRef.current })
    onClose()
  }

  const inSession = !!sessionId

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={handleClose}>
      <div
        className="flex h-[80vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-950 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
          {inSession && (
            <button onClick={detach} className="rounded-lg p-1 text-zinc-400 hover:bg-white/10 hover:text-white" title="Back to agents (keeps session alive)">
              <ChevronLeft className="h-4 w-4" />
            </button>
          )}
          <Server className="h-4 w-4 text-emerald-400" />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-white">Remote interactive session</h2>
            <p className="truncate text-[11px] text-zinc-500">
              {inSession
                ? `${activeAgent?.name || 'agent'}${status ? ` — ${status}` : ''}`
                : 'Open a session on a cloud agent for a hosted project'}
            </p>
          </div>
          {inSession && (
            <>
              <button onClick={detach} className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-white/10" title="Detach — leave the PTY running on the agent">
                <LogOut className="h-3.5 w-3.5" /> Detach
              </button>
              <button onClick={endSession} className="flex items-center gap-1 rounded-lg border border-red-500/25 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-300 hover:bg-red-500/20" title="End the remote session">
                <Square className="h-3.5 w-3.5" /> End
              </button>
            </>
          )}
          <button onClick={handleClose} className="rounded-lg p-1 text-zinc-400 hover:bg-white/10 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        {inSession ? (
          <div className="min-h-0 flex-1 bg-black/40 p-2">
            <div ref={termHostRef} className="h-full w-full" />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col p-4">
            {/* Project selector */}
            <div className="mb-3 flex items-center gap-2">
              <label className="text-[11px] uppercase tracking-wider text-zinc-500">Project</label>
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-sm text-zinc-200 outline-none"
              >
                <option value="" className="bg-zinc-900">Select a project…</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id} className="bg-zinc-900">{p.name}</option>
                ))}
              </select>
              <button
                onClick={() => projectId && listAgents(projectId)}
                disabled={!projectId || loading}
                className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-zinc-400 hover:bg-white/10 hover:text-white disabled:opacity-40"
                title="Refresh agents"
              >
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>

            {/* Agent list */}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {!projectId ? (
                <Empty>Select a project to see its cloud agents.</Empty>
              ) : loading && agents.length === 0 ? (
                <Empty><Loader2 className="mr-1.5 inline h-3.5 w-3.5 animate-spin" /> Loading agents…</Empty>
              ) : error ? (
                <Empty className="text-red-400">{error}</Empty>
              ) : agents.length === 0 ? (
                <Empty>No agents registered for this project. Install orquesta-agent on the machine you want to reach.</Empty>
              ) : (
                <div className="space-y-1.5">
                  {agents.map((a) => (
                    <div key={a.id} className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5">
                      <Circle className={`h-2.5 w-2.5 shrink-0 ${a.online ? 'fill-emerald-400 text-emerald-400' : 'fill-zinc-600 text-zinc-600'}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm text-zinc-100">{a.name}</span>
                          {a.cli && <span className="shrink-0 rounded bg-white/5 px-1.5 py-px text-[9px] uppercase text-zinc-400">{a.cli}</span>}
                        </div>
                        <p className="truncate text-[10px] text-zinc-500">
                          {a.host ? `${a.host} · ` : ''}{a.cwd ? `${a.cwd} · ` : ''}{a.online ? 'online' : `seen ${relativeTime(a.lastSeen)}`}
                        </p>
                      </div>
                      <button
                        onClick={() => startSession(a)}
                        disabled={!a.online || starting}
                        className="flex shrink-0 items-center gap-1 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                        title={a.online ? 'Open an interactive session on this agent' : 'Agent is offline'}
                      >
                        {starting && activeAgent?.id === a.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                        Open
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <p className="mt-3 flex items-center gap-1.5 text-[10px] text-zinc-600">
              <TerminalIcon className="h-3 w-3" />
              Sessions run on the agent&apos;s machine and stream here live. Closing this dialog detaches but keeps the session running.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function Empty({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`py-12 text-center text-[13px] text-zinc-500 ${className}`}>{children}</div>
}
