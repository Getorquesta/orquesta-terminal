// DEPRECATED — replaced by useTauri.ts (Phase 8 Tauri migration)
// This stub keeps page.tsx compiling while useTauri.ts is being wired in.
// The socket is always null in Tauri mode — features that depend on socket.io
// (ExternalSessionsButton, TerminalMonitorButton, RemoteSessionModal) will be
// re-wired to Tauri IPC commands in the next migration phase.

'use client'

import { useCallback } from 'react'

interface UseSocketOptions {
  projectId?: string
  sessionToken?: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NullSocket = any

export function useSocket(_opts: UseSocketOptions = {}): {
  socket: NullSocket | null
  connected: boolean
  agentOnline: boolean
  emit: (event: string, data?: unknown) => void
} {
  const emit = useCallback((_event: string, _data?: unknown) => {
    // no-op: socket.io replaced by Tauri IPC
  }, [])

  return { socket: null, connected: false, agentOnline: false, emit }
}
