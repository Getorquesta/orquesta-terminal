'use client'

/**
 * Mesh — the org's agent graph (who may ask whom), read-only, as the
 * dashboard draws it at mesh.getorquesta.com: nodes at their saved positions,
 * edges by kind and approval, requests in flight marching along their edge,
 * pending approvals and the latest runs.
 *
 * Talks to the oclt_-authed /api/orquesta-cli/orgs/:id/mesh routes through the
 * Rust proxy and polls. A CLI token never edits the mesh, and request text
 * stays in the dashboard: every change links out to it (session + step-up).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  X, Loader2, Cloud, ChevronDown, AlertCircle, Network, RefreshCw, ExternalLink, Maximize2, Clock,
} from 'lucide-react'
import { hostedFetch } from '@/lib/tauri-proxy'
import type { HostedAuth } from '@/hooks/useHostedAuth'

interface MeshNode {
  id: string
  project_id: string | null
  sub_agent_id?: string | null
  external_kind?: string | null
  label: string
  family_id: string | null
  status: string
  capabilities: string[]
  pos_x: number | null
  pos_y: number | null
  project: { id: string; name: string } | null
  handle: string | null
  online: boolean
  lastSeen: string | null
  host: string | null
  version: string | null
  logo: string | null
}

interface MeshEdge {
  id: string
  from_node_id: string
  to_node_id: string
  kind: string
  approval: string
  capabilities: string[]
  daily_limit: number
  allow_auto_agent: boolean
}

interface PendingApproval {
  prompt_id: string
  from_project_id: string | null
  from_node_id?: string | null
  to_project_id: string
  kind: string
  capability: string | null
  created_at: string
  approver: 'owner' | 'target'
}

interface MeshGraph {
  enforce: string
  families: Array<{ id: string; name: string; color: string }>
  nodes: MeshNode[]
  edges: MeshEdge[]
  pendingOwnerApprovals: PendingApproval[]
  /** Studio businesses and the mesh projects each owns. Empty → no business layer. */
  businesses?: Array<{ id: string; name: string; project_ids: string[] }>
  role: string
}

interface MeshRun {
  prompt_id: string
  from_project_id: string | null
  from_node_id: string | null
  from_external: string | null
  to_project_id: string
  kind: string
  status: string
  origin: string
  created_at: string
  duration_ms: number | null
  cost_cents: number | null
}

interface MeshActivity {
  runs: MeshRun[]
  day: { totals: { requests: number; completed: number; failed: number; running: number; pending: number; denied: number }; pairs: Record<string, number> }
  inflight: Record<string, { active: number; approval: number }>
  observed: { pairs: Array<{ from_project_id: string | null; from_node_id: string | null; to_project_id: string; kind: string; count: number }> }
}

interface Org { id: string; name: string; role: string }

const ORG_KEY = 'orquesta-mesh-org'
/** Per org: '' = whole org, BIZ_NONE = projects outside every business, else a business id. */
const BIZ_KEY = 'orquesta-mesh-business'
const BIZ_NONE = 'none'
const IDLE_POLL_MS = 30000
const INFLIGHT_POLL_MS = 10000
const NODE_R = 22
const KIND_COLOR: Record<string, string> = { consulta: '#38bdf8', encargo: '#a78bfa' }
const ENFORCE_STYLE: Record<string, string> = {
  on: 'border-green-500/30 bg-green-500/10 text-green-300',
  shadow: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  off: 'border-white/10 bg-white/5 text-zinc-400',
}

function readStored(key: string): string {
  try { return localStorage.getItem(key) || '' } catch { return '' }
}

function writeStored(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch {}
}

function relTime(iso: string | null): string {
  if (!iso) return 'never'
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function monogram(label: string): string {
  const words = label.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean)
  return ((words[0]?.[0] || '?') + (words[1]?.[0] || '')).toUpperCase()
}

/**
 * Where each node goes: its saved dashboard position, or — when it has none —
 * a ring around the saved ones, so a fresh org still reads.
 */
function layoutNodes(nodes: MeshNode[]): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>()
  const placed = nodes.filter(n => n.pos_x != null && n.pos_y != null)
  for (const n of placed) out.set(n.id, { x: n.pos_x!, y: n.pos_y! })
  const rest = nodes.filter(n => !out.has(n.id))
  if (!rest.length) return out
  const xs = placed.map(n => n.pos_x!), ys = placed.map(n => n.pos_y!)
  const cx = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0
  const cy = ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : 0
  const spread = xs.length ? Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2 + 140 : 0
  const r = Math.max(spread, (rest.length * NODE_R * 3.2) / (2 * Math.PI), 120)
  rest.forEach((n, i) => {
    const a = (i / rest.length) * 2 * Math.PI - Math.PI / 2
    out.set(n.id, { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  })
  return out
}

/** Project ids the business filter keeps, or null when it keeps the whole org. */
function businessProjects(graph: MeshGraph, biz: string): Set<string> | null {
  if (!biz) return null
  const list = graph.businesses || []
  if (biz === BIZ_NONE) {
    const owned = new Set(list.flatMap(b => b.project_ids))
    return new Set(graph.nodes.map(n => n.project_id).filter((p): p is string => !!p && !owned.has(p)))
  }
  const b = list.find(x => x.id === biz)
  return b ? new Set(b.project_ids) : null
}

/**
 * The graph narrowed to one business, as the dashboard does it: the business's
 * project nodes, the project-less nodes (people, external agents) with an edge
 * to one of them, the edges among those, and the approvals touching them.
 */
function filterByBusiness(graph: MeshGraph, keep: Set<string> | null): MeshGraph {
  if (!keep) return graph
  const inside = new Set(graph.nodes.filter(n => n.project_id && keep.has(n.project_id)).map(n => n.id))
  const loose = new Set(graph.nodes.filter(n => !n.project_id).map(n => n.id))
  const kept = new Set(inside)
  for (const e of graph.edges) {
    if (inside.has(e.from_node_id) && loose.has(e.to_node_id)) kept.add(e.to_node_id)
    if (inside.has(e.to_node_id) && loose.has(e.from_node_id)) kept.add(e.from_node_id)
  }
  return {
    ...graph,
    nodes: graph.nodes.filter(n => kept.has(n.id)),
    edges: graph.edges.filter(e => kept.has(e.from_node_id) && kept.has(e.to_node_id)),
    pendingOwnerApprovals: graph.pendingOwnerApprovals.filter(p =>
      keep.has(p.to_project_id) || (!!p.from_project_id && keep.has(p.from_project_id))),
  }
}

/** Pair key the activity route uses: asking project (or external node) | target project | kind. */
function pairKey(from: MeshNode | undefined, to: MeshNode | undefined, kind: string): string | null {
  if (!from || !to?.project_id) return null
  return `${from.project_id || from.id}|${to.project_id}|${kind}`
}

export function MeshPanel({
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
        <Network className="h-10 w-10 text-sky-400" />
        <div>
          <h2 className="text-lg font-semibold text-white">Mesh</h2>
          <p className="mt-1 max-w-sm text-sm text-zinc-400">
            See which agents may ask which, and what they are asking each other right now. Connect your Orquesta account to start.
          </p>
        </div>
        <button
          onClick={onConnect}
          disabled={connecting}
          className="flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-60"
        >
          {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Cloud className="h-4 w-4" />}
          Connect to Orquesta
        </button>
      </div>
    )
  }
  return <MeshView auth={auth} onClose={onClose} />
}

function MeshView({ auth, onClose }: { auth: HostedAuth; onClose: () => void }) {
  const [orgs, setOrgs] = useState<Org[] | null>(null)
  const [orgId, setOrgId] = useState('')
  const [rawGraph, setGraph] = useState<MeshGraph | null>(null)
  const [rawActivity, setActivity] = useState<MeshActivity | null>(null)
  const [biz, setBiz] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    hostedFetch<{ orgs: Org[] }>({ url: `${auth.apiUrl}/api/orquesta-cli/mesh/orgs`, token: auth.token })
      .then(r => {
        if (cancelled) return
        setOrgs(r.orgs)
        const stored = readStored(ORG_KEY)
        setOrgId(r.orgs.find(o => o.id === stored)?.id || r.orgs[0]?.id || '')
      })
      .catch(e => { if (!cancelled) { setOrgs([]); setError(String(e)) } })
    return () => { cancelled = true }
  }, [auth.apiUrl, auth.token])

  const base = `${auth.apiUrl}/api/orquesta-cli/orgs/${orgId}/mesh`
  const load = useCallback(async () => {
    if (!orgId) return
    setLoading(true)
    try {
      const [g, a] = await Promise.all([
        hostedFetch<MeshGraph>({ url: base, token: auth.token }),
        hostedFetch<MeshActivity>({ url: `${base}/activity?limit=30`, token: auth.token }),
      ])
      setGraph(g)
      setActivity(a)
      setError(null)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [base, orgId, auth.token])

  useEffect(() => { if (orgId) setBiz(readStored(`${BIZ_KEY}.${orgId}`)) }, [orgId])

  // Business selector: the canvas, the side panel and the run list all read the narrowed graph.
  const keep = useMemo(() => (rawGraph ? businessProjects(rawGraph, biz) : null), [rawGraph, biz])
  const graph = useMemo(() => (rawGraph ? filterByBusiness(rawGraph, keep) : null), [rawGraph, keep])
  const activity = useMemo(() => (rawActivity && keep ? {
    ...rawActivity,
    runs: rawActivity.runs.filter(r => keep.has(r.to_project_id) || (!!r.from_project_id && keep.has(r.from_project_id))),
  } : rawActivity), [rawActivity, keep])

  const anyInflight = useMemo(() => Object.keys(rawActivity?.inflight || {}).length > 0, [rawActivity])
  useEffect(() => {
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, anyInflight ? INFLIGHT_POLL_MS : IDLE_POLL_MS)
    return () => clearInterval(id)
  }, [load, anyInflight])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (selected) setSelected(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, onClose])

  const switchOrg = (id: string) => {
    setOrgId(id)
    writeStored(ORG_KEY, id)
    setGraph(null)
    setActivity(null)
    setSelected(null)
  }

  const switchBiz = (id: string) => {
    setBiz(id)
    writeStored(`${BIZ_KEY}.${orgId}`, id)
    setSelected(null)
  }
  const businesses = useMemo(
    () => [...(rawGraph?.businesses || [])].sort((a, b) => a.name.localeCompare(b.name)),
    [rawGraph],
  )
  const bizValue = biz === BIZ_NONE || businesses.some(b => b.id === biz) ? biz : ''

  // Workstream sub-nodes stay collapsed into their project, as the dashboard draws them by default.
  const nodes = useMemo(() => (graph?.nodes || []).filter(n => !n.sub_agent_id), [graph])
  const byId = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes])
  const byProject = useMemo(() => new Map(nodes.filter(n => n.project_id).map(n => [n.project_id!, n])), [nodes])
  const nameOfProject = (id: string | null, nodeId?: string | null) =>
    (id && byProject.get(id)?.label) || (nodeId && byId.get(nodeId)?.label) || 'external'

  const totals = activity?.day.totals
  const dashboardUrl = `${auth.apiUrl}/mesh${orgId ? `?org=${orgId}` : ''}`
  const sel = selected ? byId.get(selected) : undefined

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/10 bg-zinc-900/80 px-3 py-2">
        <Network className="h-4 w-4 text-sky-400" />
        <span className="text-sm font-semibold text-white">Mesh</span>
        {orgs && orgs.length > 1 ? (
          <div className="relative">
            <select
              value={orgId}
              onChange={e => switchOrg(e.target.value)}
              className="appearance-none rounded-md bg-zinc-800 py-1 pl-2 pr-6 text-xs text-zinc-200 outline-none hover:bg-zinc-700"
            >
              {orgs.map(o => <option key={o.id} value={o.id}>{o.name}{o.role === 'guest' ? ' (guest)' : ''}</option>)}
            </select>
            <ChevronDown className="pointer-events-none absolute right-1.5 top-1.5 h-3.5 w-3.5 text-zinc-500" />
          </div>
        ) : (
          <span className="text-xs text-zinc-400">{orgs?.[0]?.name || auth.organizationName || ''}</span>
        )}
        {businesses.length > 0 && (
          <div className="relative">
            <select
              value={bizValue}
              onChange={e => switchBiz(e.target.value)}
              aria-label="Business"
              title="Show one business's agents"
              className={`appearance-none rounded-md py-1 pl-2 pr-6 text-xs outline-none hover:bg-zinc-700 ${bizValue ? 'bg-sky-900/60 text-sky-200' : 'bg-zinc-800 text-zinc-200'}`}
            >
              <option value="">All businesses</option>
              {businesses.map(b => <option key={b.id} value={b.id}>{b.name.replace(/^Business · /, '')}</option>)}
              <option value={BIZ_NONE}>Projects outside a business</option>
            </select>
            <ChevronDown className="pointer-events-none absolute right-1.5 top-1.5 h-3.5 w-3.5 text-zinc-500" />
          </div>
        )}
        {graph && (
          <span
            className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase ${ENFORCE_STYLE[graph.enforce] || ENFORCE_STYLE.off}`}
            title="Enforce: off = legacy policies decide, shadow = would-deny is audited, on = no edge, no request"
          >
            enforce {graph.enforce}
          </span>
        )}
        {totals && (
          <span className="flex items-center gap-2 font-mono text-[10px] text-zinc-400" title="Agent-to-agent requests, last 24h">
            <span>{totals.requests} req/24h</span>
            {totals.running > 0 && <span className="text-cyan-300">{totals.running} running</span>}
            {totals.pending > 0 && <span className="text-amber-300">{totals.pending} pending</span>}
            {totals.failed > 0 && <span className="text-red-300">{totals.failed} failed</span>}
            {totals.denied > 0 && <span className="text-zinc-500">{totals.denied} denied</span>}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button onClick={load} className="rounded p-1.5 text-zinc-400 hover:bg-white/10 hover:text-white" title="Refresh">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </button>
          <a
            href={dashboardUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-zinc-300 hover:bg-white/10 hover:text-white"
            title="Edit edges, approve requests and manage Autopilot in the dashboard"
          >
            <ExternalLink className="h-3 w-3" /> Edit in dashboard
          </a>
          <button onClick={onClose} className="rounded p-1.5 text-zinc-400 hover:bg-white/10 hover:text-white" title="Close (Esc)">
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      {error && (
        <div className="flex items-center gap-2 border-b border-red-500/20 bg-red-500/10 px-3 py-1.5 text-xs text-red-300">
          <AlertCircle className="h-3.5 w-3.5" /> {error}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {!graph ? (
            <div className="flex h-full items-center justify-center text-sm text-zinc-500">
              {orgs && !orgs.length ? 'No organization with a mesh for this account.' : <Loader2 className="h-5 w-5 animate-spin" />}
            </div>
          ) : nodes.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-zinc-500">No agents on this mesh yet.</div>
          ) : (
            <MeshCanvas
              graph={graph}
              nodes={nodes}
              byId={byId}
              byProject={byProject}
              activity={activity}
              selected={selected}
              onSelect={setSelected}
            />
          )}
        </div>

        <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-white/10 bg-zinc-900/80">
          {sel && graph ? (
            <NodeDetail node={sel} graph={graph} byId={byId} activity={activity} onClose={() => setSelected(null)} />
          ) : (
            <>
              <section className="border-b border-white/10 p-3">
                <h3 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                  Waiting on a human {graph?.pendingOwnerApprovals.length ? `· ${graph.pendingOwnerApprovals.length}` : ''}
                </h3>
                {!graph?.pendingOwnerApprovals.length ? (
                  <p className="text-[11px] text-zinc-500">Nothing pending.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {graph.pendingOwnerApprovals.map(p => (
                      <li key={p.prompt_id} className="rounded-md border border-amber-500/20 bg-amber-500/5 px-2 py-1.5 text-[11px]">
                        <div className="truncate text-zinc-200">
                          {nameOfProject(p.from_project_id, p.from_node_id)} → {nameOfProject(p.to_project_id)}
                        </div>
                        <div className="flex items-center gap-1.5 font-mono text-[10px] text-zinc-500">
                          <span style={{ color: KIND_COLOR[p.kind] }}>{p.kind}</span>
                          <span>· {p.approver === 'owner' ? 'org admin' : 'target admin'}</span>
                          <span className="ml-auto">{relTime(p.created_at)}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {!!graph?.pendingOwnerApprovals.length && (
                  <a href={dashboardUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-[11px] text-sky-300 hover:underline">
                    Review in dashboard <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </section>
              <section className="p-3">
                <h3 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-zinc-500">Latest runs</h3>
                {!activity?.runs.length ? (
                  <p className="text-[11px] text-zinc-500">No agent-to-agent requests yet.</p>
                ) : (
                  <ul className="space-y-1">
                    {activity.runs.map(r => (
                      <li key={r.prompt_id} className="rounded-md px-2 py-1 text-[11px] hover:bg-white/5">
                        <div className="flex items-center gap-1.5">
                          <RunDot status={r.status} />
                          <span className="truncate text-zinc-200">
                            {r.from_external || nameOfProject(r.from_project_id, r.from_node_id)} → {nameOfProject(r.to_project_id)}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 pl-3.5 font-mono text-[10px] text-zinc-500">
                          <span style={{ color: KIND_COLOR[r.kind] }}>{r.kind}</span>
                          {r.origin === 'auto-agent' && <span className="text-fuchsia-300">auto</span>}
                          {r.duration_ms != null && <span>{Math.round(r.duration_ms / 1000)}s</span>}
                          {r.cost_cents != null && r.cost_cents > 0 && <span>${(r.cost_cents / 100).toFixed(2)}</span>}
                          <span className="ml-auto">{relTime(r.created_at)}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </aside>
      </div>
    </div>
  )
}

function RunDot({ status }: { status: string }) {
  const color =
    status === 'completed' ? 'bg-green-400'
      : status === 'failed' || status === 'cancelled' ? 'bg-red-400'
        : status === 'running' || status === 'evaluating' ? 'bg-cyan-400 animate-pulse'
          : status === 'pending_approval' ? 'bg-amber-400 animate-pulse'
            : 'bg-zinc-500'
  return <span className={`h-2 w-2 shrink-0 rounded-full ${color}`} title={status} />
}

type View = { x: number; y: number; k: number }

function MeshCanvas({
  graph, nodes, byId, byProject, activity, selected, onSelect,
}: {
  graph: MeshGraph
  nodes: MeshNode[]
  byId: Map<string, MeshNode>
  byProject: Map<string, MeshNode>
  activity: MeshActivity | null
  selected: string | null
  onSelect: (id: string | null) => void
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const pos = useMemo(() => layoutNodes(nodes), [nodes])
  const families = useMemo(() => new Map(graph.families.map(f => [f.id, f.color])), [graph.families])
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 })
  const drag = useRef<{ px: number; py: number; vx: number; vy: number; moved: boolean } | null>(null)

  const fit = useCallback(() => {
    const box = boxRef.current
    if (!box || !pos.size) return
    const pts = [...pos.values()]
    const minX = Math.min(...pts.map(p => p.x)) - NODE_R * 3, maxX = Math.max(...pts.map(p => p.x)) + NODE_R * 3
    // Labels hang under the nodes and the legend sits on the bottom edge.
    const minY = Math.min(...pts.map(p => p.y)) - NODE_R * 3, maxY = Math.max(...pts.map(p => p.y)) + NODE_R * 5
    const { width, height } = box.getBoundingClientRect()
    const k = Math.min(2, width / (maxX - minX), height / (maxY - minY))
    setView({ k, x: width / 2 - k * (minX + maxX) / 2, y: height / 2 - k * (minY + maxY) / 2 })
  }, [pos])

  // Fit once per org (a new node set), not on every poll.
  const fitted = useRef('')
  useEffect(() => {
    const sig = nodes.map(n => n.id).join(',')
    if (fitted.current === sig) return
    fitted.current = sig
    fit()
  }, [nodes, fit])

  const onWheel = (e: React.WheelEvent) => {
    const rect = boxRef.current!.getBoundingClientRect()
    const mx = e.clientX - rect.left, my = e.clientY - rect.top
    setView(v => {
      const k = Math.min(4, Math.max(0.15, v.k * Math.exp(-e.deltaY * 0.0015)))
      return { k, x: mx - (mx - v.x) * (k / v.k), y: my - (my - v.y) * (k / v.k) }
    })
  }

  const edgeKeys = useMemo(() => new Set(graph.edges.map(e => {
    const from = byId.get(e.from_node_id), to = byId.get(e.to_node_id)
    return pairKey(from, to, e.kind)
  })), [graph.edges, byId])

  // Traffic with no edge behind it (enforce off/shadow): drawn faint so an org with no edges still sees who talks.
  const observed = useMemo(() => (activity?.observed.pairs || []).flatMap(p => {
    const from = p.from_project_id ? byProject.get(p.from_project_id) : p.from_node_id ? byId.get(p.from_node_id) : undefined
    const to = byProject.get(p.to_project_id)
    if (!from || !to || edgeKeys.has(pairKey(from, to, p.kind))) return []
    return [{ key: `${from.id}|${to.id}|${p.kind}`, from, to, kind: p.kind, count: p.count }]
  }), [activity, byId, byProject, edgeKeys])

  const near = (id: string) => !selected || id === selected || graph.edges.some(e =>
    (e.from_node_id === selected && e.to_node_id === id) || (e.to_node_id === selected && e.from_node_id === id))

  const line = (a: { x: number; y: number }, b: { x: number; y: number }, bend: number) => {
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1
    const ux = dx / len, uy = dy / len
    const sx = a.x + ux * NODE_R, sy = a.y + uy * NODE_R
    const ex = b.x - ux * (NODE_R + 6), ey = b.y - uy * (NODE_R + 6)
    const mx = (sx + ex) / 2 - uy * bend, my = (sy + ey) / 2 + ux * bend
    return `M${sx},${sy} Q${mx},${my} ${ex},${ey}`
  }

  return (
    <div
      ref={boxRef}
      className="h-full w-full cursor-grab select-none overflow-hidden active:cursor-grabbing"
      onWheel={onWheel}
      onPointerDown={e => { drag.current = { px: e.clientX, py: e.clientY, vx: view.x, vy: view.y, moved: false }; (e.target as Element).setPointerCapture?.(e.pointerId) }}
      onPointerMove={e => {
        const d = drag.current
        if (!d) return
        if (Math.abs(e.clientX - d.px) + Math.abs(e.clientY - d.py) > 3) d.moved = true
        setView(v => ({ ...v, x: d.vx + e.clientX - d.px, y: d.vy + e.clientY - d.py }))
      }}
      onPointerUp={e => {
        const d = drag.current
        drag.current = null
        if (d?.moved) return
        const id = (e.target as Element).closest('[data-node]')?.getAttribute('data-node')
        onSelect(id || null)
      }}
    >
      <style>{`
        @keyframes mesh-march { to { stroke-dashoffset: -24 } }
        @keyframes mesh-pulse { 50% { opacity: .35 } }
        .mesh-inflight { stroke-dasharray: 8 4; animation: mesh-march .8s linear infinite }
        .mesh-approval { animation: mesh-pulse 1.4s ease-in-out infinite }
        @media (prefers-reduced-motion: reduce) { .mesh-inflight, .mesh-approval { animation: none } }
      `}</style>
      <svg className="h-full w-full">
        <defs>
          {Object.entries(KIND_COLOR).map(([k, c]) => (
            <marker key={k} id={`mesh-arrow-${k}`} viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill={c} />
            </marker>
          ))}
        </defs>
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {observed.map(o => (
            <path
              key={o.key}
              d={line(pos.get(o.from.id)!, pos.get(o.to.id)!, 0)}
              fill="none"
              stroke="#71717a"
              strokeWidth={1}
              strokeDasharray="2 4"
              opacity={near(o.from.id) && near(o.to.id) ? 0.6 : 0.1}
            >
              <title>{`${o.from.label} → ${o.to.label}: ${o.count} ${o.kind} in 30 days, no edge`}</title>
            </path>
          ))}
          {graph.edges.map(e => {
            const a = pos.get(e.from_node_id), b = pos.get(e.to_node_id)
            if (!a || !b) return null
            const key = pairKey(byId.get(e.from_node_id), byId.get(e.to_node_id), e.kind)
            const fl = key ? activity?.inflight[key] : undefined
            const used = key ? activity?.day.pairs[key] || 0 : 0
            // Both kinds between the same pair: bend them apart.
            const twin = graph.edges.some(o => o.id !== e.id && o.from_node_id === e.from_node_id && o.to_node_id === e.to_node_id)
            const dim = selected && e.from_node_id !== selected && e.to_node_id !== selected
            const color = e.approval === 'deny' ? '#52525b' : fl?.approval ? '#f59e0b' : KIND_COLOR[e.kind] || '#a1a1aa'
            return (
              <path
                key={e.id}
                d={line(a, b, twin ? (e.kind === 'encargo' ? 18 : -18) : 0)}
                fill="none"
                stroke={color}
                strokeWidth={fl?.active ? 2.5 : 1.5}
                strokeDasharray={e.approval === 'deny' ? '4 4' : e.approval === 'auto' ? undefined : '10 3'}
                markerEnd={`url(#mesh-arrow-${e.kind})`}
                opacity={dim ? 0.12 : 0.9}
                className={[fl?.active ? 'mesh-inflight' : '', fl?.approval ? 'mesh-approval' : ''].join(' ')}
              >
                <title>{`${byId.get(e.from_node_id)?.label} → ${byId.get(e.to_node_id)?.label}\n${e.kind} · approval ${e.approval} · ${used}/${e.daily_limit} today${e.capabilities.length ? `\n${e.capabilities.join(', ')}` : ''}`}</title>
              </path>
            )
          })}
          {nodes.map(n => {
            const p = pos.get(n.id)!
            const ring = n.family_id ? families.get(n.family_id) || '#3f3f46' : '#3f3f46'
            const paused = n.status !== 'active'
            return (
              <g key={n.id} data-node={n.id} transform={`translate(${p.x},${p.y})`} className="cursor-pointer" opacity={near(n.id) ? 1 : 0.2}>
                <circle r={NODE_R} fill="#18181b" stroke={n.id === selected ? '#fff' : ring} strokeWidth={n.id === selected ? 3 : 2} strokeDasharray={paused ? '4 3' : undefined} />
                <text textAnchor="middle" dy="0.35em" fontSize={12} fontWeight={600} fill={paused ? '#71717a' : '#e4e4e7'} className="pointer-events-none font-mono">
                  {n.external_kind ? '⇄' : monogram(n.label)}
                </text>
                {n.project_id && (
                  <circle cx={NODE_R * 0.72} cy={-NODE_R * 0.72} r={4.5} fill={n.online ? '#4ade80' : '#52525b'} stroke="#18181b" strokeWidth={1.5} />
                )}
                <text y={NODE_R + 14} textAnchor="middle" fontSize={11} fill="#a1a1aa" className="pointer-events-none">
                  {n.label.length > 22 ? `${n.label.slice(0, 21)}…` : n.label}
                </text>
                <title>{`${n.label}${n.status !== 'active' ? ` (${n.status})` : ''}${n.project_id ? ` · ${n.online ? 'online' : `last seen ${relTime(n.lastSeen)}`}` : ''}`}</title>
              </g>
            )
          })}
        </g>
      </svg>

      <div className="pointer-events-none absolute bottom-2 left-2 flex flex-wrap items-center gap-3 rounded-md bg-zinc-900/80 px-2 py-1 font-mono text-[10px] text-zinc-400">
        <span className="flex items-center gap-1"><span className="h-0.5 w-4" style={{ background: KIND_COLOR.consulta }} />consulta</span>
        <span className="flex items-center gap-1"><span className="h-0.5 w-4" style={{ background: KIND_COLOR.encargo }} />encargo</span>
        <span>solid = auto · dashed = needs approval</span>
        <span className="text-amber-300">amber = waiting approval</span>
        <span>dotted grey = traffic, no edge</span>
      </div>
      <button
        onClick={fit}
        onPointerDown={e => e.stopPropagation()}
        onPointerUp={e => e.stopPropagation()}
        className="absolute right-2 top-2 rounded-md border border-white/10 bg-zinc-900/80 p-1.5 text-zinc-400 hover:text-white"
        title="Fit to screen"
      >
        <Maximize2 className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

function NodeDetail({
  node, graph, byId, activity, onClose,
}: {
  node: MeshNode
  graph: MeshGraph
  byId: Map<string, MeshNode>
  activity: MeshActivity | null
  onClose: () => void
}) {
  const out = graph.edges.filter(e => e.from_node_id === node.id)
  const inc = graph.edges.filter(e => e.to_node_id === node.id)
  const runs = (activity?.runs || []).filter(r =>
    r.to_project_id === node.project_id || (node.project_id ? r.from_project_id === node.project_id : r.from_node_id === node.id))
  const edgeRow = (e: MeshEdge, other: MeshNode | undefined, dir: '→' | '←') => {
    const key = dir === '→' ? pairKey(node, other, e.kind) : pairKey(other, node, e.kind)
    const used = key ? activity?.day.pairs[key] || 0 : 0
    return (
      <li key={e.id} className="flex items-center gap-1.5 text-[11px]">
        <span className="text-zinc-500">{dir}</span>
        <span className="flex-1 truncate text-zinc-200">{other?.label || '?'}</span>
        <span className="font-mono text-[10px]" style={{ color: KIND_COLOR[e.kind] }}>{e.kind}</span>
        <span className="font-mono text-[10px] text-zinc-500" title={`approval ${e.approval}, ${used} of ${e.daily_limit} in 24h`}>
          {e.approval} · {used}/{e.daily_limit}
        </span>
      </li>
    )
  }
  return (
    <div className="p-3">
      <div className="mb-3 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-white">{node.label}</h3>
          <p className="flex items-center gap-1.5 text-[11px] text-zinc-400">
            {node.project_id ? (
              <>
                <span className={`h-1.5 w-1.5 rounded-full ${node.online ? 'bg-green-400' : 'bg-zinc-500'}`} />
                {node.online ? 'online' : `last seen ${relTime(node.lastSeen)}`}
              </>
            ) : node.external_kind ? `external · ${node.external_kind}` : 'proposed'}
            {node.status !== 'active' && <span className="text-amber-300">· {node.status}</span>}
          </p>
        </div>
        <button onClick={onClose} className="rounded p-1 text-zinc-500 hover:bg-white/10 hover:text-white" title="Back (Esc)">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {(node.host || node.version || node.handle) && (
        <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 font-mono text-[10px]">
          {node.host && <><dt className="text-zinc-500">host</dt><dd className="truncate text-zinc-300">{node.host}</dd></>}
          {node.version && <><dt className="text-zinc-500">agent</dt><dd className="text-zinc-300">{node.version}</dd></>}
          {node.handle && <><dt className="text-zinc-500">handle</dt><dd className="truncate text-zinc-300">{node.handle}</dd></>}
        </dl>
      )}
      {node.capabilities.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1">
          {node.capabilities.map(c => <span key={c} className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">{c}</span>)}
        </div>
      )}
      <h4 className="mb-1 font-mono text-[10px] uppercase tracking-wider text-zinc-500">May ask · {out.length}</h4>
      <ul className="mb-3 space-y-1">
        {out.length ? out.map(e => edgeRow(e, byId.get(e.to_node_id), '→')) : <li className="text-[11px] text-zinc-500">No outgoing edges.</li>}
      </ul>
      <h4 className="mb-1 font-mono text-[10px] uppercase tracking-wider text-zinc-500">Asked by · {inc.length}</h4>
      <ul className="mb-3 space-y-1">
        {inc.length ? inc.map(e => edgeRow(e, byId.get(e.from_node_id), '←')) : <li className="text-[11px] text-zinc-500">No incoming edges.</li>}
      </ul>
      <h4 className="mb-1 flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-zinc-500"><Clock className="h-3 w-3" /> Recent runs</h4>
      <ul className="space-y-1">
        {runs.length ? runs.slice(0, 12).map(r => (
          <li key={r.prompt_id} className="flex items-center gap-1.5 text-[11px]">
            <RunDot status={r.status} />
            <span className="flex-1 truncate text-zinc-300">
              {r.to_project_id === node.project_id
                ? `← ${r.from_external || byId.get(r.from_node_id || '')?.label || [...byId.values()].find(n => n.project_id === r.from_project_id)?.label || 'external'}`
                : `→ ${[...byId.values()].find(n => n.project_id === r.to_project_id)?.label || '?'}`}
            </span>
            <span className="font-mono text-[10px] text-zinc-500">{relTime(r.created_at)}</span>
          </li>
        )) : <li className="text-[11px] text-zinc-500">None in the latest runs.</li>}
      </ul>
    </div>
  )
}
