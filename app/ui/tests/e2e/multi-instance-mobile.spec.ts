import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import {
  createFixtureProject,
  selectProject,
  waitForAppReady,
  layoutKey,
  runTag,
  type FixtureProject,
} from './helpers/workspace'

// Mobile projection (design: §D) projects the ACTIVE editor/terminal instance — one
// of N — through the same PanelHost the desktop tree uses. Mobile has no split
// affordances, so these seed a multi-instance state per (project) and assert the
// mobile pane shows the active instance (MRU head), not a sibling.

test.use({ viewport: { width: 375, height: 812 }, hasTouch: true })

let fixture: FixtureProject | null = null
const openedSessions: string[] = []

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
  const name = `mi-mobile-${runTag()}`
  const res = await request.post('/api/sessions/start', { data: { provider: 'shell', cwd, name } })
  expect(res.ok(), `start shell: ${res.status()}`).toBeTruthy()
  const body = (await res.json()) as { name: string }
  openedSessions.push(body.name)
  return body.name
}

async function waitServed(request: APIRequestContext, name: string): Promise<void> {
  await expect.poll(async () => {
    const res = await request.get('/api/projects')
    return res.ok() && (await res.json() as { name: string }[]).some((p) => p.name === name)
  }, { timeout: 10_000 }).toBe(true)
}

/** Seed (guarded) under the project's layout key before the workspace mounts. */
async function seed(page: Page, project: string, blob: unknown): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, value) },
    { key: layoutKey(project), value: JSON.stringify(blob) },
  )
}

const paneButton = (page: Page, name: string) => page.getByRole('button', { name, exact: true })
const terminalHeader = (page: Page, name: string) =>
  page.locator('span.truncate.flex-1.font-semibold', { hasText: name })

const panelState = {
  files: { mode: 'tree' as const },
  editor: { previewMode: 'edit' as const, splitDirection: 'horizontal' as const, splitSize: 50, autocompleteEnabled: false },
}

test.describe('Mobile projects the active instance (editor / terminal)', () => {
  test('the editor pane projects the active editor instance, not a sibling', async ({ page, request }) => {
    fixture = await createFixtureProject(request, { files: { 'a.txt': 'AAA_MARKER\n', 'b.txt': 'BBB_MARKER\n' } })
    await waitServed(request, fixture.name)
    // Two editor instances; editor:2 (on b.txt) is the MRU head → the active editor.
    await seed(page, fixture.name, {
      panelLayout: {
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
      },
      editorViews: {
        editor: { openTabs: ['a.txt'], activeTab: 'a.txt', previewTab: null },
        'editor:2': { openTabs: ['b.txt'], activeTab: 'b.txt', previewTab: null },
      },
      editorMru: ['editor:2', 'editor'],
      terminalBindings: {}, terminalMru: [],
    })
    await page.goto('/')
    await waitForAppReady(page)
    await selectProject(page, fixture.name)

    // Switch to the Editor pane: it projects the ACTIVE editor (editor:2 → b.txt),
    // showing b.txt's content and NOT the home editor's a.txt.
    await paneButton(page, 'Editor').click()
    const editor = page.locator('.cm-content')
    await expect(editor).toBeVisible({ timeout: 10_000 })
    await expect(editor).toContainText('BBB_MARKER')
    await expect(editor).not.toContainText('AAA_MARKER')
  })

  test('the terminal pane projects the active terminal instance, not a sibling', async ({ page, request }) => {
    fixture = await createFixtureProject(request)
    const s1 = await startShell(request, fixture.path)
    const s2 = await startShell(request, fixture.path)
    await waitServed(request, fixture.name)
    await page.goto('/')
    await waitForAppReady(page)
    await selectProject(page, fixture.name)

    // Bind both sessions via REAL session-row clicks → two terminal tabs in the
    // active group; the second (s2) becomes the active terminal. (clickSession
    // reveals the Terminal pane, so step back to Browse to bind the second.)
    const browse = page.getByText('Sessions', { exact: true }).first()
    await expect(browse).toBeVisible({ timeout: 10_000 })
    await page.getByText(s1, { exact: true }).first().click()
    await paneButton(page, 'Browse').click()
    await page.getByText(s2, { exact: true }).first().click()

    // The Terminal pane projects the ACTIVE terminal (s2 — the MRU head), not the
    // sibling s1 also bound in the same group.
    await paneButton(page, 'Terminal').click()
    await expect(terminalHeader(page, s2)).toBeVisible({ timeout: 15_000 })
    await expect(terminalHeader(page, s1)).toHaveCount(0)
  })
})
