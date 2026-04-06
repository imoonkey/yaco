import { useState, useEffect, useRef, useCallback } from 'react'
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

// --- Context collapse ---

const CONTEXT_VISIBLE = 3 // show first/last N context lines before collapsing

function collapseContextRows(rows: DiffRow[]): Array<DiffRow | { kind: 'collapsed'; key: string; count: number; startIndex: number }> {
  // Find leading and trailing context runs within the hunk
  const result: Array<DiffRow | { kind: 'collapsed'; key: string; count: number; startIndex: number }> = []

  // Identify contiguous context runs
  let i = 0
  while (i < rows.length) {
    if (rows[i].kind !== 'context') {
      result.push(rows[i])
      i++
      continue
    }

    // Collect contiguous context run
    const runStart = i
    while (i < rows.length && rows[i].kind === 'context') i++
    const runLength = i - runStart

    if (runLength <= CONTEXT_VISIBLE * 2 + 1) {
      // Short run — show all
      for (let j = runStart; j < i; j++) result.push(rows[j])
    } else {
      // Long run — show first N, collapse middle, show last N
      for (let j = runStart; j < runStart + CONTEXT_VISIBLE; j++) result.push(rows[j])
      const collapsedCount = runLength - CONTEXT_VISIBLE * 2
      result.push({ kind: 'collapsed', key: `collapse-${runStart}`, count: collapsedCount, startIndex: runStart + CONTEXT_VISIBLE })
      for (let j = i - CONTEXT_VISIBLE; j < i; j++) result.push(rows[j])
    }
  }

  return result
}

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

function UnifiedRow({ row }: { row: DiffRow }) {
  let bg = ''
  let color = C.textDim

  if (row.kind === 'added') { bg = COLORS.addBg; color = SOLARIZED_LIGHT.green }
  else if (row.kind === 'deleted') { bg = COLORS.delBg; color = SOLARIZED_LIGHT.red }

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
  const placeholderBg = '#f0ece0'

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

// --- Collapsed context row ---

function CollapsedContextRow({ count, onExpand }: { count: number; onExpand: () => void }) {
  return (
    <div
      style={{
        textAlign: 'center',
        color: SOLARIZED_LIGHT.base1,
        fontSize: 11,
        padding: '2px 0',
        cursor: 'pointer',
        userSelect: 'none',
      }}
      onClick={onExpand}
      onMouseEnter={e => (e.currentTarget.style.backgroundColor = COLORS.hunkBg)}
      onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
    >
      {count} unchanged lines
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
  const [expandedContexts, setExpandedContexts] = useState<Set<string>>(new Set())
  const scrollRef = useRef<HTMLDivElement>(null)
  const hunkRefs = useRef<Map<number, HTMLDivElement>>(new Map())

  // Mobile always uses unified
  const effectiveMode = isMobile ? 'unified' : viewMode

  const handleViewMode = (mode: ViewMode) => {
    setViewMode(mode)
    saveViewMode(mode)
  }

  // Reset state when parsed data changes
  useEffect(() => {
    setActiveHunkIndex(0)
    setExpandedContexts(new Set())
  }, [parsed])

  const hunkCount = parsed.hunks.length

  const scrollToHunk = useCallback((index: number) => {
    const el = hunkRefs.current.get(index)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  const navigatePrev = useCallback(() => {
    setActiveHunkIndex(i => {
      const next = Math.max(0, i - 1)
      scrollToHunk(next)
      return next
    })
  }, [scrollToHunk])

  const navigateNext = useCallback(() => {
    setActiveHunkIndex(i => {
      const next = Math.min(hunkCount - 1, i + 1)
      scrollToHunk(next)
      return next
    })
  }, [hunkCount, scrollToHunk])

  // j/k keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Only handle when diff tab has focus (no input/textarea focused)
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      if (e.key === 'j') {
        e.preventDefault()
        navigateNext()
      } else if (e.key === 'k') {
        e.preventDefault()
        navigatePrev()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [navigateNext, navigatePrev])

  const handleExpandContext = useCallback((key: string) => {
    setExpandedContexts(prev => {
      const next = new Set(prev)
      next.add(key)
      return next
    })
  }, [])

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
        ref={scrollRef}
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

          // Collapse long context runs within hunk
          const displayRows = collapseContextRows(hunk.rows)

          return (
            <div
              key={hunk.id}
              ref={el => { if (el) hunkRefs.current.set(hunkIdx, el) }}
            >
              {gapLines > 0 && <InterHunkGap lineCount={gapLines} />}
              <HunkHeader hunk={hunk} isActive={isActive} />
              {displayRows.map(item => {
                if ('count' in item && item.kind === 'collapsed') {
                  if (expandedContexts.has(item.key)) {
                    // Render the hidden rows
                    return hunk.rows
                      .slice(item.startIndex, item.startIndex + item.count)
                      .map(row => (
                        effectiveMode === 'split'
                          ? <SplitRow key={row.key} row={row} />
                          : <UnifiedRow key={row.key} row={row} />
                      ))
                  }
                  return (
                    <CollapsedContextRow
                      key={item.key}
                      count={item.count}
                      onExpand={() => handleExpandContext(item.key)}
                    />
                  )
                }
                const row = item as DiffRow
                return effectiveMode === 'split'
                  ? <SplitRow key={row.key} row={row} />
                  : <UnifiedRow key={row.key} row={row} />
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}
