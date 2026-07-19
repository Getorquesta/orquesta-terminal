import { invoke } from '@tauri-apps/api/core'

interface ProxyOptions {
  url: string
  token: string
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT'
  body?: unknown
}

export async function hostedFetch<T = unknown>(opts: ProxyOptions): Promise<T> {
  return invoke<T>('hosted_proxy', {
    url: opts.url,
    token: opts.token,
    method: opts.method ?? 'GET',
    body: opts.body ?? null,
  })
}
