export function ImagePreview({ src }: { src: string }) {
  return (
    <div
      className="flex items-center justify-center h-full w-full overflow-auto"
      style={{ backgroundColor: 'var(--sol-editor-bg)' }}
    >
      <img
        src={src}
        style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
        draggable={false}
      />
    </div>
  )
}
