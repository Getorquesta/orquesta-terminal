/**
 * Turning raw PTY bytes back into something a human (and a Kanban card) can read.
 *
 * Terminal agents don't print a transcript — they paint a screen. The tail of a
 * pane is full of cursor moves, colour codes, spinner frames rewritten in place
 * with \r, and box-drawing chrome around a permanently-visible input prompt.
 * These helpers strip all of that so the board can show what the agent actually
 * SAID, which is usually a suggestion or a question waiting on the user.
 *
 * Best-effort by nature: it's a heuristic over a screen, not a parse of a
 * protocol. It errs toward showing a bit too much rather than eating the answer.
 */

/** CSI/OSC escapes, charset selects, and the C0 controls we never want to keep. */
const ANSI =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>NOPX^_]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

/** Box drawing, and the pieces of a TUI frame that carry no words. */
const BOX = /[─-╿▀-▟]/g

/**
 * Lines that are pure interface, not speech. Matching is deliberately narrow —
 * a false positive here silently swallows the agent's answer.
 */
const CHROME = [
  /^\s*[>❯$#]\s*$/,                              // empty input prompt
  /^\s*\?\s*for shortcuts/i,
  /^\s*esc(ape)? to (interrupt|cancel)/i,
  /^\s*(ctrl|shift|alt|cmd|⌘)\+/i,
  /^\s*(auto-?accept|bypassing permissions|accept edits)/i,
  /^\s*\(?\s*\d+[smh]?\s*·/,                     // "(12s · ↓ 1.4k tokens)"
  /^\s*[✻✽✢·✳*]\s*\w+…/,                          // "✻ Thinking…" spinner frames
  /^\s*\d+\s*(tokens?|lines?)\b/i,
]

/**
 * Strip escapes, resolve \r overwrites, drop chrome, and keep the last
 * `maxLines` lines that still have words in them.
 */
export function cleanOutput(raw: string, maxLines = 14): string {
  if (!raw) return ''
  const lines = raw
    .replace(ANSI, '')
    // A PTY ends every line with CRLF. That \r is a line terminator, not an
    // overwrite — leave it in and the \r-handling below would treat each line's
    // real content as painted-over and keep the empty tail instead.
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      // A \r rewinds to column 0: whatever came after it painted over the rest,
      // so only the final segment survived on screen (this is how spinners work).
      const seg = line.split('\r')
      return (seg[seg.length - 1] ?? '').replace(BOX, ' ').replace(/\s+$/, '')
    })
    .filter((l) => {
      const body = l.trim()
      if (body.length < 2) return false
      if (!/[\p{L}\p{N}]/u.test(body)) return false // pure punctuation/rules
      return !CHROME.some((re) => re.test(body))
    })
    .map((l) => l.replace(/^\s+/, ''))

  return lines.slice(-maxLines).join('\n')
}

/**
 * The one line of an agent's closing output most worth acting on.
 *
 * A question beats a statement: when an agent ends with "should I close X or
 * Y?" that question IS the next task, and it's exactly what the user wants
 * sitting on the board waiting for a decision. Failing that, the last thing it
 * said stands in as the summary.
 */
export function pickSuggestion(clean: string): string {
  const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return ''
  // Scan from the end: the latest question is the live one.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/[?？]\s*$/.test(lines[i])) {
      // A question often spills over two lines — glue the previous one back on
      // when it clearly runs into this one (no terminal punctuation).
      const prev = i > 0 && !/[.!?:;•—]\s*$/.test(lines[i - 1]) && lines[i - 1].length < 120 ? lines[i - 1] : ''
      return (prev ? `${prev} ${lines[i]}` : lines[i]).slice(0, 400)
    }
  }
  return lines[lines.length - 1].slice(0, 400)
}
