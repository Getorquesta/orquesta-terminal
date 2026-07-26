import { test, expect, type Page } from '@playwright/test'
import { TAURI_MOCK_SCRIPT } from './tauri-mock'

/**
 * Browser sign-in has to actually reach a browser.
 *
 * It used to call `@tauri-apps/plugin-shell`'s `open()`, but the webview is
 * never granted `shell:allow-open` (see capabilities/default.json), so that IPC
 * was rejected; the fallback, `window.open()`, does nothing inside the WebKitGTK
 * webview. Nothing opened, nothing was ever authorized, and the button sat on
 * "Waiting…" until the 5-minute poll gave up. It now goes through our own
 * `open_external_url` command.
 */

const opened = (page: Page) =>
  page.evaluate(() =>
    ((window as unknown as { __tauriCalls: { cmd: string; args?: { url?: string } }[] }).__tauriCalls || [])
      .filter(c => c.cmd === 'open_external_url')
      .map(c => c.args?.url))

test.beforeEach(async ({ page }) => {
  await page.addInitScript(TAURI_MOCK_SCRIPT)
  await page.goto('/')
  await page.waitForSelector('header', { state: 'visible' })
  await page.locator('[title="Connect to backend"]').click()
})

test('signing in opens the authorization page in the real browser', async ({ page }) => {
  const signIn = page.locator('button', { hasText: 'Sign in with browser' })
  await expect(signIn).toBeVisible({ timeout: 5_000 })
  await signIn.click()

  await expect.poll(() => opened(page), { timeout: 5_000 }).toHaveLength(1)
  const [url] = await opened(page)
  expect(url).toMatch(/^https:\/\/getorquesta\.com\/cli\/auth\?session=[0-9a-f-]{36}$/)
  await expect(page.locator('text=Waiting…')).toBeVisible()
})

test('waiting for the browser can be given up on', async ({ page }) => {
  await page.locator('button', { hasText: 'Sign in with browser' }).click()
  await expect(page.locator('text=Waiting…')).toBeVisible({ timeout: 5_000 })

  await page.locator('button', { hasText: 'Cancel' }).click()
  // Back to the start, with no error scolding the user for their own click.
  await expect(page.locator('button', { hasText: 'Sign in with browser' })).toBeVisible({ timeout: 8_000 })
  await expect(page.locator('text=Sign-in cancelled')).toHaveCount(0)
})
