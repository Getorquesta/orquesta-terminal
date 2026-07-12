/**
 * Orquesta Terminal — Custom Server
 * Runs Next.js + Socket.io with built-in PTY spawning.
 * No external backend needed — terminals work standalone.
 */
import { createServer } from 'http'
import { parse } from 'url'
import next from 'next'
import { Server as SocketServer } from 'socket.io'
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client'
import { spawn, execSync } from 'child_process'
import * as os from 'os'
import * as path from 'path'
import { promises as fsp } from 'fs'

const dev = process.env.NODE_ENV !== 'production'
const port = parseInt(process.env.PORT || '4000', 10)
const app = next({ dev })
const handle = app.getRequestHandler()

// Try to load node-pty (optional — if not available, terminals won't work)
let ptyModule: any = null
try {
  ptyModule = require('@homebridge/node-pty-prebuilt-multiarch')
} catch {
  try {
    ptyModule = require('node-pty')
  } catch {
    console.warn('[terminal] node-pty not available — install @homebridge/node-pty-prebuilt-multiarch for local terminals')
  }
}

// ── Hosted hook enrollment ───────────────────────────────────────────────────
//
// When a terminal pane is bound to a hosted project, we enrol its working
// directory so BOTH local CLIs self-report prompts to the hosted timeline:
//   • claude  → via the .claude/settings.json UserPromptSubmit/PostToolUse/Stop
//     hooks (they shell out to `orquesta-agent hook <event>`).
//   • orquesta-cli → via its built-in prompt-reporter, which keys off
//     .orquesta.json.
// This is the handler the cockpit UI (AgentGrid `hook:init-project`) has always
// emitted but the standalone server never implemented — so panes "connected" to
// a project streamed as a viewer but logged NO prompts. That was the bug.

const HOME_DIR = os.homedir()

// The pane's working directory. Falls back to $HOME (where a default pane's PTY
// actually spawns) — NEVER process.cwd(), which here is the cockpit repo dir.
function hookTargetDir(cwd?: string): string {
  return cwd || process.env.ORQUESTA_WORKDIR || HOME_DIR
}

// Refuse to enrol the home directory itself: writing hooks into ~/.claude/
// settings.json would make EVERY claude session on the machine report to this
// project, and a ~/.orquesta.json would capture every orquesta-cli run under
// $HOME. Enrollment must target a real project folder.
function isEnrollableDir(dir: string): boolean {
  try {
    return path.resolve(dir) !== path.resolve(HOME_DIR)
  } catch {
    return false
  }
}

// Resolve the orquesta-agent binary (needed only for the claude hooks; the
// orquesta-cli path works off .orquesta.json alone).
function resolveOrquestaAgentBin(): string | null {
  try {
    const probe = process.platform === 'win32' ? 'where orquesta-agent' : 'command -v orquesta-agent'
    const resolved = execSync(probe, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/)[0]
      .trim()
    return resolved || null
  } catch {
    return null
  }
}

// Read the enrolled project (never the token) from an existing .orquesta.json.
async function readHookStatus(dir: string): Promise<{ configured: boolean; projectId?: string | null; projectName?: string | null; apiUrl?: string | null }> {
  try {
    const raw = await fsp.readFile(path.join(dir, '.orquesta.json'), 'utf8')
    const cfg = JSON.parse(raw)
    return {
      configured: true,
      projectId: cfg.projectId || null,
      projectName: cfg.projectName || null,
      apiUrl: cfg.apiUrl || null,
    }
  } catch {
    return { configured: false }
  }
}

// ── Daemon takeover ──────────────────────────────────────────────────────────
//
// "Make this the project agent": promote a local terminal into the daemon that
// receives dispatched prompts from getorquesta.com (channel agent:project-{id}).
// We mint a project-scoped oat_ (via the oclt_-authed cockpit endpoint) and
// spawn the canonical `orquesta-agent --daemon`, which speaks the hosted
// protocol (validate/heartbeat + ws-client). NOTE: the legacy OSS agent/index.js
// only talks to a local OSS backend, so it would NOT receive hosted dispatch —
// the real hosted daemon is always orquesta-agent.
//
// Daemons are machine-level and keyed by projectId; they deliberately OUTLIVE
// the socket that started them (closing the browser tab must not kill the
// agent). Status is broadcast to every connected cockpit client.

interface DaemonInfo {
  projectId: string
  projectName?: string
  tokenName: string
  tokenId?: string
  cwd: string
  pid?: number
  startedAt: number
  child: ReturnType<typeof spawn>
  logTail: string[] // last N log lines for late status requests
}
const daemons = new Map<string, DaemonInfo>()
const DAEMON_LOG_TAIL = 60

function daemonPublic(d: DaemonInfo) {
  return {
    projectId: d.projectId,
    projectName: d.projectName,
    tokenName: d.tokenName,
    pid: d.pid,
    cwd: d.cwd,
    startedAt: d.startedAt,
    running: !!d.child && d.child.exitCode === null,
  }
}

app.prepare().then(() => {
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url!, true)
    handle(req, res, parsedUrl)
  })

  const io = new SocketServer(server, {
    path: '/api/socket',
    cors: { origin: '*' },
  })

  // Track active PTY sessions
  const sessions = new Map<string, any>()

  // ── Share-to-Orquesta bridge ─────────────────────────────────────────
  // When a user clicks "Share terminal" on a pane, we stream that PTY over the
  // Orquesta WS (ws.orquesta.live) onto channel agent:project-{id} as the same
  // session:started/session:output events the getorquesta.com dashboard already
  // consumes (InteractiveSession). Teammates open it from the "Shared Terminals"
  // sub-tab. A DB row (via the oclt_-authed REST API) is the read-model so the
  // list survives even if no one had the dashboard open at share time.
  const WS_URL = process.env.ORQUESTA_WS_URL || 'https://ws.orquesta.live'
  const MAX_SHARE_BUFFER = 200_000 // ~200 KB scrollback replayed to late joiners
  const HOSTNAME = os.hostname()

  interface SharedInfo {
    sessionId: string
    projectId: string
    channel: string
    apiUrl: string
    cliToken: string
    cliType: string
    cwd?: string
    allowControl: boolean
    buffer: string
    cloud: ClientSocket
  }
  const sharedTerminals = new Map<string, SharedInfo>()
  // One cloud socket per (apiUrl+cliToken+projectId) — reference-counted by share.
  const cloudConns = new Map<string, { socket: ClientSocket; refs: Set<string> }>()
  // Presence: who (dashboard viewers) is currently watching each shared session.
  // sessionId → (viewerId → { name, lastSeen }). Viewers announce themselves with
  // session:viewer_join over the WS channel and heartbeat it; we prune stale ones.
  const sessionViewers = new Map<string, Map<string, { name: string; lastSeen: number }>>()
  const VIEWER_STALE_MS = 70_000

  function connKey(apiUrl: string, cliToken: string, projectId: string) {
    return `${apiUrl}::${cliToken.slice(0, 12)}::${projectId}`
  }

  // Push the current viewer list for a session to the LOCAL cockpit UI (the pane
  // that owns this PTY filters by sessionId). Broadcast to all local clients.
  function emitViewers(sessionId: string) {
    const m = sessionViewers.get(sessionId)
    const viewers = m ? Array.from(m.entries()).map(([id, v]) => ({ id, name: v.name })) : []
    io.emit('terminal:viewers', { sessionId, viewers })
  }

  async function registerShare(s: SharedInfo, label: string) {
    try {
      await fetch(`${s.apiUrl}/api/orquesta-cli/projects/${s.projectId}/shared-terminals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.cliToken}` },
        body: JSON.stringify({
          sessionId: s.sessionId,
          cliType: s.cliType,
          cwd: s.cwd,
          host: HOSTNAME,
          label,
          allowControl: s.allowControl,
        }),
      })
    } catch (err) {
      console.error('[share] register failed:', err)
    }
  }

  async function patchShare(s: SharedInfo, patch: Record<string, unknown>) {
    try {
      await fetch(`${s.apiUrl}/api/orquesta-cli/projects/${s.projectId}/shared-terminals`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.cliToken}` },
        body: JSON.stringify({ sessionId: s.sessionId, ...patch }),
      })
    } catch (err) {
      console.error('[share] patch failed:', err)
    }
  }

  // Cloud → PTY: viewers with control send input/resize; late joiners request a
  // buffer replay. All keyed by sessionId and gated on allow_control.
  function wireCloudHandlers(cloud: ClientSocket) {
    cloud.on('session:input', (p: any) => {
      const s = sharedTerminals.get(p?.sessionId)
      if (!s || !s.allowControl) return
      const term = sessions.get(s.sessionId)
      if (term) term.write(p.input ?? p.data ?? '')
    })
    cloud.on('session:resize', (p: any) => {
      const s = sharedTerminals.get(p?.sessionId)
      if (!s || !s.allowControl) return
      const term = sessions.get(s.sessionId)
      if (term) try { term.resize(p.cols, p.rows) } catch {}
    })
    cloud.on('session:sync_request', (p: any) => {
      const s = sharedTerminals.get(p?.sessionId)
      if (!s || !s.buffer) return
      s.cloud.emit('broadcast', {
        channel: s.channel, event: 'session:output',
        payload: { sessionId: s.sessionId, data: s.buffer }, self: false,
      })
    })
    // Presence: a dashboard viewer opened / heartbeats this shared terminal.
    cloud.on('session:viewer_join', (p: any) => {
      const sid = p?.sessionId
      if (!sid || !sharedTerminals.has(sid) || !p?.viewer?.id) return
      let m = sessionViewers.get(sid)
      if (!m) { m = new Map(); sessionViewers.set(sid, m) }
      m.set(String(p.viewer.id), { name: String(p.viewer.name || 'Someone'), lastSeen: Date.now() })
      emitViewers(sid)
    })
    cloud.on('session:viewer_leave', (p: any) => {
      const sid = p?.sessionId
      const m = sid ? sessionViewers.get(sid) : undefined
      if (!m || !p?.viewerId) return
      if (m.delete(String(p.viewerId))) emitViewers(sid)
    })
    // Live cursors: a dashboard viewer (or another viewer) moved their mouse
    // over the shared terminal. Relay it to the LOCAL cockpit UI so the pane
    // that owns this PTY can draw their pointer. We only forward cursors for a
    // session we actually host (avoids leaking foreign channel traffic).
    cloud.on('terminal:cursor', (p: any) => {
      if (p?.sessionId && sharedTerminals.has(p.sessionId)) io.emit('terminal:cursor', p)
    })
  }

  async function startShare(opts: {
    sessionId: string; projectId: string; apiUrl: string; cliToken: string
    cliType: string; cwd?: string; label?: string; allowControl: boolean
  }): Promise<{ ok: boolean; error?: string }> {
    if (!sessions.has(opts.sessionId)) return { ok: false, error: 'Session not running' }
    const apiUrl = (opts.apiUrl || 'https://getorquesta.com').replace(/\/$/, '')
    const channel = `agent:project-${opts.projectId}`
    const key = connKey(apiUrl, opts.cliToken, opts.projectId)

    let conn = cloudConns.get(key)
    if (!conn) {
      const socket = ioClient(WS_URL, {
        transports: ['websocket', 'polling'],
        auth: { cliToken: opts.cliToken },
        reconnection: true,
      })
      conn = { socket, refs: new Set() }
      cloudConns.set(key, conn)
      wireCloudHandlers(socket)
      socket.on('connect', () => socket.emit('subscribe', { channel }))
      if (socket.connected) socket.emit('subscribe', { channel })
    }
    conn.refs.add(opts.sessionId)

    const label = opts.label || `${HOSTNAME} — ${opts.cliType}`
    const info: SharedInfo = {
      sessionId: opts.sessionId, projectId: opts.projectId, channel, apiUrl,
      cliToken: opts.cliToken, cliType: opts.cliType, cwd: opts.cwd,
      allowControl: opts.allowControl, buffer: '', cloud: conn.socket,
    }
    sharedTerminals.set(opts.sessionId, info)

    await registerShare(info, label)
    // Announce the live session on the channel (dashboard InteractiveSession +
    // SharedTerminalViewer both key off session:started / session:output).
    conn.socket.emit('broadcast', {
      channel, event: 'session:started',
      payload: { sessionId: opts.sessionId, cliType: opts.cliType, workingDirectory: opts.cwd || HOSTNAME },
      self: false,
    })
    // Ask any viewers already on the channel to re-announce their presence.
    conn.socket.emit('broadcast', {
      channel, event: 'session:viewer_ping', payload: { sessionId: opts.sessionId }, self: false,
    })
    emitViewers(opts.sessionId)
    return { ok: true }
  }

  async function stopShare(sessionId: string, opts: { emitEnded?: boolean } = {}) {
    const s = sharedTerminals.get(sessionId)
    if (!s) return
    sharedTerminals.delete(sessionId)
    sessionViewers.delete(sessionId)
    emitViewers(sessionId)
    if (opts.emitEnded) {
      s.cloud.emit('broadcast', {
        channel: s.channel, event: 'session:ended',
        payload: { sessionId, exitCode: 0 }, self: false,
      })
    }
    await patchShare(s, { status: 'closed' })
    const key = connKey(s.apiUrl, s.cliToken, s.projectId)
    const conn = cloudConns.get(key)
    if (conn) {
      conn.refs.delete(sessionId)
      if (conn.refs.size === 0) {
        try { conn.socket.disconnect() } catch {}
        cloudConns.delete(key)
      }
    }
  }

  // Heartbeat: keep last_active_at fresh so the dashboard read-model can dim/
  // sweep stale shares.
  const shareHeartbeat = setInterval(() => {
    for (const s of sharedTerminals.values()) patchShare(s, {})
  }, 60_000)
  shareHeartbeat.unref?.()

  // Drop viewers who stopped heartbeating (closed the tab without a clean leave).
  const viewerPrune = setInterval(() => {
    const now = Date.now()
    for (const [sid, m] of sessionViewers) {
      let changed = false
      for (const [vid, v] of m) {
        if (now - v.lastSeen > VIEWER_STALE_MS) { m.delete(vid); changed = true }
      }
      if (changed) emitViewers(sid)
    }
  }, 30_000)
  viewerPrune.unref?.()

  // ── Terminal Monitor (live activity log broadcast to all clients) ──
  const activityAt = new Map<string, number>()
  const stripAnsi = (s: string) =>
    s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')

  function logTerminal(level: string, message: string, sessionId: string, extra: Record<string, unknown> = {}) {
    io.emit('log', { level, type: 'session', message, sessionId, timestamp: Date.now(), ...extra })
  }

  function logActivity(sessionId: string, label: string, data: string) {
    const now = Date.now()
    if (now - (activityAt.get(sessionId) || 0) < 1500) return
    const line = stripAnsi(data).split('\n').map(l => l.trim()).filter(Boolean).pop()
    if (!line) return
    activityAt.set(sessionId, now)
    io.emit('log', {
      level: 'info', type: 'output', sessionId, cli: label, timestamp: now,
      message: line.slice(0, 200),
    })
  }

  io.on('connection', (socket) => {
    console.log('[terminal] Client connected:', socket.id)

    // ── Directory browser (folder picker) ───────────────────────────────
    // Lists sub-directories of a path so the cockpit can pick a working dir for
    // a new terminal. Read-only, directories only. This runs on the user's own
    // machine (localhost cockpit) listing their own filesystem — the same trust
    // model as the local agent UI's working-dir browser.
    socket.on('fs:list-dir', async ({ path: reqPath }: { path?: string } = {}) => {
      try {
        const target = reqPath && reqPath.trim() ? path.resolve(reqPath) : HOME_DIR
        const dirents = await fsp.readdir(target, { withFileTypes: true })
        const entries = dirents
          .filter((d: import('fs').Dirent) => {
            // Directories (and symlinks that may point at directories), no dotfiles.
            if (d.name.startsWith('.')) return false
            return d.isDirectory() || d.isSymbolicLink()
          })
          .map((d: import('fs').Dirent) => ({ name: d.name, path: path.join(target, d.name) }))
          .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))
        const parent = path.dirname(target)
        socket.emit('fs:list-dir-result', {
          ok: true,
          path: target,
          parent: parent !== target ? parent : null,
          home: HOME_DIR,
          entries,
        })
      } catch (err: any) {
        socket.emit('fs:list-dir-result', { ok: false, path: reqPath || HOME_DIR, error: err.message })
      }
    })

    // Spawn a PTY session
    socket.on('session:start', ({ sessionId, cliType = 'shell', rows = 24, cols = 80, cwd, resumeId }) => {
      if (!ptyModule) {
        socket.emit('session:error', { sessionId, error: 'node-pty not installed' })
        return
      }

      const shell = process.env.SHELL || (process.platform === 'win32' ? 'cmd.exe' : '/bin/bash')
      let command = shell
      let args: string[] = []

      switch (cliType) {
        case 'claude': command = 'claude'; if (resumeId) args = ['--resume', resumeId]; break
        case 'orquesta': command = 'orquesta'; if (resumeId) args = ['--resume', resumeId]; break
        case 'kimi': command = 'kimi'; break
        case 'kiro': command = 'kiro-cli'; args = ['chat']; if (resumeId) args.push('--resume-id', resumeId); break
        case 'opencode': command = 'opencode'; break
      }

      // Imported panes spawn in the original session's directory when it exists.
      let spawnCwd = process.env.HOME || process.cwd()
      if (cwd) {
        try { if (require('fs').statSync(cwd).isDirectory()) spawnCwd = cwd } catch {}
      }

      try {
        const term = ptyModule.spawn(command, args, {
          name: 'xterm-256color',
          rows,
          cols,
          cwd: spawnCwd,
          env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        })

        sessions.set(sessionId, term)

        term.onData((data: string) => {
          socket.emit('session:output', { sessionId, data })
          logActivity(sessionId, cliType, data)
          // Mirror to Orquesta if this pane is shared.
          const shared = sharedTerminals.get(sessionId)
          if (shared) {
            shared.buffer += data
            if (shared.buffer.length > MAX_SHARE_BUFFER) {
              shared.buffer = shared.buffer.slice(-MAX_SHARE_BUFFER)
            }
            shared.cloud.emit('broadcast', {
              channel: shared.channel, event: 'session:output',
              payload: { sessionId, data }, self: false,
            })
          }
        })

        term.onExit(() => {
          sessions.delete(sessionId)
          activityAt.delete(sessionId)
          socket.emit('session:ended', { sessionId })
          if (sharedTerminals.has(sessionId)) stopShare(sessionId, { emitEnded: true })
          logTerminal('warn', `■ ${cliType} session ended`, sessionId, { cli: cliType, event: 'ended' })
        })

        socket.emit('session:started', { sessionId, cliType })
        logTerminal('success', `▶ ${cliType} session started`, sessionId, { cli: cliType, event: 'started', pid: term.pid })
      } catch (err: any) {
        socket.emit('session:error', { sessionId, error: err.message })
        logTerminal('error', `✕ ${cliType} failed: ${err.message}`, sessionId, { cli: cliType, event: 'error' })
      }
    })

    socket.on('session:input', ({ sessionId, data }) => {
      const term = sessions.get(sessionId)
      if (term) term.write(data)
    })

    // Live cursor from the LOCAL cockpit pane (the sharer's own mouse) → relay
    // out to the dashboard viewers over the shared channel. No-op if the pane
    // isn't shared. Coordinates are fractional (0..1) of the terminal viewport
    // so every participant maps them onto their own sized terminal.
    socket.on('terminal:cursor', (p: any) => {
      const s = p?.sessionId ? sharedTerminals.get(p.sessionId) : undefined
      if (!s) return
      s.cloud.emit('broadcast', {
        channel: s.channel, event: 'terminal:cursor', payload: p, self: false,
      })
    })

    socket.on('session:resize', ({ sessionId, rows, cols }) => {
      const term = sessions.get(sessionId)
      if (term) try { term.resize(cols, rows) } catch {}
    })

    socket.on('session:end', ({ sessionId }) => {
      const term = sessions.get(sessionId)
      if (term) { term.kill(); sessions.delete(sessionId) }
      if (sharedTerminals.has(sessionId)) stopShare(sessionId, { emitEnded: true })
    })

    // Emitted by the client on pane unmount — same as session:end (the previous
    // omission leaked PTYs when a pane was closed via React teardown).
    socket.on('session:force_end', ({ sessionId }) => {
      const term = sessions.get(sessionId)
      if (term) { term.kill(); sessions.delete(sessionId) }
      if (sharedTerminals.has(sessionId)) stopShare(sessionId, { emitEnded: true })
    })

    // ── Hosted hook enrollment (report local CLI prompts to the timeline) ─
    //
    // Dashboard/cockpit asks: is this dir already hooked, and to which project?
    socket.on('hook:status', async ({ cwd }: { cwd?: string } = {}) => {
      const dir = hookTargetDir(cwd)
      const status = await readHookStatus(dir)
      socket.emit('hook:status_result', { cwd: dir, ...status })
    })

    // Enrol the pane's working dir into a hosted project: write .orquesta.json
    // (+ .gitignore it) and, when orquesta-agent is on PATH, the claude hooks.
    socket.on(
      'hook:init-project',
      async ({ token, apiUrl, projectId, projectName, cwd }: {
        token?: string; apiUrl?: string; projectId?: string; projectName?: string; cwd?: string
      } = {}) => {
        const dir = hookTargetDir(cwd)
        const emitResult = (ok: boolean, message: string, extra: Record<string, unknown> = {}) =>
          socket.emit('hook:result', { ok, cwd: dir, message, ...extra })

        if (!token || !projectId) {
          return emitResult(false, 'Token and projectId are required.')
        }
        if (!isEnrollableDir(dir)) {
          return emitResult(
            false,
            'This terminal is running in your home directory. Open it in the project’s folder (set the pane’s working directory) to enable prompt logging — enrolling $HOME would hook every session on the machine.',
          )
        }

        try {
          const orquestaJson = path.join(dir, '.orquesta.json')
          const config = {
            projectId,
            ...(projectName ? { projectName } : {}),
            token,
            apiUrl: apiUrl || 'https://getorquesta.com',
          }
          await fsp.writeFile(orquestaJson, JSON.stringify(config, null, 2) + '\n')

          // .gitignore — the file holds a token, keep it out of git.
          const gitignorePath = path.join(dir, '.gitignore')
          try {
            const existing = await fsp.readFile(gitignorePath, 'utf8').catch(() => '')
            if (!existing.includes('.orquesta.json')) {
              await fsp.appendFile(gitignorePath, '\n# Orquesta hook config (contains token)\n.orquesta.json\n')
            }
          } catch { /* .gitignore is best-effort */ }

          // .claude/settings.json — add hooks only if orquesta-agent is present.
          const bin = resolveOrquestaAgentBin()
          let claudeHooked = false
          if (bin) {
            const claudeDir = path.join(dir, '.claude')
            const settingsPath = path.join(claudeDir, 'settings.json')
            await fsp.mkdir(claudeDir, { recursive: true })

            let settings: any = {}
            try { settings = JSON.parse(await fsp.readFile(settingsPath, 'utf8')) } catch { /* new file */ }
            if (!settings.hooks) settings.hooks = {}

            const hookCmd = (event: string) => `${bin} hook ${event}`
            const hookEntries: Record<string, any> = {
              UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookCmd('prompt-submit') }] }],
              PostToolUse: [{ matcher: 'Edit|Write|Bash|Read|Glob|Grep', hooks: [{ type: 'command', command: hookCmd('tool-use'), async: true }] }],
              Stop: [{ hooks: [{ type: 'command', command: hookCmd('stop') }] }],
            }

            for (const [event, entry] of Object.entries(hookEntries)) {
              if (!settings.hooks[event]) {
                settings.hooks[event] = entry
              } else if (Array.isArray(settings.hooks[event])) {
                const has = settings.hooks[event].some((e: any) =>
                  e.hooks?.some((h: any) => h.command?.includes('orquesta-agent hook')),
                )
                if (!has) settings.hooks[event] = [...settings.hooks[event], ...entry]
              }
            }

            await fsp.writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n')
            claudeHooked = true
          }

          emitResult(
            true,
            claudeHooked
              ? `Hooked "${projectName || projectId}" — restart the CLI in this pane so prompts start logging.`
              : `Enrolled "${projectName || projectId}" for orquesta-cli. Install orquesta-agent (npm i -g orquesta-agent) to also log claude prompts.`,
            { configured: true, projectId, projectName, claudeHooked },
          )
          console.log(`[terminal] Hook configured for project "${projectName || projectId}" in ${dir}`)
        } catch (err: any) {
          emitResult(false, `Failed to write hook files: ${err.message}`)
        }
      },
    )

    // ── Daemon takeover ─────────────────────────────────────────────────
    // Pre-flight: list agents already online for this project so the UI can
    // warn about a competing daemon before the user confirms takeover.
    socket.on('daemon:preflight', async ({ apiUrl, cliToken, projectId }: {
      apiUrl?: string; cliToken?: string; projectId?: string
    } = {}) => {
      const base = (apiUrl || 'https://getorquesta.com').replace(/\/$/, '')
      if (!cliToken || !projectId) {
        return socket.emit('daemon:preflight-result', { ok: false, error: 'Missing token or projectId', projectId })
      }
      try {
        const res = await fetch(`${base}/api/v1/agents`, {
          headers: { Authorization: `Bearer ${cliToken}` },
        })
        if (!res.ok) {
          return socket.emit('daemon:preflight-result', { ok: false, error: `Agent list failed (${res.status})`, projectId })
        }
        const data = await res.json().catch(() => ({}))
        const list: any[] = Array.isArray(data) ? data : (data.agents || data.data || [])
        const forProject = list.filter((a) => (a.project_id || a.projectId) === projectId)
        const online = forProject.filter((a) => {
          if (a.status) return a.status === 'online'
          const last = a.last_seen || a.last_used_at
          return last ? Date.now() - new Date(last).getTime() < 3 * 60_000 : false
        })
        const existing = daemons.get(projectId)
        socket.emit('daemon:preflight-result', {
          ok: true,
          projectId,
          online: online.map((a) => ({
            id: a.id,
            name: a.name || 'Agent',
            lastSeen: a.last_seen || a.last_used_at || null,
          })),
          totalTokens: forProject.length,
          localDaemon: existing ? daemonPublic(existing) : null,
        })
      } catch (err: any) {
        socket.emit('daemon:preflight-result', { ok: false, error: err.message || 'Pre-flight failed', projectId })
      }
    })

    // Start (or report) the local daemon for a project.
    socket.on('daemon:start', async ({ apiUrl, cliToken, projectId, projectName, cwd }: {
      apiUrl?: string; cliToken?: string; projectId?: string; projectName?: string; cwd?: string
    } = {}) => {
      const base = (apiUrl || 'https://getorquesta.com').replace(/\/$/, '')
      const emit = (ok: boolean, message: string, extra: Record<string, unknown> = {}) =>
        socket.emit('daemon:result', { ok, projectId, message, ...extra })

      if (!cliToken || !projectId) return emit(false, 'Missing token or projectId.')

      // Idempotent: one daemon per project.
      const running = daemons.get(projectId)
      if (running && running.child.exitCode === null) {
        return emit(true, `Already running as the project agent (pid ${running.pid}).`, { daemon: daemonPublic(running) })
      }

      const bin = resolveOrquestaAgentBin()
      if (!bin) {
        return emit(false, 'orquesta-agent is not installed on this machine. Install it with:  npm i -g orquesta-agent')
      }

      // Mint a fresh project-scoped oat_ via the oclt_-authed cockpit endpoint.
      let oat: string
      let tokenName = 'Cockpit daemon'
      let tokenId: string | undefined
      try {
        const res = await fetch(`${base}/api/orquesta-cli/projects/${projectId}/agent-token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cliToken}` },
          body: JSON.stringify({ name: `Cockpit daemon (${HOSTNAME})` }),
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          return emit(false, `Could not mint an agent token (${res.status}). ${body.error || ''}`.trim())
        }
        const minted = await res.json()
        oat = minted.token
        tokenName = minted.name || tokenName
        tokenId = minted.id
        if (!oat) return emit(false, 'Token endpoint returned no token.')
      } catch (err: any) {
        return emit(false, `Token minting failed: ${err.message}`)
      }

      const workDir = hookTargetDir(cwd)
      let child
      try {
        child = spawn(bin, ['--token', oat, '--daemon', '--working-dir', workDir], {
          cwd: workDir,
          env: { ...process.env, ORQUESTA_API_URL: base },
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
        })
      } catch (err: any) {
        return emit(false, `Failed to spawn orquesta-agent: ${err.message}`)
      }

      const info: DaemonInfo = {
        projectId,
        projectName,
        tokenName,
        tokenId,
        cwd: workDir,
        pid: child.pid,
        startedAt: Date.now(),
        child,
        logTail: [],
      }
      daemons.set(projectId, info)

      const pushLog = (line: string) => {
        const clean = line.replace(/\r/g, '')
        info.logTail.push(clean)
        if (info.logTail.length > DAEMON_LOG_TAIL) info.logTail.shift()
        io.emit('daemon:log', { projectId, line: clean })
      }
      child.stdout?.on('data', (d) => String(d).split('\n').filter(Boolean).forEach(pushLog))
      child.stderr?.on('data', (d) => String(d).split('\n').filter(Boolean).forEach(pushLog))
      child.on('exit', (code, signal) => {
        io.emit('daemon:status', { projectId, running: false, exitCode: code, signal })
        // Keep the record briefly so a status request can report the exit, then drop.
        const cur = daemons.get(projectId)
        if (cur && cur.child === child) daemons.delete(projectId)
      })
      child.on('error', (err) => pushLog(`[spawn error] ${err.message}`))

      io.emit('daemon:status', daemonPublic(info))
      emit(true, `This terminal is now the project agent for "${projectName || projectId}" (pid ${child.pid}). It will receive dispatched prompts.`, { daemon: daemonPublic(info) })
      console.log(`[terminal] Daemon started for project "${projectName || projectId}" pid=${child.pid} cwd=${workDir}`)
    })

    // Stop the local daemon for a project.
    socket.on('daemon:stop', ({ projectId }: { projectId?: string } = {}) => {
      if (!projectId) return
      const d = daemons.get(projectId)
      if (!d) return socket.emit('daemon:result', { ok: false, projectId, message: 'No local daemon is running for this project.' })
      try {
        d.child.kill('SIGTERM')
        // Escalate if it doesn't exit promptly.
        const child = d.child
        setTimeout(() => { if (child.exitCode === null) { try { child.kill('SIGKILL') } catch { /* gone */ } } }, 4000)
      } catch { /* already gone */ }
      daemons.delete(projectId)
      io.emit('daemon:status', { projectId, running: false, stopped: true })
      socket.emit('daemon:result', { ok: true, projectId, message: 'Stopped the local project agent.' })
      console.log(`[terminal] Daemon stopped for project ${projectId}`)
    })

    // Report current daemon status (for a project, or all).
    socket.on('daemon:status-request', ({ projectId }: { projectId?: string } = {}) => {
      if (projectId) {
        const d = daemons.get(projectId)
        socket.emit('daemon:status', d ? { ...daemonPublic(d), logTail: d.logTail } : { projectId, running: false })
      } else {
        socket.emit('daemon:status-all', Array.from(daemons.values()).map(daemonPublic))
      }
    })

    // ── Share terminal to Orquesta ──────────────────────────────────────
    socket.on('terminal:share', async (opts: {
      sessionId: string; projectId: string; apiUrl: string; cliToken: string
      cliType?: string; cwd?: string; label?: string; allowControl?: boolean
    }, ack?: (r: { ok: boolean; error?: string }) => void) => {
      if (!opts?.sessionId || !opts?.projectId || !opts?.cliToken) {
        const r = { ok: false, error: 'sessionId, projectId and cliToken required' }
        ack?.(r); socket.emit('terminal:share-status', { sessionId: opts?.sessionId, ...r }); return
      }
      const result = await startShare({
        sessionId: opts.sessionId, projectId: opts.projectId, apiUrl: opts.apiUrl,
        cliToken: opts.cliToken, cliType: opts.cliType || 'shell', cwd: opts.cwd,
        label: opts.label, allowControl: opts.allowControl === true,
      })
      ack?.(result)
      socket.emit('terminal:share-status', {
        sessionId: opts.sessionId, shared: result.ok, error: result.error,
        allowControl: opts.allowControl === true,
      })
    })

    socket.on('terminal:unshare', async ({ sessionId }: { sessionId: string }) => {
      await stopShare(sessionId, { emitEnded: true })
      socket.emit('terminal:share-status', { sessionId, shared: false })
    })

    socket.on('terminal:share-control', async ({ sessionId, allowControl }: { sessionId: string; allowControl: boolean }) => {
      const s = sharedTerminals.get(sessionId)
      if (!s) return
      s.allowControl = allowControl === true
      await patchShare(s, { allowControl: s.allowControl })
      socket.emit('terminal:share-status', { sessionId, shared: true, allowControl: s.allowControl })
    })

    // ── External Session Detection (import running CLIs) ──────────────
    const fs = require('fs')
    const fsp = require('fs/promises')
    const path = require('path')
    const os = require('os')
    const activeTailers = new Map<string, { stop: () => void }>()

    function claudeProjectsRoot() {
      return path.join(os.homedir(), '.claude', 'projects')
    }

    function decodeDirName(encoded: string) {
      return '/' + encoded.replace(/^-/, '').replace(/-/g, '/')
    }

    socket.on('sessions:external-list', async () => {
      try {
        const root = claudeProjectsRoot()
        let projectDirs: string[]
        try { projectDirs = await fsp.readdir(root) } catch { projectDirs = [] }

        const found: any[] = []
        const now = Date.now()
        const RECENT_MS = 30 * 60 * 1000

        for (const dir of projectDirs) {
          const dirPath = path.join(root, dir)
          let files: string[]
          try { files = await fsp.readdir(dirPath) } catch { continue }

          for (const file of files) {
            if (!file.endsWith('.jsonl')) continue
            const filePath = path.join(dirPath, file)
            try {
              const stat = await fsp.stat(filePath)
              if (now - stat.mtimeMs > RECENT_MS) continue
              found.push({
                id: file.replace('.jsonl', ''),
                cwd: decodeDirName(dir),
                file: filePath,
                lastActivity: stat.mtimeMs,
                size: stat.size,
                isActive: now - stat.mtimeMs < 60_000,
              })
            } catch { continue }
          }
        }

        found.sort((a, b) => b.lastActivity - a.lastActivity)
        socket.emit('sessions:external-list-result', { sessions: found.slice(0, 20) })
      } catch (err: any) {
        socket.emit('sessions:external-list-result', { sessions: [], error: err.message })
      }
    })

    socket.on('sessions:external-attach', async ({ sessionId, file }: { sessionId: string; file: string }) => {
      if (!sessionId || !file) return
      if (activeTailers.has(sessionId)) return

      let offset = 0
      let stopped = false

      // Read last 50 lines
      try {
        const content = await fsp.readFile(file, 'utf8')
        const lines = content.trim().split('\n')
        offset = Buffer.byteLength(content)
        for (const line of lines.slice(-50)) {
          try {
            socket.emit('sessions:external-data', { sessionId, entry: JSON.parse(line) })
          } catch {}
        }
      } catch {}

      // Poll for new content
      const poll = async () => {
        while (!stopped) {
          try {
            const stat = await fsp.stat(file)
            if (stat.size > offset) {
              const fd = await fsp.open(file, 'r')
              const buf = Buffer.alloc(stat.size - offset)
              await fd.read(buf, 0, buf.length, offset)
              await fd.close()
              offset = stat.size
              for (const line of buf.toString('utf8').trim().split('\n')) {
                if (!line.trim()) continue
                try {
                  socket.emit('sessions:external-data', { sessionId, entry: JSON.parse(line) })
                } catch {}
              }
            }
          } catch {}
          await new Promise(r => setTimeout(r, 500))
        }
      }
      poll()
      activeTailers.set(sessionId, { stop: () => { stopped = true } })
    })

    socket.on('sessions:external-detach', ({ sessionId }: { sessionId: string }) => {
      const tailer = activeTailers.get(sessionId)
      if (tailer) { tailer.stop(); activeTailers.delete(sessionId) }
    })

    socket.on('disconnect', () => {
      // Stop all tailers for this client
      activeTailers.forEach(t => t.stop())
      activeTailers.clear()
    })
  })

  server.listen(port, () => {
    console.log(`> Orquesta Terminal running at http://localhost:${port}`)
    console.log(`  PTY: ${ptyModule ? 'available' : 'not available (install node-pty)'}`)
  })
})
