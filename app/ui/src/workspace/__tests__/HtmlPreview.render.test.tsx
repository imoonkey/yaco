// @vitest-environment jsdom
import { render, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HtmlPreview } from '../HtmlPreview'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('HtmlPreview', () => {
  it('renders the live buffer through srcdoc when not oversize', () => {
    render(<HtmlPreview content="<h1>BUFFER</h1>" rawUrl="/api/files/p/raw?path=a.html" useRaw={false} />)
    const frame = screen.getByTitle('HTML preview') as HTMLIFrameElement
    expect(frame.getAttribute('srcdoc')).toContain('<h1>BUFFER</h1>')
  })

  it('keeps the opaque-origin sandbox boundary (scripts but never same-origin)', () => {
    render(<HtmlPreview content="<p>x</p>" rawUrl="" useRaw={false} />)
    const sandbox = screen.getByTitle('HTML preview').getAttribute('sandbox') ?? ''
    expect(sandbox).toContain('allow-scripts')
    expect(sandbox).toContain('allow-modals')
    expect(sandbox).toContain('allow-popups')
    expect(sandbox).not.toContain('allow-same-origin')
    expect(sandbox).not.toContain('allow-top-navigation')
  })

  it('fetches the bytes from /raw as text when the file is oversize', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve('<h1>RAW</h1>') }))
    vi.stubGlobal('fetch', fetchMock)

    render(<HtmlPreview content="" rawUrl="/api/files/p/raw?path=big.html" useRaw={true} />)

    const frame = await screen.findByTitle('HTML preview') as HTMLIFrameElement
    expect(fetchMock).toHaveBeenCalledWith('/api/files/p/raw?path=big.html', expect.objectContaining({ signal: expect.anything() }))
    expect(frame.getAttribute('srcdoc')).toContain('<h1>RAW</h1>')
  })

  it('shows an error note when the raw fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('') })))

    render(<HtmlPreview content="" rawUrl="/api/files/p/raw?path=big.html" useRaw={true} />)

    expect(await screen.findByText('Unable to load preview')).toBeTruthy()
  })
})
