// ── CLI launch settings ───────────────────────────────────────────────────────
// Per-CLI launch configuration the user edits in the Settings panel: whether to
// skip permission prompts (the CLI's documented "yolo" flag) and any extra
// arguments to append. Persisted to localStorage; read at session-start time and
// forwarded to the Rust PTY spawner via the `session:start` payload.

export interface CliConfig {
  /** Pass the CLI's documented skip-all-prompts flag (see YOLO_FLAGS). */
  skipPermissions?: boolean
  /** Free-form extra arguments, appended verbatim (space-separated in the UI). */
  extraArgs?: string
}

export interface OrqSettings {
  /** Per-cliType launch config. */
  cli: Record<string, CliConfig>
  /** cliType used when opening a brand-new terminal. */
  defaultCli?: string
}

// The documented "skip every permission prompt" flag per CLI. Mirror of the Rust
// `yolo_flag` map in src-tauri/src/pty.rs — keep the two in sync. Only CLIs with a
// real, documented flag appear here; others rely on Extra arguments instead.
export const YOLO_FLAGS: Record<string, string> = {
  claude: '--dangerously-skip-permissions',
  gemini: '--yolo',
  codex: '--dangerously-bypass-approvals-and-sandbox',
}

const STORAGE_KEY = 'orq-term-settings'

const DEFAULTS: OrqSettings = {
  // Skip-permissions defaults ON where a flag exists — the app's long-standing
  // behaviour — so nothing changes until the user opts out in Settings.
  cli: { claude: { skipPermissions: true } },
  defaultCli: 'shell',
}

export function loadSettings(): OrqSettings {
  if (typeof window === 'undefined') return DEFAULTS
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULTS
    const parsed = JSON.parse(raw) as Partial<OrqSettings>
    return { cli: { ...DEFAULTS.cli, ...(parsed.cli ?? {}) }, defaultCli: parsed.defaultCli ?? DEFAULTS.defaultCli }
  } catch {
    return DEFAULTS
  }
}

export function saveSettings(s: OrqSettings): void {
  if (typeof window === 'undefined') return
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)) } catch {}
}

/** Split a free-form extra-args string into argv, honouring simple "quoted groups". */
export function parseArgs(raw: string | undefined): string[] {
  if (!raw) return []
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

/** The launch config to send with `session:start` for a given cliType. */
export function launchConfigFor(cliType: string): { skipPermissions: boolean; extraArgs: string[] } {
  const cfg = loadSettings().cli[cliType] ?? {}
  // Default skip-permissions ON where a flag exists (matches the Rust default).
  const skip = cfg.skipPermissions ?? (cliType in YOLO_FLAGS)
  return { skipPermissions: skip, extraArgs: parseArgs(cfg.extraArgs) }
}
