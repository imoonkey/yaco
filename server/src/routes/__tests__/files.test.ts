import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Mock loadProjects to return a test project pointing to our temp dir
let testProjectPath: string
vi.mock('../../lib/projects', () => ({
  loadProjects: () => Promise.resolve([{ name: 'test-project', path: testProjectPath }]),
}))

// Import the file routes (after mocks are set up)
const { fileRoutes } = await import('../files')

describe('POST /:project/create-file', () => {
  beforeEach(async () => {
    testProjectPath = await mkdtemp(join(tmpdir(), 'workflow-test-'))
  })
  afterEach(async () => {
    await rm(testProjectPath, { recursive: true, force: true })
  })

  it('creates a file at the project root', async () => {
    const res = await fileRoutes.request('/test-project/create-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'hello.txt' }),
    })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ path: 'hello.txt' })

    // Verify file on disk
    const absPath = join(testProjectPath, 'hello.txt')
    expect(existsSync(absPath)).toBe(true)
    expect(await readFile(absPath, 'utf-8')).toBe('')
  })

  it('creates a file inside a subdirectory (mkdir -p)', async () => {
    const res = await fileRoutes.request('/test-project/create-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'src/components/Button.tsx' }),
    })
    expect(res.status).toBe(200)
    expect(existsSync(join(testProjectPath, 'src/components/Button.tsx'))).toBe(true)
  })

  it('returns 400 for empty path', async () => {
    const res = await fileRoutes.request('/test-project/create-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 for path with ..', async () => {
    const res = await fileRoutes.request('/test-project/create-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '../escape.txt' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 409 if file already exists', async () => {
    // Create first
    await fileRoutes.request('/test-project/create-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'exists.txt' }),
    })
    // Try again
    const res = await fileRoutes.request('/test-project/create-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'exists.txt' }),
    })
    expect(res.status).toBe(409)
  })

  it('returns 404 for unknown project', async () => {
    const res = await fileRoutes.request('/nonexistent/create-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'test.txt' }),
    })
    expect(res.status).toBe(404)
  })
})

describe('POST /:project/create-dir', () => {
  beforeEach(async () => {
    testProjectPath = await mkdtemp(join(tmpdir(), 'workflow-test-'))
  })
  afterEach(async () => {
    await rm(testProjectPath, { recursive: true, force: true })
  })

  it('creates a directory at the project root', async () => {
    const res = await fileRoutes.request('/test-project/create-dir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'new-folder' }),
    })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ path: 'new-folder' })

    const absPath = join(testProjectPath, 'new-folder')
    expect(existsSync(absPath)).toBe(true)
    expect((await stat(absPath)).isDirectory()).toBe(true)
  })

  it('creates nested directories', async () => {
    const res = await fileRoutes.request('/test-project/create-dir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'a/b/c' }),
    })
    expect(res.status).toBe(200)
    expect(existsSync(join(testProjectPath, 'a/b/c'))).toBe(true)
  })

  it('returns 400 for path traversal', async () => {
    const res = await fileRoutes.request('/test-project/create-dir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '../outside' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 409 if directory already exists', async () => {
    await fileRoutes.request('/test-project/create-dir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'exists-dir' }),
    })
    const res = await fileRoutes.request('/test-project/create-dir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'exists-dir' }),
    })
    expect(res.status).toBe(409)
  })
})
