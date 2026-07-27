'use client'

// Pick a project's CLOUD agent to open a session on.
//
// The cockpit normally drives LOCAL PTYs; a remote session is the inverse — a
// daemon on a customer VM / self-host streams a live interactive PTY here. This
// dialog is only the PICKER: choosing an agent hands it to the grid, which
// opens it as a normal pane in the main workspace (see RemoteCell). The wire
// protocol is relayed by server.ts (remote:* events) onto the hosted WS channel
// agent:project-{id}, authenticated with the cockpit's oclt_ token.

import { useState, useEffect, useCallback } from 'react'
import { X, Server, RefreshCw, Loader2, Play, Circle, Terminal as TerminalIcon } from 'lucide-react'
import type { TauriHandle } from '@/hooks/useTauri'
import type { HostedAuth } from '@/hooks/useHostedAuth'
import type { RemoteTarget } from './RemoteCell'

interface RemoteAgent {
  id: string
  name: string
  online: boolean
  lastSeen: string | null
  host: string | null
  cli: string | null
  cwd: string | null
}

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
  onOpen,
  onClose,
}: {
  socket: TauriHandle | null
  auth: HostedAuth
  /** Hand the chosen agent to the grid — it becomes a pane in the workspace. */
  onOpen: (target: RemoteTarget) => void
  onClose: () => void
}) {
  const projects = auth.projects || []
  const [projectId, setProjectId] = useState<string>(projects.length === 1 ? projects[0].id : '')
  const [agents, setAgents] = useState<RemoteAgent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const listAgents = useCallback((pid: string) => {
    if (!socket || !pid) return
    setLoading(true)
    setError(null)
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke('remote_list_agents', { apiUrl: auth.apiUrl, token: auth.token, projectId: pid }).then((r: any) => {
        setLoading(false)
        if (!r?.ok) { setError(r?.error || 'Failed to list agents'); setAgents([]); return }
        // Online first, then by most-recent heartbeat.
        const sorted = [...(r.agents || [])].sort((a: RemoteAgent, b: RemoteAgent) => {
          if (a.online !== b.online) return a.online ? -1 : 1
          return (new Date(b.lastSeen || 0).getTime()) - (new Date(a.lastSeen || 0).getTime())
        })
        setAgents(sorted)
      }).catch((e: unknown) => {
        setLoading(false)
        // The Rust side already turns HTTP failures into a readable sentence;
        // only a transport-level problem reaches here.
        setError(typeof e === 'string' && e ? e : e instanceof Error ? e.message : 'Failed to list agents')
      })
    })
  }, [socket, auth.apiUrl, auth.token])

  useEffect(() => {
    if (projectId) listAgents(projectId)
  }, [projectId, listAgents])

  const open = (a: RemoteAgent) => {
    if (!projectId) return
    onOpen({ agentId: a.id, agentName: a.name, projectId, host: a.host, cli: a.cli })
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-950 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
          <Server className="h-4 w-4 text-white" />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-white">Open a remote terminal</h2>
            <p className="truncate text-[11px] text-zinc-500">
              Pick a cloud agent — it opens as a pane in the workspace
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-zinc-400 hover:bg-white/10 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
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
                      onClick={() => open(a)}
                      disabled={!a.online}
                      className="flex shrink-0 items-center gap-1 rounded-lg border border-white/25 bg-white/10 px-3 py-1.5 text-xs text-white transition-colors hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
                      title={a.online ? 'Open this agent as a terminal pane' : 'Agent is offline'}
                    >
                      <Play className="h-3.5 w-3.5" />
                      Open
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <p className="mt-3 flex items-center gap-1.5 text-[10px] text-zinc-600">
            <TerminalIcon className="h-3 w-3" />
            Sessions run on the agent&apos;s machine and stream into the pane. Closing the pane detaches but keeps the session running.
          </p>
        </div>
      </div>
    </div>
  )
}

function Empty({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`py-12 text-center text-[13px] text-zinc-500 ${className}`}>{children}</div>
}
