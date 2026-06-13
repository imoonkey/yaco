// InsertionMarker — the thin vertical insertion line shown in a tab strip during a
// pane drag to mark where the dragged tab will land. Purely presentational: a full-
// height accent bar laid out inline between tabs, so the strip's flexbox positions it
// (no measuring at render time). Reusable anywhere an insertion point is shown.
import type { CSSProperties } from 'react'

const MARKER_STYLE: CSSProperties = {
  width: 2,
  alignSelf: 'stretch',
  flexShrink: 0,
  backgroundColor: 'var(--sol-accent)',
  pointerEvents: 'none',
}

export function InsertionMarker({ style }: { style?: CSSProperties }) {
  return <div data-testid="insertion-marker" aria-hidden="true" style={{ ...MARKER_STYLE, ...style }} />
}
