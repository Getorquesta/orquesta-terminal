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
import { spawn } from 'child_process'
import * as os from 'os'

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

  function connKey(apiUrl: string, cliToken: string, projectId: string) {
    return `${apiUrl}::${cliToken.slice(0, 12)}::${projectId}`
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
    return { ok: true }
  }

  async function stopShare(sessionId: string, opts: { emitEnded?: boolean } = {}) {
    const s = sharedTerminals.get(sessionId)
    if (!s) return
    sharedTerminals.delete(sessionId)
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
