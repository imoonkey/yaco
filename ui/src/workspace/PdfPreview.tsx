import { useState, useRef, useCallback, lazy, Suspense } from 'react'
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Maximize } from 'lucide-react'

// Lazy-load the inner PDF renderer to isolate react-pdf + worker setup
const PdfRenderer = lazy(() => import('./PdfRenderer'))

export function PdfPreview({ src }: { src: string }) {
  const [numPages, setNumPages] = useState<number>(0)
  const [page, setPage] = useState(1)
  const [scale, setScale] = useState(1.2)
  const containerRef = useRef<HTMLDivElement>(null)
  const pageSizeRef = useRef<{ w: number; h: number } | null>(null)

  const fitToScreen = useCallback(() => {
    const container = containerRef.current
    const ps = pageSizeRef.current
    if (!container || !ps) return
    const padding = 32 // p-4 = 16px each side
    const availW = container.clientWidth - padding
    const availH = container.clientHeight - padding
    const fitScale = Math.min(availW / ps.w, availH / ps.h)
    setScale(Math.max(0.1, Math.min(5, fitScale)))
  }, [])

  const handlePageSize = useCallback((w: number, h: number) => {
    pageSizeRef.current = { w, h }
  }, [])

  return (
    <div className="flex flex-col h-full" style={{ backgroundColor: 'var(--sol-editor-bg)' }}>
      {/* Toolbar */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 text-[12px] shrink-0"
        style={{
          backgroundColor: 'var(--sol-header-bg)',
          borderBottom: '1px solid var(--sol-border)',
          color: 'var(--sol-text)',
        }}
      >
        <button
          onClick={() => setPage(p => Math.max(1, p - 1))}
          disabled={page <= 1}
          className="p-0.5 rounded hover:bg-sol-hover-bg disabled:opacity-30"
        >
          <ChevronLeft size={14} />
        </button>
        <span style={{ minWidth: 80, textAlign: 'center' }}>
          {page} / {numPages}
        </span>
        <button
          onClick={() => setPage(p => Math.min(numPages, p + 1))}
          disabled={page >= numPages}
          className="p-0.5 rounded hover:bg-sol-hover-bg disabled:opacity-30"
        >
          <ChevronRight size={14} />
        </button>

        <div className="w-px h-4 mx-1" style={{ backgroundColor: 'var(--sol-border)' }} />

        <button
          onClick={() => setScale(s => Math.max(0.5, s - 0.2))}
          className="p-0.5 rounded hover:bg-sol-hover-bg"
        >
          <ZoomOut size={14} />
        </button>
        <span style={{ minWidth: 40, textAlign: 'center' }}>
          {Math.round(scale * 100)}%
        </span>
        <button
          onClick={() => setScale(s => Math.min(3, s + 0.2))}
          className="p-0.5 rounded hover:bg-sol-hover-bg"
        >
          <ZoomIn size={14} />
        </button>

        <button
          onClick={fitToScreen}
          title="Fit to screen"
          className="p-0.5 rounded hover:bg-sol-hover-bg"
        >
          <Maximize size={14} />
        </button>
      </div>

      {/* Page — scrollable in both directions */}
      <div ref={containerRef} className="flex-1 min-h-0 overflow-auto p-4 select-text">
        <div className="min-w-min flex justify-center">
          <Suspense fallback={<div className="loading-spinner" />}>
            <PdfRenderer
              src={src}
              page={page}
              scale={scale}
              onLoadSuccess={setNumPages}
              onPageSize={handlePageSize}
            />
          </Suspense>
        </div>
      </div>
    </div>
  )
}
