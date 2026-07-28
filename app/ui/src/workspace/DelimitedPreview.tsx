// Spreadsheet-style preview for CSV/TSV files. Rows are windowed with
// @tanstack/react-virtual so a 1 MB file (tens of thousands of rows) scrolls at
// the same cost as a small one; sorting comes from @tanstack/react-table, which
// is headless — the markup and Solarized styling below stay ours.
//
// The table elements carry `display: grid` — the layout the virtualizer needs,
// since absolutely-positioned rows can't take part in native table layout. That
// drops the implicit table semantics, so every element restates its ARIA role.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer, type Range } from '@tanstack/react-virtual'
import {
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ChevronsUpDown, WrapText } from 'lucide-react'
import { parseDelimited } from './delimitedTable'

const ROW_HEIGHT = 30
const OVERSCAN = 6
const MIN_COL_PX = 40
const BLOCK = 8

// Snap the rendered window to blocks of rows. The virtualizer's own range moves
// every time the viewport crosses a row, so the DOM mutated on every scroll
// frame, forcing main-thread scrolling. Quantised, the rendered set is identical
// for BLOCK rows at a time and those frames composite with no style/layout/paint.
//
// OVERSCAN still has to be non-zero: snapping alone leaves NO rows past the
// viewport edge when it lands on a block boundary, so a fast scroll outruns the
// render and flashes a blank strip. The overscan is the floor on that lookahead.
function blockRange(range: Range): number[] {
  const first = Math.max(0, Math.floor((range.startIndex - range.overscan) / BLOCK) * BLOCK)
  const last = Math.min(range.count - 1, Math.ceil((range.endIndex + range.overscan) / BLOCK) * BLOCK)
  const indexes: number[] = []
  for (let i = first; i <= last; i++) indexes.push(i)
  return indexes
}

// Banding is mixed INTO the editor background rather than washed over it with the
// translucent `--sol-subtle-bg`, so the two row colours are opaque and predictable.
const ROW_BG = 'var(--sol-editor-bg)'
const ROW_BG_BANDED = 'color-mix(in srgb, var(--sol-muted) 9%, var(--sol-editor-bg))'

const SORT_ICON = { asc: ArrowUp, desc: ArrowDown } as const

// Scroll cost lives here. The virtualizer re-renders the whole window on every
// scroll frame, and React Compiler skips this component (both TanStack hooks
// return unmemoizable functions), so without an explicit memo every rendered row
// and cell is reconciled ~60 times a second. Every prop below is stable for a
// given row — `start` and `banded` derive from an index that does not move — so
// scrolling reconciles only the rows genuinely entering the window.
const DelimitedRow = memo(function DelimitedRow({
  values, sourceRow, start, height, gridTemplateColumns, banded, wrap, rowBorder, measureRef, index,
}: {
  values: string[]
  sourceRow: number
  start: number
  height: number | undefined
  gridTemplateColumns: string
  banded: boolean
  wrap: boolean
  rowBorder: string
  measureRef: ((el: HTMLElement | null) => void) | undefined
  index: number
}) {
  const background = banded ? ROW_BG_BANDED : ROW_BG
  const cellClass = wrap
    ? 'block px-2 py-1.5 whitespace-pre-wrap [overflow-wrap:anywhere]'
    : 'block px-2 overflow-hidden text-ellipsis whitespace-nowrap'
  const cellStyle = wrap ? { lineHeight: 'var(--lh-normal)' } : { lineHeight: `${ROW_HEIGHT}px` }

  return (
    <tr
      role="row"
      // Wrapped rows have no knowable height until laid out, so the virtualizer
      // measures each live row instead of assuming one.
      ref={measureRef}
      data-index={index}
      className="grid absolute w-full"
      style={{
        gridTemplateColumns,
        height,
        minHeight: ROW_HEIGHT,
        transform: `translateY(${start}px)`,
        borderBottom: rowBorder,
        backgroundColor: background,
        contain: 'layout style paint',
      }}
    >
      {/* The row's position in the FILE, so a sorted view still points back at the
          source. Deliberately NOT sticky: freezing it means a sticky element and a
          stacking context on every rendered row, which measured as double the p95
          scroll frame time (see editor-and-preview.md). It scrolls with the data. */}
      <th
        scope="row"
        role="rowheader"
        className={`${cellClass} text-ui-md font-mono font-normal text-right`}
        style={{ ...cellStyle, borderRight: rowBorder, color: 'var(--sol-text-disabled)' }}
      >
        {sourceRow}
      </th>
      {values.map((value, col) => (
        <td key={col} role="cell" title={wrap ? undefined : value} className={cellClass} style={cellStyle}>
          {value}
        </td>
      ))}
    </tr>
  )
})

// Memoised for the same reason as the row: the header re-rendered on every scroll
// frame, and each column carries a button plus a lucide SVG. It takes the sorting
// STATE rather than the table instance, whose handlers are new objects each render.
const DelimitedHeader = memo(function DelimitedHeader({
  labels, sorting, gridTemplateColumns, rowBorder, onSort, onResize, onResetWidth,
}: {
  labels: string[]
  sorting: SortingState
  gridTemplateColumns: string
  rowBorder: string
  onSort: (col: number, additive: boolean) => void
  onResize: (col: number, event: React.PointerEvent<HTMLElement>) => void
  onResetWidth: (col: number) => void
}) {
  return (
    <thead role="rowgroup" className="grid sticky top-0" style={{ zIndex: 2 }}>
      <tr role="row" className="grid" style={{ gridTemplateColumns, height: ROW_HEIGHT, backgroundColor: 'var(--sol-code-bg)', borderBottom: rowBorder }}>
        <th scope="col" className="block" style={{ borderRight: rowBorder }} />
        {labels.map((label, col) => {
          const sort = sorting.find(entry => entry.id === String(col))
          const direction = sort ? (sort.desc ? 'desc' : 'asc') : null
          const Icon = direction ? SORT_ICON[direction] : ChevronsUpDown
          return (
            <th
              key={col}
              scope="col"
              role="columnheader"
              aria-sort={direction ? `${direction}ending` : 'none'}
              className="relative block overflow-hidden"
              style={{ lineHeight: `${ROW_HEIGHT}px` }}
            >
              <button
                type="button"
                onClick={event => onSort(col, event.shiftKey)}
                title={`${label} — click to sort, shift-click to add a level`}
                className="flex items-center gap-1 w-full px-2 text-left cursor-pointer font-semibold transition-colors hover:bg-[var(--sol-subtle-bg)]"
                style={{ lineHeight: `${ROW_HEIGHT}px`, color: 'inherit' }}
              >
                <span className="overflow-hidden text-ellipsis whitespace-nowrap">{label}</span>
                <Icon
                  size={12}
                  className="shrink-0"
                  style={{ opacity: direction ? 1 : 0.35, color: direction ? 'var(--sol-blue)' : 'inherit' }}
                  aria-hidden
                />
              </button>
              {/* Drag to resize, double-click to hand the column back to auto-width. */}
              <span
                aria-hidden
                data-resize-col={col}
                title="Drag to resize, double-click to reset"
                onPointerDown={event => onResize(col, event)}
                onDoubleClick={() => onResetWidth(col)}
                className="absolute top-0 right-0 h-full w-[6px] cursor-col-resize hover:bg-[var(--sol-blue)]/40"
              />
            </th>
          )
        })}
      </tr>
    </thead>
  )
})

export function DelimitedPreview({ content, filePath }: { content: string; filePath: string }) {
  const parsed = useMemo(() => parseDelimited(content, filePath), [content, filePath])
  const scrollRef = useRef<HTMLDivElement>(null)
  const [sorting, setSorting] = useState<SortingState>([])
  const [wrap, setWrap] = useState(false)
  // Per-column px overrides from the drag handles; absent columns keep their
  // content-derived `ch` width.
  const [columnPx, setColumnPx] = useState<Record<number, number>>({})
  const [resizing, setResizing] = useState(false)

  useEffect(() => { setColumnPx({}) }, [filePath])

  // Every value is a string, so `alphanumeric` does the work a plain string sort
  // gets wrong: it compares embedded numbers numerically ("100" after "99").
  const columns = useMemo<ColumnDef<string[]>[]>(
    () => parsed.headers.map((header, col) => ({
      id: String(col),
      header,
      accessorFn: (row: string[]) => row[col],
      sortingFn: 'alphanumeric',
    })),
    [parsed.headers],
  )

  const table = useReactTable({
    data: parsed.rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  const rows = table.getRowModel().rows

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
    rangeExtractor: blockRange,
  })

  // A new order under the old scroll offset would strand the reader mid-file.
  const { scrollToOffset, measure } = virtualizer
  useEffect(() => { scrollToOffset(0) }, [sorting, scrollToOffset])
  // Wrapping changes every row's height, so the cached measurements are void.
  // Re-measurement of the live rows is automatic (see `measureElement` below).
  useEffect(() => { measure() }, [wrap, measure])

  const startResize = useCallback((col: number, event: React.PointerEvent<HTMLElement>) => {
    // Suppresses the text selection a drag would otherwise paint across cells.
    event.preventDefault()
    const handle = event.currentTarget
    const startX = event.clientX
    const startWidth = (handle.parentElement as HTMLElement).offsetWidth
    handle.setPointerCapture(event.pointerId)
    setResizing(true)

    const onMove = (move: PointerEvent) => {
      setColumnPx(prev => ({ ...prev, [col]: Math.max(MIN_COL_PX, startWidth + move.clientX - startX) }))
    }
    const onUp = () => {
      setResizing(false)
      handle.releasePointerCapture(event.pointerId)
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
  }, [])

  const resetWidth = useCallback((col: number) => {
    setColumnPx(({ [col]: _dropped, ...rest }) => rest)
  }, [])

  // react-table's own toggle handler is a new function every render, which would
  // defeat the header memo. The cycle it implements is asc -> desc -> unsorted,
  // shift-click adding a level; the library still owns the sort itself.
  const toggleSort = useCallback((col: number, additive: boolean) => {
    const id = String(col)
    setSorting(prev => {
      const current = prev.find(entry => entry.id === id)
      const next = !current ? { id, desc: false } : current.desc ? null : { id, desc: true }
      if (!additive) return next ? [next] : []
      const others = prev.filter(entry => entry.id !== id)
      return next ? [...others, next] : others
    })
  }, [])

  // The gutter holds the largest row number, so its width follows the digit count.
  const gridTemplateColumns = useMemo(() => {
    const cols = parsed.widths.map((ch, col) => columnPx[col] ? `${columnPx[col]}px` : `${ch}ch`)
    return `${String(parsed.rows.length).length + 3}ch ${cols.join(' ')}`
  }, [parsed.rows.length, parsed.widths, columnPx])

  if (parsed.headers.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-ui-md" style={{ color: 'var(--sol-text)' }}>
        No rows to preview
      </div>
    )
  }

  const rowBorder = '1px solid var(--sol-border)'

  return (
    // The panel tree sets `select-none` app-wide so its pane drags don't paint a
    // selection (DesktopPanelTreeLayout); a data surface has to opt back in, the
    // same way TerminalPanel does. Suspended mid-drag so resizing stays clean.
    <div
      className="flex flex-col h-full text-ui-xl"
      style={{
        backgroundColor: 'var(--sol-editor-bg)',
        color: 'var(--sol-text)',
        userSelect: resizing ? 'none' : 'text',
        WebkitUserSelect: resizing ? 'none' : 'text',
      }}
    >
      {/* The base font size sits on the scroller so the `ch` column widths
          resolve against the same font the cells render in. */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto">
        <table role="table" className="grid" style={{ width: 'max-content', minWidth: '100%' }}>

          <DelimitedHeader
            labels={parsed.headers}
            sorting={sorting}
            gridTemplateColumns={gridTemplateColumns}
            rowBorder={rowBorder}
            onSort={toggleSort}
            onResize={startResize}
            onResetWidth={resetWidth}
          />
          <tbody role="rowgroup" className="grid relative" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map(item => {
              const row = rows[item.index]
              return (
                <DelimitedRow
                  key={row.id}
                  index={item.index}
                  values={row.original}
                  sourceRow={row.index + 1}
                  start={item.start}
                  height={wrap ? undefined : item.size}
                  gridTemplateColumns={gridTemplateColumns}
                  // Banded by display position, so the stripes stay aligned after a sort.
                  banded={item.index % 2 === 1}
                  wrap={wrap}
                  rowBorder={rowBorder}
                  measureRef={wrap ? virtualizer.measureElement : undefined}
                />
              )
            })}
          </tbody>
        </table>
      </div>

      <div
        className="shrink-0 flex items-center gap-3 px-3 py-1 text-ui-md"
        style={{ borderTop: rowBorder, color: 'var(--sol-text-dim)', backgroundColor: 'var(--sol-code-bg)' }}
      >
        <span>{parsed.rows.length.toLocaleString()} rows &times; {parsed.headers.length} columns</span>
        {/* Reads as a control, not as status text — at the muted status-bar color
            it was there but invisible. */}
        <button
          type="button"
          onClick={() => setWrap(value => !value)}
          aria-pressed={wrap}
          title={wrap ? 'Wrapping long values — click to clip them instead' : 'Clipping long values — click to wrap them instead'}
          className="ml-auto flex items-center gap-1 px-2 rounded border cursor-pointer transition-colors hover:bg-[var(--sol-subtle-bg)]"
          style={{
            color: wrap ? 'var(--sol-base3)' : 'var(--sol-text)',
            backgroundColor: wrap ? 'var(--sol-blue)' : undefined,
            borderColor: wrap ? 'var(--sol-blue)' : 'var(--sol-border)',
          }}
        >
          <WrapText size={12} aria-hidden />
          Wrap
        </button>
      </div>
    </div>
  )
}
