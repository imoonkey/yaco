import { describe, it, expect } from 'vitest'
import { prepareHtmlPreviewSrcDoc } from '../htmlPreviewSrcDoc'

describe('prepareHtmlPreviewSrcDoc', () => {
  it('pins srcdoc base URL so fragment links stay inside the iframe', () => {
    const html = '<!doctype html><html><head><title>Doc</title></head><body><a href="#s1">Section</a><section id="s1"></section></body></html>'

    const prepared = prepareHtmlPreviewSrcDoc(html)

    expect(prepared).toContain('<head>\n<base href="about:srcdoc">')
    expect(prepared.indexOf('<base href="about:srcdoc">')).toBeLessThan(prepared.indexOf('<title>Doc</title>'))
  })

  it('does not override a document-provided base tag', () => {
    const html = '<html><head><base href="https://example.test/docs/"><title>Doc</title></head><body></body></html>'

    expect(prepareHtmlPreviewSrcDoc(html)).toBe(html)
  })

  it('adds a head when previewing an HTML fragment', () => {
    const prepared = prepareHtmlPreviewSrcDoc('<main>hello</main>')

    expect(prepared.startsWith('<head><base href="about:srcdoc"></head>\n')).toBe(true)
  })
})
