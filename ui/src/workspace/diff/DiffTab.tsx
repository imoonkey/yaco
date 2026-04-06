import { useState, useEffect } from 'react'
import { SOLARIZED_LIGHT, SOLARIZED_LIGHT_UI as C } from '../../lib/solarizedLight'
import type { ParsedFileDiff, DiffRow, DiffSegment } from '../../lib/parseDiff'
import type { DiffHunk } from '../../lib/parseDiff'

// --- View mode persistence ---

const VIEW_MODE_KEY = 'workflow-diff-viewmode'
type ViewMode = 'unified' | 'split'

function loadViewMode(): ViewMode {
  try {
    const v = localStorage.getItem(VIEW_MODE_KEY)
    return v === 'split' ? 'split' : 'unified'
  } catch { return 'unified' }
}

function saveViewMode(mode: ViewMode) {
  try { localStorage.setItem(VIEW_MODE_KEY, mode) } catch { /* noop */ }
}

// --- Colors ---

const COLORS = {
  addBg: 'rgba(133,153,0,0.08)',
  delBg: 'rgba(220,50,47,0.08)',
  addWord: 'rgba(133,153,0,0.25)',
  delWord: 'rgba(220,50,47,0.25)',
  hunkBg: 'rgba(38,139,210,0.08)',
  gapBorder: C.border,
} as const

// --- Segment renderer ---

function Segments({ segments, highlight }: { segments: DiffSegment[]; highlight: string }) {
  return (
    <>
      {segments.map((seg, i) => (
        <span
          key={i}
          style={seg.kind !== 'same' ? { backgroundColor: highlight } : undefined}
        >
          {seg.text}
        </span>
      ))}
    </>
  )
}

// --- Line number cell ---

function LineNum({ num, style }: { num: number | null; style?: React.CSSProperties }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 48,
        textAlign: 'right',
        paddingRight: 8,
        color: SOLARIZED_LIGHT.base1,
        userSelect: 'none',
        flexShrink: 0,
        ...style,
      }}
    >
      {num ?? ''}
    </span>
  )
}

// --- Unified row ---

function UnifiedRow({ row, isActive }: { row: DiffRow; isActive: boolean }) {
  let bg = ''
  let color = C.textDim

  if (row.kind === 'added') { bg = COLORS.addBg; color = SOLARIZED_LIGHT.green }
  else if (row.kind === 'deleted') { bg = COLORS.delBg; color = SOLARIZED_LIGHT.red }
  else if (row.kind === 'modified') { bg = COLORS.addBg }

  return (
    <>
      {row.kind === 'modified' ? (
        <>
          <div style={{ display: 'flex', backgroundColor: COLORS.delBg, color: SOLARIZED_LIGHT.red, minHeight: 20 }}>
            <LineNum num={row.oldLine} />
            <LineNum num={null} />
            <span style={{ flex: 1, paddingRight: 12 }}>
              <Segments segments={row.oldSegments} highlight={COLORS.delWord} />
            </span>
          </div>
          <div style={{ display: 'flex', backgroundColor: COLORS.addBg, color: SOLARIZED_LIGHT.green, minHeight: 20 }}>
            <LineNum num={null} />
            <LineNum num={row.newLine} />
            <span style={{ flex: 1, paddingRight: 12 }}>
              <Segments segments={row.newSegments} highlight={COLORS.addWord} />
            </span>
          </div>
        </>
      ) : (
        <div style={{ display: 'flex', backgroundColor: bg, color, minHeight: 20 }}>
          <LineNum num={row.kind === 'added' ? null : row.oldLine} />
          <LineNum num={row.kind === 'deleted' ? null : row.newLine} />
          <span style={{ flex: 1, paddingRight: 12 }}>
            {row.kind === 'context' || row.kind === 'added' || row.kind === 'deleted'
              ? row.text
              : null}
          </span>
        </div>
      )}
    </>
  )
}

// --- Split row ---

function SplitRow({ row }: { row: DiffRow }) {
  const placeholderBg = '#f0ece0' // subtle gray for empty side

  if (row.kind === 'context') {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: '48px 1fr 1px 48px 1fr', minHeight: 20 }}>
        <LineNum num={row.oldLine} />
        <span style={{ color: C.textDim, paddingRight: 8 }}>{row.text}</span>
        <div style={{ backgroundColor: C.border }} />
        <LineNum num={row.newLine} />
        <span style={{ color: C.textDim, paddingRight: 8 }}>{row.text}</span>
      </div>
    )
  }

  if (row.kind === 'deleted') {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: '48px 1fr 1px 48px 1fr', minHeight: 20 }}>
        <LineNum num={row.oldLine} style={{ backgroundColor: COLORS.delBg }} />
        <span style={{ backgroundColor: COLORS.delBg, color: SOLARIZED_LIGHT.red, paddingRight: 8 }}>{row.text}</span>
        <div style={{ backgroundColor: C.border }} />
        <LineNum num={null} style={{ backgroundColor: placeholderBg }} />
        <span style={{ backgroundColor: placeholderBg }} />
      </div>
    )
  }

  if (row.kind === 'added') {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: '48px 1fr 1px 48px 1fr', minHeight: 20 }}>
        <LineNum num={null} style={{ backgroundColor: placeholderBg }} />
        <span style={{ backgroundColor: placeholderBg }} />
        <div style={{ backgroundColor: C.border }} />
        <LineNum num={row.newLine} style={{ backgroundColor: COLORS.addBg }} />
        <span style={{ backgroundColor: COLORS.addBg, color: SOLARIZED_LIGHT.green, paddingRight: 8 }}>{row.text}</span>
      </div>
    )
  }

  // modified
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '48px 1fr 1px 48px 1fr', minHeight: 20 }}>
      <LineNum num={row.oldLine} style={{ backgroundColor: COLORS.delBg }} />
      <span style={{ backgroundColor: COLORS.delBg, color: SOLARIZED_LIGHT.red, paddingRight: 8 }}>
        <Segments segments={row.oldSegments} highlight={COLORS.delWord} />
      </span>
      <div style={{ backgroundColor: C.border }} />
      <LineNum num={row.newLine} style={{ backgroundColor: COLORS.addBg }} />
      <span style={{ backgroundColor: COLORS.addBg, color: SOLARIZED_LIGHT.green, paddingRight: 8 }}>
        <Segments segments={row.newSegments} highlight={COLORS.addWord} />
      </span>
    </div>
  )
}

// --- Hunk header ---

function HunkHeader({ hunk, isActive }: { hunk: DiffHunk; isActive: boolean }) {
  return (
    <div
      style={{
        backgroundColor: COLORS.hunkBg,
        color: SOLARIZED_LIGHT.blue,
        padding: '2px 12px',
        fontSize: 12,
        fontFamily: 'monospace',
        borderTop: isActive ? `2px solid ${SOLARIZED_LIGHT.blue}` : `1px solid ${C.border}`,
        borderBottom: `1px solid ${C.border}`,
      }}
    >
      {hunk.header}
    </div>
  )
}

// --- Inter-hunk gap ---

function InterHunkGap({ lineCount }: { lineCount: number }) {
  return (
    <div
      style={{
        textAlign: 'center',
        color: SOLARIZED_LIGHT.base1,
        fontSize: 11,
        padding: '4px 0',
        borderTop: `1px dashed ${COLORS.gapBorder}`,
        borderBottom: `1px dashed ${COLORS.gapBorder}`,
        userSelect: 'none',
      }}
    >
      {lineCount} unchanged lines omitted
    </div>
  )
}

// --- Toolbar ---

function DiffToolbar({
  parsed,
  viewMode,
  onViewMode,
  activeIndex,
  hunkCount,
  onPrev,
  onNext,
  isMobile,
}: {
  parsed: ParsedFileDiff
  viewMode: ViewMode
  onViewMode: (mode: ViewMode) => void
  activeIndex: number
  hunkCount: number
  onPrev: () => void
  onNext: () => void
  isMobile: boolean
}) {
  const btnStyle: React.CSSProperties = {
    padding: '0 6px',
    height: 22,
    fontSize: 11,
    border: `1px solid ${C.border}`,
    borderRadius: 3,
    cursor: 'pointer',
    backgroundColor: 'transparent',
    color: C.text,
  }

  const activeBtnStyle: React.CSSProperties = {
    ...btnStyle,
    backgroundColor: C.bg,
    fontWeight: 600,
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        height: 28,
        padding: '0 12px',
        backgroundColor: C.headerBg,
        borderBottom: `1px solid ${C.border}`,
        fontSize: 12,
        color: C.text,
        flexShrink: 0,
      }}
    >
      <span>
        <span style={{ color: SOLARIZED_LIGHT.green }}>+{parsed.stats.added}</span>
        {' '}
        <span style={{ color: SOLARIZED_LIGHT.red }}>-{parsed.stats.deleted}</span>
      </span>

      {!isMobile && (
        <span style={{ display: 'flex', gap: 2 }}>
          <button
            style={viewMode === 'unified' ? activeBtnStyle : btnStyle}
            onClick={() => onViewMode('unified')}
          >
            Unified
          </button>
          <button
            style={viewMode === 'split' ? activeBtnStyle : btnStyle}
            onClick={() => onViewMode('split')}
          >
            Split
          </button>
        </span>
      )}

      <span style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
        <button style={btnStyle} onClick={onPrev} disabled={hunkCount === 0}>&#8593;</button>
        <button style={btnStyle} onClick={onNext} disabled={hunkCount === 0}>&#8595;</button>
        {hunkCount > 0 && (
          <span style={{ fontSize: 11, color: C.textDim }}>
            Change {activeIndex + 1} of {hunkCount}
          </span>
        )}
      </span>
    </div>
  )
}

// --- Main DiffTab component ---

export function DiffTab({
  parsed,
  isMobile,
}: {
  parsed: ParsedFileDiff
  isMobile: boolean
}) {
  const [viewMode, setViewMode] = useState<ViewMode>(loadViewMode)
  const [activeHunkIndex, setActiveHunkIndex] = useState(0)

  // Mobile always uses unified
  const effectiveMode = isMobile ? 'unified' : viewMode

  const handleViewMode = (mode: ViewMode) => {
    setViewMode(mode)
    saveViewMode(mode)
  }

  // Reset active hunk when parsed data changes
  useEffect(() => { setActiveHunkIndex(0) }, [parsed])

  const hunkCount = parsed.hunks.length

  const navigatePrev = () => {
    setActiveHunkIndex(i => Math.max(0, i - 1))
  }

  const navigateNext = () => {
    setActiveHunkIndex(i => Math.min(hunkCount - 1, i + 1))
  }

  // Binary placeholder
  if (parsed.mode === 'binary') {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: C.muted }}>
        Binary file changed
      </div>
    )
  }

  // Empty diff
  if (hunkCount === 0) {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: C.muted }}>
        No changes
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <DiffToolbar
        parsed={parsed}
        viewMode={effectiveMode}
        onViewMode={handleViewMode}
        activeIndex={activeHunkIndex}
        hunkCount={hunkCount}
        onPrev={navigatePrev}
        onNext={navigateNext}
        isMobile={isMobile}
      />
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          fontFamily: 'monospace',
          fontSize: 12,
          lineHeight: '1.6',
          backgroundColor: C.editorBg,
        }}
      >
        {parsed.hunks.map((hunk, hunkIdx) => {
          const isActive = hunkIdx === activeHunkIndex

          // Compute inter-hunk gap
          let gapLines = 0
          if (hunkIdx > 0) {
            const prev = parsed.hunks[hunkIdx - 1]
            const prevEnd = prev.newStart + prev.newLines
            gapLines = hunk.newStart - prevEnd
          }

          return (
            <div key={hunk.id}>
              {gapLines > 0 && <InterHunkGap lineCount={gapLines} />}
              <HunkHeader hunk={hunk} isActive={isActive} />
              {hunk.rows.map(row => (
                effectiveMode === 'split'
                  ? <SplitRow key={row.key} row={row} />
                  : <UnifiedRow key={row.key} row={row} isActive={isActive} />
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
