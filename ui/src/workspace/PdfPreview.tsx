// Native browser PDF viewer — continuous scroll, keyboard nav, zoom, search,
// page thumbnails all come for free. The raw endpoint serves the correct MIME
// type, so the URL embeds directly via an <iframe>.
export function PdfPreview({ src }: { src: string }) {
  return (
    <iframe
      src={src}
      title="PDF preview"
      className="w-full h-full"
      style={{ border: 'none', backgroundColor: 'var(--sol-editor-bg)' }}
    />
  )
}
