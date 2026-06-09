// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EditorState, EditorSelection, Compartment } from '@codemirror/state'
import { EditorView, runScopeHandlers } from '@codemirror/view'
import {
  inlineAutocomplete,
  SUGGESTION_DEBOUNCE_MS,
  isSecretPath,
  isInsideFence,
  isMidWord,
  nextWordLength,
  type CompletionProvider,
} from '../../lib/editor/inlineAutocomplete'

// --- Pure helper tests ---

describe('isSecretPath', () => {
  it('flags env / key / cert files and secret directories', () => {
    expect(isSecretPath('.env')).toBe(true)
    expect(isSecretPath('config/.env.local')).toBe(true)
    expect(isSecretPath('certs/server.pem')).toBe(true)
    expect(isSecretPath('a/b/private.key')).toBe(true)
    expect(isSecretPath('tls/site.crt')).toBe(true)
    expect(isSecretPath('home/id_rsa')).toBe(true)
    expect(isSecretPath('user/.ssh/notes.md')).toBe(true)
    expect(isSecretPath('secrets/plan.md')).toBe(true)
  })
  it('leaves ordinary markdown alone', () => {
    expect(isSecretPath('plan/design.md')).toBe(false)
    expect(isSecretPath('environment.md')).toBe(false)
  })
})

describe('isInsideFence', () => {
  function doc(text: string) {
    return EditorState.create({ doc: text }).doc
  }
  it('detects an open fence above the cursor', () => {
    const d = doc('```js\nconst x = 1\n')
    expect(isInsideFence(d, d.length)).toBe(true)
  })
  it('returns false once the fence closes', () => {
    const d = doc('```js\nconst x = 1\n```\nprose ')
    expect(isInsideFence(d, d.length)).toBe(false)
  })
  it('keeps a longer fence open across a shorter same-char line inside it', () => {
    // 4-backtick opener containing a 3-backtick line — the inner line is content,
    // not a valid closer, so the cursor is still inside the block.
    const d = doc('````\n```\nstill code\n')
    expect(isInsideFence(d, d.length)).toBe(true)
  })
  it('only closes on a same-char fence with no trailing text', () => {
    const tilde = doc('~~~\ncode\n```\nstill code\n') // ``` cannot close a ~~~ fence
    expect(isInsideFence(tilde, tilde.length)).toBe(true)
  })
})

describe('isMidWord', () => {
  function doc(text: string) {
    return EditorState.create({ doc: text }).doc
  }
  it('true only when word chars sit on both sides', () => {
    const d = doc('word')
    expect(isMidWord(d, 2)).toBe(true)
    expect(isMidWord(d, 4)).toBe(false) // end of word
    expect(isMidWord(d, 0)).toBe(false) // start
  })
})

describe('nextWordLength', () => {
  it('takes leading whitespace plus one token', () => {
    expect(nextWordLength(' more text')).toBe(5) // " more"
    expect(nextWordLength('rest of it')).toBe(4) // "rest"
    expect(nextWordLength('solo')).toBe(4)
  })
})

// --- Extension behavior tests ---

const views: EditorView[] = []

function makeView(filePath: string, provider: CompletionProvider, docText = '') {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const state = EditorState.create({
    doc: docText,
    selection: EditorSelection.cursor(docText.length),
    extensions: [inlineAutocomplete(provider, filePath)],
  })
  const view = new EditorView({ state, parent })
  views.push(view)
  return view
}

function typeAt(view: EditorView, from: number, text: string) {
  view.dispatch({
    changes: { from, insert: text },
    selection: EditorSelection.cursor(from + text.length),
    userEvent: 'input.type',
  })
}

function typeEnd(view: EditorView, text: string) {
  typeAt(view, view.state.doc.length, text)
}

function pasteAt(view: EditorView, from: number, text: string) {
  view.dispatch({
    changes: { from, insert: text },
    selection: EditorSelection.cursor(from + text.length),
    userEvent: 'input.paste',
  })
}

function blur(view: EditorView) {
  view.contentDOM.dispatchEvent(new Event('blur'))
}

function press(view: EditorView, key: string, mods: Partial<KeyboardEventInit> = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods })
  return runScopeHandlers(view, event, 'editor')
}

function ghost(view: EditorView): string | null {
  return view.dom.querySelector('.cm-inline-ghost')?.textContent ?? null
}

async function tick() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

// Status endpoint reports the feature available; provider is injected directly.
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ enabled: true }),
  })) as unknown as typeof fetch)
})

afterEach(() => {
  views.splice(0).forEach(v => v.destroy())
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function enabledView(filePath: string, provider: CompletionProvider, docText = '') {
  const view = makeView(filePath, provider, docText)
  await tick() // let the status check resolve so `enabled` flips true
  return view
}

describe('inlineAutocomplete request gating', () => {
  it('debounces, then requests after markdown typing and shows a single-line ghost', async () => {
    const provider = vi.fn<CompletionProvider>().mockResolvedValue(' in the morning')
    const view = await enabledView('plan/design.md', provider)

    typeEnd(view, 'hello world')
    await vi.advanceTimersByTimeAsync(SUGGESTION_DEBOUNCE_MS - 100)
    expect(provider).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(100)
    await tick()
    expect(provider).toHaveBeenCalledTimes(1)
    expect(ghost(view)).toBe(' in the morning')
  })

  it('makes no request for a non-markdown file', async () => {
    const provider = vi.fn<CompletionProvider>().mockResolvedValue('x')
    const view = await enabledView('src/index.ts', provider)

    typeEnd(view, 'const value = 1')
    await vi.advanceTimersByTimeAsync(SUGGESTION_DEBOUNCE_MS)
    expect(provider).not.toHaveBeenCalled()
  })

  it('makes no request for a secret-glob markdown file', async () => {
    const provider = vi.fn<CompletionProvider>().mockResolvedValue('x')
    const view = await enabledView('secrets/notes.md', provider)

    typeEnd(view, 'hello world')
    await vi.advanceTimersByTimeAsync(SUGGESTION_DEBOUNCE_MS)
    expect(provider).not.toHaveBeenCalled()
  })

  it('makes no request inside a fenced code block', async () => {
    const provider = vi.fn<CompletionProvider>().mockResolvedValue('x')
    const view = await enabledView('plan/design.md', provider, '```js\n')

    typeEnd(view, 'const value = 1')
    await vi.advanceTimersByTimeAsync(SUGGESTION_DEBOUNCE_MS)
    expect(provider).not.toHaveBeenCalled()
  })

  it('makes no request mid-word', async () => {
    const provider = vi.fn<CompletionProvider>().mockResolvedValue('x')
    const view = await enabledView('plan/design.md', provider, 'abcdefgh ab')

    typeAt(view, 10, 'a') // cursor lands between two word chars
    await vi.advanceTimersByTimeAsync(SUGGESTION_DEBOUNCE_MS)
    expect(provider).not.toHaveBeenCalled()
  })

  it('makes no request below the length threshold', async () => {
    const provider = vi.fn<CompletionProvider>().mockResolvedValue('x')
    const view = await enabledView('plan/design.md', provider)

    typeEnd(view, 'hi')
    await vi.advanceTimersByTimeAsync(SUGGESTION_DEBOUNCE_MS)
    expect(provider).not.toHaveBeenCalled()
  })

  it('requests immediately after a fresh list marker despite the threshold', async () => {
    const provider = vi.fn<CompletionProvider>().mockResolvedValue('first item')
    const view = await enabledView('plan/design.md', provider)

    typeEnd(view, '- ')
    await vi.advanceTimersByTimeAsync(SUGGESTION_DEBOUNCE_MS)
    await tick()
    expect(provider).toHaveBeenCalledTimes(1)
  })

  it('does not bypass the threshold once content follows the marker', async () => {
    const provider = vi.fn<CompletionProvider>().mockResolvedValue('x')
    const view = await enabledView('plan/design.md', provider)

    typeEnd(view, '- a') // a started list item with one char — below threshold
    await vi.advanceTimersByTimeAsync(SUGGESTION_DEBOUNCE_MS)
    expect(provider).not.toHaveBeenCalled()
  })

  it('does not bypass the threshold for a mid-line marker with content after the cursor', async () => {
    const provider = vi.fn<CompletionProvider>().mockResolvedValue('x')
    const view = await enabledView('plan/design.md', provider, '-a')

    typeAt(view, 1, ' ') // -> "- a" with the cursor between "- " and "a"
    await vi.advanceTimersByTimeAsync(SUGGESTION_DEBOUNCE_MS)
    expect(provider).not.toHaveBeenCalled()
  })

  it('makes no request for a paste (not genuine typing)', async () => {
    const provider = vi.fn<CompletionProvider>().mockResolvedValue('x')
    const view = await enabledView('plan/design.md', provider)

    pasteAt(view, 0, 'pasted markdown sentence')
    await vi.advanceTimersByTimeAsync(SUGGESTION_DEBOUNCE_MS)
    expect(provider).not.toHaveBeenCalled()
  })

  it('cancels a pending request when the editor blurs during debounce', async () => {
    const provider = vi.fn<CompletionProvider>().mockResolvedValue('x')
    const view = await enabledView('plan/design.md', provider)

    typeEnd(view, 'hello world')
    await vi.advanceTimersByTimeAsync(SUGGESTION_DEBOUNCE_MS - 200)
    blur(view)
    await vi.advanceTimersByTimeAsync(400)
    expect(provider).not.toHaveBeenCalled()
  })

  it('drops a stale in-flight response after Escape', async () => {
    let resolveProvider: (v: string) => void = () => {}
    const provider = vi.fn<CompletionProvider>(
      () => new Promise<string>(r => { resolveProvider = r }),
    )
    const view = await enabledView('plan/design.md', provider, 'hello world')

    // Manual invoke fires a request immediately (no debounce).
    expect(press(view, '\\', { altKey: true })).toBe(true)
    await tick()
    expect(provider).toHaveBeenCalledTimes(1)

    press(view, 'Escape')
    resolveProvider(' stale text')
    await tick()
    expect(ghost(view)).toBeNull()
  })

  it('drops a late in-flight response after the extension is disabled/torn down', async () => {
    let resolveProvider: (v: string) => void = () => {}
    const provider = vi.fn<CompletionProvider>(
      () => new Promise<string>(r => { resolveProvider = r }),
    )
    const comp = new Compartment()
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new EditorView({
      state: EditorState.create({
        doc: 'hello world',
        selection: EditorSelection.cursor(11),
        extensions: [comp.of(inlineAutocomplete(provider, 'plan/design.md'))],
      }),
      parent,
    })
    views.push(view)
    await tick() // status resolves

    expect(press(view, '\\', { altKey: true })).toBe(true) // manual request in flight
    await tick()
    expect(provider).toHaveBeenCalledTimes(1)

    // Editor disables the feature → compartment reconfigures to nothing → plugin destroy().
    view.dispatch({ effects: comp.reconfigure([]) })
    resolveProvider(' late text')
    await tick()

    expect(ghost(view)).toBeNull()
    expect(view.state.doc.toString()).toBe('hello world')
  })

  it('ignores a stale response after the cursor moves', async () => {
    let resolveProvider: (v: string) => void = () => {}
    const provider = vi.fn<CompletionProvider>(
      () => new Promise<string>(r => { resolveProvider = r }),
    )
    const view = await enabledView('plan/design.md', provider, 'hello world')

    typeEnd(view, ' again')
    await vi.advanceTimersByTimeAsync(SUGGESTION_DEBOUNCE_MS)
    expect(provider).toHaveBeenCalledTimes(1)

    // Move the cursor while the request is in flight, then let it resolve.
    view.dispatch({ selection: EditorSelection.cursor(0) })
    resolveProvider(' stale text')
    await tick()
    expect(ghost(view)).toBeNull()
  })
})

describe('inlineAutocomplete accept / dismiss', () => {
  async function showing(provider: CompletionProvider) {
    const view = await enabledView('plan/design.md', provider)
    typeEnd(view, 'hello world')
    await vi.advanceTimersByTimeAsync(SUGGESTION_DEBOUNCE_MS)
    await tick()
    return view
  }

  it('Tab accepts the full suggestion', async () => {
    const provider = vi.fn<CompletionProvider>().mockResolvedValue(' more text')
    const view = await showing(provider)
    expect(ghost(view)).toBe(' more text')

    expect(press(view, 'Tab')).toBe(true)
    expect(view.state.doc.toString()).toBe('hello world more text')
    expect(ghost(view)).toBeNull()
  })

  it('accept-word inserts one word and keeps the remainder anchored without a new request', async () => {
    const provider = vi.fn<CompletionProvider>().mockResolvedValue(' more text here')
    const view = await showing(provider)

    expect(press(view, 'ArrowRight', { ctrlKey: true })).toBe(true)
    expect(view.state.doc.toString()).toBe('hello world more')
    expect(ghost(view)).toBe(' text here')
    expect(provider).toHaveBeenCalledTimes(1) // no follow-up server call
  })

  it('Escape dismisses without changing the document', async () => {
    const provider = vi.fn<CompletionProvider>().mockResolvedValue(' more text')
    const view = await showing(provider)

    expect(press(view, 'Escape')).toBe(true)
    expect(view.state.doc.toString()).toBe('hello world')
    expect(ghost(view)).toBeNull()
  })

  it('typing clears a visible suggestion', async () => {
    const provider = vi.fn<CompletionProvider>().mockResolvedValue(' more text')
    const view = await showing(provider)

    typeEnd(view, '!')
    expect(ghost(view)).toBeNull()
  })
})
