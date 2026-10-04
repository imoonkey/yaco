import { test, expect, type APIRequestContext } from '@playwright/test'
import {
  createFixtureProject,
  selectProject,
  waitForAppReady,
  runTag,
  type FixtureProject,
} from './helpers/workspace'

// A phone cannot select text in the xterm canvas. The touch key bar's Copy button
// opens the session's tmux pane text in a native read-only textarea, with a
// "Copy all" that writes the whole buffer to the clipboard.

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
  const name = `copy-${runTag()}`
  const res = await request.post('/api/sessions/start', { data: { provider: 'shell', cwd, name } })
  expect(res.ok(), `start shell: ${res.status()}`).toBeTruthy()
  const body = (await res.json()) as { name: string }
  openedSessions.push(body.name)
  return body.name
}

test('the key bar Copy button shows pane text and copies it all', async ({ page, request, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  fixture = await createFixtureProject(request)
  const session = await startShell(request, fixture.path)
  await page.goto('/')
  await waitForAppReady(page)
  await selectProject(page, fixture.name)

  await page.getByText(session, { exact: true }).first().click()
  const xterm = page.locator('.xterm').first()
  await expect(xterm).toBeVisible({ timeout: 15_000 })
  await xterm.click()
  // The marker only exists once the shell has evaluated it — it is pane OUTPUT,
  // not the echoed keystrokes.
  await page.keyboard.type('echo COPY_MARKER_$((40+2))\n')
  await expect.poll(async () => {
    const res = await request.get(`/api/sessions/${encodeURIComponent(session)}/text`)
    return ((await res.json()) as { text?: string }).text ?? ''
  }, { timeout: 10_000 }).toContain('COPY_MARKER_42')

  await page.getByRole('toolbar', { name: 'Terminal key bar' })
    .getByRole('button', { name: 'Copy terminal text' }).tap()

  const textarea = page.getByRole('textbox', { name: 'Terminal text' })
  await expect(textarea).toBeVisible()
  await expect(textarea).toHaveJSProperty('readOnly', false)
  await expect(textarea).toHaveAttribute('inputmode', 'none')
  await expect.poll(() => textarea.inputValue()).toContain('COPY_MARKER_42')

  await page.getByRole('button', { name: 'Copy all' }).tap()
  await expect(textarea).toHaveCount(0)
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('COPY_MARKER_42')
})
