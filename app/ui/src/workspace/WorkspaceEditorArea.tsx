import { useState, useRef, useEffect, useLayoutEffect, useCallback, Component, type ReactNode } from 'react'
import { Editor } from '../components/Editor'
import type { DiffHunk } from '../lib/parseDiff'
import type { ParsedFileDiff } from '../lib/parseDiff'
import type { CompareContext } from './diff/DiffTab'
import { escapeHtml, clampLine, renderMarkdown, resolveRelativePath, loadMermaid } from './markdown'
import { VResizeHandle, HResizeHandle } from './ResizeHandle'
import type { PreviewMode, SplitDirection } from '../hooks/useWorkspaceState'
import { DiffTab } from './diff/DiffTab'
import { isImageFile, isPdfFile, rawFileUrl } from '../lib/binaryFiles'
import { ImagePreview } from './ImagePreview'
import { PdfPreview } from './PdfPreview'
import { HtmlPreview } from './HtmlPreview'

// --- Error boundary for binary previews (isolates react-pdf/image errors from the app) ---
class PreviewErrorBoundary extends Component<{ children: ReactNode; fileName: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-2" style={{ color: 'var(--sol-text)' }}>
          <span className="text-ui-md">Unable to preview {this.props.fileName}</span>
          <span className="text-ui-sm" style={{ opacity: 0.7 }}>{this.state.error.message}</span>
        </div>
      )
    }
    return this.props.children
  }
}

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
  projectName,
  worktree,
  viewportLine,
  onViewportLine,
  onActivateLine,
  onNavigateToFile,
  onNavigateDir,
  onRegisterSync,
}: {
  content: string
  filePath?: string
  projectName?: string
  worktree?: string | null
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
  const anchorScrollRef = useRef(false)
  const cancelLerpRef = useRef<(() => void) | null>(null)
  const lastReportedLineRef = useRef(-1)
  const appliedHtmlRef = useRef('')
  const anchorsRef = useRef<CachedAnchor[]>([])
  const onViewportLineRef = useRef(onViewportLine)
  const onRegisterSyncRef = useRef(onRegisterSync)
  useEffect(() => {
    onViewportLineRef.current = onViewportLine
    onRegisterSyncRef.current = onRegisterSync
  })
  const rawHtml = renderMarkdown(content)
  const [html, setHtml] = useState(rawHtml)

  // When content changes, process mermaid async then update HTML.
  // Key: don't setHtml(rawHtml) eagerly when mermaid is present — that
  // briefly shows raw mermaid source text, causing a visible flash.
  useEffect(() => {
    const parser = new DOMParser()
    const doc = parser.parseFromString(rawHtml, 'text/html')
    const mermaidDivs = doc.querySelectorAll<HTMLElement>('.mermaid')
    if (mermaidDivs.length === 0) {
      // Plain HTML (no mermaid) — sync to rawHtml. The mermaid path below updates
      // html after async rendering; this fast path avoids a flash for the common case.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHtml(rawHtml)
      return
    }

    let cancelled = false
    let counter = 0
    const renderAll = async () => {
      const mermaid = await loadMermaid()
      if (cancelled) return
      for (const div of mermaidDivs) {
        if (cancelled) return
        const source = div.textContent?.trim()
        if (!source) continue
        try {
          const { svg } = await mermaid.render(`mermaid-${Date.now()}-${counter++}`, source)
          div.innerHTML = svg
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Diagram render failed'
          div.innerHTML = `<pre style="color:var(--sol-red);font-size:var(--text-ui-md);white-space:pre-wrap">${escapeHtml(msg)}</pre>`
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

    // Rewrite relative <img src> to the server's raw-file route so images
    // embedded in markdown resolve relative to the markdown file, not the
    // dev server origin. Absolute URLs (http:, https:, data:, blob:, //…)
    // pass through unchanged.
    if (filePath && projectName) {
      el.querySelectorAll<HTMLImageElement>('img[src]').forEach((img) => {
        const src = img.getAttribute('src')
        if (!src) return
        if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) return
        img.setAttribute('src', rawFileUrl(projectName, resolveRelativePath(filePath, src), worktree))
      })
    }

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
    cancelLerpRef.current = cancelLerp

    onRegisterSyncRef.current?.((line: number) => {
      if (anchorScrollRef.current) return
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
      if (anchorScrollRef.current) return
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
        // --- Link navigation (single click) ---
        const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a')
        if (!anchor) return
        const href = anchor.getAttribute('href')
        if (!href) return
        event.preventDefault()
        if (href.startsWith('#')) {
          const id = href.slice(1)
          const el = containerRef.current
          const target = el?.querySelector(`[id="${CSS.escape(id)}"]`)
          if (target && el) {
            cancelLerpRef.current?.()
            anchorScrollRef.current = true
            target.scrollIntoView({ behavior: 'smooth', block: 'start' })
            const done = () => {
              anchorScrollRef.current = false
              const line = lineFromAnchors(anchorsRef.current, el.scrollTop)
              lastReportedLineRef.current = line
              onViewportLineRef.current?.(line)
            }
            el.addEventListener('scrollend', done, { once: true })
            // Fallback if scrollend doesn't fire (e.g. already at target)
            setTimeout(() => { if (anchorScrollRef.current) done() }, 800)
          }
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
      }}
      onDoubleClick={(event) => {
        // --- Double-click-to-edit line sync (skip when on a link) ---
        if ((event.target as HTMLElement).closest('a')) return
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
  isHtml,
  previewMode,
  splitDirection,
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
  compareContext,
  projectName,
  worktree,
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
  isHtml: boolean | undefined
  previewMode: PreviewMode
  splitDirection: SplitDirection
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
  compareContext?: CompareContext
  projectName: string
  worktree?: string | null
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
  useEffect(() => { onViewportLineRef.current = onViewportLine })

  // Flush latest viewport line on tab or mode change so newly mounted
  // components get the current position, not a debounce-stale value.
  // This is React's "adjust state during render on prop change" pattern; it reads
  // mutable refs (latestLineRef updated on every scroll, persistTimerRef) during
  // render to seed the child position without a wasted extra render — so the
  // refs rule is scoped off for just this guarded block.
  const prevTabRef = useRef(activeTab)
  const prevPreviewModeRef = useRef(previewMode)
  /* eslint-disable react-hooks/refs */
  if (activeTab !== prevTabRef.current) {
    prevTabRef.current = activeTab
    prevPreviewModeRef.current = previewMode
    latestLineRef.current = activeViewportLine
    setLocalViewportLine(activeViewportLine)
  } else if (previewMode !== prevPreviewModeRef.current) {
    prevPreviewModeRef.current = previewMode
    clearTimeout(persistTimerRef.current)
    setLocalViewportLine(latestLineRef.current)
  }
  /* eslint-enable react-hooks/refs */

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
    const startPos = splitDirection === 'horizontal' ? e.clientX : e.clientY
    const startSize = splitSize
    const container = splitContainerRef.current
    if (!container) return
    const containerSpan = splitDirection === 'horizontal' ? container.offsetWidth : container.offsetHeight

    const onMove = (me: MouseEvent) => {
      const currentPos = splitDirection === 'horizontal' ? me.clientX : me.clientY
      const delta = currentPos - startPos
      const pct = startSize + (delta / containerSpan) * 100
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
  }, [splitSize, splitDirection, onSplitResize])

  const isPreviewable = isMd || isHtml
  const showSplit = isPreviewable && previewMode === 'split'
  const showPreviewOnly = isPreviewable && previewMode === 'preview'

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

  const previewElement = isHtml ? (
    <HtmlPreview content={activeFileContent ?? ''} />
  ) : (
    <MarkdownPreview
      content={activeFileContent ?? ''}
      filePath={activeTab ?? undefined}
      projectName={projectName}
      worktree={worktree}
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
        <div className="flex items-center gap-3 px-3 py-2 text-ui-md shrink-0" style={{ backgroundColor: 'color-mix(in srgb, var(--sol-warning) 9%, transparent)', borderBottom: '1px solid color-mix(in srgb, var(--sol-warning) 25%, transparent)', color: 'var(--sol-warning)', animation: 'panel-slide-in 200ms cubic-bezier(0.2, 0, 0, 1) both' }}>
          <span>&#9888; File changed on disk.</span>
          <button
            onClick={onAcceptDisk}
            className="conflict-btn px-2 py-0.5 rounded text-ui-sm cursor-pointer border"
            style={{ borderColor: 'color-mix(in srgb, var(--sol-warning) 25%, transparent)', color: 'var(--sol-warning)', transition: 'background-color 120ms' }}
          >
            Accept Disk Version
          </button>
          <button
            onClick={onForceSave}
            className="conflict-btn px-2 py-0.5 rounded text-ui-sm cursor-pointer border"
            style={{ borderColor: 'color-mix(in srgb, var(--sol-warning) 25%, transparent)', color: 'var(--sol-warning)', transition: 'background-color 120ms' }}
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
        !activeDiff || (activeDiff.loading && activeDiff.raw == null) ? <div className="flex items-center justify-center h-full"><div className="loading-spinner" /></div>
        : activeDiff?.parsed != null ? <DiffTab parsed={activeDiff.parsed} isMobile={!!isMobile} compareContext={compareContext} />
        : <div className="flex items-center justify-center h-full" style={{ color: 'var(--sol-text)' }}>Unable to load diff</div>
      ) : activeTab ? (
        activeFilePath && isImageFile(activeFilePath) ? (
          <PreviewErrorBoundary key={activeFilePath} fileName={activeFilePath.split('/').pop() ?? ''}>
            <ImagePreview src={rawFileUrl(projectName, activeFilePath, worktree)} />
          </PreviewErrorBoundary>
        ) : activeFilePath && isPdfFile(activeFilePath) ? (
          <PreviewErrorBoundary key={activeFilePath} fileName={activeFilePath.split('/').pop() ?? ''}>
            <PdfPreview src={rawFileUrl(projectName, activeFilePath, worktree)} />
          </PreviewErrorBoundary>
        ) : activeFileLoading ? <div className="flex items-center justify-center h-full"><div className="loading-spinner" /></div>
        : activeFileContent !== null ? (
          showSplit ? (
            <div ref={splitContainerRef} className={splitDirection === 'vertical' ? 'flex flex-col h-full' : 'flex h-full'} style={{ userSelect: isDragging ? 'none' : undefined }}>
              <div className={splitDirection === 'vertical' ? 'min-h-0 overflow-hidden' : 'min-w-0 overflow-hidden'} style={{ flex: `0 0 ${splitSize}%` }}>
                {editorElement}
              </div>
              {splitDirection === 'vertical'
                ? <HResizeHandle onMouseDown={handleSplitMouseDown} isDragging={isDragging} />
                : <VResizeHandle onMouseDown={handleSplitMouseDown} isDragging={isDragging} />
              }
              <div className={splitDirection === 'vertical' ? 'flex-1 min-h-0 overflow-hidden' : 'flex-1 min-w-0 overflow-hidden'}>
                {previewElement}
              </div>
            </div>
          ) : showPreviewOnly ? (
            previewElement
          ) : (
            editorElement
          )
        ) : <div className="flex items-center justify-center h-full" style={{ color: 'var(--sol-text)' }}>Unable to load file</div>
      ) : <div className="flex flex-col items-center justify-center h-full gap-2" style={{ color: 'var(--sol-text)' }}>
          <span className="text-ui-md">No file open</span>
          <span className="text-ui-sm">
            Press <kbd className="inline-block px-1.5 py-0.5 rounded text-ui-xs font-mono" style={{ backgroundColor: 'color-mix(in srgb, var(--sol-muted) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--sol-muted) 20%, transparent)' }}>{navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl'}+P</kbd> to open a file
          </span>
        </div>}
      </div>
    </div>
  )
}
