import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import {
  provisionWorkspace,
  createTestFile,
  deleteTestFile,
  openFileViaSearch,
  waitForSSERefresh,
  uniqueFileName,
  sectionHeader,
  type FixtureProject,
} from './helpers/workspace'

// Multi-instance editor flows against the real renderer (design: §E EditorPanel,
// §F keyboard, §3.8 reset). Pins the user-visible acceptance:
//   - Cmd+\ splits the focused editor into a side-by-side pane that SHARES the
//     buffer (an edit in one shows in the other; the dirty dot lands on both);
//   - the bright focus marker (data-focused) tracks the focused pane and the dim
//     active marker (data-active) appears only with >1 instance of a type;
//   - Reset layout discards the extra editor instance but keeps a dirty buffer.

test.use({ viewport: { width: 1280, height: 800 } })

let provisioned: FixtureProject[] = []

test.afterEach(async () => {
  const all = provisioned
  provisioned = []
  await Promise.all(all.map((f) => f.dispose().catch(() => undefined)))
})

async function ws(page: Page, request: APIRequestContext): Promise<FixtureProject> {
  const project = await provisionWorkspace(page, request)
  provisioned.push(project)
  return project
}

const homePane = (page: Page) => page.locator('[data-instance-id="editor"]')
const secondaryPane = (page: Page) => page.locator('[data-instance-id="editor:2"]')
const tabIn = (pane: ReturnType<Page['locator']>, title: string) => pane.locator(`[data-testid="tab"][title="${title}"]`)

/** Open a file via quick-open and pin it (double-click clears the preview italic). */
async function openPinned(page: Page, file: string): Promise<void> {
  await openFileViaSearch(page, file)
  const t = tabIn(homePane(page), file)
  await expect(t).toBeVisible({ timeout: 10_000 })
  await t.dblclick()
}

/** Focus the home editor, then Cmd+\ to split it into a side-by-side secondary. */
async function splitHomeEditor(page: Page): Promise<void> {
  await homePane(page).locator('.cm-content').click()
  await expect(homePane(page)).toHaveAttribute('data-focused', 'true')
  await page.keyboard.press('Meta+\\')
  await expect(secondaryPane(page)).toBeVisible({ timeout: 10_000 })
}

/** Open a framed panel's header menu and click an item (waits for the menu to close). */
async function runPanelMenu(page: Page, panelTitle: string, item: string): Promise<void> {
  await sectionHeader(page, panelTitle).getByRole('button', { name: 'Panel menu' }).click()
  await page.getByRole('menuitem', { name: item }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
}

test.describe('Multi-instance editors (split / shared buffer / focus markers / reset)', () => {
  test('Cmd+\\ splits into side-by-side editors that share one buffer', async ({ page, request }) => {
    const project = await ws(page, request)
    const file = uniqueFileName('shared.ts')
    await createTestFile(page, project.name, file, 'export const v = 1\n')
    await waitForSSERefresh(page, 3000)

    await openPinned(page, file)
    await splitHomeEditor(page)

    // The split mirrors the source's active file into the new pane (same path).
    await expect(tabIn(secondaryPane(page), file)).toBeVisible()
    await expect(tabIn(homePane(page), file)).toBeVisible()

    // Focus the HOME editor and prove it has focus — the split left the SECONDARY
    // focused, so without this the edit would originate in the secondary and the test
    // would not prove cross-pane sharing.
    await homePane(page).locator('.cm-content').click()
    await expect(homePane(page)).toHaveAttribute('data-focused', 'true')

    // Type in the home editor → the edit lands HERE, then propagates to the SECONDARY
    // editor showing the same path (one buffer per path).
    await page.keyboard.type('SHAREDEDIT ')
    await expect(homePane(page).locator('.cm-content')).toContainText('SHAREDEDIT', { timeout: 10_000 })
    await expect(secondaryPane(page).locator('.cm-content')).toContainText('SHAREDEDIT', { timeout: 10_000 })

    // The dirty dot is by path, so it shows on the file's tab in BOTH panes.
    await expect(tabIn(homePane(page), file).locator('.rounded-full')).toBeVisible()
    await expect(tabIn(secondaryPane(page), file).locator('.rounded-full')).toBeVisible()

    await deleteTestFile(page, project.name, file)
  })

  test('Reset layout discards the extra editor instance but keeps a dirty buffer', async ({ page, request }) => {
    const project = await ws(page, request)
    const file = uniqueFileName('reset_dirty.ts')
    await createTestFile(page, project.name, file, 'export const r = 1\n')
    await waitForSSERefresh(page, 3000)

    await openPinned(page, file)
    await splitHomeEditor(page)
    await expect(secondaryPane(page)).toBeVisible()

    // Dirty the shared buffer (typed in the home editor; dirty is by path).
    await homePane(page).locator('.cm-content').click()
    await page.keyboard.type('DIRTYRESET ')
    await expect(tabIn(homePane(page), file).locator('.rounded-full')).toBeVisible()

    // Reset layout via a framed panel's kebab (the editor chrome has no Reset).
    await runPanelMenu(page, 'Sessions', 'Reset layout')

    // The extra editor instance is discarded...
    await expect(secondaryPane(page)).toHaveCount(0)
    // ...but the home editor keeps the file AND its dirty buffer (recoverable, not lost).
    await expect(tabIn(homePane(page), file)).toBeVisible()
    await expect(tabIn(homePane(page), file).locator('.rounded-full')).toBeVisible()
    await expect(homePane(page).locator('.cm-content')).toContainText('DIRTYRESET')

    await deleteTestFile(page, project.name, file)
  })
})
