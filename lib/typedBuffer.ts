/**
 * Reconstructing the line a human is typing from xterm's raw keystroke stream,
 * so a prompt sent by hand can show up on the board like a dispatched one.
 *
 * We only ever see what the user *sends*, never what the CLI echoes back, so
 * this has to rebuild the line itself: honour backspace, drop escape sequences
 * (arrows, history recall, function keys), and treat CR/LF as submit. Ctrl-C
 * abandons the line, same as the shell would.
 */

/** In-progress typed line, plus whether we're inside a bracketed paste. */
export interface TypedBuffer {
  line: string
  pasting: boolean
}

export const emptyTypedBuffer = (): TypedBuffer => ({ line: '', pasting: false })

/**
 * Below this, a submitted line is an answer rather than a prompt — "y", "no",
 * a menu pick. Cheap heuristic, and a wrong guess only costs a card you delete.
 */
export const MIN_TYPED_PROMPT = 4

/**
 * Feed raw terminal input; returns the new state. `submit` fires once per
 * completed line.
 *
 * Two things this must NOT do, both learned from a board that grew 700 junk
 * cards in a day:
 *
 * - **A paste is one prompt, not one per line.** xterm frames a paste in
 *   `ESC[200~ … ESC[201~`; the newlines inside it are content, not submits.
 *   Stripping the brackets and splitting on every newline turned one pasted
 *   console dump into ~200 cards.
 * - **Terminal auto-replies are not typing.** A CLI asking for the background
 *   colour gets `ESC]11;rgb:e8e8/…` back on this same stream. Skipping to the
 *   first letter mistook the `r` of `rgb` for a CSI terminator and left
 *   `gb:e8e8/…` in the buffer, which then became a card. So parse the sequence
 *   families properly: CSI ends on a final byte, OSC/DCS run to BEL or ST.
 */
export function feedTypedBuffer(state: TypedBuffer, data: string, submit: (line: string) => void): TypedBuffer {
  let out = state.line
  let pasting = state.pasting
  for (let i = 0; i < data.length; i++) {
    const ch = data[i]
    if (ch === '\x1b') {
      const next = data[i + 1]
      if (next === '[') {
        // CSI — runs to a final byte in @…~. Paste brackets are CSI too.
        let j = i + 2
        while (j < data.length && !/[@-~]/.test(data[j])) j++
        const seq = data.slice(i, j + 1)
        if (seq === '\x1b[200~') pasting = true
        else if (seq === '\x1b[201~') pasting = false
        i = j
        continue
      }
      if (next === ']' || next === 'P' || next === 'X' || next === '^' || next === '_') {
        // OSC/DCS/SOS/PM/APC — payload until BEL or ST (ESC \).
        let j = i + 2
        while (j < data.length && data[j] !== '\x07' && !(data[j] === '\x1b' && data[j + 1] === '\\')) j++
        i = data[j] === '\x1b' ? j + 1 : j
        continue
      }
      // SS3 (ESC O <char>, the arrow keys in application mode) takes one more.
      i += next === 'O' ? 2 : 1
      continue
    }
    if (ch === '\r' || ch === '\n') {
      // Inside a paste this is content; the submit comes with the Enter the
      // human presses afterwards.
      if (pasting) { out += '\n'; continue }
      submit(out)
      out = ''
      continue
    }
    if (ch === '\x7f' || ch === '\b') { out = out.slice(0, -1); continue }
    if (ch === '\x03') { out = ''; continue }
    if (ch < ' ') continue
    out += ch
  }
  return { line: out, pasting }
}
