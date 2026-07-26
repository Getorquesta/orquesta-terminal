import { test, expect, type Page } from '@playwright/test'
import { TAURI_MOCK_SCRIPT } from './tauri-mock'

/**
 * Folder picker regression: browsing must survive the grid re-rendering.
 *
 * The picker read `initialPath` and the parent's `onChoose` closure from its
 * effect deps. `onChoose` is an inline arrow in AgentGrid, so it changed on
 * every parent render — and the grid re-renders constantly (a pane going
 * busy/idle is enough). Each of those re-ran the effect, which re-listed
 * `initialPath` — undefined for a new terminal, i.e. $HOME — so the folder the
 * user had just navigated into snapped back to home mid-pick.
 */

const HOME = '/home/tester'
const PROJ = '/home/tester/proj'

type Call = { cmd: string; args?: { path?: string } }

async function emit(page: Page, event: string, payload: unknown) {
  await page.evaluate(([e, p]) => {
    ;(window as unknown as { __tauriEmit: (e: string, p: unknown) => void }).__tauriEmit(e as string, p)
  }, [event, payload] as const)
}

/** Every fs:list-dir the UI has asked for, oldest first. */
async function listDirCalls(page: Page): Promise<(string | undefined)[]> {
  return page.evaluate(() =>
    ((window as unknown as { __tauriCalls: Call[] }).__tauriCalls || [])
      .filter((c) => c.cmd === 'fs_list_dir')
      .map((c) => c.args?.path),
  )
}

/**
 * Answer the most recent fs:list-dir the way the Rust side does — including its
 * fallback to $HOME when no path was given. The mock only records invokes; the
 * real listing comes back as an event, so the test plays the backend.
 */
async function answerLastListDir(page: Page) {
  const calls = await listDirCalls(page)
  const requested = calls[calls.length - 1] ?? HOME
  await emit(page, 'fs:list-dir-result', {
    ok: true,
    path: requested,
    parent: requested.replace(/\/[^/]+$/, '') || '/',
    home: HOME,
    entries: requested === HOME ? [{ name: 'proj', path: PROJ }] : [],
  })
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(TAURI_MOCK_SCRIPT)
  await page.goto('/')
  await page.waitForSelector('header', { state: 'visible' })
})

test('keeps the browsed folder when the grid re-renders', async ({ page }) => {
  // A live pane, so the busy/idle machinery actually churns parent state.
  await expect(page.locator('text=Terminal Grid').first()).toBeVisible({ timeout: 15_000 })
  await page.locator('button', { hasText: 'Add Terminal' }).first().click()
  await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 15_000 })

  await page.locator('[title="Choose a working folder for this terminal"]').first().click()
  await answerLastListDir(page)
  await expect(page.locator('text=Use: ' + HOME)).toBeVisible({ timeout: 5_000 })

  // Walk into the project folder.
  await page.locator('button', { hasText: 'proj' }).first().click()
  await answerLastListDir(page)
  await expect(page.locator('text=Use: ' + PROJ)).toBeVisible({ timeout: 5_000 })
  // (Dev runs under StrictMode, so the mount listing can appear twice — what
  // matters is that browsing settled on PROJ and nothing re-lists after it.)
  const beforeChurn = await listDirCalls(page)
  expect(beforeChurn.at(-1)).toBe(PROJ)

  // Now churn the grid: PTY output marks the pane running, and ~2.5s of quiet
  // marks it finished — two parent renders with the picker open.
  const sessionId = await page.evaluate(() => {
    const calls = (window as unknown as { __tauriCalls: { cmd: string; args?: { sessionId?: string } }[] }).__tauriCalls || []
    return calls.find((c) => c.cmd === 'session_start')?.args?.sessionId ?? ''
  })
  expect(sessionId).not.toBe('')
  await emit(page, 'session:output', { sessionId, data: 'working…\r\n' })
  await page.waitForTimeout(4_000)

  // Answer whatever the picker asked for last. On the regression that is a
  // fresh $HOME listing, which is exactly what used to yank the user back.
  await answerLastListDir(page)

  await expect(page.locator('text=Use: ' + PROJ)).toBeVisible()
  expect(await listDirCalls(page)).toEqual(beforeChurn)
})
