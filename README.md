<p align="center">
  <img src="https://raw.githubusercontent.com/Getorquesta/orquesta-terminal/main/public/icon.png" width="80" height="80" alt="Orquesta Terminal" />
</p>

<h1 align="center">Orquesta Terminal</h1>

<p align="center">
  <strong>The AI coding cockpit.</strong><br/>
  Run multiple AI CLIs side by side. See what your agents are doing in real-time.<br/>
  Import running sessions. Coordinate. Ship faster.
</p>

<p align="center">
  <a href="#download">Download</a> ·
  <a href="https://getorquesta.com">Orquesta Cloud</a> ·
  <a href="https://github.com/Getorquesta/orquesta-oss">Self-Hosted Backend</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#features">Features</a>
</p>

---

## What is this?

Orquesta Terminal is a **standalone terminal workspace** for developers who use AI coding agents. Think of it as a multiplexer purpose-built for Claude, Orquesta CLI, Kimi, OpenCode, and any shell — with real-time observability, coordination, and integrations baked in.

It connects to either:
- **Orquesta Self-Hosted** — your own backend on your machine/VM ([orquesta-oss](https://github.com/Getorquesta/orquesta-oss))
- **Orquesta Cloud** — the hosted platform at [getorquesta.com](https://getorquesta.com)

## Download

Orquesta Terminal ships as a **native desktop app** (built with [Tauri](https://tauri.app/) v2) — or just run it in your browser via [Orquesta Cloud](https://getorquesta.com).

| Platform | Download |
|----------|----------|
| **Linux** · AppImage | [Orquesta.Terminal_0.1.14_amd64.AppImage](https://github.com/Getorquesta/orquesta-terminal/releases/download/v0.1.14/Orquesta.Terminal_0.1.14_amd64.AppImage) |
| **Linux** · Debian/Ubuntu `.deb` | [Orquesta.Terminal_0.1.14_amd64.deb](https://github.com/Getorquesta/orquesta-terminal/releases/download/v0.1.14/Orquesta.Terminal_0.1.14_amd64.deb) |
| **Windows** · installer `.exe` | [Orquesta.Terminal_0.1.14_x64-setup.exe](https://github.com/Getorquesta/orquesta-terminal/releases/download/v0.1.14/Orquesta.Terminal_0.1.14_x64-setup.exe) |
| **macOS** · Universal `.dmg` | [Orquesta.Terminal_0.1.14_universal.dmg](https://github.com/Getorquesta/orquesta-terminal/releases/download/v0.1.14/Orquesta.Terminal_0.1.14_universal.dmg) |

Latest builds are always on the [Releases page](https://github.com/Getorquesta/orquesta-terminal/releases/latest).

Running the AppImage:

```bash
chmod +x Orquesta.Terminal_0.1.14_amd64.AppImage
./Orquesta.Terminal_0.1.14_amd64.AppImage
```

## Quick Start

> Prefer a prebuilt binary? See [Download](#download) above. To run from source:

```bash
git clone https://github.com/Getorquesta/orquesta-terminal.git
cd orquesta-terminal
npm install
npm run dev
```

Open **http://localhost:4000** — that's your workspace.

To connect to a self-hosted backend, run [orquesta-oss](https://github.com/Getorquesta/orquesta-oss) on port 3000.

## Features

### 🖥️ Multi-CLI Terminal Grid
Run Claude, Orquesta CLI, Kimi, OpenCode, or any shell in resizable panes side by side. Drag to rearrange. `Ctrl+P` to auto-layout. Each pane is an independent PTY session.

### 📡 Import External Sessions
Detect Claude Code sessions already running on your machine and attach to them read-only. See what the agent is doing without interrupting it.

### ⏱️ Real-Time Timeline
See prompts flowing through your hosted projects in real-time. Star them, tag them, open them in the dashboard — all from the sidebar.

### 🔗 Coordination
Join coordination channels between agents. Send messages, ping peers, monitor inter-agent communication — all inline.

### ☁️ Hosted Connection
Sign in to Orquesta Cloud with one click (OAuth popup) or a CLI token. Each terminal pane can target a different hosted project for hook reporting.

### 🧩 Plugins
Integrations with companion tools:
- **SudoSudo** — Autonomous server monitoring & remediation
- **RogerThat** — Voice calls, meet, and agent coordination
- **Apumail** — Agent-native email inbox with OTP extraction
- **TrustOps** — Policy enforcement and cryptographic audit

### ⌨️ Keyboard-First
| Shortcut | Action |
|----------|--------|
| `⌘K` | Command palette |
| `Alt+T` | New terminal |
| `Alt+W` | Close terminal |
| `Ctrl+P` | Auto-arrange all panes |
| `Ctrl+±` | Zoom in/out |
| `Ctrl+Shift+L` | Clear terminal |

### 🎨 Customizable
- 5 wallpaper themes + custom image upload
- Terminal transparency slider
- Geist Mono font, on-brand emerald theme
- Persisted per-project layouts

## Architecture

```
┌─────────────────────────────┐
│     Orquesta Terminal       │  ← This repo (frontend + agent)
│     http://localhost:4000   │
└──────────────┬──────────────┘
               │ WebSocket + REST
               ▼
┌─────────────────────────────┐
│     Orquesta OSS            │  ← github.com/Getorquesta/orquesta-oss
│     http://localhost:3000   │     (or getorquesta.com for cloud)
│                             │
│  - Prisma/SQLite            │
│  - Socket.io server         │
│  - Auth (better-auth)       │
│  - Agent token management   │
└──────────────┬──────────────┘
               │ oat_ token
               ▼
┌─────────────────────────────┐
│     Agent (agent/index.js)  │
│                             │
│  - Spawns PTYs              │
│  - Detects Claude sessions  │
│  - Manages hooks            │
│  - Reports to hosted        │
└─────────────────────────────┘
```

## Modes

| Mode | Status | How |
|------|--------|-----|
| **Desktop** | ✅ Linux · ✅ Windows · ✅ macOS | [Download](#download) the AppImage/`.deb`/`.exe`/`.dmg` (Tauri native app) |
| **Web** | ✅ Ready | `npm run dev` → browser, or [getorquesta.com](https://getorquesta.com) |
| **TUI** | 🚧 Coming | `npm run tui` → terminal-native UI |

## Related

- [orquesta-oss](https://github.com/Getorquesta/orquesta-oss) — Self-hosted backend
- [getorquesta.com](https://getorquesta.com) — Hosted platform
- [sudosudo.dev](https://sudosudo.dev) — Monitoring plugin
- [rogerthat.chat](https://rogerthat.chat) — Voice & coordination plugin
- [apumail.com](https://apumail.com) — Agent email plugin
- [trustops.eu](https://trustops.eu) — Policy & audit plugin

## License

MIT
