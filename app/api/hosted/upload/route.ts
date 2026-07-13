import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/hosted/upload
 *
 * Multipart sibling of /api/hosted/proxy: forwards a browser file upload to a
 * hosted Orquesta endpoint (avoids CORS from localhost). The JSON proxy can't
 * carry a file body, so uploads come through here.
 *
 * Form fields: url (string), token (string), file (File)
 * Returns: the proxied JSON response.
 */
export async function POST(request: NextRequest) {
  try {
    const form = await request.formData()
    const url = form.get('url')
    const token = form.get('token')
    const file = form.get('file')

    if (typeof url !== 'string' || typeof token !== 'string') {
      return NextResponse.json({ error: 'url and token are required' }, { status: 400 })
    }
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'file is required' }, { status: 400 })
    }

    // SSRF guard: only known Orquesta hosts (same allowlist as the JSON proxy).
    const parsed = new URL(url)
    const allowedHosts = ['getorquesta.com', 'ws.orquesta.live']
    if (!allowedHosts.some(h => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`))) {
      return NextResponse.json({ error: 'Host not allowed' }, { status: 403 })
    }

    // Rebuild a clean multipart body carrying only the file. Do NOT set
    // Content-Type — fetch derives the multipart boundary from the FormData.
    const outbound = new FormData()
    outbound.append('file', file, file.name)

    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: outbound,
    })
    const data = await res.json().catch(() => ({}))

    return NextResponse.json(data, { status: res.status })
  } catch (error) {
    console.error('[hosted/upload] error:', error)
    return NextResponse.json({ error: 'Upload proxy failed' }, { status: 502 })
  }
}
