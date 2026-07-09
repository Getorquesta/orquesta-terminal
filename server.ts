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

  io.on('connection', (socket) => {
    console.log('[terminal] Client connected:', socket.id)

    // Spawn a PTY session
    socket.on('session:start', ({ sessionId, cliType = 'shell', rows = 24, cols = 80 }) => {
      if (!ptyModule) {
        socket.emit('session:error', { sessionId, error: 'node-pty not installed' })
        return
      }

      const shell = process.env.SHELL || (process.platform === 'win32' ? 'cmd.exe' : '/bin/bash')
      let command = shell
      let args: string[] = []

      switch (cliType) {
        case 'claude': command = 'claude'; break
        case 'orquesta': command = 'orquesta'; break
        case 'kimi': command = 'kimi'; break
        case 'opencode': command = 'opencode'; break
      }

      try {
        const term = ptyModule.spawn(command, args, {
          name: 'xterm-color',
          rows,
          cols,
          cwd: process.env.HOME || process.cwd(),
          env: process.env,
        })

        sessions.set(sessionId, term)

        term.onData((data: string) => {
          socket.emit('session:output', { sessionId, data })
        })

        term.onExit(() => {
          sessions.delete(sessionId)
          socket.emit('session:ended', { sessionId })
        })

        socket.emit('session:started', { sessionId, cliType })
      } catch (err: any) {
        socket.emit('session:error', { sessionId, error: err.message })
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

    socket.on('disconnect', () => {
      // Kill all sessions for this client
      // (In a real app you'd track which sessions belong to which socket)
    })
  })

  server.listen(port, () => {
    console.log(`> Orquesta Terminal running at http://localhost:${port}`)
    console.log(`  PTY: ${ptyModule ? 'available' : 'not available (install node-pty)'}`)
  })
})
