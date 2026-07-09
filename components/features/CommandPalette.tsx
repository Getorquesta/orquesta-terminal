'use client'

import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { Search, CornerDownLeft } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export interface Command {
  id: string
  label: string
  hint?: string
  /** Small right-aligned keycap, e.g. "⌘1". */
  keys?: string
  group?: string
  icon?: LucideIcon
  /** Keep the palette open after running (e.g. cycling a setting). */
  keepOpen?: boolean
  run: () => void
}

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  commands: Command[]
  placeholder?: string
}

/**
 * A ⌘K-style command palette. Fully self-contained: fuzzy-ish substring filter,
 * full keyboard nav (↑/↓, Enter, Esc), grouped results, glass styling.
 * The host owns `open` state + the global ⌘K/Ctrl+K listener.
 */
export function CommandPalette({ open, onClose, commands, placeholder = 'Type a command…' }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Reset + focus each time it opens.
  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
      // focus after paint so the autofocus lands
      const t = setTimeout(() => inputRef.current?.focus(), 0)
      return () => clearTimeout(t)
    }
  }, [open])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    return commands.filter(c =>
      c.label.toLowerCase().includes(q) ||
      c.hint?.toLowerCase().includes(q) ||
      c.group?.toLowerCase().includes(q)
    )
  }, [commands, query])

  // Clamp active row when the filtered list shrinks.
  useEffect(() => { setActive(0) }, [query])

  const runAt = useCallback((idx: number) => {
    const cmd = filtered[idx]
    if (!cmd) return
    cmd.run()
    if (!cmd.keepOpen) onClose()
  }, [filtered, onClose])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive(a => Math.min(a + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive(a => Math.max(a - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      runAt(active)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  // Keep the active row scrolled into view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!open) return null

  // Group in stable order of first appearance.
  const groups: { name: string; items: { cmd: Command; idx: number }[] }[] = []
  filtered.forEach((cmd, idx) => {
    const name = cmd.group || ''
    let g = groups.find(x => x.name === name)
    if (!g) { g = { name, items: [] }; groups.push(g) }
    g.items.push({ cmd, idx })
  })

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center px-4 pt-[14vh]"
      role="dialog"
      aria-modal="true"
    >
      {/* backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-in slide-in-from-bottom-2"
        onClick={onClose}
      />

      <div
        className="glass relative w-full max-w-xl overflow-hidden rounded-2xl animate-in slide-in-from-bottom-2"
        onKeyDown={onKeyDown}
      >
        {/* search row */}
        <div className="flex items-center gap-3 border-b border-white/10 px-4">
          <Search className="h-4 w-4 shrink-0 text-zinc-500" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={placeholder}
            className="h-12 w-full bg-transparent text-sm text-white placeholder:text-zinc-600 focus:outline-none"
          />
          <kbd className="hidden shrink-0 rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500 sm:block">
            ESC
          </kbd>
        </div>

        {/* results */}
        <div ref={listRef} className="max-h-[52vh] overflow-auto p-1.5">
          {filtered.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-zinc-500">No matching commands</p>
          )}

          {groups.map(group => (
            <div key={group.name || '_'} className="mb-1">
              {group.name && (
                <p className="px-2.5 pb-1 pt-2 font-mono text-[10px] uppercase tracking-wider text-zinc-600">
                  {group.name}
                </p>
              )}
              {group.items.map(({ cmd, idx }) => {
                const Icon = cmd.icon
                const isActive = idx === active
                return (
                  <button
                    key={cmd.id}
                    data-idx={idx}
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => runAt(idx)}
                    className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                      isActive ? 'bg-green-500/15 text-white ring-1 ring-inset ring-green-500/30' : 'text-zinc-300 hover:bg-white/5'
                    }`}
                  >
                    {Icon && (
                      <Icon className={`h-4 w-4 shrink-0 ${isActive ? 'text-green-300' : 'text-zinc-500'}`} />
                    )}
                    <span className="min-w-0 flex-1 truncate">{cmd.label}</span>
                    {cmd.hint && (
                      <span className="hidden shrink-0 truncate text-xs text-zinc-500 sm:block">{cmd.hint}</span>
                    )}
                    {cmd.keys && (
                      <kbd className="shrink-0 rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
                        {cmd.keys}
                      </kbd>
                    )}
                    {isActive && !cmd.keys && (
                      <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-green-300/70" />
                    )}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
