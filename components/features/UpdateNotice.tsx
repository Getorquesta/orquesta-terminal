'use client'

// Startup update prompt.
//
// On launch we ask for the newest published release; if it is newer than this
// build we offer it once. Installs that can replace themselves — the AppImage
// on Linux, the NSIS install on Windows, the .app on macOS — get "Update &
// restart": the signed installer is downloaded, its signature checked against
// the key baked into tauri.conf.json, and the app relaunches on the new
// version. A .deb/.rpm install belongs to the package manager, so there we fall
// back to what this dialog used to do and open the release page.
//
// "Later" asks again next launch, "Skip this version" stays quiet until a newer
// tag lands.

import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { Download, X, ArrowUpCircle, Loader2, RefreshCw } from 'lucide-react'

interface UpdateInfo {
  updateAvailable: boolean
  current: string
  latest: string | null
  url: string
  notes: string | null
  publishedAt: string | null
}

// What the dialog shows, whichever path found the release.
interface Offer {
  latest: string
  current: string
  notes: string | null
  /// Set when the app can install this itself; null on .deb/.rpm and whenever
  /// the manifest could not be read, in which case `url` is all we have.
  update: Update | null
  url: string
}

const SKIP_KEY = 'orquesta.update.skippedVersion'

// The window is busy spawning PTYs on launch; let it settle before a modal.
const CHECK_DELAY_MS = 2_000

const RELEASES_PAGE = 'https://github.com/Getorquesta/orquesta-terminal/releases/latest'

type Phase = 'idle' | 'downloading' | 'installing' | 'failed'

export function UpdateNotice() {
  const [offer, setOffer] = useState<Offer | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const timer = setTimeout(async () => {
      const found = await findUpdate()
      if (cancelled || !found) return
      if (localStorage.getItem(SKIP_KEY) === found.latest) return
      setOffer(found)
    }, CHECK_DELAY_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [])

  if (!offer) return null

  const busy = phase === 'downloading' || phase === 'installing'

  const install = async () => {
    if (!offer.update) return
    setError(null)
    setPhase('downloading')
    try {
      let done = 0
      await offer.update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          setProgress({ done: 0, total: event.data.contentLength ?? 0 })
        } else if (event.event === 'Progress') {
          done += event.data.chunkLength
          setProgress((p) => ({ done, total: p?.total ?? 0 }))
        } else if (event.event === 'Finished') {
          setPhase('installing')
        }
      })
      // Windows hands control to the installer and closes us; elsewhere we ask.
      await relaunch()
    } catch (err) {
      console.error('[update] install failed:', err)
      setError(String(err))
      setPhase('failed')
    }
  }

  const openReleasePage = () => {
    invoke('open_external_url', { url: offer.url }).catch(() => {})
    setOffer(null)
  }

  const skip = () => {
    try {
      localStorage.setItem(SKIP_KEY, offer.latest)
    } catch {}
    setOffer(null)
  }

  // Release notes are markdown; show a short plain-text preview, not a render.
  const notes = (offer.notes || '')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('<'))
    .slice(0, 8)
    .join('\n')

  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.done / progress.total) * 100))
      : null

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-zinc-950 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
          <ArrowUpCircle className="h-4 w-4 text-emerald-400" />
          <h2 className="flex-1 text-sm font-medium text-zinc-100">Update available</h2>
          {!busy && (
            <button
              onClick={() => setOffer(null)}
              className="rounded-lg p-1 text-zinc-400 hover:bg-white/10 hover:text-white"
              title="Later"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="space-y-3 px-4 py-4">
          <p className="text-sm text-zinc-300">
            Orquesta Terminal{' '}
            <span className="font-mono text-emerald-300">v{offer.latest}</span> is out — you are
            running <span className="font-mono text-zinc-400">v{offer.current}</span>.
          </p>

          {notes && !busy && (
            <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs leading-relaxed text-zinc-400">
              {notes}
            </pre>
          )}

          {busy && (
            <div className="space-y-2">
              <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full bg-emerald-400 transition-[width] duration-200"
                  style={{ width: phase === 'installing' ? '100%' : `${pct ?? 5}%` }}
                />
              </div>
              <p className="text-xs text-zinc-400">
                {phase === 'installing'
                  ? 'Installing — the app will restart…'
                  : pct !== null
                    ? `Downloading… ${pct}%`
                    : 'Downloading…'}
              </p>
            </div>
          )}

          {error && (
            <p className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-300">
              {error}
            </p>
          )}

          {!offer.update && !busy && (
            <p className="text-xs text-zinc-500">
              This install is managed by your package manager, so it cannot update itself — the
              release page has the new installer.
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-white/10 px-4 py-3">
          <button
            onClick={skip}
            disabled={busy}
            className="rounded-lg px-2.5 py-1.5 text-xs text-zinc-500 hover:text-zinc-300 disabled:opacity-40"
          >
            Skip this version
          </button>
          <div className="flex-1" />
          <button
            onClick={() => setOffer(null)}
            disabled={busy}
            className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/10 disabled:opacity-40"
          >
            Later
          </button>
          {offer.update ? (
            <button
              onClick={install}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:opacity-60"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              {phase === 'failed' ? 'Retry' : 'Update & restart'}
            </button>
          ) : (
            <button
              onClick={openReleasePage}
              className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-300 transition-colors hover:bg-emerald-500/20"
            >
              <Download className="h-3.5 w-3.5" />
              Download
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/// Prefer the signed manifest — it is what we can install. Anything that stops
/// it (a .deb install, a release published before latest.json existed, GitHub
/// being unreachable) falls back to the plain release check, which at worst
/// tells the user a new version exists.
async function findUpdate(): Promise<Offer | null> {
  try {
    const selfUpdatable = await invoke<boolean>('can_self_update')
    if (selfUpdatable) {
      const update = await check()
      if (update) {
        return {
          latest: update.version,
          current: update.currentVersion,
          notes: update.body ?? null,
          update,
          url: RELEASES_PAGE,
        }
      }
      // No manifest match is not proof there is nothing newer — the release
      // may predate latest.json — so let the fallback have a look.
    }
  } catch (err) {
    console.debug('[update] manifest check failed:', err)
  }

  try {
    const res = await invoke<UpdateInfo | null>('check_for_update')
    if (!res?.updateAvailable || !res.latest) return null
    return {
      latest: res.latest,
      current: res.current,
      notes: res.notes,
      update: null,
      url: res.url,
    }
  } catch (err) {
    // Offline, rate-limited, no release yet — never block the terminal.
    console.debug('[update] check failed:', err)
    return null
  }
}
