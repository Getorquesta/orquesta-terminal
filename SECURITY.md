# Security

Orquesta Terminal is a terminal workspace: it spawns shells, runs AI CLIs, and
reads your project files. That is the product, so "it can touch my machine" is
by design — this document is about *where the boundaries are*, which ones are
deliberate, and how to report a problem.

## Reporting a vulnerability

Email **security@getorquesta.com** with steps to reproduce. Please do not open a
public issue for anything exploitable. We aim to acknowledge within 72 hours.

## Threat model in one paragraph

The desktop app is a Tauri v2 shell: a Rust process (full user privileges) plus
a webview that renders the UI. The Rust side is trusted; the webview is treated
as the thing an attacker would try to reach, because it renders text produced by
terminals, AI CLIs and remote sessions. So the security work is concentrated on
what the webview is allowed to ask the Rust side to do.

## What the webview may call

`src-tauri/capabilities/default.json` grants exactly three things:

- `core:default` — window, event and path basics.
- `clipboard-manager:allow-read-text` / `allow-write-text` — copy/paste in panes.

The `fs`, `dialog` and `shell` plugins are **not** exposed over IPC. Filesystem
work goes through the app's own commands (`fs_list_dir`, `fs_native_pick`, …),
which live in `src-tauri/src/` and validate their own inputs. This matters:
an earlier version granted `fs:allow-home-read-recursive` and
`fs:allow-home-write-recursive`, which would have let anything running in the
webview read or write your entire home directory directly.

Application commands (PTY lifecycle, cloud calls, hook enrollment, remote
sessions) are reachable from the webview by design — they *are* the app.

## What the app can do on your machine

- **Spawns PTYs** running the shell or CLI you pick, as your user, with your
  environment. A terminal emulator cannot be sandboxed from the thing it runs.
- **Reads `~/.claude/projects/*.jsonl`** to detect Claude Code sessions started
  outside the app. Read-only, local, never uploaded by the terminal itself.
- **Writes `.orquesta.json`** in a project when you enroll it, and appends that
  filename to the project's `.gitignore` — the file carries a project token.
- **Reads directories you choose** through the folder picker.

## Content Security Policy

Declared in `src-tauri/tauri.conf.json`:

```
default-src 'self' ipc: http://ipc.localhost;
script-src  'self' 'unsafe-inline' 'unsafe-eval';
style-src   'self' 'unsafe-inline';
img-src     'self' data: https:;
connect-src 'self' https://getorquesta.com https://ws.orquesta.live
            https://apumail.com https://sudosudo.dev
            https://rogerthat.chat https://trustops.eu
```

`connect-src` is an allowlist: the UI can only reach Orquesta and the plugin
products, never an arbitrary host. `script-src` still carries `unsafe-inline`
and `unsafe-eval`, which the Next.js runtime needs in the bundled build — it is
the weakest line here, and it is why the IPC surface above is kept small rather
than trusted to stay unreachable. Tightening it is tracked work, not a
resolved issue.

## Credentials

- The cloud token lives in `localStorage` under `orquesta-hosted-auth`, scoped
  to the app's own origin. Sign out clears it.
- Project tokens live in `.orquesta.json`, git-ignored automatically.
- The terminal has no database and never persists prompt content itself; what
  you send to a backend is stored by that backend (self-hosted or cloud).
- Nothing in this repo ships a secret. `.env.example` holds only a localhost
  URL, and release signing keys live in GitHub Actions secrets.

## Self-hosted backends

Point the app at a backend you control with `NEXT_PUBLIC_BACKEND_URL`. The
terminal trusts that backend to relay session data, so run
[orquesta-oss](https://github.com/Getorquesta/orquesta-oss) on a host you
trust, and give it a real `BETTER_AUTH_SECRET`.
