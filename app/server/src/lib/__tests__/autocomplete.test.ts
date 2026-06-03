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
  complete,
} from '../autocomplete'

// --- resolveAutocompleteModels ---

describe('resolveAutocompleteModels', () => {
  afterEach(() => {
    delete process.env.AUTOCOMPLETE_MODELS
    delete process.env.AUTOCOMPLETE_MODEL
  })

  it('returns default model chain when no env vars set', () => {
    const models = resolveAutocompleteModels()
    expect(models).toEqual([
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

  it('ignores empty AUTOCOMPLETE_MODELS and falls to defaults', () => {
    process.env.AUTOCOMPLETE_MODELS = '  ,  '
    expect(resolveAutocompleteModels()).toEqual([
      'qwen/qwen3-32b',
      'moonshotai/kimi-k2-instruct',
      'llama-3.1-8b-instant',
    ])
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

// --- complete (multi-model fallback) ---

describe('complete', () => {
  beforeEach(() => {
    mockCreate = vi.fn()
    process.env.GROQ_API_KEY = 'test-key'
  })

  afterEach(() => {
    delete process.env.GROQ_API_KEY
    delete process.env.AUTOCOMPLETE_MODELS
    delete process.env.AUTOCOMPLETE_MODEL
    delete process.env.AUTOCOMPLETE_BASE_URL
  })

  it('returns prediction from first model on success', async () => {
    process.env.AUTOCOMPLETE_MODELS = 'model-a,model-b'
    mockCreate.mockResolvedValueOnce(chatResponse('console.log("hello")'))
    const result = await complete('const x = ', '', 'test.ts')
    expect(result).toEqual({
      prediction: 'console.log("hello")',
      model: 'model-a',
    })
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it('falls to second model when first fails', async () => {
    process.env.AUTOCOMPLETE_MODELS = 'model-a,model-b'
    mockCreate
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce(chatResponse('return true'))
    const result = await complete('function isValid() { ', ' }', 'test.ts')
    expect(result.prediction).toBe('return true')
    expect(result.model).toBe('model-b')
    expect(mockCreate).toHaveBeenCalledTimes(2)
  })

  it('returns empty prediction when all models fail', async () => {
    process.env.AUTOCOMPLETE_MODELS = 'model-a,model-b'
    mockCreate
      .mockRejectedValueOnce(new Error('fail'))
      .mockRejectedValueOnce(new Error('fail'))
    const result = await complete('const ', '', 'test.ts')
    expect(result).toEqual({ prediction: '', model: '' })
  })

  it('skips model returning empty content and tries next', async () => {
    process.env.AUTOCOMPLETE_MODELS = 'model-a,model-b'
    mockCreate
      .mockResolvedValueOnce(chatResponse(''))
      .mockResolvedValueOnce(chatResponse('x + 1'))
    const result = await complete('return ', '', 'test.ts')
    expect(result.prediction).toBe('x + 1')
    expect(result.model).toBe('model-b')
  })

  it('strips <think> blocks from model output', async () => {
    process.env.AUTOCOMPLETE_MODEL = 'test-model'
    mockCreate.mockResolvedValueOnce(chatResponse('<think>reasoning here</think>return x + 1'))
    const result = await complete('function add(x) { ', ' }')
    expect(result.prediction).toBe('return x + 1')
  })

  it('preserves leading whitespace (trimEnd only)', async () => {
    process.env.AUTOCOMPLETE_MODEL = 'test-model'
    mockCreate.mockResolvedValueOnce(chatResponse('  indented\n  code\n'))
    const result = await complete('if (true) {\n', '\n}', 'test.ts')
    expect(result.prediction).toBe('  indented\n  code')
    expect(result.prediction.startsWith('  ')).toBe(true)
  })

  it('sends reasoning_effort:none for qwen3 models', async () => {
    process.env.AUTOCOMPLETE_MODEL = 'qwen/qwen3-32b'
    mockCreate.mockResolvedValueOnce(chatResponse('x'))
    await complete('const ', '', 'test.ts')
    const params = mockCreate.mock.calls[0][0]
    expect(params.reasoning_effort).toBe('none')
  })

  it('does NOT send reasoning_effort for non-qwen3 models', async () => {
    process.env.AUTOCOMPLETE_MODEL = 'llama-3.1-8b-instant'
    mockCreate.mockResolvedValueOnce(chatResponse('x'))
    await complete('const ', '', 'test.ts')
    const params = mockCreate.mock.calls[0][0]
    expect(params.reasoning_effort).toBeUndefined()
  })

  it('sends structured JSON user prompt', async () => {
    process.env.AUTOCOMPLETE_MODEL = 'test-model'
    mockCreate.mockResolvedValueOnce(chatResponse('x'))
    await complete('pre', 'suf', 'test.ts')
    const params = mockCreate.mock.calls[0][0]
    const userMsg = params.messages[1].content
    const parsed = JSON.parse(userMsg)
    expect(parsed).toEqual({ prefix: 'pre', suffix: 'suf' })
  })

  it('includes language in system prompt based on file extension', async () => {
    process.env.AUTOCOMPLETE_MODEL = 'test-model'
    mockCreate.mockResolvedValueOnce(chatResponse('x'))
    await complete('', '', 'test.tsx')
    const params = mockCreate.mock.calls[0][0]
    const sysMsg = params.messages[0].content
    expect(sysMsg).toContain('Language: TypeScript (React)')
  })

  it('truncates long prefix to ~6KB', async () => {
    process.env.AUTOCOMPLETE_MODEL = 'test-model'
    mockCreate.mockResolvedValueOnce(chatResponse('x'))
    // Create a prefix with 200 lines of 100 chars each (~20KB)
    const longPrefix = Array.from({ length: 200 }, (_, i) => 'x'.repeat(100) + ` // line ${i}`).join('\n')
    await complete(longPrefix, '', 'test.ts')
    const params = mockCreate.mock.calls[0][0]
    const userMsg = params.messages[1].content
    const parsed = JSON.parse(userMsg)
    expect(Buffer.byteLength(parsed.prefix, 'utf8')).toBeLessThanOrEqual(6 * 1024 + 200) // some tolerance
  })

  it('truncates long suffix to ~2KB', async () => {
    process.env.AUTOCOMPLETE_MODEL = 'test-model'
    mockCreate.mockResolvedValueOnce(chatResponse('x'))
    const longSuffix = Array.from({ length: 100 }, (_, i) => 'y'.repeat(100) + ` // line ${i}`).join('\n')
    await complete('', longSuffix, 'test.ts')
    const params = mockCreate.mock.calls[0][0]
    const userMsg = params.messages[1].content
    const parsed = JSON.parse(userMsg)
    expect(Buffer.byteLength(parsed.suffix, 'utf8')).toBeLessThanOrEqual(2 * 1024 + 200)
  })

  it('preserves file header (first 15 lines) when prefix is long', async () => {
    process.env.AUTOCOMPLETE_MODEL = 'test-model'
    mockCreate.mockResolvedValueOnce(chatResponse('x'))
    // Create prefix: 15 header lines + 50 middle lines + 20 tail lines = 85 lines
    const header = Array.from({ length: 15 }, (_, i) => `import { thing${i} } from 'mod'`)
    const middle = Array.from({ length: 50 }, (_, i) => `// middle line ${i}`)
    const tail = Array.from({ length: 20 }, (_, i) => `// tail line ${i}`)
    const prefix = [...header, ...middle, ...tail].join('\n')
    await complete(prefix, '', 'test.ts')
    const params = mockCreate.mock.calls[0][0]
    const userMsg = params.messages[1].content
    const parsed = JSON.parse(userMsg)
    // Header lines should be preserved
    expect(parsed.prefix).toContain("import { thing0 } from 'mod'")
    expect(parsed.prefix).toContain("import { thing14 } from 'mod'")
    // Tail should be preserved
    expect(parsed.prefix).toContain('// tail line 19')
  })

  it('sanitizes control characters in filePath', async () => {
    process.env.AUTOCOMPLETE_MODEL = 'test-model'
    mockCreate.mockResolvedValueOnce(chatResponse('x'))
    await complete('', '', 'test\x00\x07.ts')
    const params = mockCreate.mock.calls[0][0]
    const sysMsg = params.messages[0].content
    expect(sysMsg).not.toContain('\x00')
    expect(sysMsg).not.toContain('\x07')
    expect(sysMsg).toContain('test.ts')
  })
})
