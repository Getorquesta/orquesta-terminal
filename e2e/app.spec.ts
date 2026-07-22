import { test, expect } from '@playwright/test'
import { TAURI_MOCK_SCRIPT } from './tauri-mock'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(TAURI_MOCK_SCRIPT)
  await page.goto('/')
  await page.waitForSelector('header', { state: 'visible' })
})

// ── App shell ─────────────────────────────────────────────────────────────────

test('loads the workspace — header and brand visible', async ({ page }) => {
  await expect(page.locator('header')).toBeVisible()
  await expect(page.locator('text=Terminal').first()).toBeVisible()
  await expect(page.locator('text=workspace').first()).toBeVisible()
  await expect(page.locator('text=Application error')).toHaveCount(0)
})

test('shows the terminal grid empty state when no panes', async ({ page }) => {
  await expect(page.locator('text=Terminal Grid').first()).toBeVisible({ timeout: 5_000 })
})

// ── Toolbar buttons ───────────────────────────────────────────────────────────

test('command palette button is visible in toolbar', async ({ page }) => {
  await expect(page.locator('[title="Command palette"]')).toBeVisible()
})

test('background button is visible in toolbar', async ({ page }) => {
  await expect(page.locator('[title="Customize background"]')).toBeVisible()
})

test('shows cloud connect button', async ({ page }) => {
  await expect(page.locator('[title="Connect to backend"]')).toBeVisible()
})

// ── Command palette ───────────────────────────────────────────────────────────

const PALETTE_PLACEHOLDER = 'Switch project, change background…'

test('command palette opens via button click', async ({ page }) => {
  await page.locator('[title="Command palette"]').click()
  await expect(page.getByPlaceholder(PALETTE_PLACEHOLDER)).toBeVisible({ timeout: 5_000 })
})

test('command palette opens via Ctrl+K', async ({ page }) => {
  // Click the brand, not the header box — the header's centre point lands on
  // whichever toolbar button happens to sit there, which would toggle it.
  await page.locator('header').getByText('workspace').click()
  await page.keyboard.press('Control+k')
  await expect(page.getByPlaceholder(PALETTE_PLACEHOLDER)).toBeVisible({ timeout: 5_000 })
})

test('command palette closes with Escape', async ({ page }) => {
  await page.locator('[title="Command palette"]').click()
  const input = page.getByPlaceholder(PALETTE_PLACEHOLDER)
  await expect(input).toBeVisible({ timeout: 5_000 })
  await page.keyboard.press('Escape')
  await expect(input).toBeHidden({ timeout: 3_000 })
})

test('command palette filters commands', async ({ page }) => {
  await page.locator('[title="Command palette"]').click()
  const input = page.getByPlaceholder(PALETTE_PLACEHOLDER)
  await expect(input).toBeVisible({ timeout: 5_000 })
  await input.fill('terminal')
  await expect(page.locator('[role="dialog"]').getByText('New terminal').first()).toBeVisible({ timeout: 3_000 })
})

test('command palette shows no-match message for unknown query', async ({ page }) => {
  await page.locator('[title="Command palette"]').click()
  const input = page.getByPlaceholder(PALETTE_PLACEHOLDER)
  await expect(input).toBeVisible({ timeout: 5_000 })
  await input.fill('xxxxxxxxxnotacommand')
  await expect(page.locator('text=No matching commands')).toBeVisible({ timeout: 3_000 })
})

// ── Background picker ─────────────────────────────────────────────────────────

test('background picker opens and shows wallpaper options', async ({ page }) => {
  await page.locator('[title="Customize background"]').click()
  // Wallpaper buttons use title= attributes (no text content)
  await expect(page.locator('[title="Console"]').first()).toBeVisible({ timeout: 3_000 })
  await expect(page.locator('[title="Aurora"]').first()).toBeVisible({ timeout: 3_000 })
  await expect(page.locator('[title="Nebula"]').first()).toBeVisible({ timeout: 3_000 })
})

test('can switch wallpaper by clicking a swatch', async ({ page }) => {
  await page.locator('[title="Customize background"]').click()
  await expect(page.locator('[title="Nebula"]').first()).toBeVisible({ timeout: 3_000 })
  await page.locator('[title="Nebula"]').first().click()
  // After switching, Nebula ring should be active (ring-green-400)
  const nebulaBtn = page.locator('[title="Nebula"]').first()
  await expect(nebulaBtn).toHaveClass(/ring-green-400/)
})

// ── Terminal pane ─────────────────────────────────────────────────────────────

test('can add terminal pane from empty state button', async ({ page }) => {
  await expect(page.locator('text=Terminal Grid').first()).toBeVisible({ timeout: 5_000 })

  // Click "Add Terminal" from the empty state
  const addBtn = page.locator('button', { hasText: 'Add Terminal' }).first()
  await expect(addBtn).toBeVisible({ timeout: 5_000 })
  await addBtn.click()

  // A live terminal pane should appear
  await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 10_000 })
})

test('can add terminal pane via command palette', async ({ page }) => {
  await page.locator('[title="Command palette"]').click()
  const input = page.getByPlaceholder(PALETTE_PLACEHOLDER)
  await expect(input).toBeVisible({ timeout: 5_000 })
  await input.fill('terminal')
  // The command label is "New terminal" (defined in page.tsx commands array)
  await page.locator('[role="dialog"]').getByText('New terminal').first().click()

  // A live terminal pane should appear and the palette should close
  await expect(page.getByPlaceholder(PALETTE_PLACEHOLDER)).toBeHidden({ timeout: 3_000 })
  await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 10_000 })
})

// ── Plugins panel ─────────────────────────────────────────────────────────────

test('plugins panel opens and shows 2-column grid', async ({ page }) => {
  await page.locator('[title="Plugins & Integrations"]').click()
  await expect(page.locator('text=Plugins & Integrations').first()).toBeVisible({ timeout: 3_000 })
  // All 6 plugins should be present
  for (const name of ['SudoSudo', 'RogerThat', 'Apumail', 'TrustOps', 'Prowl', 'Notlogin']) {
    await expect(page.locator(`text=${name}`).first()).toBeVisible({ timeout: 3_000 })
  }
})

test('clicking a plugin tile shows its detail panel', async ({ page }) => {
  await page.locator('[title="Plugins & Integrations"]').click()
  await expect(page.locator('text=SudoSudo').first()).toBeVisible({ timeout: 3_000 })
  await page.locator('text=SudoSudo').first().click()
  // Detail panel should show description content
  await expect(page.locator('text=Example prompts').first()).toBeVisible({ timeout: 3_000 })
  await expect(page.locator('text=Features').first()).toBeVisible({ timeout: 3_000 })
})

test('plugins panel has View all and Request buttons', async ({ page }) => {
  await page.locator('[title="Plugins & Integrations"]').click()
  await expect(page.locator('text=View all plugins').first()).toBeVisible({ timeout: 3_000 })
  await expect(page.locator('text=Request a plugin').first()).toBeVisible({ timeout: 3_000 })
})
