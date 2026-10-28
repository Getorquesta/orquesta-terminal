'use client'

/**
 * A small Markdown renderer for Operator replies: fenced code (with a copy
 * button), headings, lists, quotes, paragraphs, and inline code / bold /
 * italic / links. It builds React elements — never innerHTML — so an agent's
 * reply cannot inject markup. Links open through the app's external-link
 * handler (`target="_blank"`, see lib/open-external.ts).
 */

import { useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { writeText as clipboardWrite } from '@tauri-apps/plugin-clipboard-manager'

export async function copyText(text: string): Promise<boolean> {
  try { await clipboardWrite(text); return true } catch { /* not in Tauri */ }
  try { await navigator.clipboard.writeText(text); return true } catch { return false }
}

export function CopyButton({ text, className = '' }: { text: string; className?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      onClick={async () => {
        if (await copyText(text)) { setDone(true); setTimeout(() => setDone(false), 1200) }
      }}
      className={`flex items-center gap-1 rounded px-1 text-zinc-500 hover:bg-white/5 hover:text-zinc-300 ${className}`}
      title="Copy"
    >
      {done ? <Check className="h-3 w-3 text-green-400" /> : <Copy className="h-3 w-3" />}
    </button>
  )
}

type Block =
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'rule' }
  | { kind: 'para'; text: string }

const LIST_ITEM = /^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let para: string[] = []
  const flush = () => {
    if (para.length) blocks.push({ kind: 'para', text: para.join('\n') })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)/)
    if (fence) {
      flush()
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++])
      blocks.push({ kind: 'code', lang: fence[2], text: body.join('\n') })
      continue
    }
    if (!line.trim()) { flush(); continue }
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) { flush(); blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] }); continue }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); blocks.push({ kind: 'rule' }); continue }
    if (/^\s*>/.test(line)) {
      flush()
      const body: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
      i--
      blocks.push({ kind: 'quote', text: body.join('\n') })
      continue
    }
    const item = line.match(LIST_ITEM)
    if (item) {
      flush()
      const ordered = !!item[1]
      const items: string[] = []
      while (i < lines.length) {
        const m = lines[i].match(LIST_ITEM)
        if (m && !!m[1] === ordered) items.push(m[2])
        else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) items[items.length - 1] += `\n${lines[i].trim()}`
        else break
        i++
      }
      i--
      blocks.push({ kind: 'list', ordered, items })
      continue
    }
    para.push(line)
  }
  flush()
  return blocks
}

// `code` | **bold** | *italic* / _italic_ | [text](url) | bare url
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\s][^*\n]*\*|\b_[^_\s][^_\n]*_\b)|(\[[^\]\n]+\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g

function link(href: string, children: ReactNode, key: number) {
  return (
    <a key={key} href={href} target="_blank" rel="noreferrer" className="text-green-300 underline decoration-green-300/40 underline-offset-2 hover:decoration-green-300">
      {children}
    </a>
  )
}

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let k = 0
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    const [whole, code, bold, italic, md, mdHref, bare] = m
    if (code) out.push(<code key={k++} className="rounded bg-white/10 px-1 py-px font-mono text-[0.85em] text-zinc-100">{code.slice(1, -1)}</code>)
    else if (bold) out.push(<strong key={k++} className="font-semibold text-white">{inline(bold.slice(2, -2))}</strong>)
    else if (italic) out.push(<em key={k++}>{inline(italic.slice(1, -1))}</em>)
    else if (md && mdHref) out.push(link(mdHref, md.slice(1, md.indexOf('](')), k++))
    else if (bare) out.push(link(bare, bare, k++))
    else out.push(whole)
    last = at + whole.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const HEADING = ['text-base', 'text-[15px]', 'text-sm', 'text-sm', 'text-sm', 'text-sm']

export function OperatorMarkdown({ text }: { text: string }) {
  const blocks = parseBlocks(text)
  return (
    <div className="space-y-2.5 break-words text-sm leading-relaxed text-zinc-200">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'code':
            return (
              <div key={i} className="overflow-hidden rounded-lg border border-white/10 bg-black/40">
                <div className="flex items-center justify-between border-b border-white/5 px-2.5 py-1 font-mono text-[10px] text-zinc-500">
                  <span>{b.lang || 'code'}</span>
                  <CopyButton text={b.text} />
                </div>
                <pre className="overflow-x-auto p-2.5 font-mono text-[12px] leading-relaxed text-zinc-200"><code>{b.text}</code></pre>
              </div>
            )
          case 'heading':
            return <p key={i} className={`${HEADING[b.level - 1]} pt-1 font-semibold text-white`}>{inline(b.text)}</p>
          case 'list': {
            const Tag = b.ordered ? 'ol' : 'ul'
            return (
              <Tag key={i} className={`space-y-1 pl-5 ${b.ordered ? 'list-decimal' : 'list-disc'} marker:text-zinc-500`}>
                {b.items.map((it, j) => <li key={j} className="whitespace-pre-wrap">{inline(it)}</li>)}
              </Tag>
            )
          }
          case 'quote':
            return <blockquote key={i} className="whitespace-pre-wrap border-l-2 border-white/15 pl-3 text-zinc-400">{inline(b.text)}</blockquote>
          case 'rule':
            return <hr key={i} className="border-white/10" />
          default:
            return <p key={i} className="whitespace-pre-wrap">{inline(b.text)}</p>
        }
      })}
    </div>
  )
}
