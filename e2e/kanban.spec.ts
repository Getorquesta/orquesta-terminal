import { test, expect, type Page } from '@playwright/test'
import { TAURI_MOCK_SCRIPT } from './tauri-mock'

// Board state lives in localStorage under the active project scope; with no
// project selected that's `standalone`.
const BOARD_KEY = 'orquesta-kanban-standalone'

/** Seed the board before the app boots — lets us start from any column state. */
function seed(cards: Record<string, unknown>[]) {
  return `try { localStorage.setItem(${JSON.stringify(BOARD_KEY)}, JSON.stringify({ v: 1, cards: ${JSON.stringify(cards)} })) } catch (e) {}`
}

function card(over: Record<string, unknown> = {}) {
  return {
    id: `k_${Math.random().toString(36).slice(2, 9)}`,
    text: 'Refactor the auth middleware',
    column: 'backlog',
    tags: [],
    createdAt: 1700000000000,
    order: 0,
    ...over,
  }
}

/**
 * Playwright's dragTo() doesn't emit HTML5 drag events for this board, so drive
 * the real DragEvent sequence by hand with a shared DataTransfer. This exercises
 * the app's own dragstart/dragover/drop handlers — only Chromium's native drag
 * plumbing is bypassed.
 */
async function dragCardToColumn(page: Page, cardId: string, column: string) {
  await page.evaluate(([id, col]) => {
    const card = document.querySelector<HTMLElement>(`[data-card-id="${id}"]`)
    const target = document.querySelector<HTMLElement>(`[data-testid="kanban-column-${col}"]`)
    if (!card || !target) throw new Error('drag source or target missing')
    const dt = new DataTransfer()
    const fire = (el: HTMLElement, type: string) =>
      el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
    fire(card, 'dragstart')
    fire(target, 'dragover')
    fire(target, 'drop')
    fire(card, 'dragend')
  }, [cardId, column] as const)
}

/**
 * Open a terminal pane and wait until its PTY session has actually been
 * started. Dispatching before that races the pane's xterm/session init and the
 * board (correctly) refuses to run the card.
 */
async function openLivePane(page: Page) {
  await expect(page.locator('text=Terminal Grid').first()).toBeVisible({ timeout: 15_000 })
  await page.locator('button', { hasText: 'Add Terminal' }).first().click()
  await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 15_000 })
  await expect
    .poll(async () => page.evaluate(() => {
      const calls = (window as unknown as { __tauriCalls: { cmd: string }[] }).__tauriCalls || []
      return calls.some(c => c.cmd === 'session_start')
    }), { timeout: 15_000 })
    .toBe(true)
}

/** The PTY id of the pane opened by openLivePane(). */
async function liveSessionId(page: Page): Promise<string> {
  const sid = await page.evaluate(() => {
    const calls = (window as unknown as { __tauriCalls: { cmd: string; args?: { sessionId?: string } }[] }).__tauriCalls || []
    return calls.find(c => c.cmd === 'session_start')?.args?.sessionId ?? ''
  })
  expect(sid).not.toBe('')
  return sid
}

/** Push a backend event at the app the way the Tauri shell would. */
async function emit(page: Page, event: string, payload: unknown) {
  await page.evaluate(([e, p]) => {
    ;(window as unknown as { __tauriEmit: (e: string, p: unknown) => void }).__tauriEmit(e as string, p)
  }, [event, payload] as const)
}

/** Every `session_input` payload the UI has written to a PTY so far. */
async function ptyWrites(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const calls = (window as unknown as { __tauriCalls: { cmd: string; args?: { data?: string } }[] }).__tauriCalls || []
    return calls.filter(c => c.cmd === 'session_input').map(c => c.args?.data ?? '')
  })
}

async function openBoard(page: Page) {
  await page.getByTestId('board-toggle').click()
  await expect(page.getByTestId('kanban-board')).toBeVisible({ timeout: 5_000 })
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(TAURI_MOCK_SCRIPT)
})

// ── Shell ───────────────────────────────────────────────────────────────────

test('board toggle opens the five-column board', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('header', { state: 'visible' })
  await openBoard(page)

  for (const col of ['backlog', 'queued', 'running', 'review', 'done']) {
    await expect(page.getByTestId(`kanban-column-${col}`)).toBeVisible()
  }
  await expect(page.getByText('Prompt board')).toBeVisible()
})

test('board closes back to the grid', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('header', { state: 'visible' })
  await openBoard(page)
  await page.getByTestId('kanban-close').click()
  await expect(page.getByTestId('kanban-board')).toBeHidden()
})

test('Ctrl+Shift+K toggles the board', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('header', { state: 'visible' })
  await page.locator('header').getByText('workspace').click()
  await page.keyboard.press('Control+Shift+K')
  await expect(page.getByTestId('kanban-board')).toBeVisible({ timeout: 5_000 })
  await page.keyboard.press('Control+Shift+K')
  await expect(page.getByTestId('kanban-board')).toBeHidden({ timeout: 3_000 })
})

// ── Composing cards ─────────────────────────────────────────────────────────

test('new prompt adds one card per paragraph', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('header', { state: 'visible' })
  await openBoard(page)

  await page.getByTestId('kanban-new-prompt').click()
  await page.getByTestId('kanban-composer').fill('First prompt here\n\nSecond prompt here')
  await page.getByTestId('kanban-composer-submit').click()

  const backlog = page.getByTestId('kanban-column-backlog')
  await expect(backlog.getByTestId('kanban-card')).toHaveCount(2)
  await expect(page.getByTestId('count-backlog')).toHaveText('2')
  await expect(backlog.getByText('First prompt here')).toBeVisible()
  await expect(backlog.getByText('Second prompt here')).toBeVisible()
})

test('blank composer input adds nothing', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('header', { state: 'visible' })
  await openBoard(page)

  await page.getByTestId('kanban-new-prompt').click()
  await page.getByTestId('kanban-composer').fill('   \n\n  ')
  await page.getByTestId('kanban-composer-submit').click()
  await expect(page.getByTestId('count-backlog')).toHaveText('0')
})

test('cards survive a reload', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('header', { state: 'visible' })
  await openBoard(page)
  await page.getByTestId('kanban-new-prompt').click()
  await page.getByTestId('kanban-composer').fill('Persisted prompt')
  await page.getByTestId('kanban-composer-submit').click()
  await expect(page.getByTestId('count-backlog')).toHaveText('1')

  await page.reload()
  await page.waitForSelector('header', { state: 'visible' })
  await openBoard(page)
  await expect(page.getByText('Persisted prompt')).toBeVisible({ timeout: 5_000 })
})

// ── Dispatch ────────────────────────────────────────────────────────────────

test('running a card with no terminal open explains why it cannot', async ({ page }) => {
  await page.addInitScript(seed([card({ text: 'Nowhere to run this' })]))
  await page.goto('/')
  await page.waitForSelector('header', { state: 'visible' })
  await openBoard(page)

  await page.getByTestId('card-run').first().click()
  await expect(page.getByTestId('kanban-toast')).toContainText('No terminal open')
  // The card stays put rather than pretending to run.
  await expect(page.getByTestId('count-backlog')).toHaveText('1')
  await expect(page.getByTestId('count-running')).toHaveText('0')
})

test('running a card writes the prompt and Enter into a live pane', async ({ page }) => {
  await page.addInitScript(seed([card({ text: 'Explain the retry path' })]))
  await page.goto('/')
  await page.waitForSelector('header', { state: 'visible' })

  // Open a terminal pane so there's somewhere to dispatch to.
  await openLivePane(page)

  await openBoard(page)
  await page.getByTestId('card-run').first().click()

  await expect(page.getByTestId('count-running')).toHaveText('1', { timeout: 10_000 })

  // The prompt really went down the PTY as a bracketed paste, then Enter.
  await expect.poll(() => ptyWrites(page), { timeout: 10_000 }).toEqual(
    expect.arrayContaining([expect.stringContaining('Explain the retry path'), '\r']),
  )
})

// ── Review / approval gate ──────────────────────────────────────────────────

test('approve moves a reviewed card to done', async ({ page }) => {
  await page.addInitScript(seed([card({ text: 'Needs sign-off', column: 'review', paneName: 'claude' })]))
  await page.goto('/')
  await page.waitForSelector('header', { state: 'visible' })
  await openBoard(page)

  await expect(page.getByTestId('count-review')).toHaveText('1')
  await page.getByTestId('card-approve').click()
  await expect(page.getByTestId('count-review')).toHaveText('0')
  await expect(page.getByTestId('count-done')).toHaveText('1')
})

test('rework sends the card back to queued with the feedback attached', async ({ page }) => {
  await page.addInitScript(seed([card({ text: 'Half right', column: 'review', paneName: 'claude' })]))
  await page.goto('/')
  await page.waitForSelector('header', { state: 'visible' })
  await openBoard(page)

  await page.getByTestId('card-rework').click()
  await page.getByPlaceholder('What should the agent change?').fill('Cover the timeout case too')
  await page.getByRole('button', { name: /Send back/ }).click()

  await expect(page.getByTestId('count-review')).toHaveText('0')
  await expect(page.getByTestId('count-queued')).toHaveText('1')
  await expect(page.getByTestId('kanban-column-queued')).toContainText('Cover the timeout case too')
})

test('the Board button badges how many results await approval', async ({ page }) => {
  await page.addInitScript(seed([
    card({ text: 'A', column: 'review' }),
    card({ text: 'B', column: 'review' }),
    card({ text: 'C', column: 'done' }),
  ]))
  await page.goto('/')
  await page.waitForSelector('header', { state: 'visible' })
  await expect(page.getByTestId('board-toggle')).toContainText('2')
})

// ── Recovery ────────────────────────────────────────────────────────────────

test('a card left running when the app closed reopens in review', async ({ page }) => {
  await page.addInitScript(seed([
    card({ text: 'Was mid-flight', column: 'running', paneId: 'gone', paneName: 'claude', dispatchedAt: 1700000000000, sawRunning: true }),
  ]))
  await page.goto('/')
  await page.waitForSelector('header', { state: 'visible' })
  await openBoard(page)

  await expect(page.getByTestId('count-running')).toHaveText('0')
  await expect(page.getByTestId('count-review')).toHaveText('1')
})

test('deleting a card removes it', async ({ page }) => {
  await page.addInitScript(seed([card({ text: 'Delete me' })]))
  await page.goto('/')
  await page.waitForSelector('header', { state: 'visible' })
  await openBoard(page)

  await expect(page.getByTestId('count-backlog')).toHaveText('1')
  await page.getByTestId('kanban-card').first().hover()
  await page.locator('[title="Delete card"]').first().click()
  await expect(page.getByTestId('count-backlog')).toHaveText('0')
})

test('drag and drop moves a card between columns', async ({ page }) => {
  await page.addInitScript(seed([card({ id: 'k_drag', text: 'Drag me', column: 'review' })]))
  await page.goto('/')
  await page.waitForSelector('header', { state: 'visible' })
  await openBoard(page)

  await dragCardToColumn(page, 'k_drag', 'done')
  await expect(page.getByTestId('count-done')).toHaveText('1', { timeout: 5_000 })
  await expect(page.getByTestId('count-review')).toHaveText('0')
})

test('dragging into Running dispatches the prompt rather than just relabelling', async ({ page }) => {
  await page.addInitScript(seed([card({ id: 'k_drop', text: 'Run me by drag' })]))
  await page.goto('/')
  await page.waitForSelector('header', { state: 'visible' })
  await openLivePane(page)

  await openBoard(page)
  await dragCardToColumn(page, 'k_drop', 'running')

  await expect(page.getByTestId('count-running')).toHaveText('1', { timeout: 10_000 })
  await expect.poll(() => ptyWrites(page), { timeout: 10_000 }).toEqual(
    expect.arrayContaining([expect.stringContaining('Run me by drag')]),
  )
})

test('dragging into Running with no agent leaves the card in place', async ({ page }) => {
  await page.addInitScript(seed([card({ id: 'k_noagent', text: 'Nowhere to go' })]))
  await page.goto('/')
  await page.waitForSelector('header', { state: 'visible' })
  await openBoard(page)

  await dragCardToColumn(page, 'k_noagent', 'running')
  await expect(page.getByTestId('kanban-toast')).toContainText('No terminal open')
  await expect(page.getByTestId('count-running')).toHaveText('0')
  await expect(page.getByTestId('count-backlog')).toHaveText('1')
})

// ── The live loop: agent works, then goes quiet ─────────────────────────────

test('a card follows its agent: running while it works, review when it goes quiet', async ({ page }) => {
  await page.addInitScript(seed([card({ id: 'k_live', text: 'Summarise the diff' })]))
  await page.goto('/')
  await page.waitForSelector('header', { state: 'visible' })
  await openLivePane(page)

  await openBoard(page)
  await page.getByTestId('card-run').first().click()
  await expect(page.getByTestId('count-running')).toHaveText('1', { timeout: 10_000 })

  // The pane's PTY starts talking — the card must stay in Running, not drift.
  const sessionId = await liveSessionId(page)

  for (let i = 0; i < 3; i++) {
    await emit(page, 'session:output', { sessionId, data: 'working…\r\n' })
    await page.waitForTimeout(200)
  }
  await expect(page.getByTestId('count-running')).toHaveText('1')

  // …then falls silent. After the idle window the card lands in Review.
  await expect(page.getByTestId('count-review')).toHaveText('1', { timeout: 10_000 })
  await expect(page.getByTestId('count-running')).toHaveText('0')

  // And Review is a real gate: approving is what finishes it.
  await page.getByTestId('card-approve').click()
  await expect(page.getByTestId('count-done')).toHaveText('1')
})

// ── Prompts typed by hand ───────────────────────────────────────────────────

/** Open panes as an agent CLI rather than a plain shell. */
const asAgentPane = `try { localStorage.setItem('orq-term-settings', JSON.stringify({ cli: {}, defaultCli: 'claude' })) } catch (e) {}`

test('a prompt typed straight into an agent pane shows up as running', async ({ page }) => {
  await page.addInitScript(asAgentPane)
  await page.goto('/')
  await page.waitForSelector('header', { state: 'visible' })
  await openLivePane(page)
  const sessionId = await liveSessionId(page)

  // Type into the terminal itself — the board never sees this dispatch.
  await page.locator('.xterm-helper-textarea').first().focus()
  await page.keyboard.type('check the memory usage on prod')
  await page.keyboard.press('Enter')

  await openBoard(page)
  await expect(page.getByTestId('count-running')).toHaveText('1', { timeout: 10_000 })
  await expect(page.getByTestId('kanban-column-running')).toContainText('check the memory usage on prod')

  // …and it follows the pane out of Running like any other card.
  await emit(page, 'session:output', { sessionId, data: 'reading…\r\n' })
  await expect(page.getByTestId('count-review')).toHaveText('1', { timeout: 10_000 })
})

test('typing an answer to a card already running adds nothing', async ({ page }) => {
  await page.addInitScript(asAgentPane)
  await page.addInitScript(seed([card({ id: 'k_own', text: 'Owns the pane' })]))
  await page.goto('/')
  await page.waitForSelector('header', { state: 'visible' })
  await openLivePane(page)

  await openBoard(page)
  await page.getByTestId('card-run').first().click()
  await expect(page.getByTestId('count-running')).toHaveText('1', { timeout: 10_000 })

  await page.getByTestId('kanban-close').click()
  await page.locator('.xterm-helper-textarea').first().focus()
  await page.keyboard.type('yes go ahead with that')
  await page.keyboard.press('Enter')

  await openBoard(page)
  await expect(page.getByTestId('count-running')).toHaveText('1')
})

test('shell panes do not turn every command into a card', async ({ page }) => {
  await page.goto('/')            // default pane type is shell
  await page.waitForSelector('header', { state: 'visible' })
  await openLivePane(page)

  await page.locator('.xterm-helper-textarea').first().focus()
  await page.keyboard.type('git status --short')
  await page.keyboard.press('Enter')

  await openBoard(page)
  await expect(page.getByTestId('count-running')).toHaveText('0')
})

// ── Regressions ─────────────────────────────────────────────────────────────

test('a card dispatched into an already-busy pane still reaches Review', async ({ page }) => {
  // Regression: the busy/idle watcher only re-ran on pane changes, so
  // dispatching while the pane was ALREADY running produced no pane edge, the
  // card never recorded that it saw work, and it sat in Running forever.
  await page.addInitScript(seed([card({ id: 'k_busy', text: 'Queue behind live output' })]))
  await page.goto('/')
  await page.waitForSelector('header', { state: 'visible' })
  await openLivePane(page)
  const sessionId = await liveSessionId(page)

  await openBoard(page)
  // Make the pane busy first, then dispatch inside its ~2.5s activity window.
  await emit(page, 'session:output', { sessionId, data: 'still thinking…\r\n' })
  await page.getByTestId('card-run').first().click()
  await expect(page.getByTestId('count-running')).toHaveText('1', { timeout: 10_000 })

  // Pane falls quiet — the card must follow it out of Running. Generous: the
  // pane's idle window is 2.5s of wall clock, and wall clock is exactly what a
  // loaded machine running the whole suite in parallel is short of.
  await expect(page.getByTestId('count-review')).toHaveText('1', { timeout: 25_000 })
  await expect(page.getByTestId('count-running')).toHaveText('0')
})

test('a second card will not pile onto a pane that is already running one', async ({ page }) => {
  await page.addInitScript(seed([
    card({ id: 'k_first', text: 'First one in', order: 0 }),
    card({ id: 'k_second', text: 'Second one in', order: 1 }),
  ]))
  await page.goto('/')
  await page.waitForSelector('header', { state: 'visible' })
  await openLivePane(page)   // exactly one pane
  await openBoard(page)

  await page.locator('[data-card-id="k_first"]').getByTestId('card-run').click()
  await expect(page.getByTestId('count-running')).toHaveText('1', { timeout: 10_000 })

  // Two prompts pasted into one CLI would interleave into gibberish.
  await page.locator('[data-card-id="k_second"]').getByTestId('card-run').click()
  await expect(page.getByTestId('kanban-toast')).toContainText('already running')
  await expect(page.getByTestId('count-running')).toHaveText('1')
  await expect(page.getByTestId('count-backlog')).toHaveText('1')
})

test('dispatching to a pane whose session ended is refused, not swallowed', async ({ page }) => {
  // Regression: dispatchPrompt reported success whenever the pane existed, but
  // the write silently no-ops without a live PTY — the card went to Running
  // having sent nothing.
  await page.addInitScript(seed([card({ id: 'k_dead', text: 'Into the void' })]))
  await page.goto('/')
  await page.waitForSelector('header', { state: 'visible' })
  await openLivePane(page)
  const sessionId = await liveSessionId(page)

  await emit(page, 'session:ended', { sessionId })
  await openBoard(page)
  await page.getByTestId('card-run').first().click()

  await expect(page.getByTestId('kanban-toast')).toContainText('no live session')
  await expect(page.getByTestId('count-running')).toHaveText('0')
  await expect(page.getByTestId('count-backlog')).toHaveText('1')
  // …and nothing was written to the dead PTY.
  expect(await ptyWrites(page)).toEqual([])
})

// ── What the agent said ─────────────────────────────────────────────────────

/** A believable tail from an agent: prose, a spinner frame, then a question. */
const AGENT_TAIL =
  '\x1b[2mThinking…\x1b[0m\r' +
  '\x1b[1mSwap is exhausted\x1b[0m — if something asks for memory the OOM killer acts.\r\n' +
  '\r\n' +
  'Should I stop Waydroid or the dev server?\r\n' +
  '╭──────────────────────────╮\r\n' +
  '│ >                        │\r\n' +
  '╰──────────────────────────╯\r\n' +
  '  ? for shortcuts\r\n'

/** Run the seeded card, feed it AGENT_TAIL, and wait for it to reach Review. */
async function runUntilReview(page: Page) {
  await openBoard(page)
  await page.getByTestId('card-run').first().click()
  await expect(page.getByTestId('count-running')).toHaveText('1', { timeout: 10_000 })
  await emit(page, 'session:output', { sessionId: await liveSessionId(page), data: AGENT_TAIL })
  await expect(page.getByTestId('count-review')).toHaveText('1', { timeout: 10_000 })
}

test('a reviewed card carries back what the agent actually said', async ({ page }) => {
  await page.addInitScript(seed([card({ id: 'k_ram', text: 'check the ram' })]))
  await page.goto('/')
  await page.waitForSelector('header', { state: 'visible' })
  await openLivePane(page)
  await runUntilReview(page)

  // The question is surfaced on its own — it's the decision waiting on a human.
  await expect(page.getByTestId('card-suggestion')).toContainText('Should I stop Waydroid or the dev server?')

  // The fuller output is one click away, with the TUI chrome stripped out.
  await page.getByRole('button', { name: 'Agent output' }).click()
  const out = page.getByTestId('card-result')
  await expect(out).toContainText('Swap is exhausted')
  await expect(out).not.toContainText('for shortcuts')
  await expect(out).not.toContainText('│')
})

test('the agent’s suggestion can be queued as its own prompt', async ({ page }) => {
  await page.addInitScript(seed([card({ id: 'k_ram', text: 'check the ram' })]))
  await page.goto('/')
  await page.waitForSelector('header', { state: 'visible' })
  await openLivePane(page)
  await runUntilReview(page)

  await page.getByTestId('card-queue-suggestion').click()
  // It arrives editable, in the agent's words — you send back your answer.
  const box = page.getByTestId('card-queue-confirm').locator('xpath=../..').locator('textarea')
  await box.fill('Stop Waydroid with waydroid session stop')
  await page.getByTestId('card-queue-confirm').click()

  await expect(page.getByTestId('count-queued')).toHaveText('1')
  const queued = page.getByTestId('kanban-column-queued')
  await expect(queued).toContainText('Stop Waydroid with waydroid session stop')
  await expect(queued).toContainText('suggested')
  // The original stays in Review — queueing a follow-up is not approving it.
  await expect(page.getByTestId('count-review')).toHaveText('1')
})

test('a queued prompt can be rewritten in place', async ({ page }) => {
  await page.addInitScript(seed([card({ id: 'k_edit', text: 'Close Waydroid?', column: 'queued' })]))
  await page.goto('/')
  await page.waitForSelector('header', { state: 'visible' })
  await openBoard(page)

  await page.getByTestId('card-edit-open').click()
  await page.getByTestId('card-edit').fill('Close Waydroid with waydroid session stop')
  await page.getByTestId('card-edit').press('ControlOrMeta+Enter')

  await expect(page.getByTestId('kanban-column-queued')).toContainText('Close Waydroid with waydroid session stop')

  // …and the rewrite is what's stored, so it's the rewrite that gets sent.
  // (Checked in localStorage rather than across a reload: the seed init script
  // re-runs on every navigation and would just paint the original back.)
  await expect
    .poll(async () => page.evaluate(() => {
      const raw = localStorage.getItem('orquesta-kanban-standalone') || '{}'
      const state = JSON.parse(raw) as { cards?: { text: string }[] }
      return state.cards?.[0]?.text ?? ''
    }))
    .toBe('Close Waydroid with waydroid session stop')
})

test('a real prompt typed into a shell pane still lands on the board', async ({ page }) => {
  await page.goto('/')            // default pane type is shell
  await page.waitForSelector('header', { state: 'visible' })
  await openLivePane(page)

  // People launch `claude` by hand inside a shell pane; the pane still says
  // "shell", so prose typed into it has to count as a prompt.
  await page.locator('.xterm-helper-textarea').first().focus()
  await page.keyboard.type('check how much ram the system is using right now')
  await page.keyboard.press('Enter')

  await openBoard(page)
  await expect(page.getByTestId('count-running')).toHaveText('1', { timeout: 10_000 })
})

test('the answer survives an agent that repaints its frame hundreds of times', async ({ page }) => {
  // Regression, straight from a real run: TUI agents (Ink) don't stream a
  // transcript, they redraw their whole frame on every tick. Reading back a
  // window of raw PTY bytes therefore returned the tail of one repaint — box
  // borders and escape codes — while the answer itself had scrolled out of it,
  // and the card reached Review with nothing on it. Read the rendered screen
  // and the repaints cost nothing.
  await page.addInitScript(seed([card({ id: 'k_ink', text: 'check the ram' })]))
  await page.goto('/')
  await page.waitForSelector('header', { state: 'visible' })
  await openLivePane(page)

  await openBoard(page)
  await page.getByTestId('card-run').first().click()
  await expect(page.getByTestId('count-running')).toHaveText('1', { timeout: 10_000 })

  const sessionId = await liveSessionId(page)
  await emit(page, 'session:output', {
    sessionId,
    data: 'Swap is exhausted — if something asks for memory the OOM killer acts.\r\n' +
          'Should I stop Waydroid or the dev server?\r\n',
  })
  // …then ~60 KB of the input box being redrawn in place, as Ink does.
  const frame = '╭─────────────────────────╮\r\n│ > ' + ' '.repeat(21) + '│\r\n╰─────────────────────────╯\r\n'
  let repaints = ''
  for (let i = 0; i < 300; i++) repaints += frame + '\x1b[3A\x1b[0J'
  await emit(page, 'session:output', { sessionId, data: repaints + frame })
  expect(repaints.length).toBeGreaterThan(8000)

  await expect(page.getByTestId('count-review')).toHaveText('1', { timeout: 25_000 })
  await expect(page.getByTestId('card-suggestion')).toContainText('Should I stop Waydroid or the dev server?')
})
