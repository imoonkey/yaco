import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

// Configure worker via CDN — reliable across Vite dev and production builds
pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`

export default function PdfRenderer({
  src,
  page,
  scale,
  onLoadSuccess,
  onPageSize,
}: {
  src: string
  page: number
  scale: number
  onLoadSuccess: (numPages: number) => void
  onPageSize?: (width: number, height: number) => void
}) {
  return (
    <Document
      file={src}
      onLoadSuccess={({ numPages }) => onLoadSuccess(numPages)}
      loading={<div className="loading-spinner" />}
      error={
        <div style={{ color: 'var(--sol-red)', fontSize: 13 }}>
          Failed to load PDF
        </div>
      }
    >
      <Page
        pageNumber={page}
        scale={scale}
        loading={<div className="loading-spinner" />}
        onLoadSuccess={(p) => onPageSize?.(p.originalWidth, p.originalHeight)}
      />
    </Document>
  )
}
