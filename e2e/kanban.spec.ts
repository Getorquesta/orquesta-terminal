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

  // Pane falls quiet — the card must follow it out of Running.
  await expect(page.getByTestId('count-review')).toHaveText('1', { timeout: 10_000 })
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
