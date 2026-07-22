'use client'

import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Drop-in replacement for Socket from socket.io-client.
 * Same .on() / .off() / .emit() interface so AgentGrid.tsx requires
 * minimal changes — just swap the type annotation.
 */
export interface TauriHandle {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emit: (event: string, data?: any) => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on: (event: string, handler: (data: any) => void) => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off: (event: string, handler: (data: any) => void) => void
  connected: boolean
  id?: string
}

// Events that go outbound (frontend → Rust) via invoke().
// All others are inbound (Rust → frontend) via listen().
const INVOKE_EVENTS = new Set([
  'session:start',
  'session:input',
  'session:resize',
  'session:end',
  'session:force_end',
  'fs:list-dir',
  'fs:native-pick',
  'hook:status',
  'hook:init-project',
  'terminal:share',
  'terminal:unshare',
  'terminal:share-control',
  'terminal:cursor',
  'daemon:preflight',
  'daemon:start',
  'daemon:stop',
  'daemon:status-request',
  'sessions:external-list',
  'sessions:external-attach',
  'sessions:external-detach',
  'remote:list-agents',
  'remote:start',
  'remote:input',
  'remote:resize',
  'remote:detach',
  'remote:end',
])

// Convert 'session:start' → 'session_start' (Rust command name)
function toCommand(event: string): string {
  return event.replace(/[:-]/g, '_')
}

/**
 * Is there a Tauri shell under us?
 *
 * Not always: `npm run next-dev` serves the same app in a plain browser for UI
 * work, and there `__TAURI_INTERNALS__` is absent — every listen() and invoke()
 * blows up on it. Those throws were the whole of the dev overlay's error pile
 * (one uncaught rejection per subscribed event, plus one per IPC call), which
 * buried any real error under noise.
 *
 * The shell injects this before any app JS runs, so a plain check is enough and
 * needs no caching or readiness dance.
 */
function hasTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useTauri(_opts: { projectId?: string; sessionToken?: string } = {}) {
  const [connected, setConnected] = useState(false)

  // Map of event name → Set of handlers
  const listenersRef = useRef<Map<string, Set<(data: unknown) => void>>>(new Map())
  // Map of event name → Tauri unlisten fn
  const unlistenRef = useRef<Map<string, UnlistenFn>>(new Map())

  // "Connect" on mount — instant when the IPC bridge is there, never when it
  // isn't (browser preview), so the UI reports what's actually true.
  useEffect(() => {
    setConnected(hasTauri())
    return () => {
      setConnected(false)
      // Clean up all Tauri listeners
      unlistenRef.current.forEach((unlisten) => unlisten())
      unlistenRef.current.clear()
      listenersRef.current.clear()
    }
  }, [])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const on = useCallback((event: string, handler: (data: any) => void) => {
    if (!listenersRef.current.has(event)) {
      listenersRef.current.set(event, new Set())
      // Register once with Tauri runtime. Nothing will ever be delivered
      // without a shell, but the local handler set is still kept so on/off
      // stay symmetric and callers need no branch of their own.
      if (hasTauri()) {
        listen(event, (tauriEvent) => {
          const handlers = listenersRef.current.get(event)
          handlers?.forEach((h) => h(tauriEvent.payload))
        })
          .then((unlisten) => {
            unlistenRef.current.set(event, unlisten)
          })
          .catch((err) => console.warn(`[tauri] listen ${event} failed:`, err))
      }
    }
    listenersRef.current.get(event)!.add(handler)
  }, [])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const off = useCallback((event: string, handler: (data: any) => void) => {
    listenersRef.current.get(event)?.delete(handler)
  }, [])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const emit = useCallback((event: string, data?: any) => {
    if (!INVOKE_EVENTS.has(event) || !hasTauri()) return
    const cmd = toCommand(event)
    invoke(cmd, (data as Record<string, unknown>) ?? {}).catch((err) =>
      console.error(`[tauri] invoke ${cmd} failed:`, err),
    )
  }, [])

  /**
   * Like emit() but returns the Rust command's return value.
   * Use this when you need the ack/callback pattern:
   *   socket.emit('remote:list-agents', payload, cb)
   *   → emitWithAck('remote:list-agents', payload).then(cb)
   */
  const emitWithAck = useCallback(
    async (event: string, data?: unknown): Promise<unknown> => {
      const cmd = toCommand(event)
      // Callers await a real answer here, so this one can't be silently
      // dropped like emit() — say why instead of failing on a missing global.
      if (!hasTauri()) throw new Error(`${cmd}: no Tauri backend (browser preview)`)
      return invoke(cmd, (data as Record<string, unknown>) ?? {})
    },
    [],
  )

  // Memoize the handle so its identity is STABLE across renders. emit/on/off are
  // already useCallback-stable, so this only changes when `connected` flips (once,
  // at startup). Critical: consumers like TerminalCell key their PTY-lifecycle
  // effect on `socket`; an unmemoized handle (new object every render) made that
  // effect re-run on every parent re-render — tearing down and force-ending the
  // live PTY (→ "Session not found" on the next keystroke, so typing died).
  const handle: TauriHandle = useMemo(
    () => ({ emit, on, off, connected, id: 'tauri-ipc' }),
    [emit, on, off, connected],
  )

  return {
    socket: handle,     // backward-compat: callers do const { socket } = useTauri()
    handle,
    connected,
    agentOnline: connected,
    emit,
    emitWithAck,
  }
}
