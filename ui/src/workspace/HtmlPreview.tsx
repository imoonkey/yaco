import { useMemo } from 'react'

// Sandboxed iframe preview for HTML files. The iframe runs with `allow-scripts`
// only — no `allow-same-origin`, so the document gets a unique opaque origin
// and cannot reach the parent app, localStorage, cookies, or our APIs.
//
// Tradeoff: relative asset URLs (`<img src="./logo.png">`) won't resolve,
// because srcdoc has no base URL. Self-contained HTML (inline CSS/JS, data
// URIs, CDN-hosted assets) works as expected.
export function HtmlPreview({ content }: { content: string }) {
  const srcDoc = useMemo(() => content, [content])
  return (
    <iframe
      title="HTML preview"
      srcDoc={srcDoc}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className="w-full h-full"
      style={{ border: 'none', backgroundColor: 'white' }}
    />
  )
}
