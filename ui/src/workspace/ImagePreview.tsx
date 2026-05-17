import { Maximize2, ZoomIn, ZoomOut } from 'lucide-react'
import { useState } from 'react'

const MIN_SCALE = 0.25
const MAX_SCALE = 4
const SCALE_STEP = 0.25

function clampScale(scale: number) {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale))
}

export function ImagePreview({ src }: { src: string }) {
  const [scale, setScale] = useState(1)

  const zoomOut = () => setScale(current => clampScale(current - SCALE_STEP))
  const zoomIn = () => setScale(current => clampScale(current + SCALE_STEP))
  const fitWidth = () => setScale(1)

  return (
    <div
      className="flex flex-col h-full w-full"
      style={{ backgroundColor: 'var(--sol-editor-bg)' }}
    >
      <div
        className="flex items-center gap-2 px-3 py-1.5 text-[12px] shrink-0"
        style={{
          backgroundColor: 'var(--sol-header-bg)',
          borderBottom: '1px solid var(--sol-border)',
          color: 'var(--sol-text)',
        }}
      >
        <button
          type="button"
          onClick={zoomOut}
          disabled={scale <= MIN_SCALE}
          title="Zoom out"
          aria-label="Zoom out"
          className="p-0.5 rounded hover:bg-sol-hover-bg disabled:opacity-30"
        >
          <ZoomOut size={14} />
        </button>
        <span style={{ minWidth: 40, textAlign: 'center' }}>
          {Math.round(scale * 100)}%
        </span>
        <button
          type="button"
          onClick={zoomIn}
          disabled={scale >= MAX_SCALE}
          title="Zoom in"
          aria-label="Zoom in"
          className="p-0.5 rounded hover:bg-sol-hover-bg disabled:opacity-30"
        >
          <ZoomIn size={14} />
        </button>

        <div className="w-px h-4 mx-1" style={{ backgroundColor: 'var(--sol-border)' }} />

        <button
          type="button"
          onClick={fitWidth}
          title="Fit width"
          aria-label="Fit width"
          className="p-0.5 rounded hover:bg-sol-hover-bg"
        >
          <Maximize2 size={14} />
        </button>
      </div>

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
    </div>
  )
}
