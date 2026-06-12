import { test, expect, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFixtureProject, selectProject, getWorkspaceState, activeEditorView, type FixtureProject } from './helpers/workspace'

// Characterization of Changes compare mode + compare prev/next navigation against
// CURRENT code (design.md "ChangesPanel" / "EditorPanel": self-describing
// `diff:path?base=&compare=` ids + EditorPanel compare-nav).
//
// The compare list is `git diff --name-status <base> <compare>` for the app's
// default refs (base `main`, compare `HEAD`). `createFixtureProject` leaves the
// repo on `main` with one commit, so we branch off and commit three new files:
// `git diff main HEAD` then yields a deterministic, alphabetically-ordered list
// the editor can page through.

const COMPARE_FILES = ['alpha.txt', 'bravo.txt', 'charlie.txt'] as const

/** Commit three files on a branch ahead of `main` so the default compare refs
 *  (main..HEAD) produce a stable multi-file list. */
function buildCompareHistory(root: string): void {
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  git(['checkout', '-q', '-b', 'compare-src'])
  COMPARE_FILES.forEach((name, i) => {
    writeFileSync(join(root, name), `${name} line 1\n${name} line 2\nindex ${i}\n`)
  })
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'compare-src: add files'])
}

/** The self-describing compare diff tab id the app builds for a compare file. */
const diffTabId = (path: string) => `diff:${path}?base=main&compare=HEAD`

// Locators tied to the current DOM contract.
const compareToggle = (page: Page) => page.getByRole('button', { name: 'Compare refs' })
const exitCompare = (page: Page) => page.getByRole('button', { name: 'Exit compare mode' }).first()
// Compare-list rows live in the body div immediately after the section header.
// Scoping here keeps `[title=...]` off the file-explorer tree (whose rows carry
// no path title) and off the editor tab bar.
const compareBody = (page: Page) => page.locator('[role="button"][aria-label="Compare section"] + div')
const compareRow = (page: Page, name: string) => compareBody(page).locator(`[title="${name}"]`)
// The diff toolbar's file-position pill ("N / M") — a button, unlike the hunk
// counter (a span), so role=button isolates it.
const fileCounter = (page: Page) => page.getByRole('button', { name: /^\d+ \/ \d+$/ })
const prevFile = (page: Page) => page.getByRole('button', { name: 'Previous file' })
const nextFile = (page: Page) => page.getByRole('button', { name: 'Next file' })

// The active editor's persisted active tab — the diff tab id compare-nav pages
// through. Per-instance now (editorViews), but compare-nav uses the single home
// editor, so the active view's `activeTab` is the same value the old global field held.
const activeTab = async (page: Page, project: string) =>
  activeEditorView(await getWorkspaceState(page, project))?.activeTab

// Each fixture file's first line ("<name> line 1") only appears in that file's
// diff body (added lines of a new file), so it proves the rendered DIFF CONTENT
// switched — not just the toolbar position/tab id. `.first()` because the line
// renders as a word-diff segment span nested inside the line's text span.
async function expectDiffBody(page: Page, shown: string, hidden: readonly string[]): Promise<void> {
  await expect(page.getByText(`${shown} line 1`).first()).toBeVisible()
  for (const name of hidden) {
    await expect(page.getByText(`${name} line 1`)).toBeHidden()
  }
}

test.describe('Compare prev/next navigation', () => {
  let fixture: FixtureProject

  test.beforeEach(async ({ page, request }) => {
    fixture = await createFixtureProject(request)
    buildCompareHistory(fixture.path)
    await page.goto('/')
    await selectProject(page, fixture.name)
  })

  test.afterEach(async () => {
    await fixture?.dispose()
  })

  /** Enter compare mode and wait for the main..HEAD file list to populate. */
  async function enterCompareMode(page: Page): Promise<void> {
    await compareToggle(page).click()
    // The section header relabels Changes -> Compare once the toggle engages.
    await expect(page.locator('[role="button"][aria-label="Compare section"]')).toBeVisible()
    await expect(compareRow(page, 'alpha.txt')).toBeVisible({ timeout: 10_000 })
  }

  test('compare mode lists the diff between refs and opens a self-describing diff tab', async ({ page }) => {
    // The working tree is clean (everything committed), so plain Changes is empty.
    await expect(page.getByText('Working tree is clean')).toBeVisible()

    await enterCompareMode(page)

    // The full main..HEAD diff is listed, in diff order.
    for (const name of COMPARE_FILES) {
      await expect(compareRow(page, name)).toBeVisible()
    }

    // Opening the first row activates the self-describing compare diff tab.
    await compareRow(page, 'alpha.txt').click()
    await expect.poll(() => activeTab(page, fixture.name), { timeout: 10_000 })
      .toBe(diffTabId('alpha.txt'))

    // The diff toolbar reports the compare position (file 1 of 3) — proof the
    // EditorPanel derived its compare context from the diff tab id.
    await expect(fileCounter(page)).toHaveText('1 / 3')

    // ...and the rendered diff body is alpha's content, not another file's.
    await expectDiffBody(page, 'alpha.txt', ['bravo.txt', 'charlie.txt'])

    // Exiting compare mode returns the section to plain Changes.
    await exitCompare(page).click()
    await expect(page.locator('[role="button"][aria-label="Changes section"]')).toBeVisible()
    await expect(compareToggle(page)).toBeVisible()
  })

  test('prev/next pages across the compare file list with disabled boundaries', async ({ page }) => {
    await enterCompareMode(page)
    await compareRow(page, 'alpha.txt').click()

    // First file: position 1/3, Previous disabled, Next enabled.
    await expect(fileCounter(page)).toHaveText('1 / 3')
    await expect(prevFile(page)).toBeDisabled()
    await expect(nextFile(page)).toBeEnabled()
    await expectDiffBody(page, 'alpha.txt', ['bravo.txt', 'charlie.txt'])

    // Next -> second file: tab id + counter both advance.
    await nextFile(page).click()
    await expect(fileCounter(page)).toHaveText('2 / 3')
    await expect.poll(() => activeTab(page, fixture.name), { timeout: 10_000 })
      .toBe(diffTabId('bravo.txt'))
    await expect(prevFile(page)).toBeEnabled()
    await expect(nextFile(page)).toBeEnabled()
    // The diff body actually re-rendered bravo's content (alpha's is gone).
    await expectDiffBody(page, 'bravo.txt', ['alpha.txt', 'charlie.txt'])

    // Next -> last file: Next now disabled at the end of the list.
    await nextFile(page).click()
    await expect(fileCounter(page)).toHaveText('3 / 3')
    await expect.poll(() => activeTab(page, fixture.name), { timeout: 10_000 })
      .toBe(diffTabId('charlie.txt'))
    await expect(nextFile(page)).toBeDisabled()
    await expect(prevFile(page)).toBeEnabled()
    await expectDiffBody(page, 'charlie.txt', ['alpha.txt', 'bravo.txt'])

    // Previous -> back to the middle file.
    await prevFile(page).click()
    await expect(fileCounter(page)).toHaveText('2 / 3')
    await expect.poll(() => activeTab(page, fixture.name), { timeout: 10_000 })
      .toBe(diffTabId('bravo.txt'))
    await expectDiffBody(page, 'bravo.txt', ['alpha.txt', 'charlie.txt'])
  })
})
