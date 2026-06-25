import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import {
  createExternalWorktreeFixture,
  selectProject,
  waitForAppReady,
  openFileViaSearch,
  activityPanel,
  mainGroup,
  runTag,
  type ExternalWorktreeFixture,
} from './helpers/workspace'

// End-to-end integration capstone for the worktree-as-view redesign (design §7.3).
// ONE journey over a worktree registered at an EXTERNAL path (OUTSIDE `.worktrees/`
// — the P1 path-identity dimension), proving both halves of the contract in a
// single live session:
//
//   FILE VIEWS FOLLOW the selected worktree — explorer tree, Changes/diff,
//   open-editor content, unsaved-draft round-trip, binary/raw preview, text search,
//   quick-open.
//
//   THE SHELL HOLDS STILL across the switch — the open-tab set, the terminal (NO
//   remount: its PTY socket is never closed/reopened and its xterm node survives),
//   and the session list are all unchanged. Selecting primary returns to the main
//   tree.
//
// Drives the REAL affordances (the in-panel Files picker, the session row, the tab
// the user clicks) and asserts user-observable outcomes (which tree is shown, which
// bytes the editor holds, that the same socket stays open), never selector presence.

// --- Terminal-socket instrumentation (the no-remount canary, from
// terminal-lifecycle.spec.ts). A remount closes the old `/ws/terminal/<s>` socket
// and opens a new one; a silent teardown closes without reopening — both caught by
// the open/close counters, which must stay {opens:1, closes:0} for the whole test. ---
interface TermSockets { opens: number; closes: number; last: WebSocket | null }
interface TermWindow extends Window { __termWs?: TermSockets }

async function instrumentTerminalSockets(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as TermWindow
    w.__termWs = { opens: 0, closes: 0, last: null }
    const Native = window.WebSocket
    window.WebSocket = new Proxy(Native, {
      construct(target, argArray) {
        const sock = Reflect.construct(target, argArray) as WebSocket
        if (String(argArray[0] ?? '').includes('/ws/terminal/')) {
          const stats = w.__termWs!
          stats.opens += 1
          stats.last = sock
          sock.addEventListener('close', () => { stats.closes += 1 })
        }
        return sock
      },
    })
  })
}

const termWsStats = (page: Page): Promise<{ opens: number; closes: number }> =>
  page.evaluate(() => {
    const s = (window as TermWindow).__termWs
    return { opens: s?.opens ?? 0, closes: s?.closes ?? 0 }
  })
const termWsReadyState = (page: Page): Promise<number> =>
  page.evaluate(() => (window as TermWindow).__termWs?.last?.readyState ?? -1)

// --- Locators (the real affordances) ---
const fileTree = (page: Page) => page.locator('[role="tree"]')
const xterm = (page: Page) => page.locator('.yaco-terminal-xterm')
const xtermRows = (page: Page) => page.locator('.yaco-terminal-xterm .xterm-rows')
const sessionRow = (page: Page, name: string) => activityPanel(page).getByText(name, { exact: true }).first()
const terminalTab = (page: Page, name: string) =>
  page.locator(`[data-testid="group-tab"][data-tab-kind="terminal"][title="${name}"]`)
const editorTab = (page: Page, relpath: string) =>
  mainGroup(page).locator(`[data-testid="group-tab"][data-tab-kind="editor"][title="${relpath}"]`)
const changeItem = (page: Page, relpath: string) =>
  page.locator(`[data-testid="git-change-item"][data-change-path="${relpath}"]`)

// The Files header worktree toggle reveals an INLINE list in the panel body (HIDDEN by
// default, mirrors Changes' Compare-ref mode — design §P2e); selecting a row re-roots the
// views AND closes the list.
const worktreeToggle = (page: Page) => page.getByLabel('Select worktree')
const worktreeListbox = (page: Page) => page.getByRole('listbox', { name: 'Worktrees' })
async function openWorktreePicker(page: Page): Promise<void> {
  await expect(worktreeToggle(page)).toBeVisible({ timeout: 10_000 })
  await worktreeToggle(page).click()
  await expect(worktreeListbox(page)).toBeVisible({ timeout: 5_000 })
}
async function selectWorktreeRow(page: Page, rowText: string): Promise<void> {
  await openWorktreePicker(page)
  await worktreeListbox(page).getByRole('option').filter({ hasText: rowText }).click()
  // Selecting closes the list — mirrors Compare ref's exit on choose.
  await expect(worktreeListbox(page)).toHaveCount(0)
}

/** Every session row in the activity panel carries a "Kill session <name>" button,
 *  so its count is the session-list identity the switch must not change. */
const sessionRowCount = (page: Page): Promise<number> =>
  activityPanel(page).locator('[aria-label^="Kill session "]').count()

/** The relpath `title`s of every editor tab in the main (editor) group, sorted —
 *  the durable open-tab set the switch must not mutate. */
async function editorTabTitles(page: Page): Promise<string[]> {
  const tabs = mainGroup(page).locator('[data-testid="group-tab"][data-tab-kind="editor"]')
  const n = await tabs.count()
  const titles: string[] = []
  for (let i = 0; i < n; i++) titles.push((await tabs.nth(i).getAttribute('title')) ?? '')
  return titles.sort()
}

/** Open a file via quick-open (a PREVIEW tab) and pin it by double-clicking its
 *  tab — the real "make permanent" gesture (VSCode: dbl-click promotes a preview).
 *  Pinning the first before opening the second keeps both as sibling tabs (a second
 *  preview would otherwise replace the first's preview slot). Tab-driven, so it does
 *  not depend on the explorer revealing a nested path. */
async function openAndPin(page: Page, query: string, relpath: string): Promise<void> {
  await openFileViaSearch(page, query)
  const tab = editorTab(page, relpath)
  await expect(tab).toBeVisible({ timeout: 10_000 })
  await tab.dblclick()
}

async function startShellSession(request: APIRequestContext, cwd: string): Promise<string> {
  const name = `ext-wt-shell-${runTag()}`
  const res = await request.post('/api/sessions/start', { data: { provider: 'shell', cwd, name } })
  expect(res.ok(), `start shell session: ${res.status()}`).toBeTruthy()
  return ((await res.json()) as { name: string }).name
}

test.describe('Worktree-as-view: external worktree end-to-end', () => {
  let fixture: ExternalWorktreeFixture
  let session = ''

  test.beforeEach(async ({ request }) => {
    fixture = await createExternalWorktreeFixture(request)
    session = await startShellSession(request, fixture.path)
  })

  test.afterEach(async ({ request }) => {
    if (session) await request.post(`/api/sessions/${encodeURIComponent(session)}/close`).catch(() => undefined)
    await fixture?.dispose()
  })

  test('selecting an external worktree re-points every file view while the shell holds still', async ({ page }) => {
    // A heavy single-session journey (terminal start + three worktree switches +
    // every surface check) — give it room beyond the 60s default.
    test.slow()
    const pageErrors: string[] = []
    page.on('pageerror', err => pageErrors.push(err.message))

    const MARKER = `__EXT_DRAFT_${runTag().replace(/-/g, '_')}__`
    const WT_MARKER = `__WT_DRAFT_${runTag().replace(/-/g, '_')}__`

    await instrumentTerminalSockets(page)
    await page.goto('/')
    await waitForAppReady(page)
    await selectProject(page, fixture.name)
    await expect(worktreeToggle(page)).toBeVisible({ timeout: 15_000 })

    // --- Main scope: open two PINNED editor tabs; index.js ends active. ---
    await openAndPin(page, 'README.md', 'README.md')
    await openAndPin(page, 'index.js', 'src/index.js')
    const editor = mainGroup(page).locator('.cm-content')
    await expect(editor).toContainText('export const main', { timeout: 10_000 })
    // Main's committed bytes do NOT carry the worktree's extra line.
    await expect(editor).not.toContainText('export const external')

    // Type an unsaved draft into index.js → a draft in the main (primary) bucket.
    await editor.click()
    await page.keyboard.type(`${MARKER} `)
    await expect(editor).toContainText(MARKER)
    await expect
      .poll(() => page.evaluate(
        ([key, m]) => (localStorage.getItem(key) ?? '').includes(m),
        [`yaco-drafts:${fixture.name}`, MARKER] as const,
      ), { timeout: 8_000 })
      .toBe(true)

    // Main is a clean checkout: the worktree-only wip.txt is NOT a change here.
    await expect(changeItem(page, 'wip.txt')).toHaveCount(0)

    // --- Attach the session BESIDE the editors → a terminal in its OWN group, kept
    // mounted independent of which editor tab is active (so the socket canary is not
    // confounded by later tab switches). ---
    await sessionRow(page, session).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Open beside' }).click()
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(terminalTab(page, session)).toHaveCount(1, { timeout: 15_000 })
    await expect(xterm(page)).toBeVisible({ timeout: 15_000 })
    await expect.poll(() => termWsReadyState(page), { timeout: 15_000 }).toBe(WebSocket.OPEN)
    expect(await termWsStats(page)).toEqual({ opens: 1, closes: 0 })

    // Seed real PTY output, then capture + stamp the live xterm node for the
    // identity half of the no-remount check.
    await xterm(page).click()
    await page.keyboard.type('echo EXTTERMREADY')
    await page.keyboard.press('Enter')
    await expect(xtermRows(page)).toContainText('EXTTERMREADY', { timeout: 15_000 })
    const xtermNode = await xterm(page).elementHandle()
    expect(xtermNode).not.toBeNull()
    await xtermNode!.evaluate(el => el.setAttribute('data-ext-probe', 'attached'))

    // Shell baseline, captured RIGHT BEFORE the switch.
    const tabsBefore = await editorTabTitles(page)
    expect(tabsBefore).toEqual(['README.md', 'src/index.js'])
    const sessionCountBefore = await sessionRowCount(page)
    expect(sessionCountBefore).toBeGreaterThan(0)
    await expect(sessionRow(page, session)).toBeVisible()

    // --- THE SWITCH: select the EXTERNAL worktree in the in-panel Files picker. ---
    await selectWorktreeRow(page, fixture.branch)

    // The switch actually happened: the explorer re-rooted to the worktree (its
    // untracked wip.txt appears — it exists ONLY in the worktree).
    await expect(fileTree(page).getByText('wip.txt', { exact: true })).toBeVisible({ timeout: 10_000 })

    // SHELL HOLDS STILL across the switch:
    //  - open-tab set IDENTICAL,
    expect(await editorTabTitles(page)).toEqual(tabsBefore)
    //  - terminal did NOT remount: original node still attached, live node still
    //    stamped, tab still bound, and the SAME PTY socket — never closed/reopened,
    expect(await xtermNode!.evaluate(el => el.isConnected), 'xterm node disposed (remounted)').toBe(true)
    expect(await xterm(page).getAttribute('data-ext-probe'), 'xterm node replaced (remounted)').toBe('attached')
    await expect(terminalTab(page, session)).toHaveCount(1)
    expect(await termWsStats(page), 'PTY reconnected or closed across the switch').toEqual({ opens: 1, closes: 0 })
    //  - the session list is unchanged (sessions are decoupled from the worktree):
    //    same row count AND the same session still present.
    expect(await sessionRowCount(page)).toBe(sessionCountBefore)
    await expect(sessionRow(page, session)).toBeVisible()

    // OPEN-EDITOR CONTENT FOLLOWS: the still-open index.js tab now shows the
    // worktree's committed bytes (the extra `export const external` line), and the
    // main draft did NOT bleed in (it lives in the primary bucket).
    await editorTab(page, 'src/index.js').click()
    const wtEditor = mainGroup(page).locator('.cm-content')
    await expect(wtEditor).toContainText('export const external', { timeout: 10_000 })
    await expect(wtEditor).not.toContainText(MARKER)

    // Type an unsaved draft into the WORKTREE's index.js → a draft in the worktree
    // bucket, so the unsaved-draft round-trip is proven from BOTH scopes (this one
    // must survive a switch away and back below).
    await wtEditor.click()
    await page.keyboard.type(`${WT_MARKER} `)
    await expect(wtEditor).toContainText(WT_MARKER)

    // CHANGES / DIFF FOLLOWS: the worktree's working-tree changes show; clicking the
    // modified README opens its diff, whose body carries the worktree-only edit
    // (`external worktree edit`) — proving the diff content is the worktree's.
    await expect(changeItem(page, 'wip.txt')).toBeVisible({ timeout: 15_000 })
    await changeItem(page, 'README.md').click()
    await expect(page.locator('[data-testid="group-tab"][title="diff:README.md"]')).toBeVisible({ timeout: 5_000 })
    await expect(mainGroup(page).getByText('external worktree edit').first()).toBeVisible({ timeout: 5_000 })

    // QUICK-OPEN FOLLOWS: the worktree-only wip.txt resolves from the worktree-scoped index.
    await page.keyboard.press('Meta+p')
    const quickInput = page.locator('input[placeholder="Search files..."]')
    await expect(quickInput).toBeVisible({ timeout: 10_000 })
    await quickInput.fill('wip')
    await expect(page.locator('[data-search-result-idx]', { hasText: 'wip.txt' }).first()).toBeVisible({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await expect(quickInput).toHaveCount(0)

    // TEXT SEARCH FOLLOWS: ripgrep runs in the worktree root, so the token that
    // exists only in the worktree's wip.txt is found. The token appears nowhere else
    // on screen (change rows show only filenames), so it uniquely marks the hit.
    await page.getByRole('button', { name: 'Search in files' }).click()
    const textInput = page.getByRole('textbox', { name: 'Search in files...' })
    await expect(textInput).toBeVisible({ timeout: 10_000 })
    await textInput.fill(fixture.token)
    await expect(page.getByText(fixture.token).first()).toBeVisible({ timeout: 15_000 })
    // Back to the explorer tree (the final primary-return assertion reads the tree).
    await page.getByRole('button', { name: 'Back to explorer' }).click()
    await expect(fileTree(page)).toBeVisible({ timeout: 5_000 })

    // BINARY / RAW FOLLOWS: the worktree-only asset.png renders an image preview whose
    // /raw src threads the active worktree; naturalWidth>0 proves the bytes resolved
    // against the worktree root (main has no asset.png — a missing thread would 404).
    await openFileViaSearch(page, 'asset')
    const img = page.locator('img[alt="Image preview"]')
    await expect(img).toBeVisible({ timeout: 10_000 })
    const imgSrc = await img.getAttribute('src')
    expect(imgSrc).toContain('/raw')
    expect(imgSrc).toContain('worktree=')
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 10_000 }).toBeGreaterThan(0)

    // --- RETURN TO PRIMARY: the main tree is back, the shell still holds, and the
    // main draft round-trips. ---
    await selectWorktreeRow(page, 'primary')
    await expect(fileTree(page).getByText('wip.txt', { exact: true })).toHaveCount(0)
    await expect(fileTree(page).getByText('src', { exact: true })).toBeVisible({ timeout: 5_000 })

    // Shell still unchanged across the SECOND switch too (no remount either way).
    expect(await xtermNode!.evaluate(el => el.isConnected)).toBe(true)
    expect(await xterm(page).getAttribute('data-ext-probe')).toBe('attached')
    await expect(terminalTab(page, session)).toHaveCount(1)
    expect(await termWsStats(page)).toEqual({ opens: 1, closes: 0 })
    expect(await sessionRowCount(page)).toBe(sessionCountBefore)
    await expect(sessionRow(page, session)).toBeVisible()
    expect(await editorTabTitles(page)).toEqual(expect.arrayContaining(['README.md', 'src/index.js']))

    // DRAFT ROUND-TRIP (primary): reopen index.js in main — its draft renders again
    // from the primary bucket; neither the worktree's `external` line nor the
    // worktree draft leaked in (the visit dropped nothing and crossed no bucket).
    await editorTab(page, 'src/index.js').click()
    const mainEditor = mainGroup(page).locator('.cm-content')
    await expect(mainEditor).toContainText(MARKER, { timeout: 10_000 })
    await expect(mainEditor).not.toContainText('export const external')
    await expect(mainEditor).not.toContainText(WT_MARKER)

    // DRAFT ROUND-TRIP (worktree): switch back once more — the worktree's own unsaved
    // draft survived its round-trip (restored from the worktree bucket atop the
    // worktree bytes), while the primary draft stayed out.
    await selectWorktreeRow(page, fixture.branch)
    await expect(fileTree(page).getByText('wip.txt', { exact: true })).toBeVisible({ timeout: 10_000 })
    await editorTab(page, 'src/index.js').click()
    const wtEditor2 = mainGroup(page).locator('.cm-content')
    await expect(wtEditor2).toContainText(WT_MARKER, { timeout: 10_000 })
    await expect(wtEditor2).toContainText('export const external')
    await expect(wtEditor2).not.toContainText(MARKER)
    // Terminal never remounted across any of the three switches.
    expect(await termWsStats(page)).toEqual({ opens: 1, closes: 0 })

    expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([])
  })
})
