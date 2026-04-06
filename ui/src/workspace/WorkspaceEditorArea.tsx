import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react'
import { Editor } from '../components/Editor'
import { SOLARIZED_LIGHT, SOLARIZED_LIGHT_UI as C } from '../lib/solarizedLight'
import type { DiffHunk } from '../lib/parseDiff'
import type { ParsedFileDiff } from '../lib/parseDiff'
import { escapeHtml, clampLine, renderMarkdown } from './markdown'
import { VResizeHandle } from './ResizeHandle'
import type { MdMode } from '../hooks/useWorkspaceState'
import mermaid from 'mermaid'
import { DiffTab } from './diff/DiffTab'

// --- Markdown Preview scroll helpers ---
type MarkdownBlockAnchor = {
  element: HTMLElement
  lineStart: number
  lineEnd: number
}

function getMarkdownBlockAnchors(container: HTMLDivElement): MarkdownBlockAnchor[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.markdown-block[data-source-line-start]')).map(element => ({
    element,
    lineStart: clampLine(Number(element.dataset.sourceLineStart)),
    lineEnd: clampLine(Number(element.dataset.sourceLineEnd ?? element.dataset.sourceLineStart)),
  }))
}

function lineFromBlockPosition(block: MarkdownBlockAnchor, absoluteY: number): number {
  const blockTop = block.element.offsetTop
  const blockHeight = Math.max(1, block.element.offsetHeight)
  const relativeY = Math.max(0, Math.min(blockHeight, absoluteY - blockTop))
  const ratio = relativeY / blockHeight
  const span = Math.max(0, block.lineEnd - block.lineStart)
  return clampLine(block.lineStart + ratio * span)
}

function lineFromPreviewScroll(container: HTMLDivElement): number {
  const blocks = getMarkdownBlockAnchors(container)
  if (blocks.length === 0) return 1

  const scrollTop = container.scrollTop
  const block = blocks.find(candidate => candidate.element.offsetTop + candidate.element.offsetHeight > scrollTop) ?? blocks[blocks.length - 1]
  return lineFromBlockPosition(block, scrollTop)
}

function applyPreviewViewportLine(container: HTMLDivElement, viewportLine: number): boolean {
  const blocks = getMarkdownBlockAnchors(container)
  if (blocks.length === 0) return false

  const targetLine = clampLine(viewportLine)
  const block = blocks.find(candidate => targetLine >= candidate.lineStart && targetLine <= candidate.lineEnd)
    ?? [...blocks].reverse().find(candidate => candidate.lineStart <= targetLine)
    ?? blocks[0]

  const span = Math.max(0, block.lineEnd - block.lineStart)
  const ratio = span === 0 ? 0 : Math.max(0, Math.min(1, (targetLine - block.lineStart) / span))
  const targetTop = block.element.offsetTop + ratio * Math.max(1, block.element.offsetHeight)
  if (Math.abs(container.scrollTop - targetTop) < 1) return false
  container.scrollTop = targetTop
  return true
}

// --- Markdown Preview ---
export function MarkdownPreview({
  content,
  viewportLine,
  onViewportLine,
  onActivateLine,
}: {
  content: string
  viewportLine: number
  onViewportLine?: (line: number) => void
  onActivateLine?: (line: number) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const applyingViewportRef = useRef(false)
  const lastReportedLineRef = useRef(viewportLine)
  const appliedHtmlRef = useRef('')
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
          div.innerHTML = `<pre style="color:${SOLARIZED_LIGHT.red};font-size:12px;white-space:pre-wrap">${escapeHtml(msg)}</pre>`
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
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el || html === appliedHtmlRef.current) return

    // Save <pre> horizontal scroll positions
    const pres = el.querySelectorAll('pre')
    const scrollPositions: number[] = []
    pres.forEach((pre, i) => { scrollPositions[i] = pre.scrollLeft })

    el.innerHTML = html
    appliedHtmlRef.current = html

    // Restore scroll positions on the new <pre> nodes
    el.querySelectorAll('pre').forEach((pre, i) => {
      if (scrollPositions[i] > 0) pre.scrollLeft = scrollPositions[i]
    })
  }, [html])

  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    // Skip programmatic scroll when viewportLine echoes our own scroll report
    if (viewportLine === lastReportedLineRef.current) return
    applyingViewportRef.current = applyPreviewViewportLine(element, viewportLine)
  }, [html, viewportLine])

  return (
    <div
      ref={containerRef}
      className="markdown-preview h-full"
      onScroll={() => {
        const element = containerRef.current
        if (!element) return
        if (applyingViewportRef.current) {
          applyingViewportRef.current = false
          return
        }
        const line = lineFromPreviewScroll(element)
        lastReportedLineRef.current = line
        onViewportLine?.(line)
      }}
      onClick={(event) => {
        if (!onActivateLine) return
        const element = containerRef.current
        if (!element) return
        const blockElement = (event.target as HTMLElement | null)?.closest<HTMLElement>('.markdown-block[data-source-line-start]')
        if (!blockElement) {
          onActivateLine(lineFromPreviewScroll(element))
          return
        }
        const block: MarkdownBlockAnchor = {
          element: blockElement,
          lineStart: clampLine(Number(blockElement.dataset.sourceLineStart)),
          lineEnd: clampLine(Number(blockElement.dataset.sourceLineEnd ?? blockElement.dataset.sourceLineStart)),
        }
        const rect = element.getBoundingClientRect()
        const absoluteY = element.scrollTop + (event.clientY - rect.top)
        onActivateLine(lineFromBlockPosition(block, absoluteY))
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
  jumpRequest: { key: number; path: string; line: number } | null
  onAcceptDisk: () => void
  onForceSave: () => void
  onViewportLine: (line: number) => void
  onActivateLine: (line: number) => void
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
      viewportLine={activeViewportLine}
      onViewportLine={onViewportLine}
      jumpToLine={jumpRequest?.path === activeTab ? jumpRequest.line : null}
      jumpRequestKey={jumpRequest?.path === activeTab ? jumpRequest.key : undefined}
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
      viewportLine={activeViewportLine}
      onViewportLine={onViewportLine}
      onActivateLine={onActivateLine}
    />
  )

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {activeFilePath && hasConflict && (
        <div className="flex items-center gap-3 px-3 py-1.5 text-[12px] shrink-0" style={{ backgroundColor: '#C4A24118', borderBottom: `1px solid #C4A24140`, color: '#C4A241' }}>
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
        !activeDiff || (activeDiff.loading && activeDiff.raw == null) ? <div className="flex items-center justify-center h-full" style={{ color: C.muted }}>Loading diff...</div>
        : activeDiff?.parsed != null ? <DiffTab parsed={activeDiff.parsed} isMobile={!!isMobile} />
        : <div className="flex items-center justify-center h-full" style={{ color: C.muted }}>Unable to load diff</div>
      ) : activeTab ? (
        activeFileLoading ? <div className="flex items-center justify-center h-full" style={{ color: C.muted }}>Loading...</div>
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
        ) : <div className="flex items-center justify-center h-full" style={{ color: C.muted }}>Unable to load file</div>
      ) : <div className="flex items-center justify-center h-full text-[12px]" style={{ color: C.muted }}>Select a file from Files</div>}
      </div>
    </div>
  )
}
