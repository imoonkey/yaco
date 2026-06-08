import { MoveHorizontal, MoveVertical, ZoomIn, ZoomOut } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

const MIN_SCALE = 0.25
const MAX_SCALE = 4
const SCALE_STEP = 0.25

type FitMode = 'width' | 'height'

function clampScale(scale: number) {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale))
}

export function ImagePreview({ src }: { src: string }) {
  const [scale, setScale] = useState(1)
  const [fitMode, setFitMode] = useState<FitMode>('width')
  const containerRef = useRef<HTMLDivElement>(null)

  const zoomOut = () => {
    setFitMode('width')
    setScale(current => clampScale(current - SCALE_STEP))
  }
  const zoomIn = () => {
    setFitMode('width')
    setScale(current => clampScale(current + SCALE_STEP))
  }
  const fitWidth = () => {
    setFitMode('width')
    setScale(1)
  }
  const fitHeight = () => {
    setFitMode('height')
  }

  useEffect(() => {
    containerRef.current?.focus({ preventScroll: true })
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    switch (e.key) {
      case 'w':
      case 'W':
        fitWidth()
        e.preventDefault()
        break
      case 'h':
      case 'H':
        fitHeight()
        e.preventDefault()
        break
      case '+':
      case '=':
        zoomIn()
        e.preventDefault()
        break
      case '-':
      case '_':
        zoomOut()
        e.preventDefault()
        break
    }
  }

  const isFitHeight = fitMode === 'height'

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="flex flex-col h-full w-full outline-none"
      style={{ backgroundColor: 'var(--sol-editor-bg)' }}
    >
      <div
        className="flex items-center gap-2 px-3 py-1.5 text-ui-md shrink-0"
        style={{
          backgroundColor: 'var(--sol-header-bg)',
          borderBottom: '1px solid var(--sol-border)',
          color: 'var(--sol-text)',
        }}
      >
        <button
          type="button"
          onClick={zoomOut}
          disabled={!isFitHeight && scale <= MIN_SCALE}
          title="Zoom out (−)"
          aria-label="Zoom out"
          className="p-0.5 rounded hover:bg-sol-hover-bg disabled:opacity-30"
        >
          <ZoomOut size={14} />
        </button>
        <span style={{ minWidth: 40, textAlign: 'center' }}>
          {isFitHeight ? 'Fit' : `${Math.round(scale * 100)}%`}
        </span>
        <button
          type="button"
          onClick={zoomIn}
          disabled={!isFitHeight && scale >= MAX_SCALE}
          title="Zoom in (+)"
          aria-label="Zoom in"
          className="p-0.5 rounded hover:bg-sol-hover-bg disabled:opacity-30"
        >
          <ZoomIn size={14} />
        </button>

        <div className="w-px h-4 mx-1" style={{ backgroundColor: 'var(--sol-border)' }} />

        <button
          type="button"
          onClick={fitWidth}
          title="Fit width (W)"
          aria-label="Fit width"
          aria-pressed={!isFitHeight && scale === 1}
          className="p-0.5 rounded hover:bg-sol-hover-bg"
        >
          <MoveHorizontal size={14} />
        </button>
        <button
          type="button"
          onClick={fitHeight}
          title="Fit height (H)"
          aria-label="Fit height"
          aria-pressed={isFitHeight}
          className="p-0.5 rounded hover:bg-sol-hover-bg"
        >
          <MoveVertical size={14} />
        </button>
      </div>

      {isFitHeight ? (
        <div className="flex-1 min-h-0 overflow-auto p-4 flex items-center justify-center">
          <img
            src={src}
            alt="Image preview"
            className="block select-none"
            style={{ height: '100%', width: 'auto', maxWidth: 'none' }}
            draggable={false}
          />
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto p-4">
          <div className={`min-w-full flex ${scale > 1 ? 'justify-start' : 'justify-center'}`}>
            <img
              src={src}
              alt="Image preview"
              className="block select-none"
              style={{ width: `${scale * 100}%`, maxWidth: 'none', height: 'auto' }}
              draggable={false}
            />
          </div>
        </div>
      )}
    </div>
  )
}
