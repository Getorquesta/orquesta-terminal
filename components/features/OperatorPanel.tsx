'use client'

/**
 * Operator — chat with a hosted project's agent, the same conversations as
 * the dashboard's Home. Every message becomes one prompt on the project's
 * agent (wherever it runs: this machine, a VM, the managed cloud machine), and
 * messages of one chat share a Claude session on the agent side, so it
 * remembers the conversation.
 *
 * Talks to the oclt_-authed /api/orquesta-cli/projects/:id/operator routes
 * through the Rust proxy and polls: an oclt_ token has no realtime socket.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  X, Plus, Send, Loader2, Cloud, ChevronDown, ChevronRight, AlertCircle, Bot, ScrollText,
} from 'lucide-react'
import { hostedFetch } from '@/lib/tauri-proxy'
import type { HostedAuth } from '@/hooks/useHostedAuth'

interface Conversation {
  key: string
  kind: 'chat' | 'interactive' | 'terminal' | 'prompt'
  title: string
  lastAt: string
  count: number
  running: boolean
  failed: boolean
}

type Turn =
  | { kind: 'user'; promptId: string; author: { id: string; name: string }; text: string; at: string }
  | {
      kind: 'agent'
      promptId: string
      state: 'waiting' | 'running' | 'done' | 'failed' | 'cancelled'
      text: string | null
      cli: string | null
      model: string | null
      duration: string | null
      branch: string | null
      at: string | null
    }

interface OperatorState {
  project: { id: string; name: string; configured: boolean; agentOnline: boolean }
  me: { id: string; name: string }
  conversations: Conversation[]
  thread: Turn[]
}

interface LogRow { id: string; level: string; category: string; message: string; sequence: number }

const PROJECT_KEY = 'orquesta-operator-project'
const FAST_POLL_MS = 3000
const IDLE_POLL_MS = 15000

function readStored(key: string): string {
  try { return localStorage.getItem(key) || '' } catch { return '' }
}
function writeStored(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch { /* private mode */ }
}

function newChatId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function relTime(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

export function OperatorPanel({
  auth,
  connecting,
  onConnect,
  onClose,
}: {
  auth: HostedAuth | null
  connecting: boolean
  onConnect: () => void
  onClose: () => void
}) {
  if (!auth) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <button onClick={onClose} className="absolute right-4 top-4 rounded p-1 text-zinc-500 hover:bg-white/10 hover:text-white" title="Close">
          <X className="h-4 w-4" />
        </button>
        <Bot className="h-10 w-10 text-green-400" />
        <div>
          <h2 className="text-lg font-semibold text-white">Operator</h2>
          <p className="mt-1 max-w-sm text-sm text-zinc-400">
            Chat with your project&apos;s agent — it works on your code and answers here. Connect your Orquesta account to start.
          </p>
        </div>
        <button
          onClick={onConnect}
          disabled={connecting}
          className="flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-500 disabled:opacity-60"
        >
          {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Cloud className="h-4 w-4" />}
          Connect to Orquesta
        </button>
      </div>
    )
  }
  return <OperatorChat auth={auth} onClose={onClose} />
}

function OperatorChat({ auth, onClose }: { auth: HostedAuth; onClose: () => void }) {
  const [projectId, setProjectId] = useState(() => {
    const stored = readStored(PROJECT_KEY)
    return auth.projects.some(p => p.id === stored) ? stored : auth.projects[0]?.id || ''
  })
  // `c:<id>` of the open chat; a fresh id while composing a new chat.
  const [chatKey, setChatKey] = useState<string | null>(null)
  const [data, setData] = useState<OperatorState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [logsFor, setLogsFor] = useState<string | null>(null)
  const [logs, setLogs] = useState<LogRow[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const reqSeq = useRef(0)

  const base = `${auth.apiUrl}/api/orquesta-cli/projects/${projectId}/operator`

  const load = useCallback(async () => {
    if (!projectId) return
    const seq = ++reqSeq.current
    try {
      const qs = chatKey ? `?chat=${encodeURIComponent(chatKey)}` : ''
      const res = await hostedFetch<OperatorState>({ url: `${base}${qs}`, token: auth.token })
      if (seq !== reqSeq.current) return // a newer request (other chat/project) won
      setData(res)
      setError(null)
    } catch (e) {
      if (seq === reqSeq.current) setError(e instanceof Error ? e.message : String(e))
    }
  }, [base, chatKey, auth.token, projectId])

  const busy = useMemo(
    () => !!data?.thread.some(t => t.kind === 'agent' && (t.state === 'waiting' || t.state === 'running')),
    [data],
  )

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const id = setInterval(load, busy ? FAST_POLL_MS : IDLE_POLL_MS)
    return () => clearInterval(id)
  }, [load, busy])

  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'end' }) }, [data?.thread.length, chatKey])
  useEffect(() => { inputRef.current?.focus() }, [chatKey, projectId])

  const switchProject = (id: string) => {
    setProjectId(id)
    writeStored(PROJECT_KEY, id)
    setChatKey(null)
    setData(null)
  }

  const send = async () => {
    const content = draft.trim()
    if (!content || sending || !projectId) return
    const chatId = chatKey?.startsWith('c:') ? chatKey.slice(2) : newChatId()
    setSending(true)
    setError(null)
    try {
      await hostedFetch({ url: base, token: auth.token, method: 'POST', body: { content, chatId } })
      setDraft('')
      setChatKey(`c:${chatId}`)
      // setChatKey re-runs load via its deps; if the key did not change, load now.
      if (chatKey === `c:${chatId}`) await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }

  const toggleLogs = async (promptId: string) => {
    if (logsFor === promptId) { setLogsFor(null); return }
    setLogsFor(promptId)
    setLogs([])
    try {
      const res = await hostedFetch<{ logs: LogRow[] }>({
        url: `${base}/logs?promptId=${encodeURIComponent(promptId)}`,
        token: auth.token,
      })
      setLogs(res.logs || [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const chats = (data?.conversations || []).filter(c => c.kind === 'chat')
  const project = data?.project
  // Only a Home chat can be continued; other conversations open read-only.
  const canReply = !chatKey || chatKey.startsWith('c:')

  return (
    <div className="flex h-full">
      {/* Rail: project + chats */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-white/10 bg-zinc-900/80">
        <div className="space-y-2 border-b border-white/10 p-3">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-green-400" />
            <span className="text-sm font-semibold text-white">Operator</span>
          </div>
          {auth.projects.length > 1 ? (
            <div className="relative">
              <select
                value={projectId}
                onChange={e => switchProject(e.target.value)}
                className="w-full appearance-none truncate rounded-md bg-zinc-800 py-1.5 pl-2 pr-6 text-xs text-zinc-200 outline-none hover:bg-zinc-700"
              >
                {auth.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <ChevronDown className="pointer-events-none absolute right-1.5 top-2 h-3.5 w-3.5 text-zinc-500" />
            </div>
          ) : (
            <p className="truncate text-xs text-zinc-400">{auth.projects[0]?.name || 'No projects'}</p>
          )}
          <button
            onClick={() => { setChatKey(null); setDraft('') }}
            className="flex w-full items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-zinc-200 hover:bg-white/10"
          >
            <Plus className="h-3.5 w-3.5" /> New chat
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-1.5">
          {chats.length === 0 && (
            <p className="px-2 py-3 text-[11px] text-zinc-500">No chats yet.</p>
          )}
          {chats.map(c => (
            <button
              key={c.key}
              onClick={() => setChatKey(c.key)}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                chatKey === c.key ? 'bg-zinc-700/70 text-white' : 'text-zinc-300 hover:bg-white/5'
              }`}
            >
              <span className="flex-1 truncate">{c.title}</span>
              {c.running ? (
                <Loader2 className="h-3 w-3 shrink-0 animate-spin text-cyan-400" />
              ) : c.failed ? (
                <AlertCircle className="h-3 w-3 shrink-0 text-red-400" />
              ) : (
                <span className="shrink-0 font-mono text-[10px] text-zinc-500">{relTime(c.lastAt)}</span>
              )}
            </button>
          ))}
        </div>
      </aside>

      {/* Thread + composer */}
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2">
          <span className="truncate text-sm text-zinc-200">{project?.name || '…'}</span>
          {project && (
            <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] ${
              project.agentOnline ? 'bg-green-500/10 text-green-300' : 'bg-zinc-700/60 text-zinc-400'
            }`}>
              <span className={`h-1.5 w-1.5 rounded-full ${project.agentOnline ? 'bg-green-400' : 'bg-zinc-500'}`} />
              {project.agentOnline ? 'agent online' : 'agent offline'}
            </span>
          )}
          <div className="flex-1" />
          <button onClick={onClose} className="rounded p-1 text-zinc-500 hover:bg-white/10 hover:text-white" title="Back to terminals">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          <div className="mx-auto max-w-3xl space-y-4">
            {!chatKey && (
              <div className="py-16 text-center">
                <Bot className="mx-auto h-8 w-8 text-zinc-600" />
                <p className="mt-3 text-sm text-zinc-400">Ask the agent to build, fix or explain something in {project?.name || 'this project'}.</p>
                {project && !project.agentOnline && project.configured && (
                  <p className="mt-1 text-xs text-zinc-500">The agent is offline — your message waits until it reconnects.</p>
                )}
              </div>
            )}
            {(data?.thread || []).map(t =>
              t.kind === 'user' ? (
                <div key={`u-${t.promptId}`} className="flex justify-end">
                  <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-green-600/20 px-3 py-2 text-sm text-zinc-100">
                    {t.text}
                  </div>
                </div>
              ) : (
                <div key={`a-${t.promptId}`} className="space-y-1">
                  <div className="whitespace-pre-wrap break-words text-sm text-zinc-200">
                    {t.state === 'waiting' || t.state === 'running' ? (
                      <span className="flex items-center gap-2 text-zinc-400">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        {t.state === 'waiting' ? 'Waiting for the agent…' : 'Working…'}
                      </span>
                    ) : t.state === 'failed' ? (
                      <span className="text-red-300">{t.text || 'The agent could not finish this.'}</span>
                    ) : t.state === 'cancelled' ? (
                      <span className="text-zinc-500">Cancelled.</span>
                    ) : (
                      t.text || <span className="text-zinc-500">(no reply text)</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 font-mono text-[10px] text-zinc-500">
                    {[t.cli, t.model, t.duration, t.branch].filter(Boolean).join(' · ')}
                    <button
                      onClick={() => toggleLogs(t.promptId)}
                      className="flex items-center gap-0.5 rounded px-1 text-zinc-500 hover:bg-white/5 hover:text-zinc-300"
                    >
                      {logsFor === t.promptId ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                      <ScrollText className="h-3 w-3" /> logs
                    </button>
                  </div>
                  {logsFor === t.promptId && (
                    <pre className="max-h-72 overflow-auto rounded-md border border-white/10 bg-black/40 p-2 text-[11px] leading-relaxed text-zinc-400">
                      {logs.length
                        ? logs.map(l => `[${l.category}] ${l.message}`).join('\n')
                        : 'No logs yet.'}
                    </pre>
                  )}
                </div>
              ),
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        <div className="border-t border-white/10 p-3">
          <div className="mx-auto max-w-3xl">
            {error && <p className="mb-2 text-xs text-red-400">{error}</p>}
            {project && !project.configured ? (
              <p className="text-xs text-zinc-400">
                This project has no agent yet. Set one up from the dashboard (or start a local agent in a pane), then chat here.
              </p>
            ) : canReply ? (
              <div className="flex items-end gap-2 rounded-xl border border-white/10 bg-zinc-900 p-2 focus-within:border-green-600/50">
                <textarea
                  ref={inputRef}
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      send()
                    }
                  }}
                  rows={Math.min(8, Math.max(1, draft.split('\n').length))}
                  placeholder="Message the agent…  (Enter to send, Shift+Enter for a new line)"
                  className="flex-1 resize-none bg-transparent px-1 text-sm text-white outline-none placeholder:text-zinc-500"
                />
                <button
                  onClick={send}
                  disabled={!draft.trim() || sending}
                  className="flex h-8 w-8 items-center justify-center rounded-lg bg-green-600 text-white hover:bg-green-500 disabled:opacity-40"
                  title="Send"
                >
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </button>
              </div>
            ) : (
              <p className="text-xs text-zinc-500">This conversation is read-only here.</p>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
