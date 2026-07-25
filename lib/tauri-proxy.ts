import { invoke } from '@tauri-apps/api/core'

interface ProxyOptions {
  url: string
  token: string
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT'
  body?: unknown
}

function hasTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export async function hostedFetch<T = unknown>(opts: ProxyOptions): Promise<T> {
  if (hasTauri()) {
    return invoke<T>('hosted_proxy', {
      url: opts.url,
      token: opts.token,
      method: opts.method ?? 'GET',
      body: opts.body ?? null,
    })
  }
  const res = await fetch(opts.url, {
    method: opts.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${opts.token}`,
      'Content-Type': 'application/json',
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`)
  }
  return res.json() as Promise<T>
}
