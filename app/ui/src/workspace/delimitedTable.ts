// CSV/TSV → table model for the preview pane. Parsing is Papa Parse's job
// (quoted fields, embedded newlines/delimiters, CRLF, BOM); this module only
// squares the result into a rectangle and sizes the columns.
import Papa from 'papaparse'

// Enough rows to make the widths look right without scanning a 1 MB file.
const WIDTH_SAMPLE_ROWS = 200
const MIN_COL_CH = 6
const MAX_COL_CH = 48
// Breathing room around the longest sampled value, in `ch`.
const COL_PADDING_CH = 3

export interface DelimitedTable {
  headers: string[]
  rows: string[][]
  // Per-column width in `ch`, derived from the sampled content.
  widths: number[]
}

// `.tsv` is tab by definition. `.csv` gets Papa's delimiter sniffing, so the
// semicolon-separated files some locales export read correctly too.
function delimiterFor(path: string): string {
  return path.toLowerCase().endsWith('.tsv') ? '\t' : ''
}

function columnWidths(headers: string[], rows: string[][]): number[] {
  const sample = rows.slice(0, WIDTH_SAMPLE_ROWS)
  return headers.map((header, col) => {
    const longest = sample.reduce((max, row) => Math.max(max, row[col].length), header.length)
    return Math.min(MAX_COL_CH, Math.max(MIN_COL_CH, longest + COL_PADDING_CH))
  })
}

// Papa's `errors` are per-row notes (a ragged row, an unsniffable delimiter on a
// single-column file) that it recovers from, so they are not surfaced: whatever
// parsed is previewed, and a file that yields no columns renders as empty.
export function parseDelimited(text: string, path: string): DelimitedTable {
  const { data } = Papa.parse<string[]>(text, {
    delimiter: delimiterFor(path),
    skipEmptyLines: 'greedy',
  })

  // Ragged rows are normal in the wild — the widest row defines the grid and
  // every shorter row is padded, so cells never shift between columns.
  const columnCount = data.reduce((max, row) => Math.max(max, row.length), 0)
  if (columnCount === 0) {
    return { headers: [], rows: [], widths: [] }
  }

  const [head = [], ...body] = data
  const square = (row: string[]) => Array.from({ length: columnCount }, (_, i) => row[i] ?? '')
  const headers = square(head)
  const rows = body.map(square)

  return { headers, rows, widths: columnWidths(headers, rows) }
}
