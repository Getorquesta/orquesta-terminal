'use client'

// Compact hosted panels for the per-terminal rail (TerminalSidebar): team chat
// and cross-project coordination. These are intentionally self-contained (not
// shared with the wider global-sidebar versions in app/page.tsx) so the rail
// can stay lean at ~268px and the proven global sidebar carries zero regression
// risk. All hosted access goes through /api/hosted/proxy with the oclt_ token.

import { useState, useEffect, useCallback, useRef } from 'react'
import { Loader2, Send, RefreshCw, Radio, ExternalLink } from 'lucide-react'

async function proxy<T>(apiUrl: string, token: string, path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch('/api/hosted/proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: `${apiUrl}${path}`, token, method, body }),
  })
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error((d as { error?: string }).error || `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

// ── Team chat ──────────────────────────────────────────────────────────────

interface ChatAuthor { id?: string; full_name: string | null; email: string | null }
interface ChatMessage {
  id: string
  author_id: string
  content: string
  created_at: string
  author?: ChatAuthor
}

function displayName(a?: ChatAuthor, fallbackId?: string): string {
  return a?.full_name || a?.email?.split('@')[0] || (fallbackId ? `user-${fallbackId.slice(0, 4)}` : 'Unknown')
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '?'
}

function hue(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360
  return h
}

export function RailChat({ apiUrl, token, projectId }: { apiUrl: string; token: string; projectId: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)

  const load = useCallback(async () => {
    if (!projectId || !token) return
    try {
      const data = await proxy<{ messages?: ChatMessage[]; currentUserId?: string }>(
        apiUrl, token, `/api/orquesta-cli/projects/${projectId}/chat?limit=50`,
      )
      setMessages(data.messages || [])
      if (data.currentUserId) setCurrentUserId(data.currentUserId)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [apiUrl, token, projectId])

  useEffect(() => {
    setLoading(true)
    setMessages([])
    load()
    const t = setInterval(load, 4000)
    return () => clearInterval(t)
  }, [load])

  useEffect(() => {
    if (atBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  const send = useCallback(async () => {
    const content = input.trim()
    if (!content || sending) return
    setSending(true)
    atBottomRef.current = true
    try {
      const created = await proxy<ChatMessage>(
        apiUrl, token, `/api/orquesta-cli/projects/${projectId}/chat`, 'POST', { content },
      )
      setInput('')
      setMessages(prev => (prev.some(m => m.id === created.id) ? prev : [...prev, created]))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send')
    } finally {
      setSending(false)
    }
  }, [input, sending, apiUrl, token, projectId])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {loading && messages.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-[11px] text-zinc-500">
            <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> Loading…
          </div>
        ) : error && messages.length === 0 ? (
          <div className="py-6 text-center text-[11px] text-red-400">{error}</div>
        ) : messages.length === 0 ? (
          <div className="py-10 text-center text-[11px] text-zinc-500">No messages yet. Say hi 👋</div>
        ) : (
          messages.map(m => {
            const mine = currentUserId != null && m.author_id === currentUserId
            const name = mine ? 'You' : displayName(m.author, m.author_id)
            return (
              <div key={m.id} className={`flex items-end gap-1.5 ${mine ? 'flex-row-reverse' : ''}`}>
                {!mine && (
                  <div
                    className="mb-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[8px] font-semibold text-white"
                    style={{ backgroundColor: `hsl(${hue(m.author_id)} 45% 40%)` }}
                    title={name}
                  >
                    {initials(name)}
                  </div>
                )}
                <div className={`flex min-w-0 flex-col ${mine ? 'items-end' : 'items-start'}`}>
                  {!mine && <span className="px-0.5 text-[9px] font-semibold text-zinc-400">{name}</span>}
                  <div className={`max-w-full whitespace-pre-wrap break-words rounded-xl px-2 py-1 text-[11px] leading-snug ${
                    mine ? 'rounded-br-sm bg-green-600/25 text-green-50' : 'rounded-bl-sm bg-zinc-800 text-zinc-200'
                  }`}>
                    {m.content}
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>
      <div className="border-t border-zinc-800 p-1.5">
        {error && messages.length > 0 && <div className="mb-1 text-[9px] text-red-400">{error}</div>}
        <div className="flex items-end gap-1.5">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
            placeholder="Message the team…"
            rows={1}
            className="max-h-20 flex-1 resize-none rounded-lg bg-zinc-800 px-2 py-1.5 text-[11px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:ring-1 focus:ring-green-600/40"
          />
          <button
            onClick={send}
            disabled={!input.trim() || sending}
            className="rounded-lg bg-green-600/80 p-1.5 text-white transition-colors hover:bg-green-600 disabled:cursor-not-allowed disabled:opacity-40"
            title="Send"
          >
            {sending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Coordination ─────────────────────────────────────────────────────────────

interface CoordChannel {
  id: string
  name: string
  participant_project_names?: string[]
  cross_project?: boolean
}

export function RailCoordination({
  apiUrl, token, projectId,
}: { apiUrl: string; token: string; projectId: string }) {
  const [channels, setChannels] = useState<CoordChannel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pinging, setPinging] = useState<string | null>(null)
  const [pingStatus, setPingStatus] = useState<{ id: string; msg: string; ok: boolean } | null>(null)

  const load = useCallback(async () => {
    if (!projectId || !token) return
    try {
      const data = await proxy<{ channels?: CoordChannel[] }>(
        apiUrl, token, `/api/projects/${projectId}/coordination/channels`,
      )
      if (Array.isArray(data.channels)) setChannels(data.channels)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [apiUrl, token, projectId])

  useEffect(() => { setLoading(true); load() }, [load])

  const ping = async (channelId: string) => {
    setPinging(channelId)
    setPingStatus(null)
    try {
      const data = await proxy<{ dispatched?: unknown[] }>(
        apiUrl, token, `/api/projects/${projectId}/coordination/channels/${channelId}/ping`, 'POST',
      )
      const n = Array.isArray(data.dispatched) ? data.dispatched.length : 0
      setPingStatus({ id: channelId, msg: `Pinged ${n} peer${n === 1 ? '' : 's'}`, ok: true })
    } catch (e) {
      setPingStatus({ id: channelId, msg: e instanceof Error ? e.message : 'Failed', ok: false })
    } finally {
      setPinging(null)
      setTimeout(() => setPingStatus(null), 4000)
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Channels</span>
        <button
          onClick={() => { setLoading(true); load() }}
          className="rounded p-0.5 text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300"
          title="Refresh"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>
      {loading && channels.length === 0 ? (
        <div className="flex items-center justify-center py-8 text-[11px] text-zinc-500">
          <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> Loading…
        </div>
      ) : error ? (
        <div className="py-6 text-center text-[11px] text-red-400">{error}</div>
      ) : channels.length === 0 ? (
        <div className="py-8 text-center text-[11px] text-zinc-500">
          No coordination channels.
          <a
            href={`${apiUrl}/dashboard/projects/${projectId}?view=coordination`}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 block text-green-400/80 hover:underline"
          >
            Create one in the dashboard →
          </a>
        </div>
      ) : (
        <div className="space-y-1">
          {channels.map(c => (
            <div key={c.id} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2">
              <div className="mb-1 flex items-center gap-1.5">
                <Radio className="h-3 w-3 shrink-0 text-emerald-400" />
                <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-200">{c.name}</span>
                {c.cross_project && (
                  <span className="shrink-0 rounded bg-violet-500/15 px-1 py-px text-[8px] text-violet-300">cross</span>
                )}
                <a
                  href={`${apiUrl}/dashboard/projects/${projectId}?view=coordination&channel=${encodeURIComponent(c.id)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-zinc-600 hover:text-zinc-300"
                  title="Open in dashboard"
                >
                  <ExternalLink className="h-2.5 w-2.5" />
                </a>
              </div>
              {c.participant_project_names && c.participant_project_names.length > 0 && (
                <p className="mb-1.5 truncate text-[9px] text-zinc-500">
                  {c.participant_project_names.join(' · ')}
                </p>
              )}
              <button
                onClick={() => ping(c.id)}
                disabled={pinging === c.id}
                className="flex w-full items-center justify-center gap-1 rounded border border-emerald-500/25 bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
                title="Ping peer agents in this channel"
              >
                {pinging === c.id ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Radio className="h-2.5 w-2.5" />}
                Ping peers
              </button>
              {pingStatus && pingStatus.id === c.id && (
                <p className={`mt-1 text-center text-[9px] ${pingStatus.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                  {pingStatus.msg}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
