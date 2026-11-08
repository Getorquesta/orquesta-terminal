'use client'

// ── SettingsPanel ─────────────────────────────────────────────────────────────
// A modal for launch settings: per-CLI "skip permission prompts" (the CLI's
// documented yolo flag) plus free-form extra arguments, the default CLI for new
// terminals, and agent alerts. Self-contained — loads on open, writes to localStorage on save.

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Settings as SettingsIcon, Terminal as TerminalIcon, Bell, Play } from 'lucide-react'
import { loadSettings, saveSettings, YOLO_FLAGS, type AlertSettings, type OrqSettings } from '@/lib/cliSettings'
import { playAlert } from '@/lib/alertSound'

export interface CliChoice { value: string; label: string }

function Switch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onToggle}
      className={`relative h-5 w-9 rounded-full transition-colors ${on ? 'bg-emerald-500/80' : 'bg-zinc-700'}`}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${on ? 'left-4' : 'left-0.5'}`} />
    </button>
  )
}

export function SettingsPanel({
  open, clis, onClose,
}: {
  open: boolean
  /** CLIs to expose (typically the picker options minus plain Shell). */
  clis: CliChoice[]
  onClose: () => void
}) {
  const [draft, setDraft] = useState<OrqSettings>({ cli: {} })

  // Snapshot the persisted settings each time the panel opens.
  useEffect(() => { if (open) setDraft(loadSettings()) }, [open])

  // Close on Escape.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const cfgFor = (id: string) => draft.cli[id] ?? {}
  const setCfg = (id: string, patch: Partial<{ skipPermissions: boolean; extraArgs: string }>) =>
    setDraft((d) => ({ ...d, cli: { ...d.cli, [id]: { ...d.cli[id], ...patch } } }))

  const soundOn = draft.alerts?.sound ?? true
  const toastOn = draft.alerts?.toast ?? true
  const setAlerts = (patch: AlertSettings) =>
    setDraft((d) => ({ ...d, alerts: { ...d.alerts, ...patch } }))

  const save = () => { saveSettings(draft); onClose() }

  const panel = (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="flex max-h-[85vh] w-[min(620px,92vw)] flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3.5">
          <div className="flex items-center gap-2 text-zinc-100">
            <SettingsIcon className="h-4 w-4 text-zinc-400" strokeWidth={1.75} />
            <span className="text-sm font-semibold">Settings</span>
          </div>
          <button onClick={onClose} className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" title="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {/* New-terminal default CLI */}
          <section className="mb-5">
            <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">New terminal opens</label>
            <select
              value={draft.defaultCli ?? 'shell'}
              onChange={(e) => setDraft((d) => ({ ...d, defaultCli: e.target.value }))}
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-200 outline-none focus:border-zinc-600"
            >
              <option value="shell">Shell</option>
              {clis.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </section>

          {/* Agent alerts */}
          <section className="mb-5">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
              <Bell className="h-3.5 w-3.5" /> Alerts
            </div>
            <div className="divide-y divide-zinc-800/80 rounded-lg border border-zinc-800/80 bg-zinc-900/40">
              <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
                <div className="min-w-0">
                  <div className="text-sm text-zinc-200">Sound</div>
                  <div className="text-[11px] text-zinc-500">When a pane you aren&apos;t looking at finishes or needs you</div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => playAlert('done')}
                    className="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                    title="Play the finished sound"
                  >
                    <Play className="h-3 w-3" /> Done
                  </button>
                  <button
                    type="button"
                    onClick={() => playAlert('blocked')}
                    className="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                    title="Play the needs-you sound"
                  >
                    <Play className="h-3 w-3" /> Needs you
                  </button>
                  <Switch on={soundOn} onToggle={() => setAlerts({ sound: !soundOn })} />
                </div>
              </div>
              <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
                <div className="min-w-0">
                  <div className="text-sm text-zinc-200">Toast</div>
                  <div className="text-[11px] text-zinc-500">Click it to jump to that pane</div>
                </div>
                <Switch on={toastOn} onToggle={() => setAlerts({ toast: !toastOn })} />
              </div>
            </div>
          </section>

          <div className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
            <TerminalIcon className="h-3.5 w-3.5" /> Per-CLI launch options
          </div>

          <div className="space-y-2.5">
            {clis.map((c) => {
              const cfg = cfgFor(c.value)
              const flag = YOLO_FLAGS[c.value]
              const skip = cfg.skipPermissions ?? Boolean(flag)
              return (
                <div key={c.value} className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3.5 py-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm font-medium text-zinc-200">{c.label}</span>
                    {flag ? (
                      <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-400">
                        <span>Skip permission prompts</span>
                        <Switch on={skip} onToggle={() => setCfg(c.value, { skipPermissions: !skip })} />
                      </label>
                    ) : (
                      <span className="text-[11px] text-zinc-600">no skip flag — use args</span>
                    )}
                  </div>
                  {flag && skip && (
                    <div className="mb-2 font-mono text-[11px] text-emerald-500/70">{flag}</div>
                  )}
                  <input
                    type="text"
                    value={cfg.extraArgs ?? ''}
                    onChange={(e) => setCfg(c.value, { extraArgs: e.target.value })}
                    placeholder="Extra arguments (e.g. --model opus)"
                    spellCheck={false}
                    className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 font-mono text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-zinc-600"
                  />
                </div>
              )
            })}
          </div>

          <p className="mt-4 text-[11px] leading-relaxed text-zinc-600">
            Changes apply to terminals you open next — existing sessions keep running.
          </p>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-zinc-800 px-5 py-3">
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200">
            Cancel
          </button>
          <button onClick={save} className="rounded-md bg-emerald-600 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-emerald-500">
            Save
          </button>
        </div>
      </div>
    </div>
  )
  return createPortal(panel, document.body)
}
