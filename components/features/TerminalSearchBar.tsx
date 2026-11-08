'use client'

// Find-in-scrollback bar shown over a pane. Works on xterm's buffer through the
// search addon, so it reaches everything still in scrollback, not just the screen.

import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import type { ISearchOptions, SearchAddon } from '@xterm/addon-search'
import type { Terminal } from '@xterm/xterm'

const DECORATIONS: ISearchOptions['decorations'] = {
  matchBackground: '#4a3f14',
  matchOverviewRuler: '#a8871f',
  activeMatchBackground: '#d4a72c',
  activeMatchColorOverviewRuler: '#f5d061',
}

export function TerminalSearchBar({ addon, initial, focusNonce, onClose }: {
  addon: SearchAddon
  /** Text to start from, usually the terminal's selection. */
  initial: string
  /** Bumped when the shortcut is pressed again, to pull focus back to the box. */
  focusNonce: number
  onClose: () => void
}) {
  const [query, setQuery] = useState(initial)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [results, setResults] = useState<{ index: number; count: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const options: ISearchOptions = { caseSensitive, decorations: DECORATIONS }

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusNonce])

  useEffect(() => {
    const sub = addon.onDidChangeResults(({ resultIndex, resultCount }) => {
      setResults({ index: resultIndex, count: resultCount })
    })
    return () => {
      sub.dispose()
      // The terminal may already be gone when the pane closes with the bar open.
      try { addon.clearDecorations() } catch {}
    }
  }, [addon])

  useEffect(() => {
    if (!query) { addon.clearDecorations(); setResults(null); return }
    addon.findNext(query, { ...options, incremental: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addon, query, caseSensitive])

  const step = (back: boolean) => {
    if (!query) return
    if (back) addon.findPrevious(query, options)
    else addon.findNext(query, options)
  }

  // The addon stops counting past its highlight limit and reports -1.
  const counter = !results ? ''
    : results.count === 0 ? 'No results'
    : results.count < 0 ? '1000+'
    : `${results.index + 1}/${results.count}`

  return (
    <div
      className="absolute right-3 top-2 z-20 flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900/95 p-1 shadow-xl backdrop-blur"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); onClose() }
          else if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey) }
        }}
        placeholder="Find in terminal"
        spellCheck={false}
        className="w-40 bg-transparent px-1.5 py-0.5 font-mono text-xs text-zinc-100 outline-none placeholder:text-zinc-600"
      />
      <span className="min-w-[3rem] text-right font-mono text-[10px] tabular-nums text-zinc-500">{counter}</span>
      <button
        onClick={() => setCaseSensitive((v) => !v)}
        className={`rounded px-1 py-0.5 font-mono text-[10px] ${caseSensitive ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200'}`}
        title="Match case"
        aria-pressed={caseSensitive}
      >
        Aa
      </button>
      <button onClick={() => step(true)} className="rounded p-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" title="Previous match (Shift+Enter)">
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button onClick={() => step(false)} className="rounded p-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" title="Next match (Enter)">
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <button onClick={onClose} className="rounded p-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" title="Close (Esc)">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

/**
 * Everything a pane needs for search: load the addon onto its terminal, open the
 * bar (from a shortcut or the palette), and render it. Requires the terminal to
 * be created with allowProposedApi, which match highlighting depends on.
 */
export function useTerminalSearch() {
  const [addon, setAddon] = useState<SearchAddon | null>(null)
  const [session, setSession] = useState<{ initial: string; nonce: number } | null>(null)
  const termRef = useRef<Terminal | null>(null)

  const attach = useCallback(async (term: Terminal) => {
    termRef.current = term
    const { SearchAddon } = await import('@xterm/addon-search')
    if (termRef.current !== term) return
    const next = new SearchAddon()
    term.loadAddon(next)
    setAddon(next)
  }, [])

  const detach = useCallback(() => {
    termRef.current = null
    setAddon(null)
    setSession(null)
  }, [])

  const open = useCallback(() => {
    const selection = termRef.current?.getSelection() ?? ''
    setSession((prev) => ({
      initial: selection && !selection.includes('\n') ? selection : prev?.initial ?? '',
      nonce: (prev?.nonce ?? 0) + 1,
    }))
  }, [])

  const close = useCallback(() => {
    setSession(null)
    try { termRef.current?.focus() } catch {}
  }, [])

  const bar = addon && session
    ? <TerminalSearchBar addon={addon} initial={session.initial} focusNonce={session.nonce} onClose={close} />
    : null

  return { attach, detach, open, bar }
}
