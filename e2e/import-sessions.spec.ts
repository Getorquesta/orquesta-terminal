import { test, expect, type Page } from '@playwright/test'
import { TAURI_MOCK_SCRIPT } from './tauri-mock'

/**
 * The Import panel on a well-used machine.
 *
 * `list_external_sessions` returns every Claude transcript under
 * ~/.claude/projects — 357 on the machine this was reported from, most of them
 * months-old `/tmp` runs. The panel rendered all of them in one scrolling list
 * with an "Import all (357)" button next to it, which is both unusable and a
 * foot-gun: one click would have opened 357 terminal panes.
 */

const DAY = 24 * 60 * 60 * 1000
const OLD = 300
const RECENT = 3

/** A machine with 300 stale sessions and 3 from this morning. */
async function seedSessions(page: Page) {
  await page.evaluate(([old, recent, day]) => {
    const now = Date.now()
    const sessions = []
    for (let i = 0; i < old; i++) {
      sessions.push({
        id: `old-${i}`, cwd: `/home/tester/old-${i}`, file: `/tmp/old-${i}.jsonl`,
        lastActivity: now - 30 * day - i * 1000, size: 2048, isActive: false,
      })
    }
    for (let i = 0; i < recent; i++) {
      sessions.push({
        id: `recent-${i}`, cwd: `/home/tester/recent-${i}`, file: `/tmp/recent-${i}.jsonl`,
        lastActivity: now - 3600_000, size: 4096, isActive: false,
      })
    }
    ;(window as unknown as { __tauriSet: (c: string, v: unknown) => void })
      .__tauriSet('sessions_external_list', { sessions })
  }, [OLD, RECENT, DAY] as const)
}

async function sessionStarts(page: Page): Promise<number> {
  return page.evaluate(() =>
    ((window as unknown as { __tauriCalls: { cmd: string }[] }).__tauriCalls || [])
      .filter(c => c.cmd === 'session_start').length)
}

const openPanel = (page: Page) =>
  page.locator('[title="Import external CLI sessions running on this machine"]').click()

test.beforeEach(async ({ page }) => {
  await page.addInitScript(TAURI_MOCK_SCRIPT)
  await page.goto('/')
  await page.waitForSelector('header', { state: 'visible' })
  await seedSessions(page)
})

test('only the recent sessions are listed, not everything on disk', async ({ page }) => {
  await openPanel(page)
  const rows = page.getByTestId('external-session')
  await expect(rows).toHaveCount(RECENT, { timeout: 5_000 })
  // The rest are still reachable, just not in your face.
  await expect(page.locator(`text=All (${OLD + RECENT})`)).toBeVisible()
})

test('search reaches a session older than the recent window', async ({ page }) => {
  await openPanel(page)
  await expect(page.getByTestId('external-session')).toHaveCount(RECENT, { timeout: 5_000 })

  await page.getByPlaceholder('Search by folder…').fill('old-142')
  const rows = page.getByTestId('external-session')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('/home/tester/old-142')
})

test('showing everything still caps what it renders', async ({ page }) => {
  await openPanel(page)
  await page.locator(`text=All (${OLD + RECENT})`).click()

  await expect(page.getByTestId('external-session')).toHaveCount(40, { timeout: 5_000 })
  await expect(page.locator('text=/\\+\\d+ more/')).toBeVisible()
})

test('"Import all" asks before opening a pane per session', async ({ page }) => {
  await openPanel(page)
  await page.getByPlaceholder('Search by folder…').fill('old-25')   // old-25 + old-250…259

  const importAll = page.locator('button', { hasText: /Import all \(\d+\)/ })
  await expect(importAll).toBeVisible()
  await importAll.click()

  // First click only arms it: nothing opened, panel still up.
  await expect(page.locator('button', { hasText: /Open \d+ panes\?/ })).toBeVisible()
  await expect(page.getByTestId('external-session').first()).toBeVisible()
  expect(await sessionStarts(page)).toBe(0)
})

test('a handful of sessions still imports on one click', async ({ page }) => {
  await openPanel(page)
  const rows = page.getByTestId('external-session')
  await expect(rows).toHaveCount(RECENT, { timeout: 5_000 })

  await page.locator('button', { hasText: `Import all (${RECENT})` }).click()
  await expect(rows).toHaveCount(0)                                  // panel closed
  await expect.poll(() => sessionStarts(page), { timeout: 10_000 }).toBe(RECENT)
})
