// Native browser player — play/pause, seek, volume, fullscreen, picture-in-picture.
// The raw endpoint answers range requests, so seeking fetches only what it plays.
export function VideoPreview({ src }: { src: string }) {
  return (
    <div
      className="flex items-center justify-center h-full w-full p-4"
      style={{ backgroundColor: 'var(--sol-editor-bg)' }}
    >
      <video src={src} controls playsInline preload="metadata" className="max-w-full max-h-full" />
    </div>
  )
}
