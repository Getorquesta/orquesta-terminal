import { test, expect } from '@playwright/test'
import { feedTypedBuffer, emptyTypedBuffer, type TypedBuffer } from '../lib/typedBuffer'

/**
 * The keystroke parser behind "a prompt you typed by hand shows up on the
 * board". Every case here comes from a real board that grew ~700 junk cards in
 * a day: 675 of them born in same-millisecond bursts (pastes split per line)
 * and a dozen more reading `gb:e8e8/e8e8/e8e8` (a terminal auto-reply
 * mis-parsed as typing).
 */

/** Feed one or more chunks; returns everything that got submitted. */
function submissions(...chunks: string[]): string[] {
  const out: string[] = []
  let state: TypedBuffer = emptyTypedBuffer()
  for (const chunk of chunks) state = feedTypedBuffer(state, chunk, (line) => out.push(line))
  return out
}

test('a line is submitted on Enter, backspace and Ctrl-C included', () => {
  expect(submissions('check the raX\x7fm\r')).toEqual(['check the ram'])
  expect(submissions('abandon this\x03start over\r')).toEqual(['start over'])
  // Chunk boundaries are arbitrary — the PTY doesn't send whole lines.
  expect(submissions('check the ', 'ram\r')).toEqual(['check the ram'])
})

test('a multi-line paste is one prompt, not one per line', () => {
  // xterm frames a paste in ESC[200~ … ESC[201~. The newlines inside it are
  // content; the submit is the Enter the human presses afterwards.
  const paste = '\x1b[200~fix the auth middleware:\n- it double-reads the token\n- and swallows 401s\x1b[201~'
  expect(submissions(paste)).toEqual([])
  expect(submissions(paste, '\r')).toEqual([
    'fix the auth middleware:\n- it double-reads the token\n- and swallows 401s',
  ])
})

test('a paste split across chunks stays one prompt', () => {
  // The bracket and its payload routinely arrive in different data events.
  expect(submissions('\x1b[200~one\n', 'two\n', 'three\x1b[201~', '\r')).toEqual(['one\ntwo\nthree'])
})

test('typing after a paste continues the same line', () => {
  expect(submissions('\x1b[200~ship it\x1b[201~', ' please\r')).toEqual(['ship it please'])
})

test('a terminal auto-reply is not typing', () => {
  // A CLI asks for the background colour and the terminal answers on this same
  // stream. Skipping to the first letter used to eat the `r` of `rgb` as a CSI
  // terminator and leave `gb:e8e8/…` behind — 12 cards' worth.
  expect(submissions('\x1b]11;rgb:e8e8/e8e8/e8e8\x07what is eating my ram?\r'))
    .toEqual(['what is eating my ram?'])
  // Same reply, ST-terminated instead of BEL.
  expect(submissions('\x1b]11;rgb:e8e8/e8e8/e8e8\x1b\\what is eating my ram?\r'))
    .toEqual(['what is eating my ram?'])
  // Device Control (DCS) answers the same way — sixel, DECRQSS, xterm+q.
  expect(submissions('\x1bP1$r0m\x1b\\hello there friend\r')).toEqual(['hello there friend'])
})

test('cursor keys and history recall leave no residue', () => {
  // Arrows in normal mode (CSI) and in application mode (SS3), plus a Home key.
  expect(submissions('\x1b[Aup\x1b[Bdown\x1bOCright\x1b[1~home\r')).toEqual(['updownrighthome'])
})
