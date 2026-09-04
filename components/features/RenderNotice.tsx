'use client'

// Tells the user when the app fell back to software rendering, and why.
//
// The fallback itself is automatic (see src-tauri/src/render_guard.rs): when the
// graphics driver takes the webview renderer down, the app restarts with
// LIBGL_ALWAYS_SOFTWARE=1. That recovery is invisible, which is a problem of its
// own — software rendering is noticeably slower, and a user who is not told will
// read it as Orquesta being sluggish. So say it once, with the log path, and
// stay quiet until a NEW failure happens.

import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { MonitorCog, X } from 'lucide-react'

interface RenderDiagnostics {
  mode: string
  failures: number
  reason: string | null
  lastFailure: string | null
  logPath: string | null
}

// Keyed on the timestamp of the failure, so dismissing this incident does not
// silence the next one.
const DISMISS_KEY = 'orquesta.render.dismissedFailure'

export function RenderNotice() {
  const [info, setInfo] = useState<RenderDiagnostics | null>(null)

  useEffect(() => {
    let cancelled = false

    // The window is busy spawning PTYs on launch; this is not urgent.
    const timer = setTimeout(async () => {
      try {
        const raw = await invoke<Record<string, unknown>>('render_diagnostics')
        if (cancelled) return

        const diag: RenderDiagnostics = {
          mode: String(raw.mode ?? 'gpu'),
          failures: Number(raw.failures ?? 0),
          reason: (raw.reason as string) ?? null,
          lastFailure: (raw.last_failure as string) ?? null,
          logPath: (raw.log_path as string) ?? null,
        }

        if (diag.mode !== 'software' || diag.failures === 0) return
        if (localStorage.getItem(DISMISS_KEY) === (diag.lastFailure ?? 'unknown')) return

        setInfo(diag)
      } catch {
        // No Tauri backend (browser preview), or an older build without the
        // command. Neither is worth surfacing.
      }
    }, 3_000)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [])

  if (!info) return null

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, info.lastFailure ?? 'unknown')
    } catch {
      // Private mode / storage disabled: the notice just comes back next launch.
    }
    setInfo(null)
  }

  return (
    <div className="glass fixed bottom-14 left-4 z-50 max-w-sm rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-[11px]">
      <div className="flex items-start gap-2">
        <MonitorCog size={14} className="mt-0.5 flex-shrink-0 text-amber-400" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-amber-200">Running in software rendering</p>
          <p className="mt-1 text-zinc-300">
            {info.reason ?? 'The graphics driver crashed the window renderer.'} Everything works, but
            drawing is slower. Updating your graphics driver fixes it; after that, launch with{' '}
            <code className="rounded bg-black/40 px-1">ORQUESTA_FORCE_GPU=1</code> to go back.
          </p>
          {info.logPath && (
            <p className="mt-1 break-all text-zinc-500">Log: {info.logPath}</p>
          )}
        </div>
        <button
          onClick={dismiss}
          className="flex-shrink-0 rounded p-0.5 text-zinc-500 hover:text-zinc-200"
          aria-label="Dismiss"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  )
}
