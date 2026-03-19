import { readdir, stat, readFile, writeFile, realpath } from 'fs/promises'
import { join, relative } from 'path'
import { existsSync } from 'fs'
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

async function buildTree(absPath: string, basePath: string, depth: number, maxDepth: number): Promise<FileNode[]> {
  if (depth >= maxDepth) return []
  if (!existsSync(absPath)) return []

  const entries = await readdir(absPath, { withFileTypes: true })
  const nodes: FileNode[] = []

  const sorted = entries
    .filter(e => !IGNORE.has(e.name) && !e.name.startsWith('.'))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })

  for (const entry of sorted) {
    const absEntry = join(absPath, entry.name)
    const relPath = relative(basePath, absEntry)

    if (entry.isDirectory()) {
      const children = await buildTree(absEntry, basePath, depth + 1, maxDepth)
      nodes.push({ name: entry.name, path: relPath, type: 'dir', children })
    } else {
      nodes.push({ name: entry.name, path: relPath, type: 'file' })
    }
  }
  return nodes
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

const app = new Hono()

app.get('/:project', async (c) => {
  const projectName = c.req.param('project')
  const projects = await loadProjects()
  const proj = projects.find(p => p.name === projectName)
  if (!proj) return c.json({ error: 'project not found' }, 404)

  const tree = await buildTree(proj.path, proj.path, 0, 6)
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
