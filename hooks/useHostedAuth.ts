'use client'

import { useState, useEffect, useCallback } from 'react'

const STORAGE_KEY = 'orquesta-hosted-auth'

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
  projects: HostedProject[]
}

const DEFAULT_API_URL = 'https://getorquesta.com'
const WS_URL = 'https://ws.orquesta.live'
const POLL_INTERVAL_MS = 2000
const POLL_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

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
      // Use local proxy to avoid CORS (browser → OSS backend → hosted)
      const res = await fetch('/api/hosted/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: `${url}/api/orquesta-cli/projects`, token }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        const msg = data.error || `Authentication failed (${res.status})`
        setError(msg)
        throw new Error(msg)
      }

      const data = await res.json() as {
        organization?: { id: string; name: string }
        projects?: HostedProject[]
      }

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

    // Open popup
    const popup = window.open(authPageUrl, 'orquesta-auth', 'width=500,height=650,popup=yes')
    if (!popup) {
      // Popup blocked — open in new tab
      window.open(authPageUrl, '_blank')
    }

    try {
      // Poll for result
      const deadline = Date.now() + POLL_TIMEOUT_MS
      let token: string | null = null

      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))

        try {
          // Poll through local proxy to avoid CORS with ws.orquesta.live
          const res = await fetch('/api/hosted/proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: `${WS_URL}/auth/result/${sessionId}`,
              token: 'poll', // token is required by proxy but not used by this endpoint
            }),
          })
          if (res.status === 200) {
            const data = await res.json() as { token?: string; organizationId?: string; organizationName?: string }
            if (data.token) {
              token = data.token
              break
            }
          }
        } catch {
          // Network hiccup — retry
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
      if (err instanceof Error && !error) {
        setError(err.message)
      }
      throw err
    } finally {
      setLoading(false)
    }
  }, [login, error])

  return {
    auth,
    isLoggedIn: !!auth,
    loading,
    error,
    login,
    loginWithBrowser,
    logout,
  }
}
