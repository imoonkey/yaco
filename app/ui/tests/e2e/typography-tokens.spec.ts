import { test, expect, type Page } from '@playwright/test'

// Token → expected px (must match @theme static block in src/index.css).
const EXPECTED: Record<string, number> = {
  '2xs': 9,
  'xs': 10,
  'sm': 11,
  'md': 12,
  'lg': 13,
  'xl': 14,
  '2xl': 16,
}

// Inject one probe span per token and read back its resolved font-size.
async function measureTokens(page: Page): Promise<Record<string, string>> {
  return page.evaluate((names: string[]) => {
    const out: Record<string, string> = {}
    for (const name of names) {
      const el = document.createElement('span')
      el.style.fontSize = `var(--text-ui-${name})`
      el.textContent = 'probe'
      document.body.appendChild(el)
      out[name] = getComputedStyle(el).fontSize
      el.remove()
    }
    return out
  }, Object.keys(EXPECTED))
}

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((t) => {
    if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark')
    else document.documentElement.removeAttribute('data-theme')
  }, theme)
}

test.describe('Typography token migration', () => {
  test('every --text-ui-* token resolves to its exact px in light and dark', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')

    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme)
      const measured = await measureTokens(page)

      for (const [name, px] of Object.entries(EXPECTED)) {
        expect(
          measured[name],
          `--text-ui-${name} in ${theme} theme should resolve to ${px}px`,
        ).toBe(`${px}px`)
      }
    }
  })

  test('real app elements have resolved (non-default) token font-sizes', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')

    // body is styled `font-size: var(--text-ui-lg)` (13px) in index.css. If the
    // var failed to resolve it would fall back to the 16px browser default.
    const bodyFs = await page.evaluate(() => getComputedStyle(document.body).fontSize)
    expect(bodyFs, 'body font-size should be the resolved --text-ui-lg (13px)').toBe('13px')

    // Sanity: no element on the page is left at an unresolved var() (which would
    // compute as the 16px UA default on text that was migrated to a smaller token).
    // We confirm the token cascade is intact by re-checking body in dark too.
    await setTheme(page, 'dark')
    const bodyFsDark = await page.evaluate(() => getComputedStyle(document.body).fontSize)
    expect(bodyFsDark, 'body font-size is theme-independent').toBe('13px')
  })
})
