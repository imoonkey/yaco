import { watch, existsSync, type FSWatcher } from 'fs'
import { readdir, stat, readFile, writeFile, realpath } from 'fs/promises'
import { join, relative } from 'path'
import { Hono } from 'hono'
import { loadProjects } from '../lib/projects'

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'dir'
  children?: FileNode[]
}

const IGNORE = new Set([
  'node_modules', '.git', '.next', 'dist', 'build',
  '.DS_Store', 'bun.lock', 'package-lock.json',
])

interface TreeCacheEntry {
  build?: Promise<FileNode[]>
  path: string
  tree: FileNode[]
  valid: boolean
  watcher?: FSWatcher
}

const treeCache = new Map<string, TreeCacheEntry>()

function shouldIgnoreEntry(name: string): boolean {
  return IGNORE.has(name) || name.startsWith('.')
}

function shouldIgnoreRelativePath(relPath: string): boolean {
  return relPath
    .split(/[\\/]/)
    .some(part => part.length > 0 && shouldIgnoreEntry(part))
}

async function buildTree(absPath: string, basePath: string, depth: number, maxDepth: number): Promise<FileNode[]> {
  if (depth >= maxDepth) return []
  if (!existsSync(absPath)) return []

  let entries
  try {
    entries = await readdir(absPath, { withFileTypes: true })
  } catch {
    return []
  }

  const sorted = entries
    .filter(e => !shouldIgnoreEntry(e.name))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })

  return Promise.all(sorted.map(async (entry) => {
    const absEntry = join(absPath, entry.name)
    const relPath = relative(basePath, absEntry)

    if (entry.isDirectory()) {
      const children = await buildTree(absEntry, basePath, depth + 1, maxDepth)
      return { name: entry.name, path: relPath, type: 'dir', children } satisfies FileNode
    }

    return { name: entry.name, path: relPath, type: 'file' } satisfies FileNode
  }))
}

/** Resolve real path and verify it stays within the project */
async function resolveAndValidate(projectPath: string, filePath: string): Promise<string | null> {
  const absPath = join(projectPath, filePath)
  if (!existsSync(absPath)) return null
  const resolved = await realpath(absPath)
  const resolvedProject = await realpath(projectPath)
  if (!resolved.startsWith(resolvedProject + '/') && resolved !== resolvedProject) return null
  return resolved
}

function closeTreeWatcher(projectName: string) {
  const entry = treeCache.get(projectName)
  entry?.watcher?.close()
}

function invalidateTree(projectName: string) {
  const entry = treeCache.get(projectName)
  if (!entry) return
  entry.valid = false
}

function ensureProjectWatcher(projectName: string, projectPath: string) {
  const existing = treeCache.get(projectName)
  if (!existing) return
  if (existing.watcher) return

  try {
    existing.watcher = watch(projectPath, { recursive: true }, (eventType, filename) => {
      if (!filename) {
        invalidateTree(projectName)
        return
      }

      if (eventType !== 'rename') return

      const relPath = filename.toString()
      if (shouldIgnoreRelativePath(relPath)) return
      invalidateTree(projectName)
    })
  } catch {
    // Recursive watching is best-effort. The tree still refreshes on the next fetch.
  }
}

function getOrCreateCacheEntry(projectName: string, projectPath: string): TreeCacheEntry {
  const existing = treeCache.get(projectName)
  if (existing && existing.path === projectPath) return existing

  if (existing) closeTreeWatcher(projectName)

  const created: TreeCacheEntry = {
    path: projectPath,
    tree: [],
    valid: false,
  }
  treeCache.set(projectName, created)
  return created
}

async function getProjectTree(projectName: string, projectPath: string): Promise<FileNode[]> {
  const entry = getOrCreateCacheEntry(projectName, projectPath)
  ensureProjectWatcher(projectName, projectPath)

  if (entry.valid) return entry.tree
  if (entry.build) return entry.build

  entry.build = buildTree(projectPath, projectPath, 0, 6)
    .then((tree) => {
      entry.tree = tree
      entry.valid = true
      return tree
    })
    .finally(() => {
      entry.build = undefined
    })

  return entry.build
}

const app = new Hono()

app.get('/:project', async (c) => {
  const projectName = c.req.param('project')
  const projects = await loadProjects()
  const proj = projects.find(p => p.name === projectName)
  if (!proj) return c.json({ error: 'project not found' }, 404)

  const tree = await getProjectTree(projectName, proj.path)
  return c.json(tree)
})

app.get('/:project/content', async (c) => {
  const projectName = c.req.param('project')
  const filePath = c.req.query('path')
  if (!filePath) return c.json({ error: 'path required' }, 400)

  const projects = await loadProjects()
  const proj = projects.find(p => p.name === projectName)
  if (!proj) return c.json({ error: 'project not found' }, 404)

  const resolved = await resolveAndValidate(proj.path, filePath)
  if (!resolved) return c.json({ error: 'path not found or traversal denied' }, 403)

  const info = await stat(resolved)
  if (info.isDirectory()) return c.json({ error: 'is a directory' }, 400)
  if (info.size > 1_000_000) return c.json({ error: 'file too large' }, 413)

  const content = await readFile(resolved, 'utf-8')
  return c.json({ content, path: filePath })
})

app.put('/:project/content', async (c) => {
  const projectName = c.req.param('project')
  const filePath = c.req.query('path')
  if (!filePath) return c.json({ error: 'path required' }, 400)

  const projects = await loadProjects()
  const proj = projects.find(p => p.name === projectName)
  if (!proj) return c.json({ error: 'project not found' }, 404)

  const resolved = await resolveAndValidate(proj.path, filePath)
  if (!resolved) return c.json({ error: 'path not found or traversal denied' }, 403)

  const { content } = await c.req.json<{ content: string }>()
  await writeFile(resolved, content, 'utf-8')
  return c.json({ ok: true })
})

export const fileRoutes = app
