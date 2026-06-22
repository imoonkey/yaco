import { useEffect, useMemo, useState } from 'react'
import { prepareHtmlPreviewSrcDoc } from './htmlPreviewSrcDoc'

// Sandboxed iframe preview for HTML files. The iframe runs WITHOUT
// `allow-same-origin`, so the document gets a unique opaque origin and cannot
// reach the parent app, localStorage, cookies, or our APIs — the load-bearing
// boundary for previewing untrusted (often agent-generated) HTML. The other
// flags only grant in-page interactivity (dialogs, popups, form submit);
// `allow-same-origin`, `allow-top-navigation`, and popup sandbox-escape are
// deliberately excluded.
//
// Tradeoff: relative asset URLs (`<img src="./logo.png">`) won't resolve,
// because srcdoc is pinned to about:srcdoc. Self-contained HTML (inline CSS/JS,
// data URIs, CDN-hosted assets) works as expected.
const SANDBOX = 'allow-scripts allow-modals allow-popups allow-forms'

// `useRaw` is set for files over the editor's 1 MB content cap: the live buffer
// never loaded, so the bytes are fetched once from the higher-limit /raw endpoint
// (as text) and rendered through the same srcdoc — the security model is unchanged.
export function HtmlPreview({ content, rawUrl, useRaw }: { content: string; rawUrl: string; useRaw: boolean }) {
  // Keyed on the URL it was fetched for, so a rawUrl change reads as "not ready
  // yet" without a synchronous reset in the effect body.
  const [raw, setRaw] = useState<{ url: string; content: string | null; error: boolean }>({ url: '', content: null, error: false })

  useEffect(() => {
    if (!useRaw || !rawUrl) return
    const ac = new AbortController()
    let active = true
    fetch(rawUrl, { signal: ac.signal })
      .then(res => res.ok ? res.text() : Promise.reject(new Error(String(res.status))))
      .then(text => { if (active) setRaw({ url: rawUrl, content: text, error: false }) })
      .catch((err: unknown) => { if (active && (err as { name?: string })?.name !== 'AbortError') setRaw({ url: rawUrl, content: null, error: true }) })
    return () => { active = false; ac.abort() }
  }, [useRaw, rawUrl])

  const ready = raw.url === rawUrl
  const rawContent = ready ? raw.content : null
  const rawError = ready && raw.error

  const source = useRaw ? rawContent : content
  const srcDoc = useMemo(() => source == null ? '' : prepareHtmlPreviewSrcDoc(source), [source])

  if (useRaw && rawError) {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: 'var(--sol-text)' }}>
        Unable to load preview
      </div>
    )
  }
  if (useRaw && rawContent == null) {
    return <div className="flex items-center justify-center h-full"><div className="loading-spinner" /></div>
  }

  return (
    <iframe
      title="HTML preview"
      srcDoc={srcDoc}
      sandbox={SANDBOX}
      referrerPolicy="no-referrer"
      className="w-full h-full"
      style={{ border: 'none', backgroundColor: 'white' }}
    />
  )
}
