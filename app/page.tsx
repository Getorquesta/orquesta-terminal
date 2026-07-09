'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { BACKEND_URL } from '@/lib/config'

import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { useSocket } from '@/hooks/useSocket'
import { AgentGrid, type AgentGridHandle } from '@/components/features/AgentGrid'
import { useHostedAuth, type HostedAuth } from '@/hooks/useHostedAuth'
import { CommandPalette, type Command } from '@/components/features/CommandPalette'
import { Button } from '@/components/ui/button'
import {
  ArrowLeft, ChevronDown, Wifi, WifiOff, Image as ImageIcon,
  Check, Terminal as TerminalIcon, Command as CommandIcon,
  LayoutGrid, Settings, RotateCcw, Paintbrush, Plus, X, Upload,
  Cloud, ExternalLink, Loader2, CheckCircle2, AlertCircle, Clock,
  Star, Tag, MessageSquare, Send, Monitor, Puzzle,
} from 'lucide-react'

interface Project {
  id: string
  name: string
  agentOnline: boolean
}

/* Premium CSS wallpapers — no network, CSP-safe, look bespoke. */
const WALLPAPERS: { id: string; label: string; css: string }[] = [
  { id: 'console', label: 'Console', css: '' },
  {
    id: 'aurora', label: 'Aurora',
    css: 'radial-gradient(60rem 42rem at 78% -10%, rgba(20,196,138,0.35), transparent 60%), radial-gradient(52rem 40rem at 12% 108%, rgba(56,189,248,0.22), transparent 62%), radial-gradient(40rem 34rem at 50% 50%, rgba(16,185,129,0.12), transparent 70%)',
  },
  {
    id: 'nebula', label: 'Nebula',
    css: 'radial-gradient(56rem 44rem at 84% 8%, rgba(139,92,246,0.32), transparent 60%), radial-gradient(48rem 40rem at 8% 96%, rgba(59,130,246,0.28), transparent 62%), radial-gradient(38rem 30rem at 60% 40%, rgba(236,72,153,0.14), transparent 70%)',
  },
  {
    id: 'ember', label: 'Ember',
    css: 'radial-gradient(56rem 42rem at 82% -6%, rgba(251,146,60,0.28), transparent 60%), radial-gradient(50rem 40rem at 10% 104%, rgba(239,68,68,0.22), transparent 62%), radial-gradient(40rem 32rem at 50% 60%, rgba(245,158,11,0.12), transparent 70%)',
  },
  {
    id: 'mono', label: 'Slate',
    css: 'radial-gradient(60rem 46rem at 80% -12%, rgba(148,163,184,0.16), transparent 62%), radial-gradient(48rem 40rem at 6% 106%, rgba(100,116,139,0.14), transparent 62%)',
  },
]

interface BgSettings {
  wallpaper: string
  url: string
  opacity: number
  blur: number
  /** Terminal pane translucency (0.2–1). Lower = more wallpaper shows through. */
  termOpacity: number
}

const BG_KEY = 'orquesta-terminal-bg'
const DEFAULT_BG: BgSettings = { wallpaper: 'aurora', url: '', opacity: 0.55, blur: 0, termOpacity: 1 }

export default function TerminalWorkspacePage() {
  const router = useRouter()
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState('')
  const [sessionToken, setSessionToken] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [bgOpen, setBgOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [bg, setBg] = useState<BgSettings>(DEFAULT_BG)
  const [timelineOpen, setTimelineOpen] = useState(false)
  const [pluginsOpen, setPluginsOpen] = useState(false)
  const gridRef = useRef<AgentGridHandle>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const { socket } = useSocket({ projectId, sessionToken })
  const hosted = useHostedAuth()

  // Load projects from backend (optional — only if self-hosted OSS is running)
  useEffect(() => {
    // Try to connect to self-hosted backend, but don't block if unavailable
    fetch(BACKEND_URL + '/api/projects', { mode: 'no-cors' })
      .catch(() => {}) // silently fail — terminal works without backend
    fetch(BACKEND_URL + '/api/auth/get-session', { mode: 'no-cors' })
      .catch(() => {}) // silently fail
    try {
      const saved = localStorage.getItem(BG_KEY)
      if (saved) setBg({ ...DEFAULT_BG, ...JSON.parse(saved) })
    } catch {}
  }, [router])

  const updateBg = useCallback((patch: Partial<BgSettings>) => {
    setBg(prev => {
      const next = { ...prev, ...patch }
      try { localStorage.setItem(BG_KEY, JSON.stringify(next)) } catch {}
      return next
    })
  }, [])

  // Pick a wallpaper from the local machine → embed as a data URL so it renders
  // (CSP blocks remote hosts) and persists across reloads.
  const onPickLocalImage = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!file) return
    if (!file.type.startsWith('image/')) return
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : ''
      if (dataUrl) updateBg({ url: dataUrl })
    }
    reader.readAsDataURL(file)
  }, [updateBg])

  const activeProject = projects.find(p => p.id === projectId)
  const online = activeProject?.agentOnline

  // Global shortcuts: ⌘K / Ctrl+K opens the palette; ⌘1–9 jumps to a project.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setPaletteOpen(o => !o)
        return
      }
      if (mod && /^[1-9]$/.test(e.key)) {
        const idx = Number(e.key) - 1
        if (projects[idx]) {
          e.preventDefault()
          setProjectId(projects[idx].id)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [projects])

  // Command palette actions — projects, terminal, background, navigation.
  const commands: Command[] = useMemo(() => {
    const list: Command[] = []

    if (online) {
      list.push(
        {
          id: 'term-new', group: 'Terminal', label: 'New terminal', hint: 'Alt+T',
          icon: Plus, run: () => gridRef.current?.addTerminal(),
        },
        {
          id: 'term-arrange', group: 'Terminal', label: 'Arrange & fit all panes', hint: 'Ctrl+P',
          icon: LayoutGrid, run: () => gridRef.current?.arrange(),
        },
        {
          id: 'term-close', group: 'Terminal', label: 'Close active terminal', hint: 'Alt+W',
          icon: X, run: () => gridRef.current?.closeActive(),
        },
      )
    }

    projects.forEach((p, i) => {
      list.push({
        id: `proj-${p.id}`,
        group: 'Switch project',
        label: p.name,
        hint: p.agentOnline ? 'online' : 'offline',
        keys: i < 9 ? `⌘${i + 1}` : undefined,
        icon: p.agentOnline ? Wifi : WifiOff,
        run: () => setProjectId(p.id),
      })
    })

    WALLPAPERS.forEach(w => {
      list.push({
        id: `bg-${w.id}`,
        group: 'Background',
        label: `Wallpaper: ${w.label}`,
        icon: Paintbrush,
        keepOpen: true,
        run: () => updateBg({ wallpaper: w.id, url: '' }),
      })
    })
    list.push({
      id: 'bg-reset',
      group: 'Background',
      label: 'Reset background to default',
      icon: RotateCcw,
      run: () => updateBg(DEFAULT_BG),
    })

    list.push({
      id: 'nav-dashboard',
      group: 'Navigate',
      label: 'Back to dashboard',
      icon: LayoutGrid,
      run: () => {},
    })
    if (projectId) {
      list.push({
        id: 'nav-settings',
        group: 'Navigate',
        label: 'Open project settings',
        icon: Settings,
        run: () => router.push(`/projects/${projectId}`),
      })
    }

    return list
  }, [projects, projectId, updateBg, router, online])

  const wallpaperCss = WALLPAPERS.find(w => w.id === bg.wallpaper)?.css || ''
  const wallpaperStyle: React.CSSProperties = bg.url
    ? { backgroundImage: `url(${bg.url})`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : { backgroundImage: wallpaperCss }

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-zinc-950">
      {/* ── Wallpaper layers ── */}
      <div
        className="pointer-events-none absolute inset-0 transition-opacity duration-500"
        style={{ ...wallpaperStyle, opacity: bg.opacity, filter: bg.blur ? `blur(${bg.blur}px)` : undefined }}
      />
      {/* legibility scrim */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-zinc-950/70 via-zinc-950/50 to-zinc-950/80" />

      {/* ── Title bar ── */}
      <header className="glass relative z-20 flex items-center justify-between gap-3 px-4 py-2.5">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Image src="/logo-mark.png" alt="Orquesta" width={20} height={20} className="invert" priority />
            <span className="font-semibold tracking-tight text-white">
              Terminal
            </span>
            <span className="rounded-full bg-green-500/12 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-green-300 ring-1 ring-inset ring-green-500/25">
              workspace
            </span>
          </div>
        </div>

        {/* Project selector — only shown when self-hosted backend has projects */}
        {projects.length > 0 && (
        <div className="relative">
          <button
            onClick={() => setPickerOpen(o => !o)}
            className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white transition-colors hover:bg-white/10"
          >
            <span className={`h-2 w-2 rounded-full ${online ? 'bg-green-400 shadow-[0_0_8px_rgba(20,196,138,0.8)]' : 'bg-zinc-600'}`} />
            <span className="max-w-[12rem] truncate font-medium">{activeProject?.name || 'Select project'}</span>
            <ChevronDown className="h-3.5 w-3.5 text-zinc-400" />
          </button>
          {pickerOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setPickerOpen(false)} />
              <div className="glass absolute right-0 top-full z-20 mt-2 w-64 rounded-xl p-1.5">
                <p className="px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider text-zinc-500">Projects</p>
                <div className="max-h-72 overflow-auto">
                  {projects.length === 0 && (
                    <p className="px-2.5 py-2 text-sm text-zinc-500">No projects yet</p>
                  )}
                  {projects.map(p => (
                    <button
                      key={p.id}
                      onClick={() => { setProjectId(p.id); setPickerOpen(false) }}
                      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-white/5"
                    >
                      {p.agentOnline
                        ? <Wifi className="h-3.5 w-3.5 shrink-0 text-green-400" />
                        : <WifiOff className="h-3.5 w-3.5 shrink-0 text-zinc-600" />}
                      <span className="min-w-0 flex-1 truncate text-white">{p.name}</span>
                      {p.id === projectId && <Check className="h-3.5 w-3.5 shrink-0 text-green-400" />}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
        )}

        <div className="flex items-center gap-2">
          {/* Command palette trigger */}
          <button
            onClick={() => setPaletteOpen(true)}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-white/10 hover:text-white"
            title="Command palette"
          >
            <CommandIcon className="h-3.5 w-3.5" />
            <kbd className="hidden font-mono text-[10px] text-zinc-500 sm:inline">⌘K</kbd>
          </button>

          {/* Background customizer */}
          <div className="relative">
            <button
              onClick={() => setBgOpen(o => !o)}
              className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-white/10 hover:text-white"
              title="Customize background"
            >
              <ImageIcon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Background</span>
            </button>
            {bgOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setBgOpen(false)} />
                <div className="glass absolute right-0 top-full z-20 mt-2 w-72 rounded-xl p-3">
                  <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-zinc-500">Wallpaper</p>
                  <div className="grid grid-cols-5 gap-1.5">
                    {WALLPAPERS.map(w => (
                      <button
                        key={w.id}
                        onClick={() => updateBg({ wallpaper: w.id, url: '' })}
                        title={w.label}
                        className={`h-9 rounded-lg ring-1 transition-all ${
                          bg.wallpaper === w.id && !bg.url
                            ? 'ring-2 ring-green-400'
                            : 'ring-white/10 hover:ring-white/30'
                        }`}
                        style={{ background: w.css || 'linear-gradient(135deg,#14171d,#0a0c10)' }}
                      />
                    ))}
                  </div>

                  <p className="mb-1.5 mt-3 font-mono text-[10px] uppercase tracking-wider text-zinc-500">Custom image</p>
                  <input
                    value={bg.url.startsWith('data:') ? '' : bg.url}
                    onChange={e => updateBg({ url: e.target.value })}
                    placeholder={bg.url.startsWith('data:') ? 'Local image loaded' : 'https://…/wallpaper.jpg'}
                    className="h-8 w-full rounded-lg border border-white/10 bg-black/30 px-2.5 text-xs text-white placeholder:text-zinc-600 focus:border-green-600/60 focus:outline-none focus:ring-1 focus:ring-green-600/40"
                  />
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={onPickLocalImage}
                    className="hidden"
                  />
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      <Upload className="h-3.5 w-3.5" /> From computer
                    </button>
                    {bg.url && (
                      <button
                        onClick={() => updateBg({ url: '' })}
                        className="flex items-center justify-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-white/10 hover:text-white"
                        title="Remove custom image"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>

                  <div className="mt-3 flex items-center justify-between">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">Opacity</span>
                    <span className="font-mono text-[10px] text-zinc-400">{Math.round(bg.opacity * 100)}%</span>
                  </div>
                  <input
                    type="range" min={0} max={1} step={0.05} value={bg.opacity}
                    onChange={e => updateBg({ opacity: Number(e.target.value) })}
                    className="mt-1 w-full accent-green-500"
                  />

                  <div className="mt-2 flex items-center justify-between">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">Blur</span>
                    <span className="font-mono text-[10px] text-zinc-400">{bg.blur}px</span>
                  </div>
                  <input
                    type="range" min={0} max={24} step={1} value={bg.blur}
                    onChange={e => updateBg({ blur: Number(e.target.value) })}
                    className="mt-1 w-full accent-green-500"
                  />

                  <div className="mt-2 flex items-center justify-between">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">Terminal opacity</span>
                    <span className="font-mono text-[10px] text-zinc-400">{Math.round(bg.termOpacity * 100)}%</span>
                  </div>
                  <input
                    type="range" min={0.2} max={1} step={0.05} value={bg.termOpacity}
                    onChange={e => updateBg({ termOpacity: Number(e.target.value) })}
                    className="mt-1 w-full accent-green-500"
                  />
                  <p className="mt-1 text-[10px] text-zinc-600">Lower it to let the wallpaper glow through the panes.</p>
                </div>
              </>
            )}
          </div>

          {/* Hosted hook — report local CLI sessions to a hosted project */}
          {hosted.isLoggedIn && (
            <button
              onClick={() => setTimelineOpen(o => !o)}
              className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                timelineOpen
                  ? 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300'
                  : 'border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10 hover:text-white'
              }`}
              title="Prompt timeline from hosted"
            >
              <Clock className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Timeline</span>
            </button>
          )}
          {online && (
            <ExternalSessionsButton socket={socket} />
          )}
          <button
            onClick={() => setPluginsOpen(o => !o)}
            className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
              pluginsOpen
                ? 'border-purple-500/30 bg-purple-500/10 text-purple-300'
                : 'border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10 hover:text-white'
            }`}
            title="Plugins & Integrations"
          >
            <Puzzle className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Plugins</span>
          </button>
          <HostedHookPanel hosted={hosted} />
        </div>
      </header>

      {/* ── Workspace ── */}
      <main className="relative z-10 flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-auto p-4">
          <AgentGrid
            ref={gridRef}
            socket={socket}
            storageKey={`orquesta-grid-${projectId || 'standalone'}`}
            terminalOpacity={bg.termOpacity}
            hostedApiUrl={hosted.auth?.apiUrl}
            hostedToken={hosted.auth?.token}
            hostedProjects={hosted.auth?.projects}
          />
        </div>

        {/* Timeline sidebar (hosted prompts) */}
        {timelineOpen && hosted.isLoggedIn && (
          <HostedTimeline auth={hosted.auth!} />
        )}

        {/* Plugins panel */}
        {pluginsOpen && (
          <PluginsPanel />
        )}
      </main>

      {/* ── Status bar ── */}
      <footer className="glass relative z-20 flex items-center justify-between gap-3 px-4 py-1.5 text-[11px]">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${online ? 'bg-green-400 shadow-[0_0_6px_rgba(20,196,138,0.9)]' : 'bg-zinc-600'}`} />
            <span className={online ? 'text-green-300' : 'text-zinc-500'}>
              {online ? 'agent online' : activeProject ? 'agent offline' : 'no project'}
            </span>
          </span>
          {activeProject && (
            <span className="font-mono text-zinc-500">
              <span className="text-zinc-600">project</span> {activeProject.name}
            </span>
          )}
          <span className="hidden font-mono text-zinc-600 sm:inline">
            {WALLPAPERS.find(w => w.id === bg.wallpaper)?.label || 'Custom'}
            {bg.url ? ' · image' : ''}
          </span>
        </div>
        <button
          onClick={() => setPaletteOpen(true)}
          className="flex items-center gap-1.5 font-mono text-zinc-500 transition-colors hover:text-zinc-300"
        >
          <CommandIcon className="h-3 w-3" />
          <span>commands</span>
          <kbd className="rounded border border-white/10 bg-white/5 px-1 text-[10px]">⌘K</kbd>
        </button>
      </footer>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
        placeholder="Switch project, change background…"
      />
    </div>
  )
}

/**
 * Timeline sidebar — shows recent prompts from the hosted project(s).
 * Fetches from GET /api/v1/prompts?projectId=... using the oclt_ token.
 * Auto-refreshes every 15s.
 */

interface TimelinePrompt {
  id: string
  content: string
  status: string
  source?: string | null
  cliType?: string | null
  model?: string | null
  createdAt: string
  projectId?: string
  projectName?: string
  createdByName?: string | null
  createdByEmail?: string | null
  tokensUsed?: number
  isStarred?: boolean
  tags?: string[]
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d`
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === 'completed' ? 'bg-emerald-500' :
    status === 'running' || status === 'in_progress' ? 'bg-cyan-400 animate-pulse' :
    status === 'failed' || status === 'cancelled' ? 'bg-red-500' :
    status === 'pending' ? 'bg-amber-400' :
    'bg-zinc-500'
  return <span className={`inline-block h-1.5 w-1.5 rounded-full shrink-0 ${color}`} />
}

/**
 * A single prompt in the timeline with interactive actions:
 * star, add tags, view detail (opens hosted dashboard).
 */
function PromptCard({
  prompt: p, auth, selectedProjectId, onUpdate,
}: {
  prompt: TimelinePrompt
  auth: HostedAuth
  selectedProjectId: string
  onUpdate: () => void
}) {
  const [starring, setStarring] = useState(false)
  const [showTags, setShowTags] = useState(false)
  const [tagInput, setTagInput] = useState('')
  const [localTags, setLocalTags] = useState<string[]>(p.tags || [])
  const [localStarred, setLocalStarred] = useState(p.isStarred || false)

  // Sync with parent data on refresh
  useEffect(() => { setLocalStarred(p.isStarred || false) }, [p.isStarred])
  useEffect(() => { setLocalTags(p.tags || []) }, [p.tags])

  const patchPrompt = async (updates: Record<string, unknown>) => {
    try {
      await fetch('/api/hosted/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: `${auth.apiUrl}/api/v1/prompts/${p.id}`,
          token: auth.token,
          method: 'PATCH',
          body: updates,
        }),
      })
    } catch {}
  }

  const toggleStar = async () => {
    setStarring(true)
    const next = !localStarred
    setLocalStarred(next)
    await patchPrompt({ is_starred: next })
    setStarring(false)
    onUpdate()
  }

  const addTag = async () => {
    const t = tagInput.trim()
    if (!t || localTags.includes(t)) { setTagInput(''); return }
    const next = [...localTags, t]
    setLocalTags(next)
    setTagInput('')
    await patchPrompt({ tags: next })
    onUpdate()
  }

  const removeTag = async (tag: string) => {
    const next = localTags.filter(t => t !== tag)
    setLocalTags(next)
    await patchPrompt({ tags: next })
    onUpdate()
  }

  const dashboardUrl = `${auth.apiUrl}/projects/${p.projectId || selectedProjectId}?view=prompts&prompt=${p.id}`

  return (
    <div className="group rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5 py-2 hover:border-zinc-700 transition-colors">
      <div className="flex items-start gap-1.5">
        <StatusDot status={p.status} />
        <div className="flex-1 min-w-0">
          <p className="text-[11px] text-zinc-200 line-clamp-2 break-words leading-snug">
            {p.content?.slice(0, 180) || '(empty)'}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-zinc-500">
            <span>{relativeTime(p.createdAt)}</span>
            <span className="capitalize">{p.status?.replace('_', ' ')}</span>
            {p.cliType && (
              <span className="rounded bg-zinc-800 px-1 text-zinc-400">{p.cliType}</span>
            )}
            {p.model && (
              <span className="truncate max-w-[6rem] text-zinc-600">{p.model}</span>
            )}
            {p.projectName && auth.projects.length > 1 && !selectedProjectId && (
              <span className="truncate max-w-[6rem] text-cyan-400/70">{p.projectName}</span>
            )}
          </div>
          {p.createdByName && (
            <p className="mt-0.5 text-[10px] text-zinc-600 truncate">{p.createdByName}</p>
          )}

          {/* Tags */}
          {localTags.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {localTags.map(tag => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-0.5 rounded bg-zinc-800 px-1.5 py-0.5 text-[9px] text-zinc-300"
                >
                  {tag}
                  <button onClick={() => removeTag(tag)} className="text-zinc-600 hover:text-red-400 ml-0.5">×</button>
                </span>
              ))}
            </div>
          )}

          {/* Action buttons */}
          <div className="mt-1.5 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={toggleStar}
              disabled={starring}
              className={`p-0.5 rounded transition-colors ${localStarred ? 'text-amber-400' : 'text-zinc-600 hover:text-amber-400'}`}
              title={localStarred ? 'Unstar' : 'Star'}
            >
              <Star className="h-3 w-3" fill={localStarred ? 'currentColor' : 'none'} />
            </button>
            <button
              onClick={() => setShowTags(o => !o)}
              className="p-0.5 rounded text-zinc-600 hover:text-green-400 transition-colors"
              title="Add tag"
            >
              <Tag className="h-3 w-3" />
            </button>
            <a
              href={dashboardUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="p-0.5 rounded text-zinc-600 hover:text-cyan-400 transition-colors"
              title="Open in hosted dashboard"
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>

          {/* Tag input */}
          {showTags && (
            <div className="mt-1 flex gap-1">
              <input
                value={tagInput}
                onChange={e => setTagInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addTag() }}
                placeholder="tag…"
                className="flex-1 h-5 rounded bg-zinc-800 border border-zinc-700 px-1.5 text-[10px] text-white placeholder:text-zinc-600 outline-none focus:border-green-600/50"
              />
              <button
                onClick={addTag}
                disabled={!tagInput.trim()}
                className="px-1.5 h-5 rounded bg-green-600/20 text-[10px] text-green-300 hover:bg-green-600/30 disabled:opacity-40"
              >
                +
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function HostedTimeline({ auth }: { auth: HostedAuth }) {
  const [tab, setTab] = useState<'timeline' | 'coordination'>('timeline')
  const [selectedProjectId, setSelectedProjectId] = useState<string>(
    auth.projects.length === 1 ? auth.projects[0].id : ''
  )

  return (
    <aside className="relative z-10 flex w-72 shrink-0 flex-col border-l border-white/10 bg-zinc-900/80 backdrop-blur-sm">
      {/* Header with project selector */}
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <div className="flex items-center gap-2">
          {(['timeline', 'coordination'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`text-[10px] font-mono uppercase tracking-wider transition-colors ${
                tab === t ? 'text-green-400' : 'text-zinc-600 hover:text-zinc-400'
              }`}
            >
              {t === 'timeline' ? '⏱ Timeline' : '🔗 Coordination'}
            </button>
          ))}
        </div>
        {auth.projects.length > 1 && (
          <select
            value={selectedProjectId}
            onChange={e => setSelectedProjectId(e.target.value)}
            className="max-w-[7rem] truncate rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-mono text-zinc-300 outline-none hover:bg-zinc-700 focus:ring-1 focus:ring-green-600/40"
          >
            <option value="">All</option>
            {auth.projects.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        )}
      </div>

      {/* Tab content */}
      {tab === 'timeline' ? (
        <TimelineTab auth={auth} selectedProjectId={selectedProjectId} />
      ) : (
        <CoordinationTab auth={auth} selectedProjectId={selectedProjectId} />
      )}
    </aside>
  )
}

/** Timeline tab — prompts list with actions */
function TimelineTab({ auth, selectedProjectId }: { auth: HostedAuth; selectedProjectId: string }) {
  const [prompts, setPrompts] = useState<TimelinePrompt[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchPrompts = useCallback(async () => {
    if (!auth.token) return
    const targetUrl = new URL(`${auth.apiUrl}/api/v1/prompts`)
    if (selectedProjectId) targetUrl.searchParams.set('projectId', selectedProjectId)
    targetUrl.searchParams.set('limit', '25')

    try {
      const res = await fetch('/api/hosted/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl.toString(), token: auth.token }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || `HTTP ${res.status}`)
      }
      const data = await res.json() as { prompts?: TimelinePrompt[] }
      setPrompts(data.prompts || [])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [auth.token, auth.apiUrl, selectedProjectId])

  useEffect(() => {
    setLoading(true)
    fetchPrompts()
    const t = setInterval(fetchPrompts, 15_000)
    return () => clearInterval(t)
  }, [fetchPrompts])

  return (
    <div className="flex-1 overflow-y-auto p-2 space-y-1">
      {loading && prompts.length === 0 ? (
        <div className="flex items-center justify-center py-8 text-zinc-500 text-xs">
          <Loader2 className="h-3 w-3 animate-spin mr-1.5" /> Loading…
        </div>
      ) : error ? (
        <div className="text-center py-6 text-xs text-red-400">{error}</div>
      ) : prompts.length === 0 ? (
        <div className="text-center py-8 text-zinc-500 text-xs">No prompts yet.</div>
      ) : (
        prompts.map(p => (
          <PromptCard
            key={p.id}
            prompt={p}
            auth={auth}
            selectedProjectId={selectedProjectId}
            onUpdate={fetchPrompts}
          />
        ))
      )}
    </div>
  )
}

/** Coordination tab — channels with chat and ping */
interface CoordChannel {
  id: string
  name: string
  participant_project_names?: string[]
  cross_project?: boolean
}

interface CoordMessage {
  id: number
  from: string
  to: string
  text: string
  at: number
  kind?: string
}

function CoordinationTab({ auth, selectedProjectId }: { auth: HostedAuth; selectedProjectId: string }) {
  const [channels, setChannels] = useState<CoordChannel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [openChannelId, setOpenChannelId] = useState<string | null>(null)
  const [pinging, setPinging] = useState<string | null>(null)
  const [pingStatus, setPingStatus] = useState<{ id: string; msg: string; ok: boolean } | null>(null)

  const projectId = selectedProjectId || auth.projects[0]?.id

  const fetchChannels = useCallback(async () => {
    if (!projectId || !auth.token) return
    try {
      const res = await fetch('/api/hosted/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: `${auth.apiUrl}/api/projects/${projectId}/coordination/channels`,
          token: auth.token,
        }),
      })
      if (res.ok) {
        const data = await res.json()
        if (Array.isArray(data.channels)) {
          setChannels(data.channels)
          setError(null)
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally { setLoading(false) }
  }, [projectId, auth.token, auth.apiUrl])

  useEffect(() => { fetchChannels() }, [fetchChannels])

  const ping = async (channelId: string) => {
    setPinging(channelId)
    setPingStatus(null)
    try {
      const res = await fetch('/api/hosted/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: `${auth.apiUrl}/api/projects/${projectId}/coordination/channels/${channelId}/ping`,
          token: auth.token,
          method: 'POST',
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Ping failed')
      const n = Array.isArray(data.dispatched) ? data.dispatched.length : 0
      setPingStatus({ id: channelId, msg: `Pinged ${n} peer${n === 1 ? '' : 's'}`, ok: true })
    } catch (e) {
      setPingStatus({ id: channelId, msg: e instanceof Error ? e.message : 'Failed', ok: false })
    } finally {
      setPinging(null)
      setTimeout(() => setPingStatus(null), 4000)
    }
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center py-8 text-zinc-500 text-xs">
        <Loader2 className="h-3 w-3 animate-spin mr-1.5" /> Loading…
      </div>
    )
  }

  if (!projectId) {
    return (
      <div className="flex-1 flex items-center justify-center py-8 text-zinc-500 text-xs">
        Select a project first.
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto p-2 space-y-2">
      {error && <div className="text-center py-2 text-xs text-red-400">{error}</div>}

      {channels.length === 0 ? (
        <div className="text-center py-8 text-xs text-zinc-500">
          No coordination channels.
          <a
            href={`${auth.apiUrl}/projects/${projectId}?view=coordination`}
            target="_blank"
            rel="noopener noreferrer"
            className="block mt-2 text-green-400/80 hover:underline"
          >
            Create one in the dashboard →
          </a>
        </div>
      ) : (
        channels.map(c => {
          const peers = (c.participant_project_names || []).filter(Boolean)
          const isOpen = openChannelId === c.id
          return (
            <div key={c.id} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2">
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-[10px]">🔗</span>
                <span className="text-[11px] font-medium text-zinc-200 truncate">{c.name}</span>
                {c.cross_project && (
                  <span className="text-[8px] px-1 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/20">cross</span>
                )}
              </div>
              {peers.length > 0 && (
                <p className="text-[9px] text-zinc-500 truncate mb-1.5">peers: {peers.join(', ')}</p>
              )}
              <div className="flex gap-1.5">
                <button
                  onClick={() => setOpenChannelId(isOpen ? null : c.id)}
                  className="flex-1 text-[10px] px-2 py-1 rounded border border-cyan-500/30 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20 flex items-center justify-center gap-1"
                >
                  <MessageSquare className="h-2.5 w-2.5" />
                  {isOpen ? 'Hide' : 'Chat'}
                </button>
                <button
                  onClick={() => ping(c.id)}
                  disabled={pinging === c.id}
                  className="flex-1 text-[10px] px-2 py-1 rounded border border-purple-500/30 bg-purple-500/10 text-purple-200 hover:bg-purple-500/20 disabled:opacity-50 flex items-center justify-center gap-1"
                >
                  {pinging === c.id ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : '📡'}
                  Ping
                </button>
              </div>
              {pingStatus?.id === c.id && (
                <p className={`mt-1.5 text-[9px] rounded px-1.5 py-1 ${
                  pingStatus.ok ? 'bg-green-500/10 text-green-300 border border-green-500/20' : 'bg-red-500/10 text-red-300 border border-red-500/20'
                }`}>
                  {pingStatus.msg}
                </p>
              )}
              {isOpen && (
                <ChannelChat auth={auth} projectId={projectId} channelId={c.id} />
              )}
            </div>
          )
        })
      )}
    </div>
  )
}

/** Inline channel chat (messages + send) */
function ChannelChat({ auth, projectId, channelId }: { auth: HostedAuth; projectId: string; channelId: string }) {
  const [messages, setMessages] = useState<CoordMessage[]>([])
  const [input, setInput] = useState('')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [joining, setJoining] = useState(true)
  const [sending, setSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Join channel
  useEffect(() => {
    let cancelled = false
    const join = async () => {
      try {
        const res = await fetch('/api/hosted/proxy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: `${auth.apiUrl}/api/projects/${projectId}/coordination/channels/${channelId}/join`,
            token: auth.token,
            method: 'POST',
            body: {},
          }),
        })
        if (cancelled) return
        if (res.ok) {
          const data = await res.json()
          setSessionId(data.session_id || null)
          setMessages(Array.isArray(data.history) ? data.history : [])
        }
      } catch {}
      if (!cancelled) setJoining(false)
    }
    join()
    return () => { cancelled = true }
  }, [auth, projectId, channelId])

  // Poll for new messages
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    const sinceRef = { current: messages.length > 0 ? messages[messages.length - 1].id : 0 }

    const poll = async () => {
      while (!cancelled) {
        try {
          const res = await fetch('/api/hosted/proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: `${auth.apiUrl}/api/projects/${projectId}/coordination/channels/${channelId}/listen?session_id=${sessionId}&since=${sinceRef.current}&timeout=15`,
              token: auth.token,
            }),
          })
          if (cancelled) return
          if (res.ok) {
            const data = await res.json()
            const incoming: CoordMessage[] = Array.isArray(data.messages) ? data.messages : []
            if (incoming.length > 0) {
              setMessages(prev => [...prev, ...incoming.filter(m => m.kind !== 'status')])
              sinceRef.current = incoming[incoming.length - 1].id
            }
          }
        } catch {
          if (cancelled) return
          await new Promise(r => setTimeout(r, 2000))
        }
      }
    }
    poll()
    return () => { cancelled = true }
  }, [sessionId, auth, projectId, channelId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages.length])

  const send = async () => {
    const text = input.trim()
    if (!text || !sessionId) return
    setSending(true)
    try {
      await fetch('/api/hosted/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: `${auth.apiUrl}/api/projects/${projectId}/coordination/channels/${channelId}/send`,
          token: auth.token,
          method: 'POST',
          body: { session_id: sessionId, to: 'all', text: `[👤 OPERATOR] ${text}` },
        }),
      })
      setInput('')
    } catch {}
    setSending(false)
  }

  return (
    <div className="mt-2 border-t border-zinc-800 pt-2">
      <div ref={scrollRef} className="max-h-40 overflow-y-auto space-y-1 mb-1.5">
        {joining ? (
          <p className="text-[9px] text-zinc-500 py-2 text-center">Joining…</p>
        ) : messages.length === 0 ? (
          <p className="text-[9px] text-zinc-500 py-2 text-center">No messages yet.</p>
        ) : (
          messages.map(m => (
            <div key={m.id} className="text-[10px]">
              <span className="font-mono text-cyan-400/80">{m.from}</span>
              <span className="text-zinc-600 mx-1">→</span>
              <span className="text-zinc-300 break-words">{m.text.replace(/^\[👤 OPERATOR\] /, '')}</span>
            </div>
          ))
        )}
      </div>
      <div className="flex gap-1">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') send() }}
          disabled={!sessionId || sending}
          placeholder="Message…"
          className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[10px] text-white placeholder:text-zinc-600 outline-none focus:border-cyan-500/50 disabled:opacity-50"
        />
        <button
          onClick={send}
          disabled={!input.trim() || !sessionId || sending}
          className="px-1.5 py-1 rounded border border-cyan-500/30 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-50"
        >
          {sending ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Send className="h-2.5 w-2.5" />}
        </button>
      </div>
    </div>
  )
}

/**
 * Plugins & Integrations panel — shows companion products with descriptions,
 * example prompts to use them, and integration buttons.
 */
const PLUGINS = [
  {
    id: 'sudosudo',
    name: 'SudoSudo',
    url: 'https://sudosudo.dev',
    logo: 'https://sudosudo.dev/favicon.ico',
    color: 'amber',
    tagline: 'Autonomous monitoring & remediation',
    description: 'Deploy AI-powered monitoring agents on your servers. Get alerts, automatic triage reports, and autonomous SSH-based remediation when things break.',
    features: ['YAML-based alert rules', 'Kimi agent investigates via SSH', 'Markdown triage reports', 'Per-target audit logs'],
    prompts: [
      'Use the SudoSudo API at https://sudosudo.dev to check the status of my monitoring targets and report any active alerts',
      'Connect to SudoSudo (https://sudosudo.dev) and set up a new monitoring rule: alert if CPU > 90% for 5 minutes on target "production"',
      'Fetch the last triage report from SudoSudo at https://sudosudo.dev/api/targets — show me what the agent found',
    ],
    integrationHint: 'Add your SudoSudo target ID to connect monitoring data.',
  },
  {
    id: 'rogerthat',
    name: 'RogerThat',
    url: 'https://rogerthat.chat',
    logo: '/plugins/rogerthat.svg',
    color: 'cyan',
    tagline: 'Voice, Meet & Coordination for AI agents',
    description: 'Walkie-talkie for your AI agents. Real-time coordination channels, video/voice calls with a 3D avatar, and inter-agent messaging.',
    features: ['Coordination channels (agent-to-agent)', 'Voice calls with avatar (meet.rogerthat.chat)', 'Webhook-based message relay', 'Cross-project ping'],
    prompts: [
      'Open a voice call at https://meet.rogerthat.chat and connect it to my current session so I can talk to the agent',
      'Use RogerThat (https://rogerthat.chat) to ping all agents in my coordination channel and ask them for a status update',
      'Connect to rogerthat.chat coordination channel and show me the latest messages between my agents',
    ],
    integrationHint: 'Connect your RogerThat channel to enable voice & coordination.',
  },
  {
    id: 'apumail',
    name: 'Apumail',
    url: 'https://apumail.com',
    logo: 'https://apumail.com/favicon.ico',
    color: 'green',
    tagline: 'Agent-native temp mail',
    description: 'Two-way email inbox for AI agents. Each agent gets an @apumail.com address with automatic OTP extraction, webhook push on new mail, and REST/MCP access.',
    features: ['Inbound + outbound email', 'Automatic OTP/verification extraction', 'Webhook on new mail', 'REST + MCP server'],
    prompts: [
      'Use Apumail API at https://apumail.com/api/inbox to check my agent inbox (agent@apumail.com) for new emails or verification codes',
      'Send an email via Apumail (POST https://apumail.com/api/send) from agent@apumail.com to team@company.com with the deploy report',
      'Call Apumail at https://apumail.com/api/inbox to extract the latest OTP code from incoming emails and use it to verify the account',
    ],
    integrationHint: 'Set your agent\'s apumail address to enable email capabilities.',
  },
  {
    id: 'trustops',
    name: 'TrustOps',
    url: 'https://trustops.eu',
    logo: '/plugins/trustops.svg',
    color: 'blue',
    tagline: 'Policy-enforced AI with verifiable audit',
    description: 'Continuously building trustworthy software. Policy-enforced AI agents with cryptographically verifiable audit logs. Prove what your agent did, and that it was authorized.',
    features: ['Policy enforcement (YAML rules)', 'Cryptographic audit logs', 'Verifiable agent actions', 'Compliance reporting'],
    prompts: [
      'Query TrustOps at https://trustops.eu/api/audit to show the audit log for the last deployment — verify all actions were policy-compliant',
      'Use the TrustOps API (https://trustops.eu/api/verify) to cryptographically verify that the agent actions in the last session were authorized',
      'Connect to TrustOps (https://trustops.eu) and generate a compliance report for the last 7 days of agent activity in this project',
    ],
    integrationHint: 'Connect your TrustOps project to enable policy enforcement & audit.',
  },
] as const

function PluginsPanel() {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [copiedPrompt, setCopiedPrompt] = useState<string | null>(null)

  const copyPrompt = (prompt: string) => {
    navigator.clipboard.writeText(prompt).catch(() => {})
    setCopiedPrompt(prompt)
    setTimeout(() => setCopiedPrompt(null), 2000)
  }

  const colorMap: Record<string, string> = {
    amber: 'border-amber-500/20 bg-amber-500/5',
    cyan: 'border-cyan-500/20 bg-cyan-500/5',
    green: 'border-green-500/20 bg-green-500/5',
    blue: 'border-blue-500/20 bg-blue-500/5',
  }
  const textColorMap: Record<string, string> = {
    amber: 'text-amber-400',
    cyan: 'text-cyan-400',
    green: 'text-green-400',
    blue: 'text-blue-400',
  }

  return (
    <aside className="relative z-10 flex w-80 shrink-0 flex-col border-l border-white/10 bg-zinc-900/80 backdrop-blur-sm">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <Puzzle className="h-3.5 w-3.5 text-purple-400" />
        <p className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">Plugins & Integrations</p>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {PLUGINS.map(plugin => {
          const isExpanded = expandedId === plugin.id
          return (
            <div
              key={plugin.id}
              className={`rounded-lg border transition-colors ${
                isExpanded ? colorMap[plugin.color] : 'border-zinc-800 bg-zinc-900/60'
              }`}
            >
              {/* Header */}
              <button
                onClick={() => setExpandedId(isExpanded ? null : plugin.id)}
                className="w-full px-3 py-2.5 text-left"
              >
                <div className="flex items-center gap-2">
                  <img src={plugin.logo} alt={plugin.name} className="h-6 w-6 rounded" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-white">{plugin.name}</p>
                    <p className="text-[10px] text-zinc-500">{plugin.tagline}</p>
                  </div>
                  <ChevronDown className={`h-3 w-3 text-zinc-600 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                </div>
              </button>

              {/* Expanded content */}
              {isExpanded && (
                <div className="px-3 pb-3 space-y-3">
                  {/* Description */}
                  <p className="text-[11px] leading-relaxed text-zinc-400">
                    {plugin.description}
                  </p>

                  {/* Features */}
                  <div>
                    <p className="text-[9px] uppercase tracking-wider text-zinc-600 mb-1">Features</p>
                    <div className="flex flex-wrap gap-1">
                      {plugin.features.map(f => (
                        <span key={f} className="rounded bg-zinc-800 px-1.5 py-0.5 text-[9px] text-zinc-400">
                          {f}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Prompts */}
                  <div>
                    <p className="text-[9px] uppercase tracking-wider text-zinc-600 mb-1">Example prompts</p>
                    <div className="space-y-1">
                      {plugin.prompts.map(p => (
                        <button
                          key={p}
                          onClick={() => copyPrompt(p)}
                          className="w-full rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-left text-[10px] text-zinc-300 hover:border-zinc-700 hover:text-white transition-colors group"
                        >
                          <span className="line-clamp-2">{p}</span>
                          <span className={`block mt-0.5 text-[9px] ${copiedPrompt === p ? textColorMap[plugin.color] : 'text-zinc-600 group-hover:text-zinc-500'}`}>
                            {copiedPrompt === p ? '✓ Copied' : 'Click to copy'}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Integration */}
                  <div className="border-t border-zinc-800 pt-2">
                    <p className="text-[10px] text-zinc-500 mb-2">{plugin.integrationHint}</p>
                    <div className="flex gap-2">
                      <a
                        href={plugin.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[10px] font-medium transition-colors hover:opacity-90 ${
                          plugin.color === 'amber' ? 'border-amber-500/30 bg-amber-500/10 text-amber-300' :
                          plugin.color === 'cyan' ? 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300' :
                          plugin.color === 'green' ? 'border-green-500/30 bg-green-500/10 text-green-300' :
                          'border-blue-500/30 bg-blue-500/10 text-blue-300'
                        }`}
                      >
                        <ExternalLink className="h-3 w-3" />
                        Open {plugin.name}
                      </a>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </aside>
  )
}

/**
 * "Import Sessions" — detects Claude/orquesta-cli sessions running outside
 * the OSS and lets the user attach (read-only tail of the JSONL transcript).
 */
interface ExternalSession {
  id: string
  cwd: string
  file: string
  lastActivity: number
  size: number
  isActive: boolean
}

function ExternalSessionsButton({ socket }: { socket: ReturnType<typeof useSocket>['socket'] }) {
  const [open, setOpen] = useState(false)
  const [sessions, setSessions] = useState<ExternalSession[]>([])
  const [loading, setLoading] = useState(false)
  const [attached, setAttached] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<Array<{ role?: string; type?: string; content?: string }>>([])
  const scrollRef = useRef<HTMLDivElement>(null)

  const fetchSessions = useCallback(() => {
    if (!socket) return
    setLoading(true)
    socket.emit('sessions:external-list', {})
  }, [socket])

  useEffect(() => {
    if (!socket) return
    const onResult = (data: { sessions?: ExternalSession[]; error?: string }) => {
      setSessions(data.sessions || [])
      setLoading(false)
    }
    const onData = (data: { sessionId: string; entry: Record<string, unknown> }) => {
      if (data.sessionId !== attached) return
      const entry = data.entry as { type?: string; message?: { role?: string; content?: unknown } }
      const msg = entry.message
      if (!msg) return
      let text = ''
      if (typeof msg.content === 'string') {
        text = msg.content
      } else if (Array.isArray(msg.content)) {
        text = (msg.content as Array<{ type?: string; text?: string }>)
          .filter(b => b.type === 'text' && b.text)
          .map(b => b.text)
          .join('\n')
      }
      if (text) {
        setTranscript(prev => [...prev.slice(-100), { role: msg.role, type: entry.type, content: text }])
      }
    }
    socket.on('sessions:external-list-result', onResult)
    socket.on('sessions:external-data', onData)
    return () => {
      socket.off('sessions:external-list-result', onResult)
      socket.off('sessions:external-data', onData)
    }
  }, [socket, attached])

  useEffect(() => {
    if (open) fetchSessions()
  }, [open, fetchSessions])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [transcript.length])

  const attach = (session: ExternalSession) => {
    setAttached(session.id)
    setTranscript([])
    socket?.emit('sessions:external-attach', { sessionId: session.id, file: session.file })
  }

  const detach = () => {
    if (attached) socket?.emit('sessions:external-detach', { sessionId: attached })
    setAttached(null)
    setTranscript([])
  }

  const relTime = (ms: number) => {
    const s = Math.floor((Date.now() - ms) / 1000)
    if (s < 60) return `${s}s ago`
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    return `${Math.floor(s / 3600)}h ago`
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-white/10 hover:text-white"
        title="Import external CLI sessions running on this machine"
      >
        <Monitor className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Import</span>
        {sessions.some(s => s.isActive) && (
          <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-pulse" />
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => { setOpen(false); detach() }} />
          <div className="glass absolute right-0 top-full z-20 mt-2 w-96 rounded-xl p-3 max-h-[70vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between mb-2">
              <p className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                External Sessions
              </p>
              <button onClick={fetchSessions} className="text-[10px] text-zinc-500 hover:text-white">
                ↻ Refresh
              </button>
            </div>

            {!attached ? (
              /* Session list */
              <div className="flex-1 overflow-y-auto space-y-1.5">
                {loading ? (
                  <div className="flex items-center justify-center py-6 text-zinc-500 text-xs">
                    <Loader2 className="h-3 w-3 animate-spin mr-1.5" /> Scanning…
                  </div>
                ) : sessions.length === 0 ? (
                  <div className="py-6 text-center text-xs text-zinc-600">
                    No active Claude sessions detected.
                    <p className="mt-1 text-[10px] text-zinc-700">
                      Run <code className="text-zinc-500">claude</code> in any terminal and it will appear here.
                    </p>
                  </div>
                ) : (
                  sessions.map(s => (
                    <button
                      key={s.id}
                      onClick={() => attach(s)}
                      className="w-full rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5 py-2 text-left hover:border-zinc-700 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <span className={`h-2 w-2 rounded-full ${s.isActive ? 'bg-cyan-400 animate-pulse' : 'bg-zinc-600'}`} />
                        <span className="text-[11px] text-zinc-200 font-mono truncate flex-1">
                          {s.cwd.split('/').slice(-2).join('/')}
                        </span>
                        <span className="text-[9px] text-zinc-600">{relTime(s.lastActivity)}</span>
                      </div>
                      <p className="mt-0.5 text-[9px] text-zinc-500 truncate font-mono">{s.cwd}</p>
                      <p className="mt-0.5 text-[9px] text-zinc-600">
                        {s.isActive ? '● active' : '○ idle'} · {Math.round(s.size / 1024)}KB
                      </p>
                    </button>
                  ))
                )}
              </div>
            ) : (
              /* Attached transcript view */
              <div className="flex-1 flex flex-col overflow-hidden">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] text-cyan-300 font-mono truncate">
                    Attached: {attached.slice(0, 8)}…
                  </span>
                  <button
                    onClick={detach}
                    className="text-[10px] text-zinc-400 hover:text-white border border-zinc-700 rounded px-1.5 py-0.5"
                  >
                    Detach
                  </button>
                </div>
                <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-1 max-h-[50vh]">
                  {transcript.length === 0 ? (
                    <p className="text-[10px] text-zinc-600 py-4 text-center">Waiting for activity…</p>
                  ) : (
                    transcript.map((t, i) => (
                      <div key={i} className={`text-[10px] rounded px-2 py-1 ${
                        t.role === 'assistant'
                          ? 'bg-cyan-500/5 border border-cyan-500/10 text-cyan-100'
                          : t.role === 'user'
                          ? 'bg-green-500/5 border border-green-500/10 text-green-100'
                          : 'bg-zinc-800/50 text-zinc-400'
                      }`}>
                        <span className="font-mono text-[9px] text-zinc-500 mr-1">
                          {t.role === 'assistant' ? '🤖' : t.role === 'user' ? '👤' : '🔧'}
                        </span>
                        <span className="break-words whitespace-pre-wrap line-clamp-4">
                          {t.content?.slice(0, 500)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * "Hosted" header dropdown — connects to Orquesta Cloud (getorquesta.com) via
 * CLI token. Once authenticated, projects appear in each terminal pane's
 * selector so each pane can report to a different hosted project.
 * Also shows inline login if not yet connected.
 */
function HostedHookPanel({
  hosted,
}: {
  hosted: ReturnType<typeof useHostedAuth>
}) {
  const [open, setOpen] = useState(false)
  const [token, setToken] = useState('')
  const [apiUrl, setApiUrl] = useState('https://getorquesta.com')
  const [showUrl, setShowUrl] = useState(false)

  const connect = async () => {
    const t = token.trim()
    if (!t) return
    try {
      await hosted.login(t, apiUrl)
      setToken('')
    } catch {
      // error handled in hook
    }
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-white/10 hover:text-white"
        title="Connect to Orquesta Cloud"
      >
        <Cloud className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Hosted</span>
        {hosted.isLoggedIn && (
          <span className="h-1.5 w-1.5 rounded-full bg-green-400 shadow-[0_0_6px_rgba(20,196,138,0.9)]" />
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="glass absolute right-0 top-full z-20 mt-2 w-80 rounded-xl p-3">
            <div className="flex items-center justify-between">
              <p className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">Orquesta Cloud</p>
              {hosted.isLoggedIn && (
                <span className="flex items-center gap-1 font-mono text-[10px] text-green-300">
                  <CheckCircle2 className="h-3 w-3" /> connected
                </span>
              )}
            </div>

            {hosted.isLoggedIn ? (
              <div className="mt-2">
                <p className="text-xs text-zinc-300">
                  <span className="text-white font-medium">{hosted.auth!.organizationName}</span>
                  {' · '}{hosted.auth!.projects.length} project{hosted.auth!.projects.length !== 1 ? 's' : ''}
                </p>
                <div className="mt-2 space-y-1 max-h-40 overflow-y-auto">
                  {hosted.auth!.projects.map(p => (
                    <div key={p.id} className="flex items-center gap-2 rounded border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
                      <span className="text-[11px] text-zinc-200 truncate">{p.name}</span>
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-[10px] text-zinc-500">
                  Select a project in each terminal pane to report sessions there.
                </p>
                <button
                  onClick={hosted.logout}
                  className="mt-2 text-[11px] text-zinc-400 underline-offset-2 hover:text-white hover:underline"
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <div className="mt-2">
                <p className="text-[11px] leading-relaxed text-zinc-400">
                  Connect to see your projects and report sessions to the cloud.
                </p>

                {/* OAuth login — primary */}
                <button
                  onClick={() => hosted.loginWithBrowser(apiUrl).catch(() => {})}
                  disabled={hosted.loading}
                  className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-lg bg-green-600/90 px-2.5 py-2 text-xs font-medium text-white transition-colors hover:bg-green-600 disabled:cursor-not-allowed disabled:bg-white/5 disabled:text-zinc-500"
                >
                  {hosted.loading ? (
                    <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Waiting…</>
                  ) : (
                    <><Cloud className="h-3.5 w-3.5" /> Sign in with browser</>
                  )}
                </button>

                {/* Divider */}
                <div className="mt-2.5 flex items-center gap-2">
                  <div className="h-px flex-1 bg-white/10" />
                  <span className="text-[9px] uppercase tracking-wider text-zinc-600">or token</span>
                  <div className="h-px flex-1 bg-white/10" />
                </div>

                <div className="mt-2">
                  <div className="flex items-center justify-between">
                    <label className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">Token</label>
                    <a
                      href={`${apiUrl.replace(/\/$/, '')}//settings`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-[10px] text-green-300/80 hover:text-green-200"
                    >
                      Get a token <ExternalLink className="h-2.5 w-2.5" />
                    </a>
                  </div>
                  <input
                    value={token}
                    onChange={e => setToken(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') connect() }}
                    type="password"
                    placeholder="oclt_…"
                    autoComplete="off"
                    className="mt-1 h-8 w-full rounded-lg border border-white/10 bg-black/30 px-2.5 font-mono text-xs text-white placeholder:text-zinc-600 focus:border-green-600/60 focus:outline-none focus:ring-1 focus:ring-green-600/40"
                  />
                </div>

                {showUrl ? (
                  <div className="mt-2">
                    <label className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">URL</label>
                    <input
                      value={apiUrl}
                      onChange={e => setApiUrl(e.target.value)}
                      placeholder="https://getorquesta.com"
                      className="mt-1 h-8 w-full rounded-lg border border-white/10 bg-black/30 px-2.5 text-xs text-white placeholder:text-zinc-600 focus:border-green-600/60 focus:outline-none focus:ring-1 focus:ring-green-600/40"
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setShowUrl(true)}
                    className="mt-1.5 text-[10px] text-zinc-600 hover:text-zinc-400"
                  >
                    Custom URL? →
                  </button>
                )}

                {hosted.error && (
                  <p className="mt-2 flex items-start gap-1.5 text-[11px] text-red-400">
                    <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span className="min-w-0 break-words">{hosted.error}</span>
                  </p>
                )}

                <button
                  onClick={connect}
                  disabled={!token.trim() || hosted.loading}
                  className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-lg bg-green-600/90 px-2.5 py-2 text-xs font-medium text-white transition-colors hover:bg-green-600 disabled:cursor-not-allowed disabled:bg-white/5 disabled:text-zinc-500"
                >
                  {hosted.loading ? (
                    <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Connecting…</>
                  ) : (
                    <><Cloud className="h-3.5 w-3.5" /> Connect</>
                  )}
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function EmptyState({ title, hint, action }: { title: string; hint: string; action?: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <div className="mb-4 rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur">
        <TerminalIcon className="h-8 w-8 text-zinc-400" />
      </div>
      <p className="text-lg font-semibold text-white">{title}</p>
      <p className="mt-1 max-w-sm text-sm text-zinc-400">{hint}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}
