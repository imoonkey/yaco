import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react'
import { Editor } from '../components/Editor'
import type { DiffHunk } from '../lib/parseDiff'
import type { ParsedFileDiff } from '../lib/parseDiff'
import { escapeHtml, clampLine, renderMarkdown, resolveRelativePath } from './markdown'
import { VResizeHandle } from './ResizeHandle'
import type { MdMode } from '../hooks/useWorkspaceState'
import mermaid from 'mermaid'
import { DiffTab } from './diff/DiffTab'

// --- Markdown Preview scroll helpers (cached positions — zero DOM reads during scroll) ---
type CachedAnchor = {
  lineStart: number
  lineEnd: number
  top: number
  bottom: number
}

function buildAnchorCache(container: HTMLDivElement): CachedAnchor[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.markdown-block[data-source-line-start]')).map(el => ({
    lineStart: clampLine(Number(el.dataset.sourceLineStart)),
    lineEnd: clampLine(Number(el.dataset.sourceLineEnd ?? el.dataset.sourceLineStart)),
    top: el.offsetTop,
    bottom: el.offsetTop + el.offsetHeight,
  }))
}

function lineFromAnchors(anchors: CachedAnchor[], scrollTop: number): number {
  if (anchors.length === 0) return 1
  const block = anchors.find(a => a.bottom > scrollTop) ?? anchors[anchors.length - 1]
  const height = Math.max(1, block.bottom - block.top)
  const relativeY = Math.max(0, Math.min(height, scrollTop - block.top))
  const span = Math.max(0, block.lineEnd - block.lineStart)
  return Math.max(1, block.lineStart + (height > 0 ? relativeY / height : 0) * span)
}

function scrollTopForLine(anchors: CachedAnchor[], viewportLine: number): number | null {
  if (anchors.length === 0) return null
  const targetLine = Math.max(1, viewportLine)
  const block = anchors.find(a => targetLine >= a.lineStart && targetLine <= a.lineEnd)
    ?? anchors.findLast(a => a.lineStart <= targetLine)
    ?? anchors[0]
  const span = Math.max(0, block.lineEnd - block.lineStart)
  const ratio = span === 0 ? 0 : Math.max(0, Math.min(1, (targetLine - block.lineStart) / span))
  return block.top + ratio * Math.max(1, block.bottom - block.top)
}

function scrollToLine(container: HTMLDivElement, anchors: CachedAnchor[], viewportLine: number): boolean {
  const targetTop = scrollTopForLine(anchors, viewportLine)
  if (targetTop === null || Math.abs(container.scrollTop - targetTop) < 1) return false
  container.scrollTop = targetTop
  return true
}

// --- Markdown Preview ---
export function MarkdownPreview({
  content,
  filePath,
  viewportLine,
  onViewportLine,
  onActivateLine,
  onNavigateToFile,
  onNavigateDir,
  onRegisterSync,
}: {
  content: string
  filePath?: string
  viewportLine: number
  onViewportLine?: (line: number) => void
  onActivateLine?: (line: number) => void
  onNavigateToFile?: (path: string) => void
  onNavigateDir?: (path: string) => void
  onRegisterSync?: (scrollTo: ((line: number) => void) | null) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const applyingViewportRef = useRef(false)
  const syncActiveRef = useRef(false)
  const lastReportedLineRef = useRef(-1)
  const appliedHtmlRef = useRef('')
  const anchorsRef = useRef<CachedAnchor[]>([])
  const onViewportLineRef = useRef(onViewportLine)
  onViewportLineRef.current = onViewportLine
  const onRegisterSyncRef = useRef(onRegisterSync)
  onRegisterSyncRef.current = onRegisterSync
  const rawHtml = renderMarkdown(content)
  const [html, setHtml] = useState(rawHtml)

  // When content changes, reset to raw HTML and process mermaid async
  useEffect(() => {
    setHtml(rawHtml)
    const parser = new DOMParser()
    const doc = parser.parseFromString(rawHtml, 'text/html')
    const mermaidDivs = doc.querySelectorAll<HTMLElement>('.mermaid')
    if (mermaidDivs.length === 0) return

    let cancelled = false
    let counter = 0
    const renderAll = async () => {
      for (const div of mermaidDivs) {
        if (cancelled) return
        const source = div.textContent?.trim()
        if (!source) continue
        try {
          const { svg } = await mermaid.render(`mermaid-${Date.now()}-${counter++}`, source)
          div.innerHTML = svg
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Diagram render failed'
          div.innerHTML = `<pre style="color:var(--sol-red);font-size:12px;white-space:pre-wrap">${escapeHtml(msg)}</pre>`
        }
        div.setAttribute('data-processed', 'true')
      }
      if (!cancelled) {
        setHtml(doc.body.innerHTML)
      }
    }
    renderAll()
    return () => { cancelled = true }
  }, [rawHtml])

  // Manual innerHTML management — only set when html actually changes,
  // and preserve <pre> scroll positions across DOM recreation.
  // Rebuild anchor cache after DOM update.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el || html === appliedHtmlRef.current) return

    // Save <pre> horizontal scroll positions
    const pres = el.querySelectorAll('pre')
    const scrollPositions: number[] = []
    pres.forEach((pre, i) => { scrollPositions[i] = pre.scrollLeft })

    el.innerHTML = html
    appliedHtmlRef.current = html
    anchorsRef.current = buildAnchorCache(el)

    // Restore scroll positions on the new <pre> nodes
    el.querySelectorAll('pre').forEach((pre, i) => {
      if (scrollPositions[i] > 0) pre.scrollLeft = scrollPositions[i]
    })
  }, [html])

  // Rebuild anchor cache on container resize (block positions change on reflow)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => { anchorsRef.current = buildAnchorCache(el) })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // LERP-based scroll sync from Editor — smooth interpolation eliminates
  // micro-jitter on the passive side during momentum deceleration.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const EASE = 0.2
    let lerpTarget = 0
    let raf = 0

    const lerpStep = () => {
      const delta = lerpTarget - el.scrollTop
      if (Math.abs(delta) < 0.5) { raf = 0; syncActiveRef.current = false; return }
      el.scrollTop += delta * EASE
      raf = requestAnimationFrame(lerpStep)
    }
    const cancelLerp = () => {
      if (raf) { cancelAnimationFrame(raf); raf = 0 }
      syncActiveRef.current = false
    }

    onRegisterSyncRef.current?.((line: number) => {
      const t = scrollTopForLine(anchorsRef.current, line)
      if (t === null) return
      lerpTarget = t
      lastReportedLineRef.current = line
      syncActiveRef.current = true
      if (!raf) raf = requestAnimationFrame(lerpStep)
    })

    // Cancel LERP on direct user interaction (wheel/touch never fire from programmatic scrollTop)
    el.addEventListener('wheel', cancelLerp, { passive: true })
    el.addEventListener('touchstart', cancelLerp, { passive: true })
    return () => {
      onRegisterSyncRef.current?.(null); cancelAnimationFrame(raf)
      el.removeEventListener('wheel', cancelLerp)
      el.removeEventListener('touchstart', cancelLerp)
    }
  }, [])

  // Initial scroll positioning — useLayoutEffect runs before paint to prevent flash.
  useLayoutEffect(() => {
    const element = containerRef.current
    if (!element) return
    if (viewportLine === lastReportedLineRef.current) return
    if (scrollToLine(element, anchorsRef.current, viewportLine)) {
      applyingViewportRef.current = true
    }
    lastReportedLineRef.current = viewportLine
  }, [html, viewportLine])

  // Scroll listener — native passive, synchronous on desktop, debounced on touch.
  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const isTouch = matchMedia('(pointer: coarse)').matches
    let timer = 0
    const reportLine = () => {
      const line = lineFromAnchors(anchorsRef.current, element.scrollTop)
      lastReportedLineRef.current = line
      onViewportLineRef.current?.(line)
    }
    const onScroll = () => {
      if (syncActiveRef.current) return
      if (applyingViewportRef.current) {
        applyingViewportRef.current = false
        return
      }
      if (isTouch) {
        clearTimeout(timer)
        timer = window.setTimeout(reportLine, 120)
      } else {
        reportLine()
      }
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      element.removeEventListener('scroll', onScroll)
      clearTimeout(timer)
    }
  }, [])

  return (
    <div
      ref={containerRef}
      className="markdown-preview h-full"
      onClick={(event) => {
        // --- Link navigation ---
        const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a')
        if (anchor) {
          const href = anchor.getAttribute('href')
          if (!href) return
          event.preventDefault()
          if (href.startsWith('#')) {
            const id = href.slice(1)
            const target = containerRef.current?.querySelector(`[id="${CSS.escape(id)}"]`)
            target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            return
          }
          if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) {
            window.open(href, '_blank', 'noopener')
          } else if (filePath) {
            const clean = href.split('#')[0].split('?')[0]
            if (clean.endsWith('/')) {
              onNavigateDir?.(resolveRelativePath(filePath, href))
            } else {
              onNavigateToFile?.(resolveRelativePath(filePath, href))
            }
          }
          return
        }
        // --- Click-to-edit line sync ---
        if (!onActivateLine) return
        const element = containerRef.current
        if (!element) return
        const blockElement = (event.target as HTMLElement | null)?.closest<HTMLElement>('.markdown-block[data-source-line-start]')
        if (!blockElement) {
          onActivateLine(lineFromAnchors(anchorsRef.current, element.scrollTop))
          return
        }
        const lineStart = clampLine(Number(blockElement.dataset.sourceLineStart))
        const lineEnd = clampLine(Number(blockElement.dataset.sourceLineEnd ?? blockElement.dataset.sourceLineStart))
        if (lineStart === lineEnd) {
          onActivateLine(lineStart)
          return
        }
        const blockTop = blockElement.offsetTop
        const blockHeight = Math.max(1, blockElement.offsetHeight)
        const rect = element.getBoundingClientRect()
        const absoluteY = element.scrollTop + (event.clientY - rect.top)
        const relativeY = Math.max(0, Math.min(blockHeight, absoluteY - blockTop))
        const ratio = relativeY / blockHeight
        const lineCount = lineEnd - lineStart + 1
        onActivateLine(Math.min(lineEnd, Math.floor(lineStart + ratio * lineCount)))
      }}
    />
  )
}

// --- Editor Area (conflict banner + content switching) ---
export function WorkspaceEditorArea({
  activeTab,
  activeFilePath,
  activeFileContent,
  activeFileLoading,
  activeViewportLine,
  isDiffTab,
  isTasksTab,
  activeDiff,
  isMd,
  mdMode,
  splitSize,
  onSplitResize,
  hasConflict,
  jumpRequest,
  onAcceptDisk,
  onForceSave,
  onViewportLine,
  onActivateLine,
  onNavigateToFile,
  onNavigateDir,
  onFocus,
  onCloseTab,
  onDraftChange,
  onSave,
  diffHunks,
  tasksPane,
  composeTray,
  insertText,
  insertRequestKey,
  autocompleteEnabled,
  isMobile,
}: {
  activeTab: string | null
  activeFilePath: string | null
  activeFileContent: string | null
  activeFileLoading: boolean
  activeViewportLine: number
  isDiffTab: boolean | undefined
  isTasksTab: boolean
  activeDiff: { raw: string | null; parsed: ParsedFileDiff | null; loading: boolean } | null
  isMd: boolean | undefined
  mdMode: MdMode
  splitSize: number
  onSplitResize: (size: number) => void
  hasConflict: boolean
  jumpRequest: { key: number; path: string; line: number; scroll?: boolean } | null
  onAcceptDisk: () => void
  onForceSave: () => void
  onViewportLine: (line: number) => void
  onActivateLine: (line: number) => void
  onNavigateToFile?: (path: string) => void
  onNavigateDir?: (path: string) => void
  onFocus: () => void
  onCloseTab: () => void
  onDraftChange: (content: string) => void
  onSave: (content: string) => Promise<void>
  diffHunks?: DiffHunk[]
  tasksPane?: React.ReactNode
  composeTray?: React.ReactNode
  insertText?: string | null
  insertRequestKey?: number
  autocompleteEnabled?: boolean
  isMobile?: boolean
}) {
  const splitContainerRef = useRef<HTMLDivElement>(null)
  const [isDragging, setIsDragging] = useState(false)

  // --- Scroll sync channel ---
  // Editor and Preview register LERP scroll functions here; each side calls
  // the other's function directly from its scroll handler — bypasses React.
  const syncRef = useRef<{
    scrollEditor: ((line: number) => void) | null
    scrollPreview: ((line: number) => void) | null
  }>({ scrollEditor: null, scrollPreview: null })

  const registerEditorSync = useCallback((fn: ((line: number) => void) | null) => {
    syncRef.current.scrollEditor = fn
  }, [])
  const registerPreviewSync = useCallback((fn: ((line: number) => void) | null) => {
    syncRef.current.scrollPreview = fn
  }, [])

  // Viewport line state — only for initial positioning on tab/mode switch.
  // Real-time sync goes through the imperative channel above.
  const [localViewportLine, setLocalViewportLine] = useState(activeViewportLine)
  const latestLineRef = useRef(activeViewportLine)
  const persistTimerRef = useRef(0)
  const onViewportLineRef = useRef(onViewportLine)
  onViewportLineRef.current = onViewportLine

  // Flush latest viewport line on tab or mode change so newly mounted
  // components get the current position, not a debounce-stale value.
  const prevTabRef = useRef(activeTab)
  const prevMdModeRef = useRef(mdMode)
  if (activeTab !== prevTabRef.current) {
    prevTabRef.current = activeTab
    prevMdModeRef.current = mdMode
    latestLineRef.current = activeViewportLine
    setLocalViewportLine(activeViewportLine)
  } else if (mdMode !== prevMdModeRef.current) {
    prevMdModeRef.current = mdMode
    clearTimeout(persistTimerRef.current)
    setLocalViewportLine(latestLineRef.current)
  }

  useEffect(() => () => clearTimeout(persistTimerRef.current), [])

  // Editor scroll → sync Preview imperatively, debounce persist
  const handleEditorViewportLine = useCallback((line: number) => {
    syncRef.current.scrollPreview?.(line)
    latestLineRef.current = line
    clearTimeout(persistTimerRef.current)
    persistTimerRef.current = window.setTimeout(() => {
      setLocalViewportLine(line)
      onViewportLineRef.current(line)
    }, 150)
  }, [])

  // Preview scroll → sync Editor imperatively, debounce persist
  const handlePreviewViewportLine = useCallback((line: number) => {
    syncRef.current.scrollEditor?.(line)
    latestLineRef.current = line
    clearTimeout(persistTimerRef.current)
    persistTimerRef.current = window.setTimeout(() => {
      setLocalViewportLine(line)
      onViewportLineRef.current(line)
    }, 150)
  }, [])

  const handleSplitMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startSize = splitSize
    const container = splitContainerRef.current
    if (!container) return
    const containerWidth = container.offsetWidth

    const onMove = (me: MouseEvent) => {
      const delta = me.clientX - startX
      const pct = startSize + (delta / containerWidth) * 100
      onSplitResize(Math.max(20, Math.min(80, pct)))
    }
    const onUp = () => {
      setIsDragging(false)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    setIsDragging(true)
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [splitSize, onSplitResize])

  const showSplit = isMd && mdMode === 'split'
  const showPreviewOnly = isMd && mdMode === 'preview'

  const editorElement = (
    <Editor content={activeFileContent!} filePath={activeTab!}
      viewportLine={localViewportLine}
      onViewportLine={handleEditorViewportLine}
      onRegisterSync={registerEditorSync}
      jumpToLine={jumpRequest?.path === activeTab ? jumpRequest.line : null}
      jumpRequestKey={jumpRequest?.path === activeTab ? jumpRequest.key : undefined}
      jumpScroll={jumpRequest?.path === activeTab ? jumpRequest.scroll : undefined}
      onFocus={onFocus}
      onCloseRequest={onCloseTab}
      onChange={onDraftChange}
      onSave={onSave}
      diffHunks={diffHunks}
      insertText={insertText}
      insertRequestKey={insertRequestKey}
      autocompleteEnabled={autocompleteEnabled}
    />
  )

  const previewElement = (
    <MarkdownPreview
      content={activeFileContent!}
      filePath={activeTab ?? undefined}
      viewportLine={localViewportLine}
      onViewportLine={handlePreviewViewportLine}
      onActivateLine={onActivateLine}
      onNavigateToFile={onNavigateToFile}
      onNavigateDir={onNavigateDir}
      onRegisterSync={registerPreviewSync}
    />
  )

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {activeFilePath && hasConflict && (
        <div className="flex items-center gap-3 px-3 py-2 text-[12px] shrink-0" style={{ backgroundColor: '#C4A24118', borderBottom: `1px solid #C4A24140`, color: '#C4A241', fontFamily: 'var(--font-ui)', animation: 'panel-slide-in 200ms cubic-bezier(0.2, 0, 0, 1) both' }}>
          <span>&#9888; File changed on disk.</span>
          <button
            onClick={onAcceptDisk}
            className="px-2 py-0.5 rounded text-[11px] cursor-pointer border"
            style={{ borderColor: '#C4A24140', color: '#C4A241' }}
            onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#C4A24120')}
            onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
          >
            Accept Disk Version
          </button>
          <button
            onClick={onForceSave}
            className="px-2 py-0.5 rounded text-[11px] cursor-pointer border"
            style={{ borderColor: '#C4A24140', color: '#C4A241' }}
            onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#C4A24120')}
            onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
          >
            Keep Mine &amp; Save
          </button>
        </div>
      )}
      {composeTray}
      <div className="flex-1 min-h-0">
      {isTasksTab ? (
        tasksPane
      ) : isDiffTab ? (
        !activeDiff || (activeDiff.loading && activeDiff.raw == null) ? <div className="flex items-center justify-center h-full" style={{ color: 'var(--sol-muted)' }}>Loading diff...</div>
        : activeDiff?.parsed != null ? <DiffTab parsed={activeDiff.parsed} isMobile={!!isMobile} />
        : <div className="flex items-center justify-center h-full" style={{ color: 'var(--sol-muted)' }}>Unable to load diff</div>
      ) : activeTab ? (
        activeFileLoading ? <div className="flex items-center justify-center h-full" style={{ color: 'var(--sol-muted)' }}>Loading...</div>
        : activeFileContent !== null ? (
          showSplit ? (
            <div ref={splitContainerRef} className="flex h-full" style={{ userSelect: isDragging ? 'none' : undefined }}>
              <div className="min-w-0 overflow-hidden" style={{ flex: `0 0 ${splitSize}%` }}>
                {editorElement}
              </div>
              <VResizeHandle onMouseDown={handleSplitMouseDown} isDragging={isDragging} />
              <div className="flex-1 min-w-0 overflow-hidden">
                {previewElement}
              </div>
            </div>
          ) : showPreviewOnly ? (
            previewElement
          ) : (
            editorElement
          )
        ) : <div className="flex items-center justify-center h-full" style={{ color: 'var(--sol-muted)' }}>Unable to load file</div>
      ) : <div className="flex items-center justify-center h-full text-[12px]" style={{ color: 'var(--sol-muted)' }}>Select a file from Files</div>}
      </div>
    </div>
  )
}
