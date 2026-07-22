#!/usr/bin/env node
/**
 * Orquesta OSS — Standalone Agent Script
 *
 * Zero npm dependencies beyond socket.io-client.
 *
 * Usage:
 *   node agent/index.js --url http://localhost:3000 --token oat_xxx
 *
 * Or with environment variables:
 *   ORQUESTA_URL=http://localhost:3000 ORQUESTA_TOKEN=oat_xxx node agent/index.js
 */

const { io } = require('socket.io-client')
const { spawn } = require('child_process')
const path = require('path')

// ── Parse args ───────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2)
  const result = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) result.url = args[++i]
    if (args[i] === '--token' && args[i + 1]) result.token = args[++i]
  }
  return {
    url: result.url || process.env.ORQUESTA_API_URL || process.env.ORQUESTA_URL || 'http://localhost:3000',
    token: result.token || process.env.ORQUESTA_TOKEN || '',
  }
}

const { url: serverUrl, token: agentToken } = parseArgs()

if (!agentToken) {
  console.error('[agent] Error: token required. Use --token oat_xxx or ORQUESTA_TOKEN env var')
  process.exit(1)
}

// ── Socket.io connection ──────────────────────────────────────────────────────

console.log(`[agent] Connecting to ${serverUrl}…`)

const socket = io(serverUrl, {
  path: '/api/socket',
  query: { type: 'agent' },
  auth: { token: agentToken },
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionDelay: 2000,
  reconnectionDelayMax: 30000,
})

socket.on('connect', () => {
  console.log(`[agent] Connected (id: ${socket.id})`)
})

socket.on('disconnect', (reason) => {
  console.log(`[agent] Disconnected: ${reason}`)
})

socket.on('error', (err) => {
  console.error(`[agent] Error: ${err.message}`)
})

socket.on('connect_error', (err) => {
  console.error(`[agent] Connection error: ${err.message}`)
})

// ── Execute prompt ────────────────────────────────────────────────────────────

let currentProcess = null

// ── Sync CLAUDE.md before execution ──────────────────────────────────────────

async function syncClaudeMd() {
  try {
    const res = await fetch(`${serverUrl}/api/agent/claude-md`, {
      headers: { 'Authorization': `Bearer ${agentToken}` },
    })
    if (!res.ok) return
    const data = await res.json()
    if (data.claudeMd) {
      const fs = require('fs')
      fs.writeFileSync(path.join(process.cwd(), 'CLAUDE.md'), data.claudeMd, 'utf8')
      console.log('[agent] CLAUDE.md synced from dashboard')
    }
  } catch (err) {
    console.error('[agent] Failed to sync CLAUDE.md:', err.message)
  }
}

// ── Collect git commits after execution ──────────────────────────────────────

async function collectGitCommits(beforeHash) {
  try {
    const { execSync } = require('child_process')
    const log = execSync(
      `git log ${beforeHash ? beforeHash + '..HEAD' : '-1'} --pretty=format:'%H|||%s' --no-merges 2>/dev/null`,
      { encoding: 'utf8', timeout: 5000 }
    ).trim()
    if (!log) return []

    const commits = []
    for (const line of log.split('\n')) {
      const [hash, message] = line.split('|||')
      if (!hash) continue
      let diff = '', filesChanged = 0, insertions = 0, deletions = 0
      try {
        diff = execSync(`git diff ${hash}~1..${hash} --stat 2>/dev/null`, { encoding: 'utf8', timeout: 5000 }).trim()
        const shortstat = execSync(`git diff ${hash}~1..${hash} --shortstat 2>/dev/null`, { encoding: 'utf8', timeout: 5000 }).trim()
        const fm = shortstat.match(/(\d+) file/)
        const im = shortstat.match(/(\d+) insertion/)
        const dm = shortstat.match(/(\d+) deletion/)
        filesChanged = fm ? parseInt(fm[1]) : 0
        insertions = im ? parseInt(im[1]) : 0
        deletions = dm ? parseInt(dm[1]) : 0
      } catch {}
      commits.push({ hash, message, diff, filesChanged, insertions, deletions })
    }
    return commits
  } catch {
    return []
  }
}

function getHeadHash() {
  try {
    const { execSync } = require('child_process')
    return execSync('git rev-parse HEAD 2>/dev/null', { encoding: 'utf8', timeout: 3000 }).trim()
  } catch {
    return null
  }
}

socket.on('execute', async ({ promptId, content }) => {
  if (currentProcess) {
    console.log('[agent] Already executing, queuing not yet supported. Skipping.')
    socket.emit('complete', { promptId, exitCode: 1, result: 'Agent busy' })
    return
  }

  console.log(`[agent] Executing prompt ${promptId}: ${content.slice(0, 80)}…`)

  // Sync CLAUDE.md before execution
  await syncClaudeMd()

  // Record HEAD before execution for commit tracking
  const beforeHash = getHeadHash()

  let sequence = 0
  let outputBuffer = ''
  let tokensUsed = 0
  let costCents = 0

  const emitLog = (level, type, message) => {
    socket.emit('log', { promptId, level, type, message, sequence: sequence++ })
  }

  try {
    await new Promise((resolve, reject) => {
      // Use claude CLI if available, otherwise echo for demo
      const claudePath = process.env.CLAUDE_PATH || 'claude'
      const proc = spawn(
        claudePath,
        ['--print', '--verbose', '--output-format', 'stream-json', '-p', content],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env },
        }
      )

      currentProcess = proc

      let stderrBuf = ''

      proc.stdout.on('data', (chunk) => {
        outputBuffer += chunk.toString()
        const lines = outputBuffer.split('\n')
        outputBuffer = lines.pop() // keep incomplete line

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue

          try {
            const parsed = JSON.parse(trimmed)
            handleStreamEvent(parsed, emitLog, (t, c) => { tokensUsed = t; costCents = c })
          } catch {
            // Non-JSON output — emit as text
            emitLog('info', 'text', trimmed)
          }
        }
      })

      proc.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString()
        emitLog('error', 'text', chunk.toString().trim())
      })

      proc.on('exit', (code) => {
        currentProcess = null
        if (code === 0) {
          resolve({ code, tokensUsed, costCents })
        } else {
          reject(new Error(`Process exited with code ${code}: ${stderrBuf}`))
        }
      })

      proc.on('error', (err) => {
        currentProcess = null
        if (err.code === 'ENOENT') {
          const msg = `Claude CLI not found at "${claudePath}". Install it with: npm install -g @anthropic-ai/claude-code  (or set CLAUDE_PATH env var)`
          console.error(`[agent] ${msg}`)
          emitLog('error', 'system', msg)
          reject(new Error(msg))
        } else {
          reject(err)
        }
      })
    })

    // Collect git commits made during execution
    const commits = await collectGitCommits(beforeHash)
    if (commits.length > 0) {
      socket.emit('git:commits', { promptId, commits })
      console.log(`[agent] Reported ${commits.length} git commit(s)`)
    }

    socket.emit('complete', {
      promptId,
      exitCode: 0,
      tokensUsed: tokensUsed || undefined,
      costCents: costCents || undefined,
    })
    console.log(`[agent] Prompt ${promptId} completed`)
  } catch (err) {
    currentProcess = null
    socket.emit('complete', {
      promptId,
      exitCode: 1,
      result: err.message,
    })
    console.error(`[agent] Prompt ${promptId} failed:`, err.message)
  }
})

function handleStreamEvent(event, emitLog, setTokens) {
  if (!event || !event.type) return

  switch (event.type) {
    case 'assistant':
      if (event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === 'text') {
            emitLog('info', 'text', block.text)
          } else if (block.type === 'tool_use') {
            emitLog('info', 'tool_use', `[tool: ${block.name}] ${JSON.stringify(block.input).slice(0, 200)}`)
          }
        }
        if (event.message.usage) {
          const input = event.message.usage.input_tokens || 0
          const output = event.message.usage.output_tokens || 0
          setTokens(input + output, Math.round((input * 0.003 + output * 0.015) / 1000 * 100))
        }
      }
      break

    case 'tool_result':
      if (event.content) {
        for (const block of event.content) {
          if (block.type === 'text') {
            emitLog('info', 'result', block.text)
          }
        }
      }
      break

    case 'result':
      if (event.result) {
        emitLog('info', 'result', typeof event.result === 'string' ? event.result : JSON.stringify(event.result))
      }
      if (event.usage) {
        const input = event.usage.input_tokens || 0
        const output = event.usage.output_tokens || 0
        setTokens(input + output, Math.round((input * 0.003 + output * 0.015) / 1000 * 100))
      }
      break

    case 'system':
      emitLog('info', 'system', event.subtype || event.message || JSON.stringify(event))
      break

    default:
      break
  }
}

// ── Interactive session (node-pty) ────────────────────────────────────────────

const sessions = new Map()

// Resolve a PTY binding once. Prefer the prebuilt multiarch build (ships N-API
// binaries for linux/macOS/win — no compiler needed); fall back to a plain
// `node-pty` install if someone has that instead.
function loadPty() {
  for (const name of ['@homebridge/node-pty-prebuilt-multiarch', 'node-pty']) {
    try { return require(name) } catch { /* try next */ }
  }
  return null
}
const ptyModule = loadPty()

// Map a per-pane cliType to the program the pane hosts. Falls back to the
// default shell so an unknown/unavailable CLI still yields a usable terminal.
function resolveSessionCommand(cliType) {
  switch ((cliType || 'shell').toLowerCase()) {
    case 'claude':
      return { command: process.env.CLAUDE_PATH || 'claude', args: [] }
    case 'orquesta':
      return { command: process.env.ORQUESTA_CLI_PATH || 'orquesta', args: [] }
    case 'kimi':
      return { command: process.env.KIMI_PATH || 'kimi', args: [] }
    case 'opencode':
      return { command: process.env.OPENCODE_PATH || 'opencode', args: [] }
    case 'shell':
    default:
      return {
        command: process.env.SHELL || (process.platform === 'win32' ? 'cmd.exe' : '/bin/bash'),
        args: [],
      }
  }
}

// Current git branch of a working dir (null if not a repo / git missing).
function getGitBranch(cwd) {
  try {
    const { execSync } = require('child_process')
    return (
      execSync('git rev-parse --abbrev-ref HEAD', {
        cwd,
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null
    )
  } catch {
    return null
  }
}

function emitSessionMeta(sessionId) {
  const s = sessions.get(sessionId)
  if (!s) return
  socket.emit('session:meta', {
    sessionId,
    cliType: s.cliType,
    cwd: s.cwd,
    branch: s.branch,
  })
}

socket.on('session:start', ({ sessionId, cellId, rows = 24, cols = 80, cliType = 'shell', cwd, hostedApiUrl, hostedToken }) => {
  try {
    const pty = ptyModule
    if (!pty) throw new Error('no PTY binding')
    const { command, args } = resolveSessionCommand(cliType)
    const sessionCwd = cwd || process.env.ORQUESTA_WORKDIR || process.cwd()

    // If orquesta-cli + hosted token, pass --token so it auto-connects
    const finalArgs = [...args]
    if (cliType === 'orquesta' && hostedToken) {
      finalArgs.push('--token', hostedToken)
    }

    // Hosted-hook belt-and-suspenders: when the pane is configured to report to
    // a hosted Orquesta project, point the CLI's own reporter at it.
    const sessionEnv = { ...process.env }
    if (hostedApiUrl) sessionEnv.ORQUESTA_API_URL = hostedApiUrl
    if (hostedToken) sessionEnv.ORQUESTA_TOKEN = hostedToken

    const term = pty.spawn(command, finalArgs, {
      name: 'xterm-color',
      rows,
      cols,
      cwd: sessionCwd,
      env: sessionEnv,
    })

    const meta = { term, cliType, cwd: sessionCwd, branch: getGitBranch(sessionCwd), branchTimer: null }
    sessions.set(sessionId, meta)

    term.onData((data) => {
      socket.emit('session:output', { sessionId, data })
    })

    term.onExit(() => {
      if (meta.branchTimer) clearInterval(meta.branchTimer)
      sessions.delete(sessionId)
      socket.emit('session:ended', { sessionId })
    })

    socket.emit('session:started', { sessionId, pid: term.pid })
    emitSessionMeta(sessionId)

    // Keep the branch chip live — the user checks out branches inside the pane.
    meta.branchTimer = setInterval(() => {
      const branch = getGitBranch(meta.cwd)
      if (branch !== meta.branch) {
        meta.branch = branch
        emitSessionMeta(sessionId)
      }
    }, 5000)

    console.log(`[agent] Session started: ${sessionId} (${cliType} @ ${sessionCwd})`)
  } catch (err) {
    console.error('[agent] PTY not available:', err.message)
    socket.emit('session:error', {
      sessionId,
      message: 'No PTY binding installed. Run: npm install @homebridge/node-pty-prebuilt-multiarch',
    })
  }
})

socket.on('session:input', ({ sessionId, data }) => {
  const s = sessions.get(sessionId)
  if (s) s.term.write(data)
})

socket.on('session:resize', ({ sessionId, rows, cols }) => {
  const s = sessions.get(sessionId)
  if (s) s.term.resize(cols, rows)
})

socket.on('session:force_end', ({ sessionId }) => {
  const s = sessions.get(sessionId)
  if (s) {
    if (s.branchTimer) clearInterval(s.branchTimer)
    s.term.kill()
    sessions.delete(sessionId)
  }
})

// ── Hosted hook (report local CLI sessions to a hosted Orquesta project) ──────
//
// The dashboard's "Connect to Hosted" panel drives these. The heavy lifting is
// done by the PUBLIC `orquesta-agent init` CLI: it validates the token against
// the hosted API, writes `.orquesta.json` (projectId + token + apiUrl) and
// `.claude/settings.json` hooks into the target dir. From then on BOTH CLIs
// self-report to the hosted backend: claude via the settings.json hooks,
// orquesta-cli via its built-in prompt-reporter — both key off `.orquesta.json`.

const fsp = require('fs/promises')

function hookTargetDir(cwd) {
  return cwd || process.env.ORQUESTA_WORKDIR || process.cwd()
}

// Resolve the orquesta-agent binary once (PATH-based; works for standalone too).
function resolveOrquestaAgentBin() {
  try {
    const { execSync } = require('child_process')
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
async function readHookStatus(dir) {
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

// Dashboard asks: is this dir already hooked, and to which hosted project?
socket.on('hook:status', async ({ cwd } = {}) => {
  const dir = hookTargetDir(cwd)
  const status = await readHookStatus(dir)
  socket.emit('hook:status_result', { cwd: dir, ...status })
})

// Dashboard asks: enrol this dir into a hosted project via `orquesta-agent init`.
socket.on('hook:init', async ({ token, apiUrl, cwd } = {}) => {
  const dir = hookTargetDir(cwd)
  const emitFail = (message) => socket.emit('hook:result', { ok: false, cwd: dir, message })

  if (!token || typeof token !== 'string') return emitFail('A hosted token (oat_… or oclt_…) is required.')

  const bin = resolveOrquestaAgentBin()
  if (!bin) {
    return emitFail('orquesta-agent is not installed on this machine. Install it: npm i -g orquesta-agent')
  }

  const initArgs = ['init', '--token', token]
  if (apiUrl) initArgs.push('--api-url', apiUrl)

  const child = spawn(bin, initArgs, { cwd: dir, env: process.env })
  let out = ''
  child.stdout.on('data', (d) => { out += d.toString() })
  child.stderr.on('data', (d) => { out += d.toString() })

  child.on('error', (err) => emitFail(`Could not run orquesta-agent init: ${err.message}`))

  child.on('close', async (code) => {
    if (code !== 0) {
      // init prints the reason (invalid token / unreachable host) to stdout.
      const reason = out.replace(/\s+/g, ' ').trim().slice(-240) || `exited ${code}`
      return emitFail(reason)
    }
    const status = await readHookStatus(dir)
    socket.emit('hook:result', {
      ok: true,
      cwd: dir,
      message: status.projectName
        ? `Hooked to “${status.projectName}” on the hosted backend.`
        : 'Hook configured on the hosted backend.',
      ...status,
    })
    console.log(`[agent] Hosted hook configured in ${dir}${status.projectName ? ` → ${status.projectName}` : ''}`)
  })
})

// Direct project enrollment — writes .orquesta.json + .claude/settings.json
// without requiring the orquesta-agent binary. Used when the user selects a
// specific project from the per-pane dropdown.
socket.on('hook:init-project', async ({ token, apiUrl, projectId, projectName, cwd } = {}) => {
  const dir = hookTargetDir(cwd)
  const emitResult = (ok, message, extra = {}) =>
    socket.emit('hook:result', { ok, cwd: dir, message, ...extra })

  if (!token || !projectId) {
    return emitResult(false, 'Token and projectId are required.')
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

    // .gitignore — ensure .orquesta.json is listed
    const gitignorePath = path.join(dir, '.gitignore')
    try {
      const existing = await fsp.readFile(gitignorePath, 'utf8').catch(() => '')
      if (!existing.includes('.orquesta.json')) {
        await fsp.appendFile(gitignorePath, '\n# Orquesta hook config (contains token)\n.orquesta.json\n')
      }
    } catch {}

    // .claude/settings.json — add hooks if orquesta-agent binary is available
    const bin = resolveOrquestaAgentBin()
    if (bin) {
      const claudeDir = path.join(dir, '.claude')
      const settingsPath = path.join(claudeDir, 'settings.json')
      await fsp.mkdir(claudeDir, { recursive: true })

      let settings = {}
      try { settings = JSON.parse(await fsp.readFile(settingsPath, 'utf8')) } catch {}
      if (!settings.hooks) settings.hooks = {}

      const hookCmd = (event) => `${bin} hook ${event}`
      const hookEntries = {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookCmd('prompt-submit') }] }],
        PostToolUse: [{ matcher: 'Edit|Write|Bash|Read|Glob|Grep', hooks: [{ type: 'command', command: hookCmd('tool-use'), async: true }] }],
        Stop: [{ hooks: [{ type: 'command', command: hookCmd('stop') }] }],
      }

      for (const [event, config] of Object.entries(hookEntries)) {
        if (!settings.hooks[event]) {
          settings.hooks[event] = config
        } else if (Array.isArray(settings.hooks[event])) {
          const has = settings.hooks[event].some(e =>
            e.hooks?.some(h => h.command?.includes('orquesta-agent hook'))
          )
          if (!has) settings.hooks[event] = [...settings.hooks[event], ...config]
        }
      }

      await fsp.writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n')
    }

    emitResult(true, `Hooked to "${projectName || projectId}" on the hosted backend.`, {
      configured: true, projectId, projectName,
    })
    console.log(`[agent] Hook configured for project "${projectName || projectId}" in ${dir}`)
  } catch (err) {
    emitResult(false, `Failed to write hook files: ${err.message}`)
  }
})

// ── External Session Detection (import running CLIs) ──────────────────────────
//
// Scans ~/.claude/projects/ for active JSONL transcripts. If a .jsonl file was
// modified recently, there's a Claude session running outside the OSS. The
// dashboard can "attach" to it by tailing the file.

const os = require('os')

function claudeProjectsRoot() {
  return path.join(os.homedir(), '.claude', 'projects')
}

// Decode the Claude project dir name back to the original cwd
function decodeDirName(encoded) {
  // Claude Code encodes cwd as: /home/user/foo → -home-user-foo
  return '/' + encoded.replace(/^-/, '').replace(/-/g, '/')
}

socket.on('sessions:external-list', async () => {
  try {
    const root = claudeProjectsRoot()
    let projectDirs
    try { projectDirs = await fsp.readdir(root) } catch { projectDirs = [] }

    const sessions = []
    const now = Date.now()
    const RECENT_MS = 30 * 60 * 1000 // 30 min = likely active

    for (const dir of projectDirs) {
      const dirPath = path.join(root, dir)
      let files
      try { files = await fsp.readdir(dirPath) } catch { continue }

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue
        const filePath = path.join(dirPath, file)
        try {
          const stat = await fsp.stat(filePath)
          if (now - stat.mtimeMs > RECENT_MS) continue // not recent
          // Read last line to get latest activity
          const sessionId = file.replace('.jsonl', '')
          const cwd = decodeDirName(dir)
          sessions.push({
            id: sessionId,
            cwd,
            file: filePath,
            lastActivity: stat.mtimeMs,
            size: stat.size,
            isActive: now - stat.mtimeMs < 60_000, // modified in last minute = active
          })
        } catch { continue }
      }
    }

    // Sort by lastActivity desc
    sessions.sort((a, b) => b.lastActivity - a.lastActivity)
    socket.emit('sessions:external-list-result', { sessions: sessions.slice(0, 20) })
  } catch (err) {
    socket.emit('sessions:external-list-result', { sessions: [], error: err.message })
  }
})

// Tail an external Claude transcript and stream its content to the dashboard
const activeTailers = new Map()

socket.on('sessions:external-attach', ({ sessionId, file } = {}) => {
  if (!sessionId || !file) return
  if (activeTailers.has(sessionId)) return // already tailing

  let offset = 0
  let stopped = false

  // Read existing content first (last 50 lines)
  const readExisting = async () => {
    try {
      const content = await fsp.readFile(file, 'utf8')
      const lines = content.trim().split('\n')
      offset = Buffer.byteLength(content)
      // Send last 50 lines as initial content
      const initial = lines.slice(-50)
      for (const line of initial) {
        try {
          const obj = JSON.parse(line)
          socket.emit('sessions:external-data', { sessionId, entry: obj })
        } catch {}
      }
    } catch {}
  }

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
          const newLines = buf.toString('utf8').trim().split('\n')
          for (const line of newLines) {
            if (!line.trim()) continue
            try {
              const obj = JSON.parse(line)
              socket.emit('sessions:external-data', { sessionId, entry: obj })
            } catch {}
          }
        }
      } catch {}
      await new Promise(r => setTimeout(r, 500))
    }
  }

  readExisting().then(poll)
  activeTailers.set(sessionId, { stop: () => { stopped = true } })
})

socket.on('sessions:external-detach', ({ sessionId } = {}) => {
  const tailer = activeTailers.get(sessionId)
  if (tailer) {
    tailer.stop()
    activeTailers.delete(sessionId)
  }
})

// ── Heartbeat ─────────────────────────────────────────────────────────────────

setInterval(async () => {
  try {
    await fetch(`${serverUrl}/api/agent/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: agentToken }),
    })
  } catch {}
}, 20000)

console.log('[agent] Ready. Waiting for prompts…')
