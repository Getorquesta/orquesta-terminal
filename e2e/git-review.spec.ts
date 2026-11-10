import { test, expect, type Page } from '@playwright/test'
import { TAURI_MOCK_SCRIPT } from './tauri-mock'

/**
 * Pane header project chip, worktree isolation, and the diff review panel.
 * The backend's git answers are stubbed; what's under test is that the UI shows
 * them, isolates into the worktree it was given, and turns line notes into a
 * prompt pasted into the pane's PTY.
 */

const CWD = '/home/tester/proj'
const WT = '/home/tester/.orquesta/worktrees/proj/pane-1110-120000'

const INFO = {
  isRepo: true, folder: 'proj', top: CWD, root: CWD, repoName: 'proj', isWorktree: false,
  branch: 'main', ahead: 2, behind: 0, staged: 1, modified: 2, untracked: 1, conflicts: 0,
  insertions: 14, deletions: 3, remote: null,
}

const DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,4 +1,5 @@',
  ' import { run } from "./run"',
  '-const port = 3000',
  '+const port = Number(process.env.PORT ?? 3000)',
  '+const host = "0.0.0.0"',
  ' ',
  ' run(port)',
  'diff --git a/README.md b/README.md',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/README.md',
  '@@ -0,0 +1,2 @@',
  '+# proj',
  '+Hello',
  '',
].join('\n')

const seedPane = `try { localStorage.setItem('orquesta-grid-standalone', JSON.stringify({
  v: 5, cells: [{ id: 'c1', cliType: 'shell', name: '', cwd: ${JSON.stringify(CWD)} }],
  layouts: { lg: [{ i: 'c1', x: 0, y: 0, w: 12, h: 12 }] }, viewMode: 'grid', floatGeom: {},
  lighting: false, sidebarOpen: false, queueSort: 'priority',
})) } catch (e) {}`

type Call = { cmd: string; args?: Record<string, unknown> }
const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => ((window as unknown as { __tauriCalls: Call[] }).__tauriCalls || []).filter((x) => x.cmd === c), cmd)

test.beforeEach(async ({ page }) => {
  await page.addInitScript(TAURI_MOCK_SCRIPT)
  await page.addInitScript(seedPane)
  await page.addInitScript(([info, diff, wt]) => {
    const set = (window as unknown as { __tauriSet: (c: string, v: unknown) => void }).__tauriSet
    set('git_info', info)
    set('git_diff', { ok: true, diff, base: 'HEAD', truncated: false })
    set('git_worktree_create', { ok: true, path: wt, branch: 'orq/pane-1110-120000', base: 'main', baseCommit: 'abc1234', root: '/home/tester/proj' })
  }, [INFO, DIFF, WT] as const)
  await page.goto('/')
  await page.waitForSelector('header', { state: 'visible' })
})

test('header shows repo, branch, ahead count and line totals', async ({ page }) => {
  const chip = page.locator('button[title^="/home/tester/proj"]')
  await expect(chip).toContainText('proj', { timeout: 10_000 })
  await expect(chip).toContainText('main')
  await expect(chip).toContainText('2')
  const review = page.locator('button[title*="changed files — review"]')
  await expect(review).toContainText('+14')
  await expect(review).toContainText('−3')
})

test('line notes are pasted into the pane as one prompt', async ({ page }) => {
  await page.locator('button[title*="changed files — review"]').click({ timeout: 10_000 })
  await expect(page.getByText('src/app.ts').first()).toBeVisible()
  await expect(page.getByText('README.md').first()).toBeVisible()

  const row = page.locator('tr', { hasText: 'process.env.PORT' })
  await row.hover()
  await row.locator('button[title="Add a note on this line"]').click()
  await page.getByPlaceholder('What should the agent change here?').fill('Validate PORT is a number')
  await page.getByRole('button', { name: 'Add note' }).click()
  await expect(page.getByText('Validate PORT is a number')).toBeVisible()

  // Make sure a PTY exists so the seed goes straight to session_input.
  await expect.poll(async () => (await calls(page, 'session_start')).length).toBeGreaterThan(0)
  await page.getByRole('button', { name: /Send 1 note to agent/ }).click()

  await expect.poll(async () => {
    const inputs = await calls(page, 'session_input')
    return inputs.map((c) => String(c.args?.data ?? '')).join('')
  }).toContain('src/app.ts:2')
  const pasted = (await calls(page, 'session_input')).map((c) => String(c.args?.data ?? '')).join('')
  expect(pasted).toContain('Validate PORT is a number')
  expect(pasted.startsWith('\x1b[200~') || pasted.includes('\x1b[200~')).toBe(true)
})

test('isolate moves the pane into the new worktree', async ({ page }) => {
  await page.locator('button[title^="/home/tester/proj"]').click({ timeout: 10_000 })
  await page.getByRole('button', { name: /Isolate in a new worktree/ }).click()

  await expect.poll(async () => (await calls(page, 'git_worktree_create')).length).toBe(1)
  // The session restarts in the worktree folder.
  await expect.poll(async () =>
    (await calls(page, 'session_start')).some((c) => c.args?.cwd === WT),
  ).toBe(true)
  await expect(page.locator(`button[title^="${WT}"]`)).toBeVisible()
})
