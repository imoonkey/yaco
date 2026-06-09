import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock response factory
function chatResponse(content: string) {
  return { choices: [{ message: { content } }] }
}

// Track calls to the mocked create method
let mockCreate: ReturnType<typeof vi.fn>

vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      constructor() {}
      chat = {
        completions: {
          get create() { return mockCreate },
        },
      }
    },
  }
})

import {
  resolveAutocompleteModels,
  getAutocompleteModel,
  isAutocompleteEnabled,
  isMarkdownPath,
  isLikelySecretPath,
  isInsideFence,
  extractHeadingPath,
  buildProseContext,
  postprocess,
  clearCompletionCache,
  complete,
} from '../autocomplete'

// --- resolveAutocompleteModels (unchanged) ---

describe('resolveAutocompleteModels', () => {
  afterEach(() => {
    delete process.env.AUTOCOMPLETE_MODELS
    delete process.env.AUTOCOMPLETE_MODEL
  })

  it('returns default model chain when no env vars set', () => {
    expect(resolveAutocompleteModels()).toEqual([
      'qwen/qwen3-32b',
      'moonshotai/kimi-k2-instruct',
      'llama-3.1-8b-instant',
    ])
  })

  it('parses AUTOCOMPLETE_MODELS comma-separated list', () => {
    process.env.AUTOCOMPLETE_MODELS = 'model-a, model-b'
    expect(resolveAutocompleteModels()).toEqual(['model-a', 'model-b'])
  })

  it('falls back to AUTOCOMPLETE_MODEL single model', () => {
    process.env.AUTOCOMPLETE_MODEL = 'custom-model'
    expect(resolveAutocompleteModels()).toEqual(['custom-model'])
  })

  it('prefers AUTOCOMPLETE_MODELS over AUTOCOMPLETE_MODEL', () => {
    process.env.AUTOCOMPLETE_MODELS = 'model-a'
    process.env.AUTOCOMPLETE_MODEL = 'model-b'
    expect(resolveAutocompleteModels()).toEqual(['model-a'])
  })

  it('exposes the primary model via getAutocompleteModel', () => {
    process.env.AUTOCOMPLETE_MODELS = 'model-a,model-b'
    expect(getAutocompleteModel()).toBe('model-a')
  })
})

// --- isAutocompleteEnabled ---

describe('isAutocompleteEnabled', () => {
  beforeEach(() => {
    delete process.env.GROQ_API_KEY
  })

  afterEach(() => {
    delete process.env.GROQ_API_KEY
  })

  it('returns false when GROQ_API_KEY is not set', () => {
    expect(isAutocompleteEnabled()).toBe(false)
  })

  it('returns true when GROQ_API_KEY is set', () => {
    process.env.GROQ_API_KEY = 'test-key'
    expect(isAutocompleteEnabled()).toBe(true)
  })
})

// --- path guards ---

describe('isMarkdownPath', () => {
  it('accepts markdown extensions', () => {
    for (const p of ['notes.md', 'README.mdx', 'doc.markdown']) {
      expect(isMarkdownPath(p)).toBe(true)
    }
  })

  it('rejects non-markdown paths and undefined', () => {
    for (const p of ['app.ts', 'main.py', 'data.json', undefined]) {
      expect(isMarkdownPath(p)).toBe(false)
    }
  })
})

describe('isLikelySecretPath', () => {
  it('flags secret-looking paths', () => {
    for (const p of [
      '.env',
      '.env.local',
      'config/app.pem',
      'server.key',
      'cert.crt',
      'id_rsa',
      'home/.ssh/config',
      'secrets/token.md',
    ]) {
      expect(isLikelySecretPath(p)).toBe(true)
    }
  })

  it('does not flag ordinary markdown paths', () => {
    for (const p of ['doc/notes.md', 'environment.md', 'README.md', undefined]) {
      expect(isLikelySecretPath(p)).toBe(false)
    }
  })
})

describe('isInsideFence', () => {
  it('is true when the cursor sits inside an open fence', () => {
    expect(isInsideFence('```js\nconsole.log(')).toBe(true)
    expect(isInsideFence('text\n~~~\nfoo\nbar ')).toBe(true)
  })

  it('is false when the fence is closed or absent', () => {
    expect(isInsideFence('```\ncode\n```\nprose ')).toBe(false)
    expect(isInsideFence('just prose here ')).toBe(false)
  })
})

// --- extractHeadingPath ---

describe('extractHeadingPath', () => {
  it('returns the nearest H1>..>Hn chain above the cursor', () => {
    expect(extractHeadingPath('# Title\n## Section\ntext ')).toEqual(['Title', 'Section'])
  })

  it('pops siblings so only the active chain remains', () => {
    const prefix = '# A\n## B\n### C\n## D\nbody '
    expect(extractHeadingPath(prefix)).toEqual(['A', 'D'])
  })

  it('ignores headings inside fenced code', () => {
    const prefix = '# Real\n```\n# not a heading\n```\nprose '
    expect(extractHeadingPath(prefix)).toEqual(['Real'])
  })

  it('returns an empty chain when there are no headings', () => {
    expect(extractHeadingPath('plain prose ')).toEqual([])
  })
})

// --- buildProseContext ---

describe('buildProseContext', () => {
  it('includes the heading path, current block, and byte-budgeted context', () => {
    const prefix = '# Heading\n\nFirst para.\n\nThe quick brown '
    const suffix = ' over the dog.\n\nLater para.'
    const ctx = buildProseContext(prefix, suffix)
    expect(ctx.headingPath).toEqual(['Heading'])
    expect(ctx.currentBlock).toBe('The quick brown <CURSOR> over the dog.')
    expect(ctx.before).toContain('First para.')
    expect(ctx.after).toContain('Later para.')
  })

  it('keeps exactly one <CURSOR> even when the document already contains the literal (MED-5)', () => {
    const ctx = buildProseContext('a\n\nliteral <CURSOR> here ', ' and <CURSOR> there\n\ne')
    const markers = ctx.currentBlock.split('<CURSOR>').length - 1
    expect(markers).toBe(1)
  })

  it('scopes the current block to the active list item, not the whole list (MED-6)', () => {
    const ctx = buildProseContext('- first item\n- second item', '')
    expect(ctx.currentBlock).toBe('- second item<CURSOR>')
    expect(ctx.before).toContain('- first item')
    expect(ctx.currentBlock).not.toContain('first item')
  })

  it('scopes to the owning list item from a continuation line, excluding siblings (MED-6)', () => {
    const ctx = buildProseContext('- first item\n- second item\n  more detail', '')
    expect(ctx.currentBlock).toContain('second item')
    expect(ctx.currentBlock).toContain('more detail')
    expect(ctx.currentBlock).not.toContain('first item')
    expect(ctx.before).toContain('first item')
  })

  it('scopes the current block to a single heading line', () => {
    const ctx = buildProseContext('intro\n\n## My Sec', 'tion\n\nbody')
    expect(ctx.currentBlock).toBe('## My Sec<CURSOR>tion')
  })

  it('sanitizes control characters out of heading path text (MED-7)', () => {
    const ctx = buildProseContext('# Clean\x00\x07Title\n\nbody ', '')
    expect(ctx.headingPath).toEqual(['CleanTitle'])
  })

  it('keeps before/after within their byte budgets', () => {
    const before = Array.from({ length: 500 }, (_, i) => `before line ${i} ${'x'.repeat(40)}`).join('\n')
    const after = Array.from({ length: 500 }, (_, i) => `after line ${i} ${'y'.repeat(40)}`).join('\n')
    const ctx = buildProseContext(`${before}\n\ncursor here `, ` cursor end\n\n${after}`)
    expect(Buffer.byteLength(ctx.before, 'utf8')).toBeLessThanOrEqual(3 * 1024)
    expect(Buffer.byteLength(ctx.after, 'utf8')).toBeLessThanOrEqual(1.5 * 1024)
  })
})

// --- postprocess ---

describe('postprocess', () => {
  const ctx = { lineAbove: '', afterText: '', contextText: '' }

  it('strips think/fence/label wrappers', () => {
    expect(postprocess('<think>reason</think>hello world', ctx)).toBe('hello world')
    expect(postprocess('```\nhello world\n```', ctx)).toBe('hello world')
    expect(postprocess('Continuation: hello world', ctx)).toBe('hello world')
  })

  it('strips BOTH a fence and an inner label, plus quotes and FIM tokens (MED-8)', () => {
    expect(postprocess('```\nSuggestion: hello world\n```', ctx)).toBe('hello world')
    expect(postprocess('"hello world"', ctx)).toBe('hello world')
    expect(postprocess('“hello world”', ctx)).toBe('hello world')
    expect(postprocess('<|fim_middle|>hello world', ctx)).toBe('hello world')
  })

  it('keeps up to two lines and caps length', () => {
    expect(postprocess('first line\nsecond line', ctx)).toBe('first line\nsecond line')
    expect(postprocess('one\ntwo\nthree', ctx)).toBe('one\ntwo')
    const long = 'lorem ipsum dolor sit amet '.repeat(40) // >500 chars, no long token
    const result = postprocess(long, ctx)
    expect(result.length).toBe(500)
    expect(long.startsWith(result)).toBe(true)
  })

  it('trims the overlap between candidate end and suffix start (HIGH-3)', () => {
    const c = { ...ctx, afterText: 'brown fox' }
    expect(postprocess('quick brown fox', c)).toBe('quick ')
  })

  it('rejects when the candidate fully overlaps the suffix (HIGH-3)', () => {
    const c = { ...ctx, afterText: 'brown fox jumps' }
    expect(postprocess('brown fox', c)).toBe('')
  })

  it('preserves a leading space for mid-sentence continuation', () => {
    expect(postprocess(' brown fox', ctx)).toBe(' brown fox')
  })

  it('rejects blank output', () => {
    expect(postprocess('   \n  ', ctx)).toBe('')
    expect(postprocess('', ctx)).toBe('')
  })

  it('rejects an echo of the line above', () => {
    const c = { ...ctx, lineAbove: 'The quick brown fox' }
    expect(postprocess('The quick brown fox', c)).toBe('')
  })

  it('rejects output that duplicates the suffix', () => {
    const c = { ...ctx, afterText: 'the lazy dog sleeps here' }
    expect(postprocess('the lazy dog sleeps', c)).toBe('')
  })

  it('rejects a new structural block on the current line', () => {
    expect(postprocess('# New heading', ctx)).toBe('')
    expect(postprocess('- a list item', ctx)).toBe('')
    expect(postprocess('| col | col |', ctx)).toBe('')
    expect(postprocess('> a quote', ctx)).toBe('')
  })

  it('allows a structural start on a NEW line (next bullet / heading / paragraph)', () => {
    expect(postprocess('\n- next item', ctx)).toBe('\n- next item')
    expect(postprocess('\n## Next section', ctx)).toBe('\n## Next section')
    expect(postprocess('\n\nA new paragraph.', ctx)).toBe('\n\nA new paragraph.')
  })

  it('converts the model\'s <NL> token into real line breaks', () => {
    // The model emits a visible token because it will not start output with a
    // real newline; postprocess turns it into the actual break.
    expect(postprocess('<NL><NL>The next paragraph.', ctx)).toBe('\n\nThe next paragraph.')
    expect(postprocess('<NL>- next item', ctx)).toBe('\n- next item')
    expect(postprocess('inline continuation', ctx)).toBe('inline continuation')
  })

  it('rejects a URL not already in context', () => {
    expect(postprocess('see https://new.example.com for more', ctx)).toBe('')
  })

  it('keeps a URL that already appears in context', () => {
    const c = { ...ctx, contextText: 'docs at https://known.example.com here' }
    expect(postprocess('visit https://known.example.com', c)).toBe('visit https://known.example.com')
  })

  it('rejects secret-looking output', () => {
    expect(postprocess('sk-abcdefghijklmnop1234', ctx)).toBe('')
    expect(postprocess('AKIAIOSFODNN7EXAMPLE', ctx)).toBe('')
    expect(postprocess('password = hunter2secret', ctx)).toBe('')
  })

  it('accepts a clean continuation', () => {
    expect(postprocess('fox jumps over the lazy dog.', ctx)).toBe('fox jumps over the lazy dog.')
  })
})

// --- complete ---

describe('complete', () => {
  beforeEach(() => {
    mockCreate = vi.fn()
    clearCompletionCache()
    process.env.GROQ_API_KEY = 'test-key'
  })

  afterEach(() => {
    delete process.env.GROQ_API_KEY
    delete process.env.AUTOCOMPLETE_MODELS
    delete process.env.AUTOCOMPLETE_MODEL
    delete process.env.AUTOCOMPLETE_BASE_URL
  })

  it('returns empty WITHOUT calling the model for non-markdown paths', async () => {
    const result = await complete('some code ', '', 'app.ts')
    expect(result).toEqual({ prediction: '', model: '' })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('returns empty WITHOUT calling the model for likely-secret paths', async () => {
    const result = await complete('token ', '', 'secrets/notes.md')
    expect(result).toEqual({ prediction: '', model: '' })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('returns empty WITHOUT calling the model when the cursor is inside a fence', async () => {
    const result = await complete('```js\nconsole.log(', '', 'doc.md')
    expect(result).toEqual({ prediction: '', model: '' })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('returns a continuation for a markdown path', async () => {
    process.env.AUTOCOMPLETE_MODELS = 'model-a,model-b'
    mockCreate.mockResolvedValueOnce(chatResponse('brown fox jumps over.'))
    const result = await complete('The quick ', '', 'doc.md')
    expect(result).toEqual({ prediction: 'brown fox jumps over.', model: 'model-a' })
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it('falls to the second model when the first fails', async () => {
    process.env.AUTOCOMPLETE_MODELS = 'model-a,model-b'
    mockCreate
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce(chatResponse('and continues on.'))
    const result = await complete('A sentence ', '', 'doc.md')
    expect(result.prediction).toBe('and continues on.')
    expect(result.model).toBe('model-b')
    expect(mockCreate).toHaveBeenCalledTimes(2)
  })

  it('returns empty when every model fails', async () => {
    process.env.AUTOCOMPLETE_MODELS = 'model-a,model-b'
    mockCreate
      .mockRejectedValueOnce(new Error('fail'))
      .mockRejectedValueOnce(new Error('fail'))
    expect(await complete('text ', '', 'doc.md')).toEqual({ prediction: '', model: '' })
  })

  it('skips a rejected completion and tries the next model', async () => {
    process.env.AUTOCOMPLETE_MODELS = 'model-a,model-b'
    mockCreate
      .mockResolvedValueOnce(chatResponse('# A heading')) // rejected by postprocess
      .mockResolvedValueOnce(chatResponse('clean prose.'))
    const result = await complete('Intro ', '', 'doc.md')
    expect(result.prediction).toBe('clean prose.')
    expect(result.model).toBe('model-b')
  })

  it('strips <think> blocks from model output', async () => {
    process.env.AUTOCOMPLETE_MODEL = 'test-model'
    mockCreate.mockResolvedValueOnce(chatResponse('<think>reasoning</think>and so on.'))
    const result = await complete('The story ', '', 'doc.md')
    expect(result.prediction).toBe('and so on.')
  })

  it('sends reasoning_effort:none for qwen3 models', async () => {
    process.env.AUTOCOMPLETE_MODEL = 'qwen/qwen3-32b'
    mockCreate.mockResolvedValueOnce(chatResponse('more text.'))
    await complete('A ', '', 'doc.md')
    expect(mockCreate.mock.calls[0][0].reasoning_effort).toBe('none')
  })

  it('does NOT send reasoning_effort for non-qwen3 models', async () => {
    process.env.AUTOCOMPLETE_MODEL = 'llama-3.1-8b-instant'
    mockCreate.mockResolvedValueOnce(chatResponse('more text.'))
    await complete('A ', '', 'doc.md')
    expect(mockCreate.mock.calls[0][0].reasoning_effort).toBeUndefined()
  })

  it('sends the chat-style prose prompt (not code-FIM JSON)', async () => {
    process.env.AUTOCOMPLETE_MODEL = 'test-model'
    mockCreate.mockResolvedValueOnce(chatResponse('text.'))
    await complete('# Topic\n\nThe point ', ' is clear.', 'doc.md')
    const messages = mockCreate.mock.calls[0][0].messages
    const sys = messages[0]
    const user = messages[messages.length - 1] // real prompt is last, after the few-shot turns
    expect(sys.content).toContain('inline writing assistant')
    expect(user.content).toContain('Section: Topic')
    expect(user.content).toContain('<CURSOR>')
    expect(() => JSON.parse(user.content)).toThrow() // not a JSON FIM payload
  })

  it('a heading literal <CURSOR> adds no marker beyond the inserted sentinel (MED-5)', async () => {
    process.env.AUTOCOMPLETE_MODEL = 'test-model'
    mockCreate.mockResolvedValue(chatResponse('text.'))

    await complete('# <CURSOR>\n\nThe point ', '', 'doc.md')
    let msgs = mockCreate.mock.calls[0][0].messages
    const withLiteral = msgs[msgs.length - 1].content.split('<CURSOR>').length - 1

    mockCreate.mockClear()
    await complete('# Topic\n\nThe point ', '', 'doc.md')
    msgs = mockCreate.mock.calls[0][0].messages
    const benign = msgs[msgs.length - 1].content.split('<CURSOR>').length - 1

    // The literal heading marker must be stripped: same count as a clean heading.
    expect(withLiteral).toBe(benign)
  })

  it('sanitizes control characters in filePath before prompting', async () => {
    process.env.AUTOCOMPLETE_MODEL = 'test-model'
    mockCreate.mockResolvedValueOnce(chatResponse('text.'))
    await complete('A ', '', 'doc\x00\x07.md')
    const sys = mockCreate.mock.calls[0][0].messages[0].content
    expect(sys).not.toContain('\x00')
    expect(sys).toContain('doc.md')
  })

  it('caches a successful completion (second identical call hits cache)', async () => {
    process.env.AUTOCOMPLETE_MODEL = 'model-a'
    mockCreate.mockResolvedValueOnce(chatResponse('cached text.'))
    const first = await complete('The quick ', '', 'doc.md')
    const second = await complete('The quick ', '', 'doc.md')
    expect(second).toEqual(first)
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it('caches a fallback result under the succeeding model key, not the first (HIGH-1)', async () => {
    process.env.AUTOCOMPLETE_MODELS = 'model-a,model-b'
    mockCreate
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(chatResponse('and continues on.'))
    const first = await complete('A sentence ', '', 'doc.md')
    expect(first.model).toBe('model-b')
    expect(mockCreate).toHaveBeenCalledTimes(2)

    // Re-query with only the model that succeeded: keyed on model-b, so it hits.
    process.env.AUTOCOMPLETE_MODELS = 'model-b'
    const second = await complete('A sentence ', '', 'doc.md')
    expect(second).toEqual(first)
    expect(mockCreate).toHaveBeenCalledTimes(2) // no fresh model call
  })

  it('keys the cache on model — a different model misses', async () => {
    process.env.AUTOCOMPLETE_MODEL = 'model-a'
    mockCreate.mockResolvedValue(chatResponse('text.'))
    await complete('The quick ', '', 'doc.md')
    process.env.AUTOCOMPLETE_MODEL = 'model-b'
    await complete('The quick ', '', 'doc.md')
    expect(mockCreate).toHaveBeenCalledTimes(2)
  })

  it('caches empty results so the model is not re-queried immediately', async () => {
    process.env.AUTOCOMPLETE_MODEL = 'model-a'
    mockCreate.mockResolvedValueOnce(chatResponse('# rejected heading'))
    const first = await complete('Intro ', '', 'doc.md')
    const second = await complete('Intro ', '', 'doc.md')
    expect(first).toEqual({ prediction: '', model: '' })
    expect(second).toEqual({ prediction: '', model: '' })
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })
})
