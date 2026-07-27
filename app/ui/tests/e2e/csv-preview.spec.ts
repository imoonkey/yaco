import { test, expect } from '@playwright/test'
import {
  provisionWorkspace,
  createTestFile,
  openFileViaSearch,
  uniqueFileName,
} from './helpers/workspace'

test.describe('CSV/TSV preview', () => {
  test('the Preview toggle renders a CSV as a scrollable table', async ({ page, request }) => {
    const project = await provisionWorkspace(page, request)
    const fileName = uniqueFileName('sales_preview.csv')
    // A quoted field carrying the delimiter proves the parse is not a naive split.
    const rows = Array.from({ length: 500 }, (_, i) => `row-${i + 1},"Doe, Jane ${i + 1}",${i + 1}`)
    const content = `id,customer,amount\n${rows.join('\n')}\n`

    try {
      await createTestFile(page, project.name, fileName, content)
      await openFileViaSearch(page, fileName)
      await page.getByRole('button', { name: 'Preview', exact: true }).click()

      const table = page.getByRole('table')
      await expect(table).toBeVisible()
      await expect(table.getByRole('columnheader', { name: 'customer' })).toBeVisible()
      await expect(table.getByRole('cell', { name: 'Doe, Jane 1', exact: true })).toBeVisible()

      // Windowed: 500 rows are in the file, only a screenful is in the DOM.
      await expect(page.getByText('500 rows × 3 columns')).toBeVisible()
      const rendered = await table.getByRole('row').count()
      expect(rendered).toBeLessThan(200)

      // The last row is absent until the user scrolls to it, then renders.
      // Overscrolling clamps at the bottom, so this holds at any row height.
      await expect(table.getByRole('cell', { name: 'row-500', exact: true })).toHaveCount(0)
      const scroller = table.locator('xpath=..')
      const box = await scroller.boundingBox()
      expect(box).not.toBeNull()
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
      await page.mouse.wheel(0, 100_000)
      await expect(table.getByRole('cell', { name: 'row-500', exact: true })).toBeVisible()
    } finally {
      await project.dispose()
    }
  })

  test('clicking a column header sorts the whole file, not just the rendered window', async ({ page, request }) => {
    const project = await provisionWorkspace(page, request)
    const fileName = uniqueFileName('sortable_preview.csv')
    // Descending amounts, so the file order is never the sorted order. The values
    // straddle a digit-count boundary: a string sort would rank 99 above 300.
    const rows = Array.from({ length: 300 }, (_, i) => `item-${i + 1},${300 - i}`)
    const content = `name,amount\n${rows.join('\n')}\n`

    try {
      await createTestFile(page, project.name, fileName, content)
      await openFileViaSearch(page, fileName)
      await page.getByRole('button', { name: 'Preview', exact: true }).click()

      const table = page.getByRole('table')
      const firstRow = table.getByRole('row').nth(1)
      await expect(firstRow.getByRole('cell').first()).toHaveText('item-1')

      // Ascending: the smallest amount lives on the LAST line of the file, so a
      // window-only sort could not surface it.
      await page.getByRole('button', { name: /^amount/ }).click()
      await expect(firstRow.getByRole('cell').first()).toHaveText('item-300')
      await expect(firstRow.getByRole('cell').nth(1)).toHaveText('1')
      await expect(firstRow.getByRole('rowheader')).toHaveText('300')
      await expect(table.getByRole('columnheader', { name: /^amount/ })).toHaveAttribute('aria-sort', 'ascending')

      await page.getByRole('button', { name: /^amount/ }).click()
      await expect(firstRow.getByRole('cell').nth(1)).toHaveText('300')
      await expect(table.getByRole('columnheader', { name: /^amount/ })).toHaveAttribute('aria-sort', 'descending')
    } finally {
      await project.dispose()
    }
  })

  test('cell text can be selected for copying', async ({ page, request }) => {
    const project = await provisionWorkspace(page, request)
    const fileName = uniqueFileName('selectable_preview.csv')

    try {
      await createTestFile(page, project.name, fileName, 'name,note\nalpha,SELECTABLE_VALUE\n')
      await openFileViaSearch(page, fileName)
      await page.getByRole('button', { name: 'Preview', exact: true }).click()

      const cell = page.getByRole('cell', { name: 'SELECTABLE_VALUE' })
      await cell.waitFor()
      const box = (await cell.boundingBox())!

      // Drag across the cell text the way a user would before hitting copy.
      await page.mouse.move(box.x + 3, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2, { steps: 10 })
      await page.mouse.up()

      const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '')
      expect(selected).toContain('SELECTABLE_VALUE')
    } finally {
      await project.dispose()
    }
  })

  test('a column header handle drags the column wider and resets on double-click', async ({ page, request }) => {
    const project = await provisionWorkspace(page, request)
    const fileName = uniqueFileName('resizable_preview.csv')

    try {
      await createTestFile(page, project.name, fileName, 'name,note\nalpha,some value\nbeta,another value\n')
      await openFileViaSearch(page, fileName)
      await page.getByRole('button', { name: 'Preview', exact: true }).click()

      const column = page.getByRole('columnheader', { name: /^name/ })
      const handle = page.locator('[data-resize-col="0"]')
      const before = (await column.boundingBox())!.width

      const grip = (await handle.boundingBox())!
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
      await page.mouse.down()
      await page.mouse.move(grip.x + grip.width / 2 + 120, grip.y + grip.height / 2, { steps: 10 })
      await page.mouse.up()

      const widened = (await column.boundingBox())!.width
      expect(widened).toBeGreaterThan(before + 100)

      // The body cells track the header, or the grid would shear.
      const cell = page.getByRole('cell', { name: 'alpha' })
      expect(Math.abs((await cell.boundingBox())!.width - widened)).toBeLessThan(2)

      await handle.dblclick()
      expect(Math.abs((await column.boundingBox())!.width - before)).toBeLessThan(2)
    } finally {
      await project.dispose()
    }
  })

  test('the Wrap toggle reveals a clipped value in full and grows the row', async ({ page, request }) => {
    const project = await provisionWorkspace(page, request)
    const fileName = uniqueFileName('wrap_preview.csv')
    const long = 'This is a deliberately long free-text note that cannot possibly fit within the column width the preview picks for it.'

    try {
      await createTestFile(page, project.name, fileName, `id,note\n1,"${long}"\n2,"${long}"\n`)
      await openFileViaSearch(page, fileName)
      await page.getByRole('button', { name: 'Preview', exact: true }).click()

      const cell = page.getByRole('cell', { name: long }).first()
      const clippedHeight = (await cell.boundingBox())!.height
      // Clipped: the text overflows its box, so the box is shorter than the text.
      expect(await cell.evaluate((el: HTMLElement) => el.scrollWidth > el.clientWidth)).toBe(true)

      await page.getByRole('button', { name: 'Wrap', exact: true }).click()

      // Wrapped: nothing overflows any more and the row got taller to fit.
      await expect.poll(async () => (await cell.boundingBox())!.height).toBeGreaterThan(clippedHeight)
      expect(await cell.evaluate((el: HTMLElement) => el.scrollWidth > el.clientWidth)).toBe(false)

      // The virtualizer re-measured, so the second row sits below the first.
      const [first, second] = await page.getByRole('row').nth(1).boundingBox()
        .then(async a => [a!, (await page.getByRole('row').nth(2).boundingBox())!])
      expect(second.y).toBeGreaterThanOrEqual(first.y + first.height - 2)
    } finally {
      await project.dispose()
    }
  })

  test('a .tsv splits on tabs, not on the commas inside its values', async ({ page, request }) => {
    const project = await provisionWorkspace(page, request)
    const fileName = uniqueFileName('metrics_preview.tsv')
    const content = 'metric\tvalue\nrevenue\t1,234,567\ncost\t89,012\n'

    try {
      await createTestFile(page, project.name, fileName, content)
      await openFileViaSearch(page, fileName)
      await page.getByRole('button', { name: 'Preview', exact: true }).click()

      const table = page.getByRole('table')
      await expect(table.getByRole('columnheader', { name: 'metric' })).toBeVisible()
      await expect(table.getByRole('cell', { name: '1,234,567', exact: true })).toBeVisible()
      await expect(page.getByText('2 rows × 2 columns')).toBeVisible()
    } finally {
      await project.dispose()
    }
  })
})
