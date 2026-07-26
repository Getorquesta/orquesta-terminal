'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { hostedFetch } from '@/lib/tauri-proxy'

const STORAGE_KEY = 'orquesta-hosted-auth'

function hasTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export interface HostedProject {
  id: string
  name: string
  slug?: string
  description?: string
}

export interface HostedAuth {
  apiUrl: string
  token: string
  organizationName?: string
  /** The logged-in user's id — used to attribute self-reported prompts to the
   *  actual person driving, not the machine reporting-token's owner. */
  userId?: string
  projects: HostedProject[]
}

const DEFAULT_API_URL = 'https://getorquesta.com'
const WS_URL = 'https://ws.orquesta.live'
const POLL_INTERVAL_MS = 2000
const POLL_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Send the user to the authorization page in their real browser.
 *
 * Inside Tauri this has to go through our own `open_external_url` command: the
 * webview isn't granted `shell:allow-open`, so `@tauri-apps/plugin-shell`'s
 * `open()` is rejected — and `window.open()` is a no-op in the WebKitGTK
 * webview, so the fallback silently did nothing and sign-in sat on "Waiting…"
 * until it timed out. Returns the popup handle (browsers only) or `false` when
 * nothing could be opened, so the caller can offer the link by hand.
 */
export async function openAuthPage(url: string): Promise<Window | null | false> {
  if (hasTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('open_external_url', { url })
      return null
    } catch {}
    try {
      const { open } = await import('@tauri-apps/plugin-shell')
      await open(url)
      return null
    } catch {}
    return false
  }
  const popup = window.open(url, 'orquesta-auth', 'width=500,height=650,popup=yes')
  if (popup) return popup
  return window.open(url, '_blank') || false
}

/**
 * Shared hook that manages authentication against a hosted Orquesta instance.
 * Stores token + fetched projects in localStorage so every component
 * (login page, terminal panel, grid cells) can read them without re-fetching.
 *
 * Flow: user provides an `oclt_` CLI token → we hit
 * `GET <apiUrl>/api/orquesta-cli/projects` → store org + projects.
 */
export function useHostedAuth() {
  const [auth, setAuth] = useState<HostedAuth | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Authorization page for the sign-in currently in flight, if any. */
  const [pendingAuthUrl, setPendingAuthUrl] = useState<string | null>(null)
  const cancelRef = useRef(false)

  // Load from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const parsed = JSON.parse(saved) as HostedAuth
        if (parsed.token && parsed.projects?.length) {
          setAuth(parsed)
        }
      }
    } catch {}
  }, [])

  const persist = useCallback((data: HostedAuth | null) => {
    setAuth(data)
    try {
      if (data) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
      } else {
        localStorage.removeItem(STORAGE_KEY)
      }
    } catch {}
  }, [])

  /**
   * Authenticate with a token against the hosted API and fetch projects.
   * Uses the local proxy to avoid CORS when calling from the browser.
   * Returns the projects on success, throws on failure.
   */
  const login = useCallback(async (token: string, apiUrl?: string): Promise<HostedProject[]> => {
    const url = (apiUrl || DEFAULT_API_URL).replace(/\/$/, '')
    setLoading(true)
    setError(null)

    try {
      // Use Tauri invoke to avoid CORS (Rust makes the HTTP request directly)
      const data = await hostedFetch<{
        organization?: { id: string; name: string }
        user?: { id: string }
        projects?: HostedProject[]
      }>({ url: `${url}/api/orquesta-cli/projects`, token })

      if (!data.organization) {
        const msg = 'Invalid token — no organization found'
        setError(msg)
        throw new Error(msg)
      }

      const projects = data.projects ?? []
      if (projects.length === 0) {
        const msg = 'No projects found for this token'
        setError(msg)
        throw new Error(msg)
      }

      const authData: HostedAuth = {
        apiUrl: url,
        token,
        organizationName: data.organization.name,
        userId: data.user?.id,
        projects,
      }
      persist(authData)
      return projects
    } finally {
      setLoading(false)
    }
  }, [persist])

  const logout = useCallback(() => {
    persist(null)
    setError(null)
  }, [persist])

  /**
   * Browser-based OAuth login — same flow as `orquesta-cli login`:
   * 1. Generate session UUID
   * 2. Open popup to getorquesta.com/cli/auth?session=<id>
   * 3. User logs in (Google/magic-link) and clicks "Authorize"
   * 4. Hosted mints oclt_ and POSTs to ws.orquesta.live/auth/result
   * 5. We poll GET /auth/result/<id> until we get the token
   * 6. Use the token to fetch projects
   */
  const loginWithBrowser = useCallback(async (apiUrl?: string): Promise<HostedProject[]> => {
    const url = (apiUrl || DEFAULT_API_URL).replace(/\/$/, '')
    setLoading(true)
    setError(null)

    const sessionId = crypto.randomUUID()
    const authPageUrl = `${url}/cli/auth?session=${sessionId}`

    // Surfaced by the UI while we wait, so the user can reach the page by hand
    // if their browser didn't come up.
    setPendingAuthUrl(authPageUrl)
    cancelRef.current = false

    const opened = await openAuthPage(authPageUrl)
    if (opened === false) {
      const msg = hasTauri()
        ? "Couldn't open your browser — use the sign-in link below"
        : 'Popup blocked — please allow popups for this site or use the token method below'
      setError(msg)
      setLoading(false)
      setPendingAuthUrl(null)
      throw new Error(msg)
    }
    const popup: Window | null = opened

    try {
      // Poll for result
      const deadline = Date.now() + POLL_TIMEOUT_MS
      let token: string | null = null

      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))

        if (cancelRef.current) {
          const msg = 'Sign-in cancelled'
          setError(null)
          throw new Error(msg)
        }

        try {
          // Poll through Tauri invoke to avoid CORS with ws.orquesta.live
          const data = await hostedFetch<{ token?: string; organizationId?: string; organizationName?: string }>({
            url: `${WS_URL}/auth/result/${sessionId}`,
            token: 'poll', // token is required by invoke but not used by this endpoint
          })
          if (data.token) {
            token = data.token
            break
          }
        } catch {
          // Network hiccup or 404 (not ready yet) — retry
        }

        // Check if popup was closed without authorizing
        if (popup && popup.closed) {
          const msg = 'Authorization window was closed'
          setError(msg)
          throw new Error(msg)
        }
      }

      if (!token) {
        const msg = 'Authorization timed out (5 min). Try again.'
        setError(msg)
        throw new Error(msg)
      }

      // Close popup if still open
      try { popup?.close() } catch {}

      // Now use the token to fetch projects (same as login())
      return await login(token, url)
    } catch (err) {
      if (err instanceof Error && !error && err.message !== 'Sign-in cancelled') {
        setError(err.message)
      }
      throw err
    } finally {
      setLoading(false)
      setPendingAuthUrl(null)
    }
  }, [login, error])

  /** Stop waiting for the browser — the poll loop bails on its next tick. */
  const cancelBrowserLogin = useCallback(() => {
    cancelRef.current = true
  }, [])

  return {
    auth,
    isLoggedIn: !!auth,
    loading,
    error,
    pendingAuthUrl,
    login,
    loginWithBrowser,
    cancelBrowserLogin,
    logout,
  }
}
