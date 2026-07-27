'use client'

// Startup update prompt.
//
// On launch the Rust side asks GitHub for the newest published release; if it
// is newer than this build we offer it once. "Download" opens the release page
// in the browser (each OS has its own signed installer there), "Later" asks
// again next launch, "Skip this version" stays quiet until a newer tag lands.

import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Download, X, ArrowUpCircle } from 'lucide-react'

interface UpdateInfo {
  updateAvailable: boolean
  current: string
  latest: string | null
  url: string
  notes: string | null
  publishedAt: string | null
}

const SKIP_KEY = 'orquesta.update.skippedVersion'

// The window is busy spawning PTYs on launch; let it settle before a modal.
const CHECK_DELAY_MS = 2_000

export function UpdateNotice() {
  const [info, setInfo] = useState<UpdateInfo | null>(null)

  useEffect(() => {
    let cancelled = false

    const timer = setTimeout(async () => {
      try {
        const res = await invoke<UpdateInfo | null>('check_for_update')
        if (cancelled || !res?.updateAvailable || !res.latest) return
        if (localStorage.getItem(SKIP_KEY) === res.latest) return
        setInfo(res)
      } catch (err) {
        // Offline, rate-limited, no release yet — never block the terminal.
        console.debug('[update] check failed:', err)
      }
    }, CHECK_DELAY_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [])

  if (!info) return null

  const download = () => {
    invoke('open_external_url', { url: info.url }).catch(() => {})
    setInfo(null)
  }

  const skip = () => {
    try {
      if (info.latest) localStorage.setItem(SKIP_KEY, info.latest)
    } catch {}
    setInfo(null)
  }

  // Release notes are markdown; show a short plain-text preview, not a render.
  const notes = (info.notes || '')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('<'))
    .slice(0, 8)
    .join('\n')

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-zinc-950 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
          <ArrowUpCircle className="h-4 w-4 text-emerald-400" />
          <h2 className="flex-1 text-sm font-medium text-zinc-100">Update available</h2>
          <button
            onClick={() => setInfo(null)}
            className="rounded-lg p-1 text-zinc-400 hover:bg-white/10 hover:text-white"
            title="Later"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 px-4 py-4">
          <p className="text-sm text-zinc-300">
            Orquesta Terminal{' '}
            <span className="font-mono text-emerald-300">v{info.latest}</span> is out — you are
            running <span className="font-mono text-zinc-400">v{info.current}</span>.
          </p>

          {notes && (
            <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs leading-relaxed text-zinc-400">
              {notes}
            </pre>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-white/10 px-4 py-3">
          <button
            onClick={skip}
            className="rounded-lg px-2.5 py-1.5 text-xs text-zinc-500 hover:text-zinc-300"
          >
            Skip this version
          </button>
          <div className="flex-1" />
          <button
            onClick={() => setInfo(null)}
            className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/10"
          >
            Later
          </button>
          <button
            onClick={download}
            className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-300 transition-colors hover:bg-emerald-500/20"
          >
            <Download className="h-3.5 w-3.5" />
            Download
          </button>
        </div>
      </div>
    </div>
  )
}
