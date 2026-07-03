// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { MarkdownPreview } from '../WorkspaceEditorArea'

// Fake mermaid that mimics the real v11 side effect: on a parse failure,
// render() appends its error diagram (id `d<id>`) to document.body and throws,
// leaving an orphan "Syntax error" bomb. A valid render returns svg and cleans
// up after itself.
const BROKEN = 'BROKENDIAGRAM'
const fakeMermaid = {
  initialize: vi.fn(),
  render: vi.fn(async (id: string, text: string) => {
    if (text.includes(BROKEN)) {
      const orphan = document.createElement('div')
      orphan.id = `d${id}`
      orphan.innerHTML = '<svg aria-roledescription="error">Syntax error in text</svg>'
      document.body.appendChild(orphan)
      throw new Error('Parse error on line 1')
    }
    return { svg: '<svg data-ok="1"></svg>' }
  }),
}

vi.mock('../markdown', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../markdown')>()),
  loadMermaid: () => Promise.resolve(fakeMermaid),
}))

const mermaidDoc = (body: string) => '```mermaid\n' + body + '\n```\n'
const orphans = () => document.querySelectorAll('[id^="dmermaid-"]').length

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub)
vi.stubGlobal('matchMedia', (query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  onchange: null,
  dispatchEvent() {
    return false
  },
}))

afterEach(() => {
  cleanup()
  document.querySelectorAll('[id^="dmermaid-"]').forEach((n) => n.remove())
  fakeMermaid.render.mockClear()
})

describe('MarkdownPreview mermaid orphan cleanup', () => {
  it('drops the orphan bomb from a failed render instead of leaving it in <body>', async () => {
    const view = render(<MarkdownPreview content={mermaidDoc(`flowchart TD\n  ${BROKEN}`)} viewportLine={1} />)
    // The render failed and mermaid appended its bomb; the fix must remove it.
    await waitFor(() => expect(fakeMermaid.render).toHaveBeenCalled())
    await waitFor(() => expect(orphans()).toBe(0))
    // The diagram cell shows yaco's inline error, not a floating bomb.
    expect(view.container.querySelector('.mermaid pre')?.textContent).toContain('Parse error')
    expect(document.body.textContent).not.toContain('Syntax error in text')
  })

  it('sweeps a stale orphan left by a previous pass on the next render', async () => {
    // Simulate a bomb stuck in <body> from an earlier broken edit.
    const stale = document.createElement('div')
    stale.id = 'dmermaid-stale-0'
    stale.innerHTML = '<svg aria-roledescription="error">Syntax error in text</svg>'
    document.body.appendChild(stale)
    expect(orphans()).toBe(1)

    // A subsequent render of now-valid content must clear it.
    render(<MarkdownPreview content={mermaidDoc('flowchart TD\n  A --> B')} viewportLine={1} />)
    await waitFor(() => expect(fakeMermaid.render).toHaveBeenCalled())
    await waitFor(() => expect(orphans()).toBe(0))
    expect(document.body.textContent).not.toContain('Syntax error in text')
  })
})
