'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { ListTodo, Clock, RefreshCw, Loader2, X, CornerDownLeft, ExternalLink, ClipboardList, Sparkles, MessageSquare, Radio, FolderKanban, ChevronRight, Mail, Paperclip } from 'lucide-react'
import { RailChat, RailCoordination, RailMail, RailFiles } from './RailPanels'
import { hostedFetch } from '@/lib/tauri-proxy'

// Per-terminal left rail. Mirrors the hosted interactive-session sidebar: a
// compact panel scoped to this pane's hosted project, reachable with the
// cockpit's oclt_ token through hostedFetch (Tauri invoke).
//
// Its hero tab is "Tasks": Plans / Linear / Scheduled / Assigned pulled from
// the aggregator (GET /api/orquesta-cli/projects/:id/tasks). Picking a task
// seeds its story/description into the LIVE terminal for review-before-send —
// step 1 of the Prompt Loop.

interface NormTask {
  id: string
  source: 'plan' | 'linear' | 'scheduled' | 'assigned'
  title: string
  subtitle?: string | null
  body?: string | null
  status?: string | null
  url?: string | null
  identifier?: string | null
}

interface TimelinePrompt {
  id: string
  content?: string
  status?: string
  createdAt?: string
  created_at?: string
}

type Tab = 'tasks' | 'timeline' | 'chat' | 'coord' | 'mail' | 'files'

const SOURCE_STYLE: Record<NormTask['source'], { label: string; cls: string }> = {
  plan: { label: 'Plan', cls: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/25' },
  linear: { label: 'Linear', cls: 'bg-violet-500/15 text-violet-300 border-violet-500/25' },
  scheduled: { label: 'Sched', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/25' },
  assigned: { label: 'You', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25' },
}

async function proxyGet<T>(apiUrl: string, token: string, path: string): Promise<T> {
  return hostedFetch<T>({ url: `${apiUrl}${path}`, token })
}

async function proxyPost<T>(apiUrl: string, token: string, path: string, payload: unknown): Promise<T> {
  return hostedFetch<T>({ url: `${apiUrl}${path}`, token, method: 'POST', body: payload })
}

export function TerminalSidebar({
  apiUrl,
  token,
  projectId,
  projects,
  onPickProject,
  onSeed,
  onClose,
}: {
  apiUrl: string
  token: string
  projectId?: string
  projects?: { id: string; name: string }[]
  onPickProject?: (id: string) => void
  onSeed: (text: string) => void
  onClose: () => void
}) {
  const [tab, setTab] = useState<Tab>('tasks')

  const activeProject = projectId ? projects?.find((p) => p.id === projectId) : undefined
  // No project pinned to this pane yet — offer a chooser instead of empty tabs.
  const needsProject = !projectId

  return (
    <div className="flex h-full w-[268px] flex-col border-r border-zinc-800 bg-zinc-950">
      <div className="flex items-center gap-0.5 overflow-x-auto border-b border-zinc-800 px-1.5 py-1.5">
        <TabButton active={tab === 'tasks'} onClick={() => setTab('tasks')} icon={<ListTodo className="h-3 w-3" />} label="Tasks" />
        <TabButton active={tab === 'timeline'} onClick={() => setTab('timeline')} icon={<Clock className="h-3 w-3" />} label="Runs" />
        <TabButton active={tab === 'chat'} onClick={() => setTab('chat')} icon={<MessageSquare className="h-3 w-3" />} label="Chat" />
        <TabButton active={tab === 'coord'} onClick={() => setTab('coord')} icon={<Radio className="h-3 w-3" />} label="Coord" />
        <TabButton active={tab === 'mail'} onClick={() => setTab('mail')} icon={<Mail className="h-3 w-3" />} label="Mail" />
        <TabButton active={tab === 'files'} onClick={() => setTab('files')} icon={<Paperclip className="h-3 w-3" />} label="Files" />
        <button
          onClick={onClose}
          className="ml-auto shrink-0 rounded p-1 text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300"
          title="Hide sidebar"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Project context bar — lets a pane retarget which hosted project the rail follows */}
      {projectId && onPickProject && projects && projects.length > 1 && (
        <div className="flex items-center gap-1.5 border-b border-zinc-800/70 px-2 py-1">
          <FolderKanban className="h-3 w-3 shrink-0 text-zinc-600" />
          <select
            value={projectId}
            onChange={(e) => onPickProject(e.target.value)}
            className="min-w-0 flex-1 truncate bg-transparent text-[10px] text-zinc-400 outline-none hover:text-zinc-200"
            title="Which hosted project this panel follows"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id} className="bg-zinc-900 text-zinc-200">{p.name}</option>
            ))}
          </select>
        </div>
      )}
      {projectId && (!projects || projects.length <= 1) && activeProject && (
        <div className="flex items-center gap-1.5 border-b border-zinc-800/70 px-2 py-1 text-[10px] text-zinc-500">
          <FolderKanban className="h-3 w-3 shrink-0 text-zinc-600" />
          <span className="truncate">{activeProject.name}</span>
        </div>
      )}

      {/* Mail is user-scoped (no project needed), so it works even before a project is pinned. */}
      {tab === 'mail' ? (
        <RailMail apiUrl={apiUrl} token={token} />
      ) : needsProject ? (
        <ProjectChooser projects={projects} onPickProject={onPickProject} />
      ) : tab === 'tasks' ? (
        <TasksPane apiUrl={apiUrl} token={token} projectId={projectId!} onSeed={onSeed} />
      ) : tab === 'timeline' ? (
        <TimelinePane apiUrl={apiUrl} token={token} projectId={projectId!} onSeed={onSeed} />
      ) : tab === 'chat' ? (
        <RailChat apiUrl={apiUrl} token={token} projectId={projectId!} />
      ) : tab === 'files' ? (
        <RailFiles apiUrl={apiUrl} token={token} projectId={projectId!} />
      ) : (
        <RailCoordination apiUrl={apiUrl} token={token} projectId={projectId!} />
      )}
    </div>
  )
}

function ProjectChooser({
  projects,
  onPickProject,
}: {
  projects?: { id: string; name: string }[]
  onPickProject?: (id: string) => void
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      <p className="mb-2 px-1 text-[10px] uppercase tracking-wider text-zinc-500">Pick a project</p>
      {!projects || projects.length === 0 ? (
        <div className="py-8 text-center text-[11px] text-zinc-500">
          No hosted projects available. Sign in from the header to connect.
        </div>
      ) : !onPickProject ? (
        <div className="py-8 text-center text-[11px] text-zinc-500">This pane can’t be linked to a project.</div>
      ) : (
        <div className="space-y-1">
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => onPickProject(p.id)}
              className="group flex w-full items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/50 px-2 py-2 text-left transition-colors hover:border-zinc-700 hover:bg-zinc-800/60"
            >
              <FolderKanban className="h-3.5 w-3.5 shrink-0 text-zinc-600 group-hover:text-zinc-400" />
              <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-200">{p.name}</span>
              <ChevronRight className="h-3 w-3 shrink-0 text-zinc-600 group-hover:text-zinc-300" />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium transition-colors ${
        active ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-300'
      }`}
    >
      {icon}
      {label}
    </button>
  )
}

function TasksPane({
  apiUrl,
  token,
  projectId,
  onSeed,
}: {
  apiUrl: string
  token: string
  projectId: string
  onSeed: (text: string) => void
}) {
  const [tasks, setTasks] = useState<NormTask[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [filter, setFilter] = useState<'all' | NormTask['source']>('all')
  const [seededId, setSeededId] = useState<string | null>(null)
  const [genId, setGenId] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!projectId || !token) return
    try {
      const data = await proxyGet<{ tasks?: NormTask[]; errors?: Record<string, string> }>(
        apiUrl,
        token,
        `/api/orquesta-cli/projects/${projectId}/tasks`,
      )
      setTasks(data.tasks || [])
      setErrors(data.errors || {})
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [apiUrl, token, projectId])

  useEffect(() => {
    setLoading(true)
    load()
  }, [load])

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: tasks.length }
    for (const t of tasks) c[t.source] = (c[t.source] || 0) + 1
    return c
  }, [tasks])

  const visible = filter === 'all' ? tasks : tasks.filter((t) => t.source === filter)

  const seed = (t: NormTask) => {
    const text = (t.body && t.body.trim()) || t.title
    onSeed(text)
    setSeededId(t.id)
    setTimeout(() => setSeededId((cur) => (cur === t.id ? null : cur)), 1600)
  }

  // Prompt Loop step 2: ask the server to turn this story into a concrete
  // implementation prompt, then seed THAT (falls back to raw body on any error).
  const generate = async (t: NormTask) => {
    setGenId(t.id)
    try {
      const data = await proxyPost<{ prompt?: string }>(
        apiUrl,
        token,
        `/api/orquesta-cli/projects/${projectId}/tasks/generate-prompt`,
        { title: t.title, body: t.body || '', source: t.source, identifier: t.identifier },
      )
      onSeed((data.prompt || '').trim() || (t.body && t.body.trim()) || t.title)
      setSeededId(t.id)
      setTimeout(() => setSeededId((cur) => (cur === t.id ? null : cur)), 1600)
    } catch {
      onSeed((t.body && t.body.trim()) || t.title)
    } finally {
      setGenId((cur) => (cur === t.id ? null : cur))
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-zinc-800/70 px-1.5 py-1.5">
        {(['all', 'plan', 'linear', 'scheduled', 'assigned'] as const).map((f) => {
          const n = f === 'all' ? counts.all : counts[f] || 0
          const label = f === 'all' ? 'All' : SOURCE_STYLE[f].label
          return (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                filter === f ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-300'
              }`}
            >
              {label}
              <span className="ml-1 text-zinc-600">{n}</span>
            </button>
          )
        })}
        <button
          onClick={() => { setLoading(true); load() }}
          className="ml-auto rounded p-0.5 text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300"
          title="Refresh"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {loading && tasks.length === 0 ? (
          <Centered><Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> Loading…</Centered>
        ) : error ? (
          <Centered className="text-red-400">{error}</Centered>
        ) : visible.length === 0 ? (
          <div className="py-8 text-center text-[11px] text-zinc-500">
            <ClipboardList className="mx-auto mb-2 h-5 w-5 text-zinc-700" />
            No tasks here yet.
            {Object.keys(errors).length > 0 && (
              <p className="mt-2 text-[9px] text-amber-500/70">
                Some sources unavailable: {Object.keys(errors).join(', ')}
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-1">
            {visible.map((t) => {
              const s = SOURCE_STYLE[t.source]
              const just = seededId === t.id
              return (
                <div key={t.id} className="group rounded-lg border border-zinc-800 bg-zinc-900/50 p-2 hover:border-zinc-700">
                  <div className="mb-1 flex items-center gap-1.5">
                    <span className={`shrink-0 rounded border px-1 py-px text-[8px] font-medium ${s.cls}`}>{s.label}</span>
                    {t.identifier && <span className="shrink-0 text-[9px] font-mono text-zinc-500">{t.identifier}</span>}
                    {t.url && (
                      <a href={t.url} target="_blank" rel="noopener noreferrer" className="ml-auto shrink-0 text-zinc-600 hover:text-zinc-300" title="Open in source">
                        <ExternalLink className="h-2.5 w-2.5" />
                      </a>
                    )}
                  </div>
                  <p className="mb-1.5 line-clamp-2 text-[11px] leading-snug text-zinc-200">{t.title}</p>
                  {t.subtitle && <p className="mb-1.5 truncate text-[9px] text-zinc-500">{t.subtitle}</p>}
                  <div className="flex gap-1">
                    <button
                      onClick={() => seed(t)}
                      disabled={genId === t.id}
                      className={`flex flex-1 items-center justify-center gap-1 rounded border px-2 py-1 text-[10px] transition-colors disabled:opacity-50 ${
                        just
                          ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                          : 'border-green-500/25 bg-green-500/10 text-green-300 hover:bg-green-500/20'
                      }`}
                      title="Type this task into the terminal as-is (review, then press Enter)"
                    >
                      <CornerDownLeft className="h-2.5 w-2.5" />
                      {just ? 'Seeded' : 'Start'}
                    </button>
                    <button
                      onClick={() => generate(t)}
                      disabled={genId === t.id}
                      className="flex shrink-0 items-center justify-center gap-1 rounded border border-violet-500/25 bg-violet-500/10 px-2 py-1 text-[10px] text-violet-300 transition-colors hover:bg-violet-500/20 disabled:opacity-50"
                      title="Generate a concrete implementation prompt from this story, then seed it"
                    >
                      {genId === t.id ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Sparkles className="h-2.5 w-2.5" />}
                      {genId === t.id ? '' : 'Prompt'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function TimelinePane({
  apiUrl,
  token,
  projectId,
  onSeed,
}: {
  apiUrl: string
  token: string
  projectId: string
  onSeed: (text: string) => void
}) {
  const [prompts, setPrompts] = useState<TimelinePrompt[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!token) return
    try {
      const params = new URLSearchParams()
      if (projectId) params.set('projectId', projectId)
      params.set('limit', '20')
      const data = await proxyGet<{ prompts?: TimelinePrompt[] }>(apiUrl, token, `/api/v1/prompts?${params.toString()}`)
      setPrompts(data.prompts || [])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [apiUrl, token, projectId])

  useEffect(() => {
    setLoading(true)
    load()
    const t = setInterval(load, 15_000)
    return () => clearInterval(t)
  }, [load])

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
      {loading && prompts.length === 0 ? (
        <Centered><Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> Loading…</Centered>
      ) : error ? (
        <Centered className="text-red-400">{error}</Centered>
      ) : prompts.length === 0 ? (
        <div className="py-8 text-center text-[11px] text-zinc-500">No prompts yet.</div>
      ) : (
        <div className="space-y-1">
          {prompts.map((p) => (
            <div key={p.id} className="group rounded-lg border border-zinc-800 bg-zinc-900/50 p-2 hover:border-zinc-700">
              <div className="mb-1 flex items-center gap-1.5">
                <StatusDot status={p.status} />
                <span className="text-[9px] text-zinc-500">{p.status || 'unknown'}</span>
              </div>
              <p className="mb-1.5 line-clamp-2 text-[11px] leading-snug text-zinc-300">{p.content || '(no content)'}</p>
              {p.content && (
                <button
                  onClick={() => onSeed(p.content!.trim())}
                  className="flex w-full items-center justify-center gap-1 rounded border border-zinc-700 bg-zinc-800/50 px-2 py-1 text-[10px] text-zinc-300 opacity-0 transition-opacity hover:bg-zinc-700 group-hover:opacity-100"
                  title="Re-run this prompt in the terminal"
                >
                  <CornerDownLeft className="h-2.5 w-2.5" />
                  Reuse
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function StatusDot({ status }: { status?: string }) {
  const color =
    status === 'completed' ? 'bg-green-500'
      : status === 'failed' || status === 'cancelled' ? 'bg-red-500'
      : status === 'in_progress' || status === 'running' ? 'bg-blue-500 animate-pulse'
      : 'bg-zinc-500'
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${color}`} />
}

function Centered({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`flex items-center justify-center py-8 text-[11px] text-zinc-500 ${className}`}>{children}</div>
}
