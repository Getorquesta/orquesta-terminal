# Orquesta Terminal

Standalone terminal workspace for AI-powered development. Multi-CLI grid, real-time timeline, coordination, plugins.

Connects to:
- **Orquesta Self-Hosted** (local backend via WebSocket)
- **Orquesta Cloud** (getorquesta.com via API)

## Install

```bash
npm install
npm run dev
```

## Modes

- **Web** — Browser-based terminal workspace (Next.js)
- **TUI** — Terminal UI (coming soon — Ink-based CLI)

## Architecture

The terminal is a frontend product that connects to an Orquesta backend (self-hosted or cloud) for:
- Agent PTY sessions (WebSocket)
- Project management (REST API)
- Prompt timeline & coordination (hosted API via proxy)

