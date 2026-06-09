import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import {
  provisionWorkspace,
  waitForAppReady,
  createTestFile,
  deleteTestFile,
  openFileViaSearch,
  writeFileViaAPI,
  waitForSSERefresh,
  getWorkspaceState,
  uniqueFileName,
  type FixtureProject,
} from './helpers/workspace'

// Characterization of the workspace assembly layer against the CURRENT renderer:
// SSE-driven content refetch, on-disk conflict detection, and draft persistence.
// Every test provisions its own isolated per-run project (empty per-worktree
// YACO_HOME) and disposes it, so nothing depends on the shared registry.

let provisioned: FixtureProject[] = []

test.afterEach(async () => {
  const all = provisioned
  provisioned = []
  await Promise.all(all.map((f) => f.dispose().catch(() => undefined)))
})

/** Provision an isolated workspace and track it for teardown. */
async function ws(page: Page, request: APIRequestContext): Promise<FixtureProject> {
  const project = await provisionWorkspace(page, request)
  provisioned.push(project)
  return project
}

/** A tab in the editor tab bar, addressed by its full-path title. */
function tab(page: Page, title: string) {
  return page.locator(`[data-testid="tab"][title="${title}"]`)
}

/** Open a file via quick-open and pin it (double-click) so a later preview open
 *  does not drop it. Waits on the `(preview)` marker clearing — the real "pinned"
 *  signal — instead of a fixed sleep. */
async function openPinnedTab(page: Page, fileName: string): Promise<void> {
  await openFileViaSearch(page, fileName)
  const t = tab(page, fileName)
  await expect(t).toBeVisible({ timeout: 10_000 })
  await expect(t).toContainText('(preview)') // opened as a preview tab
  await t.dblclick()
  await expect(t).not.toContainText('(preview)') // pinned — safe to open the next file
}

/**
 * Drive the SSE refetch path (`useFileState.refetchOpenFiles`).
 *
 * In production a filesystem watcher emits a `filetree`/`git` SSE event on an
 * external file change, which fans out to `refetchOpenFiles`. That watcher only
 * covers projects that existed at server boot, and a per-worktree `YACO_HOME`
 * starts empty, so a fixture registered mid-test gets no watcher and no event.
 *
 * The SSE layer (`useSSE`) reconnects and "fires all refresh callbacks (state
 * may have changed while disconnected)" on every (re)connect — including
 * `refetchOpenFiles`. A real `visibilitychange` (tab refocus / screen unlock)
 * triggers exactly that reconnect, so dispatching it invokes the identical
 * `openTabsRef` code path the watcher-driven event would, with no dependency on
 * the unwatched fixture. Callers assert the result with auto-waiting matchers.
 */
async function forceSseRefetch(page: Page): Promise<void> {
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
}

test.describe('Workspace regression', () => {
  // The openTabsRef hazard: `refetchOpenFiles` reads the dep-less `openTabsRef`
  // mirror and refetches EVERY open file tab — not just the active one. With a
  // single open tab the original test could not observe a stale ref silently
  // skipping a backgrounded tab. Switching tabs never refetches (handleSelectTab
  // -> setActiveTab only), so a non-active tab showing new content can only come
  // from the refetch — exactly what this asserts.
  test('SSE refetch updates active AND non-active tabs with >=2 open', async ({ page, request }) => {
    const project = await ws(page, request)

    const fileA = uniqueFileName('sse_active.txt')
    const fileB = uniqueFileName('sse_background.txt')
    await createTestFile(page, project.name, fileA, 'ALPHA original content\n')
    await createTestFile(page, project.name, fileB, 'BRAVO original content\n')
    await waitForSSERefresh(page, 3000) // let the quick-open index settle

    // Open both files as PINNED tabs so neither is dropped as a stale preview.
    await openPinnedTab(page, fileA)
    await openPinnedTab(page, fileB)

    // Two tabs are genuinely open — the precondition the single-file test lacked.
    await expect(page.locator('[data-testid="tab"]')).toHaveCount(2)
    await expect(tab(page, fileA)).toBeVisible()
    await expect(tab(page, fileB)).toBeVisible()

    const editor = page.locator('.cm-content')

    // B is active right after opening: PROVE its initial open-fetch resolved to the
    // original content BEFORE any external write. This isolates the later refetch
    // assertion from a slow initial fetch landing after the write.
    await expect(editor).toContainText('BRAVO original content')

    // Activate A, so B is the NON-active open tab. The editor shows A's cached
    // content; B is offscreen and updates only if the refetch reaches it.
    await tab(page, fileA).click()
    await expect(editor).toContainText('ALPHA original content')
    await expect(editor).not.toContainText('BRAVO')

    // Externally change BOTH the active (A) and the non-active (B) open files.
    await writeFileViaAPI(page, project.name, fileA, 'ALPHA updated externally\n')
    await writeFileViaAPI(page, project.name, fileB, 'BRAVO updated externally\n')
    await forceSseRefetch(page)

    // Active tab refetched (the original single-file guarantee).
    await expect(editor).toContainText('ALPHA updated externally', { timeout: 10_000 })

    // Non-active tab refetched: switching to B never triggers a fetch, and B had
    // already rendered 'BRAVO original content', so the new content can only come
    // from refetchOpenFiles updating the backgrounded tab via openTabsRef. A stale
    // ref would leave 'BRAVO original content' here and fail these assertions.
    await tab(page, fileB).click()
    await expect(editor).toContainText('BRAVO updated externally', { timeout: 10_000 })
    await expect(editor).not.toContainText('BRAVO original content')

    await deleteTestFile(page, project.name, fileA)
    await deleteTestFile(page, project.name, fileB)
  })

  test('conflict detection: dirty tab + external change shows banner', async ({ page, request }) => {
    const project = await ws(page, request)

    const filePath = uniqueFileName('conflict.txt')
    await createTestFile(page, project.name, filePath, 'line one\nline two\nline three\n')
    await waitForSSERefresh(page, 3000)

    await openFileViaSearch(page, filePath)

    // Type to make the tab dirty, then wait on the dirty-dot indicator (not a sleep).
    const editor = page.locator('.cm-content')
    await editor.click()
    await page.keyboard.type('DIRTY EDIT ')
    await expect(tab(page, filePath).locator('.rounded-full')).toBeVisible()

    // External change to a dirty file resolves to a conflict (not a silent refetch).
    await writeFileViaAPI(page, project.name, filePath, 'externally modified content\n')
    await forceSseRefetch(page)

    const banner = page.locator('text=File changed on disk')
    await expect(banner).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('button', { hasText: 'Accept Disk Version' })).toBeVisible()
    await expect(page.locator('button', { hasText: 'Keep Mine' })).toBeVisible()

    // Resolving with the disk version clears the banner and loads disk content.
    await page.locator('button', { hasText: 'Accept Disk Version' }).click()
    await expect(banner).not.toBeVisible({ timeout: 5000 })
    await expect(editor).toContainText('externally modified content')

    await deleteTestFile(page, project.name, filePath)
  })

  test('draft persistence across browser refresh', async ({ page, request }) => {
    const project = await ws(page, request)

    const filePath = uniqueFileName('draft.txt')
    await createTestFile(page, project.name, filePath, 'original content\n')
    await waitForSSERefresh(page, 3000)

    await openFileViaSearch(page, filePath)

    // Unsaved edits auto-pin the tab and persist as a draft.
    const editor = page.locator('.cm-content')
    await editor.click()
    await page.keyboard.type('DRAFT CONTENT ')

    // Gate the reload on persistence actually flushing to localStorage: the tab is
    // in the persisted layout AND the draft body is in the persisted drafts blob.
    // (layout 300ms / drafts 500ms debounce — polling beats a fixed sleep.)
    await expect
      .poll(async () => {
        const layout = await getWorkspaceState(page, project.name)
        const drafts = await page.evaluate(
          (key) => {
            const raw = localStorage.getItem(key)
            return raw ? (JSON.parse(raw) as { files?: Record<string, { draft?: string | null }> }) : null
          },
          `yaco-drafts:${project.name}`,
        )
        const tabPersisted = Array.isArray(layout?.openTabs) && layout.openTabs.includes(filePath)
        const draftBody = drafts?.files?.[filePath]?.draft ?? ''
        return tabPersisted && draftBody.includes('DRAFT CONTENT')
      }, { timeout: 10_000 })
      .toBe(true)

    // Reload: project selection + open tabs + drafts restore from localStorage.
    await page.reload()
    await waitForAppReady(page)

    const restoredTab = tab(page, filePath)
    await expect(restoredTab).toBeVisible({ timeout: 10_000 })
    await restoredTab.click()
    await expect(page.locator('.cm-content')).toContainText('DRAFT CONTENT', { timeout: 5000 })

    await deleteTestFile(page, project.name, filePath)
  })
})
