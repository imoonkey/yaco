import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import {
  createFixtureProject,
  selectProject,
  waitForAppReady,
  getWorkspaceState,
  layoutKey,
  runTag,
  type FixtureProject,
} from './helpers/workspace'

// Multi-instance persistence: the load path (usePersistence) end-to-end through the
// real built app. Pins the design's "Persistence Shape" acceptance:
//   - the one-time migration of an OLD flat blob (global openTabs/activeTab +
//     activeSession) into editorViews.editor + a structural terminal binding;
//   - a MULTI-instance new-shape blob round-trips (seed → load → reload → identical);
//   - load-normalization repairs a corrupt/legacy tree (id-collision re-id, stray
//     whitelisted tab dropped, one-per-session binding dedup).
//
// The unit layer (src/hooks/__tests__/layoutMigration.test.ts) pins the pure load
// function; these specs prove the SAME behavior survives a real load of the static
// build. The seed is written under the project's layout key BEFORE the workspace
// mounts (addInitScript, guarded so a reload never clobbers the flushed new shape),
// then the project is selected so the provider reads it.

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

/** Start a real tmux shell session (per-run name; the tmux namespace is global). */
async function startShell(request: APIRequestContext, cwd: string): Promise<string> {
  const name = `mi-persist-${runTag()}`
  const res = await request.post('/api/sessions/start', { data: { provider: 'shell', cwd, name } })
  expect(res.ok(), `start shell: ${res.status()}`).toBeTruthy()
  const body = (await res.json()) as { name: string }
  openedSessions.push(body.name)
  return body.name
}

/** Wait until the registry actually serves `name` before loading the app, so the
 *  app's initial /api/projects fetch can't race the just-committed registration. */
async function waitServed(request: APIRequestContext, name: string): Promise<void> {
  await expect.poll(async () => {
    const res = await request.get('/api/projects')
    if (!res.ok()) return false
    return (await res.json() as { name: string }[]).some((p) => p.name === name)
  }, { timeout: 10_000 }).toBe(true)
}

/** Seed a persisted blob under `project`'s layout key BEFORE the workspace mounts,
 *  then load + select the project so usePersistence reads it. Guarded on empty so
 *  the re-run on `page.reload()` never clobbers the new-shape state the app flushed
 *  on the prior unload (addInitScript fires on every navigation). Returns the fixture. */
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

// Minimal structural mirror of `instancesInOrder` (panelLayoutModel) so a spec can
// assert which editor/terminal instance ids the loader produced from the persisted tree.
type TreeNode = {
  kind: string
  id?: string
  panel?: string
  panels?: string[]
  active?: string
  children?: { node: TreeNode }[]
}
function instanceIds(node: TreeNode | undefined, panel: string, out: string[] = []): string[] {
  if (!node) return out
  if (node.kind === 'leaf') {
    if (node.panel === panel) out.push(node.id ?? '')
  } else if (node.kind === 'tabs') {
    if (node.panels?.includes(panel)) out.push(panel)
  } else {
    for (const c of node.children ?? []) instanceIds(c.node, panel, out)
  }
  return out
}

async function editorIds(page: Page, project: string): Promise<string[]> {
  const state = await getWorkspaceState(page, project)
  return instanceIds(state?.panelLayout?.desktop, 'editor').sort()
}

const panelState = {
  files: { mode: 'tree' as const },
  editor: { previewMode: 'edit' as const, splitDirection: 'horizontal' as const, splitSize: 50, autocompleteEnabled: false },
}

test.describe('Multi-instance persistence (migration + round-trip + load-normalize)', () => {
  test('migrates an old flat blob to the home editor view + structural terminal binding', async ({ page, request }) => {
    fixture = await createFixtureProject(request, { files: { [HOME_TAB]: 'export const home = 1\n' } })
    // A live session so the migrated binding survives the post-load reconcile
    // (a dead binding would be dropped on the first poll — covered elsewhere).
    const session = await startShell(request, fixture.path)
    await waitServed(request, fixture.name)
    // Old flat blob: the global openTabs/activeTab/previewTab + activeSession the
    // multi-instance model replaced. No panelLayout → loader uses the default tree.
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

    // The migrated tab opens in the home editor; the bound session shows its terminal.
    await expect(page.locator(`[data-testid="tab"][title="${HOME_TAB}"]`)).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(session, { exact: true }).first()).toBeVisible({ timeout: 15_000 })

    // Reload so the running app flushes the migrated (new-shape) state, then assert it
    // (the addInitScript guard does not re-clobber the flushed blob).
    await page.reload()
    await waitForAppReady(page)
    await expect(page.locator(`[data-testid="tab"][title="${HOME_TAB}"]`)).toBeVisible({ timeout: 10_000 })

    const state = await getWorkspaceState(page, fixture.name)
    expect(state.editorViews.editor).toEqual({ openTabs: [HOME_TAB], activeTab: HOME_TAB, previewTab: null })
    expect(state.editorMru).toEqual(['editor'])
    expect(state.terminalBindings.terminal).toBe(session)
    expect(state.terminalMru).toEqual(['terminal'])
    expect(state.recentFiles).toEqual([HOME_TAB])
    // The old flat globals are gone from the new shape.
    expect(state.openTabs).toBeUndefined()
    expect(state.activeTab).toBeUndefined()
    expect(state.activeSession).toBeUndefined()
  })

  test('round-trips multiple editor instances across reload', async ({ page, request }) => {
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

    const homePane = page.locator('[data-instance-id="editor"]')
    const secondaryPane = page.locator('[data-instance-id="editor:2"]')
    await expect(homePane).toBeVisible({ timeout: 10_000 })
    await expect(secondaryPane).toBeVisible({ timeout: 10_000 })
    await expect(homePane.locator(`[data-testid="tab"][title="${HOME_TAB}"]`)).toBeVisible()
    await expect(secondaryPane.locator(`[data-testid="tab"][title="${SECONDARY_TAB}"]`)).toBeVisible()

    // Reload: both instances + their distinct views restore (the round-trip).
    await page.reload()
    await waitForAppReady(page)
    await expect(secondaryPane).toBeVisible({ timeout: 10_000 })
    await expect(homePane.locator(`[data-testid="tab"][title="${HOME_TAB}"]`)).toBeVisible({ timeout: 10_000 })
    await expect(secondaryPane.locator(`[data-testid="tab"][title="${SECONDARY_TAB}"]`)).toBeVisible()

    const state = await getWorkspaceState(page, fixture.name)
    expect(Object.keys(state.editorViews).sort()).toEqual(['editor', 'editor:2'])
    expect(state.editorViews['editor:2'].openTabs).toEqual([SECONDARY_TAB])
    expect(await editorIds(page, fixture.name)).toEqual(['editor', 'editor:2'])
  })

  test('load-normalize: an editor leaf claiming the home id is re-id\'d to a secondary', async ({ page, request }) => {
    // A legacy/corrupt tree with an editor LEAF claiming the reserved home id
    // 'editor'. Normalization keeps the structural home (the main-tabs editor) and
    // re-ids the colliding leaf to a fresh secondary — both instances survive.
    fixture = await seedAndSelect(page, request, {
      panelLayout: {
        version: 1,
        desktop: {
          kind: 'split', id: 'root', axis: 'row',
          children: [
            { node: { kind: 'leaf', id: 'files', panel: 'files' } },
            { grow: true, node: { kind: 'tabs', id: 'main', active: 'editor', panels: ['editor', 'tasks'], chrome: 'none' } },
            { node: { kind: 'leaf', id: 'editor', panel: 'editor' } }, // collides with home id
          ],
        },
        mobile: { activeDock: 'browse' },
        panelState,
      },
      editorViews: {}, editorMru: [], terminalBindings: {}, terminalMru: [],
    })

    // Reload to flush the normalized tree (an empty editor pane has no DOM to
    // assert, so read the structural result), then confirm the home keeps 'editor'
    // and the colliding leaf became the secondary 'editor:2'.
    await page.reload()
    await waitForAppReady(page)
    await expect.poll(() => editorIds(page, fixture!.name)).toEqual(['editor', 'editor:2'])
  })

  test('load-normalize: a stray terminal tab entry is dropped from a tabs node', async ({ page, request }) => {
    // A corrupt tree that smuggles a terminal into a tabs node's panels array. The
    // tabs array has no instance-id slot, so the whitelist invariant drops it — only
    // the structural home editor (+ tasks) survives in tabs, and no terminal renders.
    fixture = await seedAndSelect(page, request, {
      panelLayout: {
        version: 1,
        desktop: {
          kind: 'split', id: 'root', axis: 'row',
          children: [
            { node: { kind: 'leaf', id: 'files', panel: 'files' } },
            { grow: true, node: { kind: 'tabs', id: 'main', active: 'editor', panels: ['editor', 'terminal', 'tasks'], chrome: 'none' } },
          ],
        },
        mobile: { activeDock: 'browse' },
        panelState,
      },
      editorViews: {}, editorMru: [], terminalBindings: {}, terminalMru: [],
    })

    await expect(page.locator('[data-instance-id="editor"]')).toBeVisible({ timeout: 10_000 })
    // The stray terminal entry produced no terminal pane.
    await expect(page.locator('[data-instance-id="terminal"]')).toHaveCount(0)
    await expect(page.getByText('Select a session to attach terminal')).toHaveCount(0)
  })

  test('load-normalize: terminal bindings dedupe to one-per-session (first in document order)', async ({ page, request }) => {
    fixture = await createFixtureProject(request)
    // A live session so the kept binding survives the post-load reconcile.
    const session = await startShell(request, fixture.path)
    await waitServed(request, fixture.name)
    // Two terminal leaves both bound to the same session: the 1-per-session invariant
    // keeps the first in document order ('terminal'); the later dup ('terminal:2')
    // is left unbound (renders the placeholder).
    await page.addInitScript(
      ({ key, value }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, value) },
      {
        key: layoutKey(fixture.name),
        value: JSON.stringify({
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
        }),
      },
    )
    await page.goto('/')
    await waitForAppReady(page)
    await selectProject(page, fixture.name)

    const firstTerminal = page.locator('[data-instance-id="terminal"]')
    const dupTerminal = page.locator('[data-instance-id="terminal:2"]')
    await expect(firstTerminal).toBeVisible({ timeout: 10_000 })
    await expect(dupTerminal).toBeVisible({ timeout: 10_000 })
    // The first terminal keeps the session (its header shows the name); the dup is
    // unbound and shows the placeholder.
    await expect(firstTerminal.getByText(session, { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(dupTerminal.getByText('Select a session to attach terminal')).toBeVisible()
  })
})
