import { useState, useEffect, useRef, useCallback } from 'react'
import { GitCompare, ChevronLeft, ChevronRight, ChevronsUpDown, GitBranch } from 'lucide-react'

import type { ParsedFileDiff, DiffRow, DiffSegment } from '../../lib/parseDiff'
import type { DiffHunk } from '../../lib/parseDiff'
import type { GitChange } from '../../types'
import { FileTypeIcon } from '../../components/fileExplorerIcons'
import { GIT_COLORS } from '../../components/fileGitColors'

// --- View mode persistence ---

const VIEW_MODE_KEY = 'yaco-diff-viewmode'
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
  addBg: 'color-mix(in srgb, var(--sol-green) 10%, transparent)',
  delBg: 'color-mix(in srgb, var(--sol-red) 10%, transparent)',
  addWord: 'color-mix(in srgb, var(--sol-green) 30%, transparent)',
  delWord: 'color-mix(in srgb, var(--sol-red) 30%, transparent)',
  hunkBg: 'color-mix(in srgb, var(--sol-blue) 6%, transparent)',
  gapBorder: 'var(--sol-border)',
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
        width: 34,
        textAlign: 'right',
        paddingRight: 6,
        color: 'var(--sol-text-faint)',
        userSelect: 'none',
        flexShrink: 0,
        fontSize: 11,
        ...style,
      }}
    >
      {num ?? ''}
    </span>
  )
}

// --- Unified row ---

const UNIFIED_TEXT: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  paddingRight: 12,
  overflowWrap: 'anywhere',
  whiteSpace: 'pre-wrap',
}

function UnifiedRow({ row, singleCol }: { row: DiffRow; singleCol?: 'old' | 'new' }) {
  let bg = ''
  let color = 'var(--sol-text-dim)'

  if (row.kind === 'added') { bg = COLORS.addBg; color = 'var(--sol-green)' }
  else if (row.kind === 'deleted') { bg = COLORS.delBg; color = 'var(--sol-red)' }

  // Single-column mode: all-added or all-deleted files only need one line number
  if (singleCol) {
    const num = singleCol === 'new'
      ? (row.kind === 'deleted' ? null : row.kind === 'modified' ? row.newLine : row.newLine)
      : (row.kind === 'added' ? null : row.kind === 'modified' ? row.oldLine : row.oldLine)

    if (row.kind === 'modified') {
      return (
        <>
          <div style={{ display: 'flex', backgroundColor: COLORS.delBg, color: 'var(--sol-red)', minHeight: 20 }}>
            <LineNum num={row.oldLine} />
            <span style={UNIFIED_TEXT}>
              <Segments segments={row.oldSegments} highlight={COLORS.delWord} />
            </span>
          </div>
          <div style={{ display: 'flex', backgroundColor: COLORS.addBg, color: 'var(--sol-green)', minHeight: 20 }}>
            <LineNum num={row.newLine} />
            <span style={UNIFIED_TEXT}>
              <Segments segments={row.newSegments} highlight={COLORS.addWord} />
            </span>
          </div>
        </>
      )
    }

    return (
      <div style={{ display: 'flex', backgroundColor: bg, color, minHeight: 20 }}>
        <LineNum num={num} />
        <span style={UNIFIED_TEXT}>{row.text}</span>
      </div>
    )
  }

  return (
    <>
      {row.kind === 'modified' ? (
        <>
          <div style={{ display: 'flex', backgroundColor: COLORS.delBg, color: 'var(--sol-red)', minHeight: 20 }}>
            <LineNum num={row.oldLine} />
            <LineNum num={null} />
            <span style={UNIFIED_TEXT}>
              <Segments segments={row.oldSegments} highlight={COLORS.delWord} />
            </span>
          </div>
          <div style={{ display: 'flex', backgroundColor: COLORS.addBg, color: 'var(--sol-green)', minHeight: 20 }}>
            <LineNum num={null} />
            <LineNum num={row.newLine} />
            <span style={UNIFIED_TEXT}>
              <Segments segments={row.newSegments} highlight={COLORS.addWord} />
            </span>
          </div>
        </>
      ) : (
        <div style={{ display: 'flex', backgroundColor: bg, color, minHeight: 20 }}>
          <LineNum num={row.kind === 'added' ? null : row.oldLine} />
          <LineNum num={row.kind === 'deleted' ? null : row.newLine} />
          <span style={UNIFIED_TEXT}>
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

const SPLIT_GRID: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '34px minmax(0, 1fr) 1px 34px minmax(0, 1fr)',
  minHeight: 20,
}

const SPLIT_TEXT: React.CSSProperties = {
  paddingRight: 8,
  minWidth: 0,
  overflowWrap: 'anywhere',
  whiteSpace: 'pre-wrap',
}

function SplitRow({ row }: { row: DiffRow }) {
  const placeholderBg = 'var(--sol-base2)'

  if (row.kind === 'context') {
    return (
      <div style={SPLIT_GRID}>
        <LineNum num={row.oldLine} />
        <span style={{ ...SPLIT_TEXT, color: 'var(--sol-text-dim)' }}>{row.text}</span>
        <div style={{ backgroundColor: 'var(--sol-border)' }} />
        <LineNum num={row.newLine} />
        <span style={{ ...SPLIT_TEXT, color: 'var(--sol-text-dim)' }}>{row.text}</span>
      </div>
    )
  }

  if (row.kind === 'deleted') {
    return (
      <div style={SPLIT_GRID}>
        <LineNum num={row.oldLine} style={{ backgroundColor: COLORS.delBg }} />
        <span style={{ ...SPLIT_TEXT, backgroundColor: COLORS.delBg, color: 'var(--sol-red)' }}>{row.text}</span>
        <div style={{ backgroundColor: 'var(--sol-border)' }} />
        <LineNum num={null} style={{ backgroundColor: placeholderBg }} />
        <span style={{ backgroundColor: placeholderBg, minWidth: 0 }} />
      </div>
    )
  }

  if (row.kind === 'added') {
    return (
      <div style={SPLIT_GRID}>
        <LineNum num={null} style={{ backgroundColor: placeholderBg }} />
        <span style={{ backgroundColor: placeholderBg, minWidth: 0 }} />
        <div style={{ backgroundColor: 'var(--sol-border)' }} />
        <LineNum num={row.newLine} style={{ backgroundColor: COLORS.addBg }} />
        <span style={{ ...SPLIT_TEXT, backgroundColor: COLORS.addBg, color: 'var(--sol-green)' }}>{row.text}</span>
      </div>
    )
  }

  // modified
  return (
    <div style={SPLIT_GRID}>
      <LineNum num={row.oldLine} style={{ backgroundColor: COLORS.delBg }} />
      <span style={{ ...SPLIT_TEXT, backgroundColor: COLORS.delBg, color: 'var(--sol-red)' }}>
        <Segments segments={row.oldSegments} highlight={COLORS.delWord} />
      </span>
      <div style={{ backgroundColor: 'var(--sol-border)' }} />
      <LineNum num={row.newLine} style={{ backgroundColor: COLORS.addBg }} />
      <span style={{ ...SPLIT_TEXT, backgroundColor: COLORS.addBg, color: 'var(--sol-green)' }}>
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
        color: isActive ? 'var(--sol-blue)' : 'var(--sol-text-faint)',
        padding: '3px 12px',
        fontSize: 11,
        fontFamily: 'var(--font-mono)',
        borderTop: isActive ? '2px solid var(--sol-blue)' : '1px solid var(--sol-border)',
        borderBottom: '1px solid var(--sol-border)',
        transition: 'color 120ms, border-color 120ms',
        letterSpacing: '-0.01em',
      }}
    >
      {hunk.header}
    </div>
  )
}

// --- Inter-hunk gap ---

function InterHunkGap({ lineCount }: { lineCount: number }) {
  return (
    <div className="collapsed-context-fold" style={{ cursor: 'default' }}>
      <span>{lineCount} unchanged lines omitted</span>
    </div>
  )
}

// --- Collapsed context row ---

function CollapsedContextRow({ count, onExpand }: { count: number; onExpand: () => void }) {
  return (
    <div
      className="collapsed-context-fold"
      onClick={onExpand}
    >
      <ChevronsUpDown size={10} />
      <span>{count} unchanged lines</span>
    </div>
  )
}

// --- Compare context type ---

export interface CompareContext {
  base: string
  compare: string
  files: GitChange[]
  currentPath: string
  onNavigate: (path: string) => void
}

// --- File list dropdown ---

function FileListDropdown({
  files,
  currentPath,
  onNavigate,
  onClose,
  anchorRef,
}: {
  files: GitChange[]
  currentPath: string
  onNavigate: (path: string) => void
  onClose: () => void
  anchorRef: React.RefObject<HTMLButtonElement | null>
}) {
  const dropdownRef = useRef<HTMLDivElement>(null)
  const [focusedIdx, setFocusedIdx] = useState(() => files.findIndex(f => f.path === currentPath))

  // Click outside closes
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
          anchorRef.current && !anchorRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose, anchorRef])

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
      if (e.key === 'ArrowDown') { e.preventDefault(); setFocusedIdx(i => Math.min(files.length - 1, i + 1)); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setFocusedIdx(i => Math.max(0, i - 1)); return }
      if (e.key === 'Enter') {
        e.preventDefault()
        const file = files[focusedIdx]
        if (file) { onNavigate(file.path); onClose() }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [files, focusedIdx, onNavigate, onClose])

  // Scroll focused item into view
  useEffect(() => {
    const el = dropdownRef.current?.querySelector(`[data-idx="${focusedIdx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [focusedIdx])

  // Position: below the anchor button
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  useEffect(() => {
    const anchor = anchorRef.current
    if (!anchor) return
    const rect = anchor.getBoundingClientRect()
    setPos({ top: rect.bottom + 4, left: Math.max(8, rect.left - 80) })
  }, [anchorRef])

  if (!pos) return null

  const STATUS_BG: Record<string, string> = {
    M: 'color-mix(in srgb, var(--sol-warning) 14%, transparent)',
    U: 'color-mix(in srgb, var(--sol-diff-add) 14%, transparent)',
    A: 'color-mix(in srgb, var(--sol-diff-add) 14%, transparent)',
    D: 'color-mix(in srgb, var(--sol-diff-del) 14%, transparent)',
  }

  return (
    <div
      ref={dropdownRef}
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        zIndex: 100,
        background: 'var(--sol-glass-bg)',
        border: '1px solid var(--sol-border)',
        boxShadow: 'var(--elevation-2)',
        backdropFilter: 'var(--backdrop-blur)',
        borderRadius: 8,
        maxHeight: 320,
        overflowY: 'auto',
        minWidth: 220,
        maxWidth: 400,
        padding: '4px 0',
      }}
    >
      <div className="px-2 pb-1 mb-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--sol-text)', borderBottom: '1px solid var(--sol-border)' }}>
        Files in comparison
      </div>
      {files.map((file, idx) => {
        const name = file.path.split('/').pop() || file.path
        const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''
        const isCurrent = file.path === currentPath
        const isFocused = idx === focusedIdx
        return (
          <div
            key={file.path}
            data-idx={idx}
            onClick={() => { onNavigate(file.path); onClose() }}
            onMouseEnter={() => setFocusedIdx(idx)}
            className="flex items-center h-[26px] px-2 text-[12px] cursor-pointer"
            style={{
              backgroundColor: isCurrent
                ? 'color-mix(in srgb, var(--sol-blue) 12%, transparent)'
                : isFocused ? 'var(--sol-hover-bg)' : undefined,
              borderLeft: isCurrent ? '2px solid var(--sol-accent)' : '2px solid transparent',
              gap: 6,
              transition: 'background-color 80ms',
            }}
          >
            <FileTypeIcon name={name} />
            <span className="truncate font-medium" style={{ color: isCurrent ? 'var(--sol-text-dark)' : 'var(--sol-text)' }}>{name}</span>
            {dir && <span className="truncate text-[10px] min-w-0 shrink" style={{ color: 'var(--sol-text-faint)' }}>{dir}</span>}
            <span
              className="ml-auto shrink-0 rounded text-[9px] font-bold leading-none"
              style={{ color: GIT_COLORS[file.status], backgroundColor: STATUS_BG[file.status], padding: '2px 4px' }}
            >{file.status}</span>
          </div>
        )
      })}
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
  compareContext,
  onPrevFile,
  onNextFile,
}: {
  parsed: ParsedFileDiff
  viewMode: ViewMode
  onViewMode: (mode: ViewMode) => void
  activeIndex: number
  hunkCount: number
  onPrev: () => void
  onNext: () => void
  isMobile: boolean
  compareContext?: CompareContext
  onPrevFile?: () => void
  onNextFile?: () => void
}) {
  const navBtnStyle: React.CSSProperties = {
    padding: '0 5px',
    height: 20,
    fontSize: 11,
    border: '1px solid var(--sol-border)',
    borderRadius: 3,
    cursor: 'pointer',
    backgroundColor: 'transparent',
    color: 'var(--sol-text)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'background-color 80ms',
  }

  const viewBtnBase: React.CSSProperties = {
    padding: '0 8px',
    height: 20,
    fontSize: 10,
    border: '1px solid var(--sol-border)',
    cursor: 'pointer',
    color: 'var(--sol-text)',
    letterSpacing: '0.02em',
    textTransform: 'uppercase',
    fontWeight: 500,
    transition: 'background-color 80ms, color 80ms',
  }

  const [showFileDropdown, setShowFileDropdown] = useState(false)
  const fileCountRef = useRef<HTMLButtonElement>(null)

  const currentIdx = compareContext?.files.findIndex(f => f.path === compareContext.currentPath) ?? -1
  const fileCount = compareContext?.files.length ?? 0

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 0,
        height: 30,
        padding: '0 10px',
        backgroundColor: 'var(--sol-header-bg)',
        borderBottom: '1px solid var(--sol-border)',
        fontSize: 12,
        color: 'var(--sol-text)',
        flexShrink: 0,
      }}
    >
      {/* Compare context */}
      {compareContext && (
        <>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--sol-text-dim)', marginRight: 10 }}>
            <GitBranch size={10} style={{ color: 'var(--sol-accent)' }} />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600, color: 'var(--sol-text)' }}>{compareContext.base}</span>
            <span style={{ color: 'var(--sol-text-faint)', fontSize: 10 }}>&rarr;</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600, color: 'var(--sol-text)' }}>{compareContext.compare}</span>
          </span>
          <div className="toolbar-sep" />
        </>
      )}

      {/* Stats */}
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '0 10px', fontSize: 11, fontWeight: 600 }}>
        <span style={{ color: 'var(--sol-green)' }}>+{parsed.stats.added}</span>
        <span style={{ color: 'var(--sol-red)' }}>-{parsed.stats.deleted}</span>
      </span>

      <div className="toolbar-sep" />

      {/* View mode */}
      {!isMobile && (
        <>
          <span style={{ display: 'flex', margin: '0 10px' }}>
            <button
              style={{ ...viewBtnBase, borderRadius: '3px 0 0 3px', backgroundColor: viewMode === 'unified' ? 'var(--sol-bg)' : 'transparent', fontWeight: viewMode === 'unified' ? 700 : 500, color: viewMode === 'unified' ? 'var(--sol-text-dark)' : 'var(--sol-text-dim)' }}
              onClick={() => onViewMode('unified')}
            >Unified</button>
            <button
              style={{ ...viewBtnBase, borderRadius: '0 3px 3px 0', borderLeft: 'none', backgroundColor: viewMode === 'split' ? 'var(--sol-bg)' : 'transparent', fontWeight: viewMode === 'split' ? 700 : 500, color: viewMode === 'split' ? 'var(--sol-text-dark)' : 'var(--sol-text-dim)' }}
              onClick={() => onViewMode('split')}
            >Split</button>
          </span>
          <div className="toolbar-sep" />
        </>
      )}

      {/* Spacer */}
      <span style={{ flex: 1 }} />

      {/* File navigation (compare mode) */}
      {compareContext && fileCount > 0 && (
        <>
          <span style={{ display: 'flex', alignItems: 'center', gap: 3, marginRight: 10 }}>
            <button style={navBtnStyle} onClick={onPrevFile} disabled={currentIdx <= 0} aria-label="Previous file">
              <ChevronLeft size={11} />
            </button>
            <button
              ref={fileCountRef}
              onClick={() => setShowFileDropdown(v => !v)}
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: 'var(--sol-text-dim)',
                cursor: 'pointer',
                background: showFileDropdown ? 'color-mix(in srgb, var(--sol-blue) 10%, transparent)' : 'transparent',
                border: '1px solid var(--sol-border)',
                borderRadius: 3,
                padding: '1px 6px',
                height: 20,
                letterSpacing: '0.02em',
                transition: 'background-color 80ms',
              }}
            >
              {currentIdx + 1}<span style={{ color: 'var(--sol-text-faint)', fontWeight: 400 }}> / </span>{fileCount}
            </button>
            <button style={navBtnStyle} onClick={onNextFile} disabled={currentIdx >= fileCount - 1} aria-label="Next file">
              <ChevronRight size={11} />
            </button>
          </span>
          <div className="toolbar-sep" />
        </>
      )}

      {/* Hunk navigation */}
      <span style={{ display: 'flex', alignItems: 'center', gap: 3, marginLeft: 10 }}>
        <button style={navBtnStyle} onClick={onPrev} disabled={hunkCount === 0} aria-label="Previous change">&#8593;</button>
        <button style={navBtnStyle} onClick={onNext} disabled={hunkCount === 0} aria-label="Next change">&#8595;</button>
        {hunkCount > 0 && (
          <span style={{ fontSize: 10, color: 'var(--sol-text-dim)', marginLeft: 4, fontWeight: 500, whiteSpace: 'nowrap' }}>
            {activeIndex + 1}<span style={{ color: 'var(--sol-text-faint)', fontWeight: 400 }}> / </span>{hunkCount}
          </span>
        )}
      </span>

      {showFileDropdown && compareContext && (
        <FileListDropdown
          files={compareContext.files}
          currentPath={compareContext.currentPath}
          onNavigate={compareContext.onNavigate}
          onClose={() => setShowFileDropdown(false)}
          anchorRef={fileCountRef}
        />
      )}
    </div>
  )
}

// --- Main DiffTab component ---

export function DiffTab({
  parsed,
  isMobile,
  compareContext,
}: {
  parsed: ParsedFileDiff
  isMobile: boolean
  compareContext?: CompareContext
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

  // Reset hunk selection when the parsed diff changes (adjust state during render).
  const [prevParsed, setPrevParsed] = useState(parsed)
  if (parsed !== prevParsed) {
    setPrevParsed(parsed)
    setActiveHunkIndex(0)
    setExpandedContexts(new Set())
  }

  const hunkCount = parsed.hunks.length

  // All-added or all-deleted files only need one line number column
  const singleCol: 'old' | 'new' | undefined =
    parsed.status === 'added' ? 'new' : parsed.status === 'deleted' ? 'old' : undefined

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

  // File navigation (compare mode)
  const currentFileIdx = compareContext?.files.findIndex(f => f.path === compareContext.currentPath) ?? -1

  const navigatePrevFile = useCallback(() => {
    if (!compareContext || currentFileIdx <= 0) return
    compareContext.onNavigate(compareContext.files[currentFileIdx - 1].path)
  }, [compareContext, currentFileIdx])

  const navigateNextFile = useCallback(() => {
    if (!compareContext || currentFileIdx >= compareContext.files.length - 1) return
    compareContext.onNavigate(compareContext.files[currentFileIdx + 1].path)
  }, [compareContext, currentFileIdx])

  // j/k keyboard navigation for hunks, [ / ] for files
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
      } else if (e.key === '[') {
        e.preventDefault()
        navigatePrevFile()
      } else if (e.key === ']') {
        e.preventDefault()
        navigateNextFile()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [navigateNext, navigatePrev, navigatePrevFile, navigateNextFile])

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
      <div className="flex flex-col items-center justify-center h-full gap-2" style={{ color: 'var(--sol-text)' }}>
        <div style={{ fontSize: 24, opacity: 0.3 }}>&#x1F4E6;</div>
        <span className="text-[12px] font-medium">Binary file changed</span>
        <span className="text-[10px]">Preview not available for binary files</span>
      </div>
    )
  }

  // Empty diff
  if (hunkCount === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2" style={{ color: 'var(--sol-text)' }}>
        <GitCompare size={20} style={{ opacity: 0.3 }} />
        <span className="text-[12px] font-medium">No changes detected</span>
        <span className="text-[10px]">The files are identical</span>
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
        compareContext={compareContext}
        onPrevFile={navigatePrevFile}
        onNextFile={navigateNextFile}
      />
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflow: 'auto',
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          lineHeight: '1.6',
          backgroundColor: 'var(--sol-editor-bg)',
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
                          : <UnifiedRow key={row.key} row={row} singleCol={singleCol} />
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
                  : <UnifiedRow key={row.key} row={row} singleCol={singleCol} />
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}
