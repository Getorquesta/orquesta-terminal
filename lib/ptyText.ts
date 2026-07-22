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
  /^[>❯$#]\s*$/,                                 // empty input prompt
  /^\?\s*for shortcuts/i,
  /^esc(ape)? to (interrupt|cancel)/i,
  /^(ctrl|shift|alt|cmd|⌘)\+/i,
  /^(auto-?accept|bypass\w*|accept edits)/i,
  /^[⏵⏴▶▷]/,                                     // mode row: "⏵⏵ bypass permissions on"
  /^[✻✽✢✳✶✷✸✹·*]\s/,                              // status row: "✻ Baked for 15s"
  /^⚠\s*transcript saving/i,
  /^\(?\s*\d+[smh]?\s*·/,                        // "(12s · ↓ 1.4k tokens)"
  /^\d+\s*(tokens?|lines?)\b/i,
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

/** A list item: "- do the thing", "• do the thing", "2) do the thing". */
const BULLET = /^\s*(?:[-*•·◦▪‣]|\d+[.)])\s+(.{8,})$/

/** Lead-ins that announce a list of actions rather than a sentence. */
const LEAD_IN =
  /\b(wins?|steps?|options?|next|recommend\w*|suggest\w*|todo|ideas?|acciones|pasos|opciones|sugerencias|recomiendo|podr[íi]as?|puedo)\b/i

/**
 * How an agent hands the decision back without asking a literal question.
 * "Dime si quieres que apague la VM." carries no '?', but it is exactly the
 * thing the board exists to queue.
 */
const OFFER =
  /^(dime |av[ií]same|d[ií]game|si quer[ée]s|si quieres|quieres que|puedo |te (puedo|sirvo)|¿|let me know|want me to|shall i|should i|i can |tell me (if|which)|would you like)/i

/**
 * Split "a, b (x, y), and c" into three clauses. Commas inside brackets belong
 * to the clause — "(5 running, ~1.7 GB total)" is one parenthetical, not two
 * separate pieces of advice.
 */
function splitClauses(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  const push = () => {
    const t = cur.trim().replace(/^(?:and|or|y|o)\s+/i, '').replace(/[.;]+$/, '')
    if (t.length >= 12) out.push(t)
    cur = ''
  }
  for (const ch of text) {
    if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1)
    if (depth === 0 && (ch === ',' || ch === ';')) { push(); continue }
    cur += ch
  }
  push()
  return out
}

/**
 * What an agent's closing output is asking you to decide, as separate items.
 *
 * Three shapes, because agents end in all three:
 *   - a bulleted/numbered list of actions
 *   - one line that packs the list into prose ("Quickest wins: do a, do b, and do c")
 *   - a question ("should I stop Waydroid or the dev server?")
 * Each item comes back on its own so it can become its own card — a list of
 * three "quickest wins" is three pieces of work, not one.
 *
 * Falls back to the last thing said, which at worst is a summary of the run.
 */
export function pickSuggestions(clean: string, max = 5): string[] {
  const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return []
  const tail = lines.slice(-25)
  const cap = (s: string) => s.slice(0, 300)

  const bullets = tail.map((l) => l.match(BULLET)?.[1]?.trim()).filter((s): s is string => !!s)
  if (bullets.length >= 2) return bullets.slice(-max).map(cap)

  // Prose list: a short lead-in, a colon, then clauses. Requiring either a
  // recognisable lead-in word or three-plus clauses keeps ordinary sentences
  // with a colon ("Error: connection refused, retrying") out of it.
  for (let i = tail.length - 1; i >= 0; i--) {
    const m = tail[i].match(/^(.{0,48}?):\s+(.{24,})$/)
    if (!m) continue
    const clauses = splitClauses(m[2])
    if (clauses.length >= 2 && (LEAD_IN.test(m[1]) || clauses.length >= 3)) return clauses.slice(0, max).map(cap)
  }

  // A question, latest first. It often spills over two lines — glue the
  // previous one back on when it clearly runs into this one.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!/[?？]\s*$/.test(lines[i])) continue
    const prev = i > 0 && !/[.!?:;•—]\s*$/.test(lines[i - 1]) && lines[i - 1].length < 120 ? lines[i - 1] : ''
    return [cap(prev ? `${prev} ${lines[i]}` : lines[i])]
  }

  // An offer to act, latest first: the same handover as a question, minus the
  // question mark. Scanned after '?' so an explicit question still wins.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (OFFER.test(lines[i]) && lines[i].length >= 24) return [cap(lines[i])]
  }

  if (bullets.length === 1) return [cap(bullets[0])]
  return [cap(lines[lines.length - 1])]
}
