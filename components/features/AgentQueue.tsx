'use client'

// Presentational pieces of the agent queue: the status marker used by the rail,
// the dock and the pane headers, and the corner toasts. See lib/agentQueue.ts.

import { useEffect } from 'react'
import { X } from 'lucide-react'
import type { QueueState } from '@/lib/agentQueue'

const TOAST_MS = 8000

export function StatusMarker({ state }: { state: QueueState }) {
  if (state === 'working') {
    return (
      <span
        title="Working"
        className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-amber-400/25 border-t-amber-400"
      />
    )
  }
  if (state === 'blocked') {
    return (
      <span
        title="Needs you"
        className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded bg-red-500/20 text-[10px] font-bold leading-none text-red-400"
      >
        !
      </span>
    )
  }
  if (state === 'done') {
    return <span title="Done" className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
  }
  return <span title="Idle" className="h-2 w-2 shrink-0 rounded-full border border-zinc-600" />
}

export interface AgentToast {
  key: number
  cellId: string
  kind: 'done' | 'blocked'
  title: string
  note?: string
}

function ToastCard({ toast, onOpen, onDismiss }: {
  toast: AgentToast
  onOpen: (cellId: string) => void
  onDismiss: (key: number) => void
}) {
  useEffect(() => {
    const t = setTimeout(() => onDismiss(toast.key), TOAST_MS)
    return () => clearTimeout(t)
  }, [toast.key, onDismiss])

  return (
    <div className="pointer-events-auto flex w-72 items-start gap-2.5 rounded-lg border border-zinc-800 bg-zinc-950/95 px-3 py-2.5 shadow-2xl backdrop-blur">
      <span className="mt-1"><StatusMarker state={toast.kind} /></span>
      <button onClick={() => onOpen(toast.cellId)} className="min-w-0 flex-1 text-left" title="Go to this terminal">
        <span className="block truncate text-xs font-medium text-zinc-100">{toast.title}</span>
        <span className="block truncate text-[11px] text-zinc-400">
          {toast.note ?? (toast.kind === 'blocked' ? 'Needs you' : 'Finished')}
        </span>
      </button>
      <button
        onClick={() => onDismiss(toast.key)}
        className="shrink-0 rounded p-0.5 text-zinc-600 hover:bg-zinc-800 hover:text-zinc-200"
        title="Dismiss"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}

export function AgentToastStack({ toasts, onOpen, onDismiss }: {
  toasts: AgentToast[]
  onOpen: (cellId: string) => void
  onDismiss: (key: number) => void
}) {
  if (toasts.length === 0) return null
  return (
    <div className="pointer-events-none fixed bottom-20 right-4 z-[250] flex flex-col gap-2">
      {toasts.map((t) => <ToastCard key={t.key} toast={t} onOpen={onOpen} onDismiss={onDismiss} />)}
    </div>
  )
}
