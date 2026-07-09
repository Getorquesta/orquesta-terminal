import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/hosted/proxy
 *
 * Server-side proxy to hosted Orquesta APIs. Avoids CORS issues when the
 * browser calls getorquesta.com from localhost.
 *
 * Body: { url: string, token: string, method?: string, body?: object }
 * Returns: proxied JSON response
 */
export async function POST(request: NextRequest) {
  try {
    const payload = await request.json() as {
      url?: string
      token?: string
      method?: string
      body?: Record<string, unknown>
    }

    if (!payload.url || !payload.token) {
      return NextResponse.json({ error: 'url and token are required' }, { status: 400 })
    }

    // Only allow proxying to known Orquesta domains (security: prevent SSRF)
    const parsed = new URL(payload.url)
    const allowedHosts = ['getorquesta.com', 'ws.orquesta.live']
    if (!allowedHosts.some(h => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`))) {
      return NextResponse.json({ error: 'Host not allowed' }, { status: 403 })
    }

    const method = payload.method || 'GET'
    const fetchOpts: RequestInit = {
      method,
      headers: {
        'Authorization': `Bearer ${payload.token}`,
        'Content-Type': 'application/json',
      },
    }

    // Include body for non-GET requests
    if (method !== 'GET' && payload.body) {
      fetchOpts.body = JSON.stringify(payload.body)
    }

    const res = await fetch(payload.url, fetchOpts)
    const data = await res.json().catch(() => ({}))

    return NextResponse.json(data, { status: res.status })
  } catch (error) {
    console.error('[hosted/proxy] error:', error)
    return NextResponse.json({ error: 'Proxy request failed' }, { status: 502 })
  }
}
