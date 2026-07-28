// @vitest-environment jsdom
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DelimitedPreview } from '../DelimitedPreview'

// Reads the rendered body as [rowNumber, ...cells] per row, in display order.
function visibleRows(): string[][] {
  return screen.getAllByRole('row')
    .slice(1) // drop the header row
    .map(row => [
      within(row).getByRole('rowheader').textContent ?? '',
      ...within(row).getAllByRole('cell').map(cell => cell.textContent ?? ''),
    ])
}

// The virtualizer observes its scroll element; jsdom has no ResizeObserver.
vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
})

// It sizes the window from `offsetHeight`, which jsdom always reports as 0 —
// without a height there is no visible range and no row would render.
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 })

afterEach(() => {
  cleanup()
})

describe('DelimitedPreview', () => {
  it('renders the header row and data cells as a table', () => {
    render(<DelimitedPreview content={'name,age\nada,36\ngrace,45\n'} filePath="people.csv" />)

    const table = screen.getByRole('table')
    expect(within(table).getByRole('columnheader', { name: 'name' })).toBeTruthy()
    expect(within(table).getByRole('columnheader', { name: 'age' })).toBeTruthy()
    expect(within(table).getByRole('cell', { name: 'ada' })).toBeTruthy()
    expect(within(table).getByRole('cell', { name: '45' })).toBeTruthy()
  })

  it('numbers the rows in a gutter that is not a data cell', () => {
    render(<DelimitedPreview content={'a\nx\ny\n'} filePath="one.csv" />)

    expect(screen.getByRole('rowheader', { name: '1' })).toBeTruthy()
    expect(screen.getByRole('rowheader', { name: '2' })).toBeTruthy()
    expect(screen.queryByRole('cell', { name: '1' })).toBeNull()
  })

  it('reports the shape of the file', () => {
    render(<DelimitedPreview content={'a,b,c\n1,2,3\n4,5,6\n'} filePath="shape.csv" />)

    expect(screen.getByText('2 rows × 3 columns')).toBeTruthy()
  })

  it('sorts a column ascending, then descending, on header clicks', () => {
    render(<DelimitedPreview content={'city,pop\nb,99\na,100\nc,9\n'} filePath="s.csv" />)

    const header = screen.getByRole('button', { name: /^pop/ })
    expect(visibleRows().map(r => r[2])).toEqual(['99', '100', '9'])

    // Numbers arrive as strings; a plain string sort would put "100" before "9".
    fireEvent.click(header)
    expect(visibleRows().map(r => r[2])).toEqual(['9', '99', '100'])

    fireEvent.click(header)
    expect(visibleRows().map(r => r[2])).toEqual(['100', '99', '9'])
  })

  it('adds a second sort level on shift-click and replaces it on a plain click', () => {
    render(<DelimitedPreview content={'team,score\nb,2\na,1\nb,1\na,2\n'} filePath="m.csv" />)

    fireEvent.click(screen.getByRole('button', { name: /^team/ }))
    fireEvent.click(screen.getByRole('button', { name: /^score/ }), { shiftKey: true })

    // team asc, then score asc within each team.
    expect(visibleRows().map(r => `${r[1]}${r[2]}`)).toEqual(['a1', 'a2', 'b1', 'b2'])
    expect(screen.getByRole('columnheader', { name: /^team/ }).getAttribute('aria-sort')).toBe('ascending')
    expect(screen.getByRole('columnheader', { name: /^score/ }).getAttribute('aria-sort')).toBe('ascending')

    // A plain click drops the other level instead of adding to it.
    fireEvent.click(screen.getByRole('button', { name: /^score/ }))
    expect(screen.getByRole('columnheader', { name: /^team/ }).getAttribute('aria-sort')).toBe('none')
  })

  it('keeps the gutter pointing at the source row when sorted', () => {
    render(<DelimitedPreview content={'city,pop\nb,99\na,100\nc,9\n'} filePath="s.csv" />)

    fireEvent.click(screen.getByRole('button', { name: /^city/ }))

    // Sorted a,b,c — the numbers still name each row's position in the file.
    expect(visibleRows()).toEqual([
      ['2', 'a', '100'],
      ['1', 'b', '99'],
      ['3', 'c', '9'],
    ])
  })

  it('reports the sort direction to assistive tech', () => {
    render(<DelimitedPreview content={'city,pop\nb,99\na,100\n'} filePath="s.csv" />)

    const column = screen.getByRole('columnheader', { name: /^city/ })
    expect(column.getAttribute('aria-sort')).toBe('none')

    fireEvent.click(screen.getByRole('button', { name: /^city/ }))
    expect(column.getAttribute('aria-sort')).toBe('ascending')

    fireEvent.click(screen.getByRole('button', { name: /^city/ }))
    expect(column.getAttribute('aria-sort')).toBe('descending')
  })

  it('opts back into text selection, which the panel tree disables app-wide', () => {
    const { container } = render(<DelimitedPreview content={'a,b\n1,2\n'} filePath="sel.csv" />)

    expect((container.firstChild as HTMLElement).style.userSelect).toBe('text')
  })

  it('bands alternating rows so the eye can track across columns', () => {
    render(<DelimitedPreview content={'a\n1\n2\n3\n4\n'} filePath="z.csv" />)

    const backgrounds = screen.getAllByRole('row').slice(1).map(row => row.style.backgroundColor)
    expect(backgrounds[0]).not.toBe(backgrounds[1])
    expect(backgrounds[0]).toBe(backgrounds[2])
    expect(backgrounds[1]).toBe(backgrounds[3])
  })

  // Freezing the gutter puts a sticky element and a stacking context on every
  // rendered row; measured at 4x CPU throttle that cost ~6ms of p95 scroll frame
  // time and doubled the dropped frames. It scrolls with the data instead.
  it('keeps the row gutter out of the compositor-hostile sticky path', () => {
    render(<DelimitedPreview content={'a\n1\n2\n'} filePath="z.csv" />)

    for (const row of screen.getAllByRole('row').slice(1)) {
      const gutter = within(row).getByRole('rowheader')
      expect(gutter.style.position).toBe('')
      expect(gutter.style.zIndex).toBe('')
    }
  })

  it('toggles between clipping and wrapping long values', () => {
    const long = 'a value far too long to fit inside its column'
    render(<DelimitedPreview content={`note\n${long}\n`} filePath="w.csv" />)

    const toggle = screen.getByRole('button', { name: 'Wrap' })
    const cell = screen.getByRole('cell')

    // Clipped: the text is cut off, so the full value is offered as a tooltip.
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(cell.className).toContain('whitespace-nowrap')
    expect(cell.getAttribute('title')).toBe(long)

    fireEvent.click(toggle)

    // Wrapped: all of it is on screen, so a tooltip would only cover it up.
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(cell.className).toContain('whitespace-pre-wrap')
    expect(cell.getAttribute('title')).toBeNull()
  })

  it('shows a placeholder instead of an empty grid', () => {
    render(<DelimitedPreview content="" filePath="empty.csv" />)

    expect(screen.getByText('No rows to preview')).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })
})
