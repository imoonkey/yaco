import { existsSync } from 'fs'
import { readdir, stat, readFile, writeFile, mkdir, realpath, rename as fsRename, rm } from 'fs/promises'
import { join, relative, dirname, normalize, basename } from 'path'
import { Hono } from 'hono'
import { loadProjects } from '../lib/projects'
import { getProjectGitignore } from '../lib/gitignore'

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'dir'
  children?: FileNode[]
  gitignored?: boolean
}

const IGNORE = new Set([
  '.git', '.DS_Store', 'node_modules', '.next', 'dist', 'build',
  '__pycache__', '.svn', '.hg', 'Thumbs.db',
])

function shouldIgnoreEntry(name: string): boolean {
  return IGNORE.has(name)
}

/** List one directory level, marking gitignored entries. Dirs get children: [] (expandable). */
async function listDir(absDir: string, basePath: string, ig: ReturnType<typeof import('ignore').default> | null): Promise<FileNode[]> {
  let entries
  try {
    entries = await readdir(absDir, { withFileTypes: true })
  } catch {
    return []
  }

  const sorted = entries
    .filter(e => !shouldIgnoreEntry(e.name))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })

  return sorted.map((entry) => {
    const relPath = relative(basePath, join(absDir, entry.name))
    const isDir = entry.isDirectory()
    const ignored = ig ? ig.ignores(isDir ? relPath + '/' : relPath) : false

    if (isDir) {
      return { name: entry.name, path: relPath, type: 'dir', children: [], ...(ignored && { gitignored: true }) } satisfies FileNode
    }
    return { name: entry.name, path: relPath, type: 'file', ...(ignored && { gitignored: true }) } satisfies FileNode
  })
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

/** Validate a relative path for creation (path may not exist yet) */
function validateNewPath(projectPath: string, filePath: string): string | null {
  if (!filePath || filePath.includes('..') || normalize(filePath) !== filePath.replace(/\\/g, '/')) return null
  const absPath = join(projectPath, filePath)
  if (!absPath.startsWith(projectPath + '/')) return null
  return absPath
}

const app = new Hono()

// GET /:project — root-level entries (lazy: dirs have children: [])
app.get('/:project', async (c) => {
  const projectName = c.req.param('project')
  const projects = await loadProjects()
  const proj = projects.find(p => p.name === projectName)
  if (!proj) return c.json({ error: 'project not found' }, 404)

  const ig = await getProjectGitignore(proj.path)
  const tree = await listDir(proj.path, proj.path, ig)
  return c.json(tree)
})

// GET /:project/search-index — flat list of all file paths (for Cmd+P search)
// ?ignored=true to also include gitignored files (filtered by hardcoded IGNORE list)
app.get('/:project/search-index', async (c) => {
  const projectName = c.req.param('project')
  const includeIgnored = c.req.query('ignored') === 'true'
  const projects = await loadProjects()
  const proj = projects.find(p => p.name === projectName)
  if (!proj) return c.json({ error: 'project not found' }, 404)

  const { execFile } = await import('child_process')
  const { promisify } = await import('util')
  const exec = promisify(execFile)

  const toFile = (p: string) => ({ name: basename(p), path: p, type: 'file' as const })

  /** Derive unique directory paths from a list of file entries */
  function addDirs(files: { name: string; path: string; type: string }[]) {
    const seen = new Set(files.map(f => f.path))
    for (const f of [...files]) {
      const parts = f.path.split('/')
      for (let i = 1; i < parts.length; i++) {
        const dirPath = parts.slice(0, i).join('/')
        if (seen.has(dirPath)) continue
        seen.add(dirPath)
        files.push({ name: parts[i - 1], path: dirPath, type: 'dir' })
      }
    }
  }

  try {
    const { stdout } = await exec('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: proj.path, maxBuffer: 50 * 1024 * 1024 })
    const files = stdout.trimEnd().split('\n').filter(Boolean).map(toFile)

    if (includeIgnored) {
      try {
        const { stdout: ignored } = await exec('git', ['ls-files', '--others', '--ignored', '--exclude-standard'], { cwd: proj.path, maxBuffer: 50 * 1024 * 1024 })
        const seen = new Set(files.map(f => f.path))
        for (const p of ignored.trimEnd().split('\n')) {
          if (!p || seen.has(p)) continue
          // Skip files under hardcoded IGNORE dirs
          const topDir = p.split('/')[0]
          if (shouldIgnoreEntry(topDir)) continue
          files.push(toFile(p))
        }
      } catch { /* ignore — git ls-files --ignored can fail on shallow clones */ }
    }

    addDirs(files)
    return c.json(files)
  } catch {
    // Non-git project: fall back to recursive walk
    const ig = includeIgnored ? null : await getProjectGitignore(proj.path)
    const files: { name: string; path: string; type: string }[] = []
    const BUDGET = 100_000

    async function walk(dir: string) {
      if (files.length >= BUDGET) return
      let entries
      try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        if (files.length >= BUDGET) return
        if (shouldIgnoreEntry(entry.name)) continue
        const relPath = relative(proj!.path, join(dir, entry.name))
        const isDir = entry.isDirectory()
        if (ig && ig.ignores(isDir ? relPath + '/' : relPath)) continue
        if (isDir) {
          await walk(join(dir, entry.name))
        } else {
          files.push({ name: entry.name, path: relPath, type: 'file' })
        }
      }
    }

    await walk(proj.path)
    addDirs(files)
    return c.json(files)
  }
})

// GET /:project/children?dir=<relPath> — one directory's immediate children
app.get('/:project/children', async (c) => {
  const projectName = c.req.param('project')
  const dirPath = c.req.query('dir')
  if (!dirPath) return c.json({ error: 'dir query param required' }, 400)

  const projects = await loadProjects()
  const proj = projects.find(p => p.name === projectName)
  if (!proj) return c.json({ error: 'project not found' }, 404)

  const resolved = await resolveAndValidate(proj.path, dirPath)
  if (!resolved) return c.json({ error: 'directory not found or traversal denied' }, 403)

  const info = await stat(resolved)
  if (!info.isDirectory()) return c.json({ error: 'not a directory' }, 400)

  const ig = await getProjectGitignore(proj.path)
  const children = await listDir(resolved, proj.path, ig)
  return c.json(children)
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
  return c.json({ content, path: filePath, revision: info.mtimeMs })
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

  const { content, baseRevision } = await c.req.json<{ content: string; baseRevision?: number }>()

  if (baseRevision != null) {
    const info = await stat(resolved)
    if (info.mtimeMs !== baseRevision) {
      return c.json({ error: 'revision conflict', currentRevision: info.mtimeMs }, 409)
    }
  }

  await writeFile(resolved, content, 'utf-8')
  const updated = await stat(resolved)
  return c.json({ ok: true, revision: updated.mtimeMs })
})

app.post('/:project/create-file', async (c) => {
  const projectName = c.req.param('project')
  const { path: filePath } = await c.req.json<{ path: string }>()
  if (!filePath) return c.json({ error: 'path required' }, 400)

  const projects = await loadProjects()
  const proj = projects.find(p => p.name === projectName)
  if (!proj) return c.json({ error: 'project not found' }, 404)

  const absPath = validateNewPath(proj.path, filePath)
  if (!absPath) return c.json({ error: 'invalid path' }, 400)
  if (existsSync(absPath)) return c.json({ error: 'already exists' }, 409)

  await mkdir(dirname(absPath), { recursive: true })
  await writeFile(absPath, '', 'utf-8')
  return c.json({ ok: true, path: filePath })
})

app.post('/:project/create-dir', async (c) => {
  const projectName = c.req.param('project')
  const { path: dirPath } = await c.req.json<{ path: string }>()
  if (!dirPath) return c.json({ error: 'path required' }, 400)

  const projects = await loadProjects()
  const proj = projects.find(p => p.name === projectName)
  if (!proj) return c.json({ error: 'project not found' }, 404)

  const absPath = validateNewPath(proj.path, dirPath)
  if (!absPath) return c.json({ error: 'invalid path' }, 400)
  if (existsSync(absPath)) return c.json({ error: 'already exists' }, 409)

  await mkdir(absPath, { recursive: true })
  return c.json({ ok: true, path: dirPath })
})

app.post('/:project/rename', async (c) => {
  const projectName = c.req.param('project')
  const { oldPath, newPath } = await c.req.json<{ oldPath: string; newPath: string }>()
  if (!oldPath || !newPath) return c.json({ error: 'oldPath and newPath required' }, 400)

  const projects = await loadProjects()
  const proj = projects.find(p => p.name === projectName)
  if (!proj) return c.json({ error: 'project not found' }, 404)

  const resolvedOld = await resolveAndValidate(proj.path, oldPath)
  if (!resolvedOld) return c.json({ error: 'source path not found or traversal denied' }, 403)

  const absNew = validateNewPath(proj.path, newPath)
  if (!absNew) return c.json({ error: 'invalid new path' }, 400)

  await fsRename(resolvedOld, absNew)
  return c.json({ ok: true })
})

app.post('/:project/move', async (c) => {
  const projectName = c.req.param('project')
  const { sourcePath, destDir } = await c.req.json<{ sourcePath: string; destDir: string }>()
  if (!sourcePath || !destDir) return c.json({ error: 'sourcePath and destDir required' }, 400)

  const projects = await loadProjects()
  const proj = projects.find(p => p.name === projectName)
  if (!proj) return c.json({ error: 'project not found' }, 404)

  const resolvedSource = await resolveAndValidate(proj.path, sourcePath)
  if (!resolvedSource) return c.json({ error: 'source path not found or traversal denied' }, 403)

  const targetRel = join(destDir, basename(sourcePath))
  const absTarget = validateNewPath(proj.path, targetRel)
  if (!absTarget) return c.json({ error: 'invalid target path' }, 400)
  if (existsSync(absTarget)) return c.json({ error: 'target already exists' }, 409)

  await fsRename(resolvedSource, absTarget)
  return c.json({ ok: true, newPath: targetRel })
})

app.post('/:project/delete', async (c) => {
  const projectName = c.req.param('project')
  const { path: filePath } = await c.req.json<{ path: string }>()
  if (!filePath) return c.json({ error: 'path required' }, 400)

  const projects = await loadProjects()
  const proj = projects.find(p => p.name === projectName)
  if (!proj) return c.json({ error: 'project not found' }, 404)

  const resolved = await resolveAndValidate(proj.path, filePath)
  if (!resolved) return c.json({ error: 'path not found or traversal denied' }, 403)

  await rm(resolved, { recursive: true })
  return c.json({ ok: true })
})

export const fileRoutes = app
