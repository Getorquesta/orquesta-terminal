/**
 * Orquesta Terminal — Custom Server
 * Runs Next.js + Socket.io with built-in PTY spawning.
 * No external backend needed — terminals work standalone.
 */
import { createServer } from 'http'
import { parse } from 'url'
import next from 'next'
import { Server as SocketServer } from 'socket.io'
import { spawn } from 'child_process'

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
        })

        term.onExit(() => {
          sessions.delete(sessionId)
          activityAt.delete(sessionId)
          socket.emit('session:ended', { sessionId })
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
