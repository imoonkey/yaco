import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import {
  createFixtureProject,
  selectProject,
  waitForAppReady,
  getWorkspaceState,
  layoutKey,
  openEditorTabIds,
  allEditorTabIds,
  activeBoundSession,
  runTag,
  type FixtureProject,
} from './helpers/workspace'

// Multi-instance persistence: the persistence LOADER end-to-end through the real
// built app (design: VSCode Tab Groups / Persistence + migration). Pins that the
// one-way migration of OLD persisted blobs into the FLAT group shape survives a
// real load + reload of the static build:
//   - an old flat blob (global openTabs/activeTab + activeSession) → a group's
//     editor tab(s) + a bound terminal tab; the new shape drops editorViews;
//   - a multi-instance old blob (editorViews + a secondary editor leaf) round-trips
//     into per-group editor tabs;
//   - an old multi-file editor expands to ONE editor tab per file, exactly one
//     preview tab;
//   - a terminal binding is preserved through migration (no rebind);
//   - two old terminal leaves bound to the SAME session dedupe to one bound tab.
//
// The pure migration is unit-tested in src; these prove the SAME behavior survives
// a real load of the static build. Seeds are written under the project's layout key
// BEFORE the workspace mounts (addInitScript, guarded so a reload never clobbers the
// flushed new shape), then the project is selected so the provider reads it.

const HOME_TAB = 'src/home.ts'
const SECONDARY_TAB = 'src/secondary.ts'

let fixture: FixtureProject | null = null
const openedSessions: string[] = []

test.use({ viewport: { width: 1280, height: 800 } })

test.afterEach(async ({ request }) => {
  for (const name of openedSessions.splice(0)) {
    await request.post(`/api/sessions/${encodeURIComponent(name)}/close`).catch(() => undefined)
  }
  if (fixture) {
    await fixture.dispose()
    fixture = null
  }
})

async function startShell(request: APIRequestContext, cwd: string): Promise<string> {
  const name = `mi-persist-${runTag()}`
  const res = await request.post('/api/sessions/start', { data: { provider: 'shell', cwd, name } })
  expect(res.ok(), `start shell: ${res.status()}`).toBeTruthy()
  const body = (await res.json()) as { name: string }
  openedSessions.push(body.name)
  return body.name
}

async function waitServed(request: APIRequestContext, name: string): Promise<void> {
  await expect.poll(async () => {
    const res = await request.get('/api/projects')
    if (!res.ok()) return false
    return (await res.json() as { name: string }[]).some((p) => p.name === name)
  }, { timeout: 10_000 }).toBe(true)
}

/** Seed a persisted blob under `project`'s layout key BEFORE the workspace mounts,
 *  then load + select so usePersistence migrates it. Guarded on empty so the re-run
 *  on `page.reload()` never clobbers the new-shape state the app flushed on the prior
 *  unload (addInitScript fires on every navigation). Returns the fixture. */
async function seedAndSelect(
  page: Page, request: APIRequestContext, blob: unknown, opts: Parameters<typeof createFixtureProject>[1] = {},
): Promise<FixtureProject> {
  const f = await createFixtureProject(request, opts)
  await waitServed(request, f.name)
  await page.addInitScript(
    ({ key, value }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, value) },
    { key: layoutKey(f.name), value: JSON.stringify(blob) },
  )
  await page.goto('/')
  await waitForAppReady(page)
  await selectProject(page, f.name)
  return f
}

const panelState = {
  files: { mode: 'tree' as const },
  editor: { previewMode: 'edit' as const, splitDirection: 'horizontal' as const, splitSize: 50, autocompleteEnabled: false },
}

// A working-area editor/terminal tab, addressed by its visible title.
const editorTab = (page: Page, title: string) =>
  page.locator(`[data-testid="group-tab"][data-tab-kind="editor"][title="${title}"]`)
const terminalTab = (page: Page, title: string) =>
  page.locator(`[data-testid="group-tab"][data-tab-kind="terminal"][title="${title}"]`)

test.describe('Multi-instance persistence (migration + round-trip)', () => {
  test('migrates an old flat blob to a group editor tab + a bound terminal tab', async ({ page, request }) => {
    fixture = await createFixtureProject(request, { files: { [HOME_TAB]: 'export const home = 1\n' } })
    // A live session so the migrated binding survives the post-load reconcile.
    const session = await startShell(request, fixture.path)
    await waitServed(request, fixture.name)
    // Old flat blob: the global openTabs/activeTab/previewTab + activeSession the
    // group model replaced. No panelLayout → loader uses the default tree.
    await page.addInitScript(
      ({ key, value }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, value) },
      {
        key: layoutKey(fixture.name),
        value: JSON.stringify({
          openTabs: [HOME_TAB], activeTab: HOME_TAB, previewTab: null,
          activeSession: session, recentFiles: [HOME_TAB], layout: { autocompleteEnabled: true },
        }),
      },
    )
    await page.goto('/')
    await waitForAppReady(page)
    await selectProject(page, fixture.name)

    // The migrated file is an editor tab; the migrated session is a bound terminal tab.
    await expect(editorTab(page, HOME_TAB)).toBeVisible({ timeout: 10_000 })
    await expect(terminalTab(page, session)).toBeVisible({ timeout: 15_000 })

    // Reload so the running app flushes the migrated (new-shape) state, then assert it
    // (the addInitScript guard does not re-clobber the flushed blob).
    await page.reload()
    await waitForAppReady(page)
    await expect(editorTab(page, HOME_TAB)).toBeVisible({ timeout: 10_000 })

    const state = await getWorkspaceState(page, fixture.name)
    expect(openEditorTabIds(state)).toEqual([HOME_TAB])
    expect(activeBoundSession(state)).toBe(session)
    expect(state.recentFiles).toEqual([HOME_TAB])
    // The old flat globals AND the per-instance editorViews map are gone.
    expect(state.editorViews).toBeUndefined()
    expect(state.openTabs).toBeUndefined()
    expect(state.activeTab).toBeUndefined()
    expect(state.activeSession).toBeUndefined()
  })

  test('round-trips multiple editor instances (one tab per old editor) across reload', async ({ page, request }) => {
    const tree = {
      version: 1,
      desktop: {
        kind: 'split', id: 'root', axis: 'row',
        children: [
          { node: { kind: 'leaf', id: 'files', panel: 'files' } },
          { grow: true, node: { kind: 'tabs', id: 'main', active: 'editor', panels: ['editor', 'tasks'], chrome: 'none' } },
          { node: { kind: 'leaf', id: 'editor:2', panel: 'editor' } },
        ],
      },
      mobile: { activeDock: 'browse' },
      panelState,
    }
    fixture = await seedAndSelect(page, request, {
      panelLayout: tree,
      editorViews: {
        editor: { openTabs: [HOME_TAB], activeTab: HOME_TAB, previewTab: null },
        'editor:2': { openTabs: [SECONDARY_TAB], activeTab: SECONDARY_TAB, previewTab: null },
      },
      terminalBindings: {},
      editorMru: ['editor:2', 'editor'],
      terminalMru: [],
    }, { files: { [HOME_TAB]: 'export const home = 1\n', [SECONDARY_TAB]: 'export const secondary = 2\n' } })

    // The two old editors migrate into two editor tabs (in two groups, side by side).
    await expect(editorTab(page, HOME_TAB)).toBeVisible({ timeout: 10_000 })
    await expect(editorTab(page, SECONDARY_TAB)).toBeVisible({ timeout: 10_000 })

    // Reload: both editor tabs restore (the round-trip).
    await page.reload()
    await waitForAppReady(page)
    await expect(editorTab(page, HOME_TAB)).toBeVisible({ timeout: 10_000 })
    await expect(editorTab(page, SECONDARY_TAB)).toBeVisible()

    const state = await getWorkspaceState(page, fixture.name)
    expect(allEditorTabIds(state).sort()).toEqual([HOME_TAB, SECONDARY_TAB].sort())
    expect(state.editorViews).toBeUndefined()
  })

  test('migration expands a multi-file editor into one tab per file with exactly one preview', async ({ page, request }) => {
    // An old single editor showing TWO files, the second a preview.
    fixture = await seedAndSelect(page, request, {
      panelLayout: {
        version: 1,
        desktop: {
          kind: 'split', id: 'root', axis: 'row',
          children: [
            { node: { kind: 'leaf', id: 'files', panel: 'files' } },
            { grow: true, node: { kind: 'tabs', id: 'main', active: 'editor', panels: ['editor', 'tasks'], chrome: 'none' } },
          ],
        },
        mobile: { activeDock: 'browse' },
        panelState,
      },
      editorViews: {
        editor: { openTabs: [HOME_TAB, SECONDARY_TAB], activeTab: SECONDARY_TAB, previewTab: SECONDARY_TAB },
      },
      editorMru: ['editor'], terminalBindings: {}, terminalMru: [],
    }, { files: { [HOME_TAB]: 'export const home = 1\n', [SECONDARY_TAB]: 'export const secondary = 2\n' } })

    // Each open file became its own editor tab in the one group.
    await expect(editorTab(page, HOME_TAB)).toBeVisible({ timeout: 10_000 })
    await expect(editorTab(page, SECONDARY_TAB)).toBeVisible()

    // Exactly one preview (italic) tab: the migrated previewTab (SECONDARY_TAB); the
    // other file is pinned (upright).
    const fontStyle = (l: ReturnType<Page['locator']>) => l.evaluate((el) => getComputedStyle(el).fontStyle)
    await expect.poll(() => fontStyle(editorTab(page, SECONDARY_TAB))).toBe('italic')
    expect(await fontStyle(editorTab(page, HOME_TAB))).not.toBe('italic')
  })

  test('migration preserves a terminal binding (no rebind, no extra miss)', async ({ page, request }) => {
    fixture = await createFixtureProject(request)
    const session = await startShell(request, fixture.path)
    await waitServed(request, fixture.name)
    // An old tree with a terminal leaf bound to a live session.
    await seedAndSelectExisting(page, fixture.name, {
      panelLayout: {
        version: 1,
        desktop: {
          kind: 'split', id: 'root', axis: 'row',
          children: [
            { grow: true, node: { kind: 'tabs', id: 'main', active: 'editor', panels: ['editor', 'tasks'], chrome: 'none' } },
            { node: { kind: 'leaf', id: 'terminal', panel: 'terminal' } },
          ],
        },
        mobile: { activeDock: 'browse' },
        panelState,
      },
      editorViews: {}, editorMru: [],
      terminalBindings: { terminal: session },
      terminalMru: ['terminal'],
    })

    // The terminal leaf migrated into a bound terminal TAB on the same session — the
    // binding carried over with no rebind.
    await expect(terminalTab(page, session)).toBeVisible({ timeout: 15_000 })
    const state = await getWorkspaceState(page, fixture.name)
    expect(activeBoundSession(state)).toBe(session)
  })

  test('migration dedupes two terminal leaves bound to the same session to one', async ({ page, request }) => {
    fixture = await createFixtureProject(request)
    const session = await startShell(request, fixture.path)
    await waitServed(request, fixture.name)
    // Two terminal leaves BOTH bound to the same session: the 1-per-session invariant
    // keeps the first; the dup ends up unbound.
    await seedAndSelectExisting(page, fixture.name, {
      panelLayout: {
        version: 1,
        desktop: {
          kind: 'split', id: 'root', axis: 'row',
          children: [
            { grow: true, node: { kind: 'tabs', id: 'main', active: 'editor', panels: ['editor', 'tasks'], chrome: 'none' } },
            { node: { kind: 'leaf', id: 'terminal', panel: 'terminal' } },
            { node: { kind: 'leaf', id: 'terminal:2', panel: 'terminal' } },
          ],
        },
        mobile: { activeDock: 'browse' },
        panelState,
      },
      editorViews: {}, editorMru: [],
      terminalBindings: { 'terminal:2': session, terminal: session },
      terminalMru: [],
    })

    // Exactly ONE terminal tab is bound to the session (the dup is unbound → "Terminal").
    await expect(terminalTab(page, session)).toHaveCount(1, { timeout: 15_000 })
    await expect(page.locator('[data-testid="group-tab"][data-tab-kind="terminal"][title="Terminal"]')).toHaveCount(1)
  })
})

/** Seed under an already-created fixture's layout key, then load + select. */
async function seedAndSelectExisting(page: Page, project: string, blob: unknown): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, value) },
    { key: layoutKey(project), value: JSON.stringify(blob) },
  )
  await page.goto('/')
  await waitForAppReady(page)
  await selectProject(page, project)
}
