# Orquesta Terminal

**Standalone terminal workspace for AI-powered development.** Multi-CLI grid, real-time timeline, coordination, plugins.

**Repo**: https://github.com/Getorquesta/orquesta-terminal
**Org**: Getorquesta (https://github.com/Getorquesta)

## Architecture

This is a **frontend product** (Next.js) that connects to a backend:
- **Self-hosted mode**: connects to `orquesta-oss` running locally (WebSocket + REST)
- **Cloud mode**: connects to Orquesta Cloud, proxied through the Tauri backend
  (`src-tauri/src/cloud.rs`) so the webview never hits CORS

The agent (`agent/index.js`) runs alongside and:
- Spawns PTYs for terminal sessions
- Detects external Claude sessions (tails ~/.claude/projects/ JSONL)
- Handles hook enrollment (writes .orquesta.json)

## Sister Repos

| Repo | Purpose |
|------|---------|
| `Getorquesta/orquesta-oss` | Self-hosted backend |
| `Getorquesta/orquesta-terminal` | This repo — the terminal product |

Orquesta Cloud ([getorquesta.com](https://getorquesta.com)) is the managed
platform this terminal can connect to. Its source is not public; from this
repo's point of view it is just the REST + WebSocket API documented above.

## Rules

- **Code language**: ALL code in English
- **Port**: Dev runs on port 4000 (`npm run dev`)
- **Backend**: Self-hosted OSS runs on port 3000
- **No DB**: This repo has NO database — it's a pure frontend + agent
- **Proxy**: Calls to the cloud API go through the Tauri command layer (CORS)
- **Agent**: The agent connects to the backend (OSS or hosted) via socket.io

## Key Files

- `app/page.tsx` — Main terminal workspace page
- `components/features/AgentGrid.tsx` — Terminal grid with panes
- `components/features/CommandPalette.tsx` — ⌘K command palette
- `hooks/useSocket.ts` — WebSocket connection to backend
- `hooks/useHostedAuth.ts` — Auth against Orquesta Cloud
- `lib/tauri-proxy.ts` / `src-tauri/src/cloud.rs` — Cloud API calls without CORS
- `agent/index.js` — Local agent (PTY spawner, hook manager, session detector)
- `src/tui/index.ts` — TUI mode entry point (coming soon)

## Plugins

The terminal integrates with companion products:
- **SudoSudo** (sudosudo.dev) — Monitoring & remediation
- **RogerThat** (rogerthat.chat) — Voice, meet & coordination
- **Apumail** (apumail.com) — Agent email inbox
- **TrustOps** (trustops.eu) — Policy & audit
