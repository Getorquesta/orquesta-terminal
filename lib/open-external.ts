'use client'

/**
 * Opening a link in the user's real browser.
 *
 * Inside the Tauri webview neither of the two web idioms works, and both fail
 * *silently*: `window.open()` is a no-op in WebKitGTK, and an `<a
 * target="_blank">` resolves to the same thing — the click lands, nothing
 * happens, and there is no error anywhere to notice. That is the whole of the
 * "Open [Plugin] and View all plugins do nothing" report: the handlers were
 * never dead, the platform just refuses to honour them.
 *
 * The sanctioned path is our own `open_external_url` command (see
 * `src-tauri/src/ipc.rs`), which exists precisely because the shell plugin is
 * deliberately not exposed over IPC.
 */

function hasTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** Open an http(s) URL in the real browser. Resolves false when nothing could. */
export async function openExternal(url: string): Promise<boolean> {
  if (!/^https?:\/\//i.test(url)) return false

  if (hasTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('open_external_url', { url })
      return true
    } catch {}
    try {
      const { open } = await import('@tauri-apps/plugin-shell')
      await open(url)
      return true
    } catch {}
    return false
  }

  return Boolean(window.open(url, '_blank', 'noopener,noreferrer'))
}

/**
 * Route every `target="_blank"` link on the page through `openExternal`.
 *
 * Deliberately one delegated listener rather than an `onClick` on each anchor:
 * there were ten such links across five components when this was written, and
 * the failure mode of the per-anchor fix is that the eleventh one gets added
 * later and is silently broken again. Anything that is already handled in JS
 * (`preventDefault` called before us) is left alone.
 *
 * Returns the teardown.
 */
export function installExternalLinkHandler(): () => void {
  if (typeof document === 'undefined') return () => {}

  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey) return
    const anchor = (e.target as Element | null)?.closest?.('a[target="_blank"]')
    if (!anchor) return
    const href = anchor.getAttribute('href') || ''
    if (!/^https?:\/\//i.test(href)) return
    e.preventDefault()
    void openExternal(href)
  }

  document.addEventListener('click', onClick)
  return () => document.removeEventListener('click', onClick)
}
