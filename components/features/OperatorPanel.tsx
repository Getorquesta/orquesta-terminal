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

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  X, Send, Loader2, Cloud, ChevronDown, ChevronRight, AlertCircle, Bot, ScrollText,
  PanelLeftClose, PanelLeftOpen, ArrowDown, RotateCw, SquarePen,
} from 'lucide-react'
import { hostedFetch } from '@/lib/tauri-proxy'
import type { HostedAuth } from '@/hooks/useHostedAuth'
import { CopyButton, OperatorMarkdown } from '@/components/features/OperatorMarkdown'

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
const RAIL_KEY = 'orquesta-operator-rail'
const FAST_POLL_MS = 3000
const IDLE_POLL_MS = 15000
/** Below this panel width the chat rail becomes an overlay. */
const NARROW_PX = 720
/** How close to the bottom still counts as "following" the thread. */
const STICK_PX = 80

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

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function elapsed(fromIso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - new Date(fromIso).getTime()) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

function dayLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today.getTime() - 86400000)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}

/** Rail sections: Today / Yesterday / Earlier, in the server's newest-first order. */
function groupChats(chats: Conversation[]): Array<{ label: string; items: Conversation[] }> {
  const groups: Array<{ label: string; items: Conversation[] }> = []
  for (const c of chats) {
    const day = dayLabel(c.lastAt)
    const label = day === 'Today' || day === 'Yesterday' ? day : 'Earlier'
    const g = groups[groups.length - 1]
    if (g?.label === label) g.items.push(c)
    else groups.push({ label, items: [c] })
  }
  return groups
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
  // Which chat `data.thread` belongs to, so switching chats never shows the old thread.
  const [loadedKey, setLoadedKey] = useState<string | null | undefined>(undefined)
  const [pollError, setPollError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  // The message just sent, shown until the thread brings it back.
  const [pending, setPending] = useState<{ key: string; text: string } | null>(null)
  const [logsFor, setLogsFor] = useState<string | null>(null)
  const [logs, setLogs] = useState<LogRow[] | null>(null)
  const [narrow, setNarrow] = useState(false)
  const [railOpen, setRailOpen] = useState(() => readStored(RAIL_KEY) !== 'closed')
  const [stick, setStick] = useState(true)
  const [now, setNow] = useState(() => Date.now())
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
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
      setLoadedKey(chatKey)
      setPollError(null)
    } catch (e) {
      if (seq === reqSeq.current) setPollError(e instanceof Error ? e.message : String(e))
    }
  }, [base, chatKey, auth.token, projectId])

  const thread = loadedKey === chatKey ? data?.thread || [] : []
  const threadLoading = !!chatKey && loadedKey !== chatKey
  const busy = useMemo(
    () => thread.some(t => t.kind === 'agent' && (t.state === 'waiting' || t.state === 'running')),
    [thread],
  )

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const id = setInterval(load, busy ? FAST_POLL_MS : IDLE_POLL_MS)
    return () => clearInterval(id)
  }, [load, busy])

  // Tick the "Working… 42s" timer only while something runs.
  useEffect(() => {
    if (!busy) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [busy])

  // Drop the optimistic bubble once the server's thread carries the message.
  useEffect(() => {
    if (pending && loadedKey === pending.key && thread.some(t => t.kind === 'user' && t.text.trim() === pending.text)) {
      setPending(null)
    }
  }, [thread, loadedKey, pending])

  // Narrow panels get the rail as an overlay instead of a column.
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < NARROW_PX))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => { setRailOpen(narrow ? false : readStored(RAIL_KEY) !== 'closed') }, [narrow])

  // Follow the thread while the user is at the bottom; leave them alone when
  // they scrolled up to read (the "Latest" button brings them back).
  const last = thread[thread.length - 1]
  const lastSig = `${thread.length}:${last?.kind === 'agent' ? `${last.state}:${last.text?.length ?? 0}` : ''}:${pending ? 1 : 0}`
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])
  useLayoutEffect(() => { if (stick) scrollToBottom() }, [lastSig, stick, scrollToBottom])
  useLayoutEffect(() => { setStick(true); scrollToBottom() }, [chatKey, loadedKey, scrollToBottom])
  const onScroll = () => {
    const el = scrollRef.current
    if (el) setStick(el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX)
  }

  useEffect(() => { inputRef.current?.focus() }, [chatKey, projectId])

  // Grow the composer with its content (wrapped lines included), up to a cap.
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [draft])

  const toggleRail = () => {
    setRailOpen(o => {
      if (!narrow) writeStored(RAIL_KEY, o ? 'closed' : 'open')
      return !o
    })
  }

  const openChat = (key: string | null) => {
    setChatKey(key)
    setLogsFor(null)
    if (narrow) setRailOpen(false)
  }

  const newChat = () => {
    openChat(null)
    setDraft('')
    inputRef.current?.focus()
  }

  const switchProject = (id: string) => {
    setProjectId(id)
    writeStored(PROJECT_KEY, id)
    setChatKey(null)
    setData(null)
    setLoadedKey(undefined)
    setPending(null)
  }

  const send = async () => {
    const content = draft.trim()
    if (!content || sending || !projectId) return
    const chatId = chatKey?.startsWith('c:') ? chatKey.slice(2) : newChatId()
    const key = `c:${chatId}`
    setSending(true)
    setError(null)
    setDraft('')
    setPending({ key, text: content })
    setStick(true)
    try {
      await hostedFetch({ url: base, token: auth.token, method: 'POST', body: { content, chatId } })
      setChatKey(key)
      // setChatKey re-runs load via its deps; if the key did not change, load now.
      if (chatKey === key) await load()
    } catch (e) {
      setPending(null)
      setDraft(d => d || content)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }

  const fetchLogs = useCallback(async (promptId: string) => {
    try {
      const res = await hostedFetch<{ logs: LogRow[] }>({
        url: `${base}/logs?promptId=${encodeURIComponent(promptId)}`,
        token: auth.token,
      })
      setLogs(res.logs || [])
    } catch (e) {
      setLogs(l => l || [])
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [base, auth.token])

  const toggleLogs = (promptId: string) => {
    if (logsFor === promptId) { setLogsFor(null); return }
    setLogsFor(promptId)
    setLogs(null)
    fetchLogs(promptId)
  }

  // Open logs of a turn that is still working follow it.
  const logsLive = !!logsFor && thread.some(t => t.kind === 'agent' && t.promptId === logsFor && (t.state === 'waiting' || t.state === 'running'))
  useEffect(() => {
    if (!logsFor || !logsLive) return
    const id = setInterval(() => fetchLogs(logsFor), FAST_POLL_MS)
    return () => clearInterval(id)
  }, [logsFor, logsLive, fetchLogs])

  // Esc: close the logs, then the overlay rail, then the panel. A draft in
  // the composer keeps Esc from closing anything.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return
    if (logsFor) { setLogsFor(null); return }
    if (narrow && railOpen) { setRailOpen(false); return }
    if (!draft.trim()) onClose()
  }

  const chats = (data?.conversations || []).filter(c => c.kind === 'chat')
  const project = data?.project
  const current = chats.find(c => c.key === chatKey)
  const meId = data?.me.id
  // Only a Home chat can be continued; other conversations open read-only.
  const canReply = !chatKey || chatKey.startsWith('c:')
  const showPending = !!pending && (chatKey === pending.key || (!chatKey && sending))

  const status = !project
    ? null
    : !project.configured
      ? { dot: 'bg-zinc-500', text: 'no agent', tone: 'text-zinc-400' }
      : project.agentOnline
        ? { dot: 'bg-green-400', text: 'agent online', tone: 'text-green-300' }
        : { dot: 'bg-amber-400', text: 'agent offline', tone: 'text-amber-300' }

  const rail = (
    <aside
      className={`flex w-64 shrink-0 flex-col border-r border-white/10 bg-zinc-900 ${
        narrow ? 'absolute inset-y-0 left-0 z-20 shadow-2xl shadow-black/60' : ''
      }`}
    >
      <div className="space-y-2 border-b border-white/10 p-3">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-green-400" />
          <span className="flex-1 text-sm font-semibold text-white">Operator</span>
          <button onClick={toggleRail} className="rounded p-1 text-zinc-500 hover:bg-white/10 hover:text-white" title="Hide chats">
            <PanelLeftClose className="h-4 w-4" />
          </button>
        </div>
        {auth.projects.length > 1 ? (
          <div className="relative">
            <select
              value={projectId}
              onChange={e => switchProject(e.target.value)}
              className="w-full appearance-none truncate rounded-md bg-zinc-800 py-1.5 pl-2 pr-6 text-xs text-zinc-200 outline-none hover:bg-zinc-700 focus-visible:ring-1 focus-visible:ring-green-600/60"
              title="Project"
            >
              {auth.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <ChevronDown className="pointer-events-none absolute right-1.5 top-2 h-3.5 w-3.5 text-zinc-500" />
          </div>
        ) : (
          <p className="truncate text-xs text-zinc-400">{auth.projects[0]?.name || 'No projects'}</p>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-1.5">
        {!data && !pollError && (
          <div className="space-y-1.5 p-1.5">
            {[0, 1, 2].map(i => <div key={i} className="h-6 animate-pulse rounded-md bg-white/5" />)}
          </div>
        )}
        {data && chats.length === 0 && (
          <p className="px-2 py-3 text-[11px] text-zinc-500">No chats yet — your first message starts one.</p>
        )}
        {groupChats(chats).map(g => (
          <div key={g.label} className="mb-1">
            <p className="px-2 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wider text-zinc-600">{g.label}</p>
            {g.items.map(c => (
              <button
                key={c.key}
                onClick={() => openChat(c.key)}
                title={c.title}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-green-600/60 ${
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
        ))}
      </div>
    </aside>
  )

  return (
    <div ref={rootRef} onKeyDown={onKeyDown} className="relative flex h-full">
      {railOpen && rail}
      {narrow && railOpen && (
        <div className="absolute inset-0 z-10 bg-black/40" onClick={() => setRailOpen(false)} />
      )}

      {/* Thread + composer */}
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-white/10 px-3">
          {!railOpen && (
            <button onClick={toggleRail} className="rounded p-1 text-zinc-500 hover:bg-white/10 hover:text-white" title="Show chats">
              <PanelLeftOpen className="h-4 w-4" />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-zinc-100" title={current?.title}>
              {chatKey ? current?.title || 'Chat' : 'New chat'}
            </p>
            <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
              <span className="truncate">{project?.name || auth.projects.find(p => p.id === projectId)?.name || '…'}</span>
              {status && (
                <>
                  <span className="text-zinc-700">·</span>
                  <span className={`flex shrink-0 items-center gap-1 ${status.tone}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
                    {status.text}
                  </span>
                </>
              )}
              {busy && (
                <>
                  <span className="text-zinc-700">·</span>
                  <span className="flex shrink-0 items-center gap-1 text-cyan-300">
                    <Loader2 className="h-3 w-3 animate-spin" /> working
                  </span>
                </>
              )}
              {pollError && data && (
                <>
                  <span className="text-zinc-700">·</span>
                  <span className="flex shrink-0 items-center gap-1 text-amber-300" title={pollError}>
                    <AlertCircle className="h-3 w-3" /> reconnecting
                  </span>
                </>
              )}
            </div>
          </div>
          <button
            onClick={newChat}
            className="flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-zinc-200 hover:bg-white/10"
            title="New chat"
          >
            <SquarePen className="h-3.5 w-3.5" />
            {!narrow && 'New chat'}
          </button>
          <button onClick={onClose} className="rounded p-1 text-zinc-500 hover:bg-white/10 hover:text-white" title="Back to terminals (Esc)">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="relative min-h-0 flex-1">
          <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto px-4 py-4">
            <div className="mx-auto max-w-3xl space-y-4">
              {!data && pollError ? (
                <div className="py-16 text-center">
                  <AlertCircle className="mx-auto h-8 w-8 text-red-400/80" />
                  <p className="mt-3 text-sm text-zinc-300">Could not reach Orquesta.</p>
                  <p className="mx-auto mt-1 max-w-md break-words text-xs text-zinc-500">{pollError}</p>
                  <button
                    onClick={load}
                    className="mx-auto mt-4 flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-200 hover:bg-white/10"
                  >
                    <RotateCw className="h-3.5 w-3.5" /> Retry
                  </button>
                </div>
              ) : threadLoading ? (
                <div className="flex justify-center py-16 text-zinc-500">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              ) : !chatKey && !showPending ? (
                <div className="py-16 text-center">
                  <Bot className="mx-auto h-8 w-8 text-zinc-600" />
                  <p className="mt-3 text-sm text-zinc-400">Ask the agent to build, fix or explain something in {project?.name || 'this project'}.</p>
                  {project && !project.agentOnline && project.configured && (
                    <p className="mt-1 text-xs text-zinc-500">The agent is offline — your message waits until it reconnects.</p>
                  )}
                </div>
              ) : null}

              {!threadLoading && thread.map((t, i) => {
                // Compare against the last USER turn, not the previous turn: agent
                // turns in between carry no day, and comparing to them repeated it.
                const day = t.kind === 'user' ? dayLabel(t.at) : null
                const lastUser = thread.slice(0, i).reverse().find(x => x.kind === 'user')
                const prevDay = lastUser ? dayLabel(lastUser.at) : null
                return (
                  <Fragment key={`${t.kind}-${t.promptId}`}>
                    {day && day !== prevDay && (prevDay !== null || day !== 'Today') && (
                      <div className="flex items-center gap-3 py-1 text-[10px] uppercase tracking-wider text-zinc-600">
                        <span className="h-px flex-1 bg-white/5" />{day}<span className="h-px flex-1 bg-white/5" />
                      </div>
                    )}
                    {t.kind === 'user' ? (
                      <UserBubble text={t.text} meta={[t.author.id !== meId ? t.author.name : null, clock(t.at)]} title={new Date(t.at).toLocaleString()} />
                    ) : (
                      <AgentTurn
                        turn={t}
                        now={now}
                        logsOpen={logsFor === t.promptId}
                        logs={logsFor === t.promptId ? logs : null}
                        onToggleLogs={() => toggleLogs(t.promptId)}
                      />
                    )}
                  </Fragment>
                )
              })}

              {showPending && pending && (
                <>
                  <UserBubble text={pending.text} meta={['sending…']} faded />
                  <div className="flex items-center gap-2 text-sm text-zinc-500">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Sending to the agent…
                  </div>
                </>
              )}
            </div>
          </div>

          {!stick && (
            <button
              onClick={() => { setStick(true); scrollToBottom() }}
              className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-white/10 bg-zinc-800/95 px-3 py-1 text-xs text-zinc-200 shadow-lg hover:bg-zinc-700"
            >
              <ArrowDown className="h-3.5 w-3.5" /> Latest
            </button>
          )}
        </div>

        <div className="border-t border-white/10 p-3">
          <div className="mx-auto max-w-3xl">
            {error && (
              <div className="mb-2 flex items-start gap-2 rounded-md border border-red-500/20 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-300">
                <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
                <span className="flex-1 break-words">{error}</span>
                <button onClick={() => setError(null)} className="text-red-300/70 hover:text-red-200" title="Dismiss">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
            {project && !project.configured ? (
              <p className="text-xs text-zinc-400">
                This project has no agent yet. Set one up from the dashboard (or start a local agent in a pane), then chat here.
              </p>
            ) : canReply ? (
              <>
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
                    rows={1}
                    placeholder={chatKey ? 'Reply to the agent…' : 'Message the agent…'}
                    className="max-h-[200px] flex-1 resize-none bg-transparent px-1 py-1 text-sm leading-relaxed text-white outline-none placeholder:text-zinc-500"
                  />
                  <button
                    onClick={send}
                    disabled={!draft.trim() || sending}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-green-600 text-white hover:bg-green-500 disabled:opacity-40"
                    title="Send (Enter)"
                  >
                    {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  </button>
                </div>
                <div className="mt-1.5 flex items-center gap-2 px-1 text-[10px] text-zinc-600">
                  {project && project.configured && !project.agentOnline && (
                    <span className="text-amber-300/80">Agent offline — messages wait until it reconnects.</span>
                  )}
                  <span className="flex-1" />
                  {!narrow && <span>Enter to send · Shift+Enter for a new line</span>}
                </div>
              </>
            ) : (
              <p className="text-xs text-zinc-500">This conversation is read-only here.</p>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}

function UserBubble({ text, meta, title, faded }: { text: string; meta: Array<string | null>; title?: string; faded?: boolean }) {
  return (
    <div className={`flex flex-col items-end gap-0.5 ${faded ? 'opacity-60' : ''}`}>
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-green-600/20 px-3 py-2 text-sm text-zinc-100" title={title}>
        {text}
      </div>
      <span className="px-1 text-[10px] text-zinc-600">{meta.filter(Boolean).join(' · ')}</span>
    </div>
  )
}

function AgentTurn({
  turn: t,
  now,
  logsOpen,
  logs,
  onToggleLogs,
}: {
  turn: Extract<Turn, { kind: 'agent' }>
  now: number
  logsOpen: boolean
  logs: LogRow[] | null
  onToggleLogs: () => void
}) {
  const live = t.state === 'waiting' || t.state === 'running'
  const meta = [t.cli, t.model, t.duration, t.branch, !live && t.at ? clock(t.at) : null].filter(Boolean).join(' · ')
  return (
    <div className="group flex gap-2.5">
      <div className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
        t.state === 'failed' ? 'bg-red-500/15 text-red-300' : 'bg-green-500/10 text-green-400'
      }`}>
        <Bot className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        {live ? (
          <div className="flex items-center gap-2 py-0.5 text-sm text-zinc-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-cyan-400" />
            {t.state === 'waiting' ? 'Waiting for the agent…' : 'Working…'}
            {t.state === 'running' && t.at && <span className="font-mono text-[11px] text-zinc-500">{elapsed(t.at, now)}</span>}
          </div>
        ) : t.state === 'failed' ? (
          <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-sm text-red-300">
            {t.text ? <OperatorMarkdown text={t.text} /> : 'The agent could not finish this.'}
          </div>
        ) : t.state === 'cancelled' ? (
          <p className="text-sm text-zinc-500">Cancelled.</p>
        ) : t.text ? (
          <OperatorMarkdown text={t.text} />
        ) : (
          <p className="text-sm text-zinc-500">(no reply text)</p>
        )}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px] text-zinc-500">
          {meta && <span>{meta}</span>}
          <button
            onClick={onToggleLogs}
            className={`flex items-center gap-0.5 rounded px-1 hover:bg-white/5 hover:text-zinc-300 ${logsOpen ? 'text-zinc-300' : 'text-zinc-500'}`}
          >
            {logsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <ScrollText className="h-3 w-3" /> logs
          </button>
          {t.text && !live && (
            <CopyButton text={t.text} className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100" />
          )}
        </div>
        {logsOpen && (
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-white/10 bg-black/40 p-2 text-[11px] leading-relaxed text-zinc-400">
            {logs === null ? (
              <span className="text-zinc-500">Loading logs…</span>
            ) : logs.length ? (
              logs.map(l => (
                <div key={l.id} className={l.level === 'error' ? 'text-red-300' : l.level === 'warn' || l.level === 'warning' ? 'text-amber-300' : ''}>
                  <span className="text-zinc-600">[{l.category}]</span> {l.message}
                </div>
              ))
            ) : (
              <span className="text-zinc-500">No logs yet.</span>
            )}
          </pre>
        )}
      </div>
    </div>
  )
}
