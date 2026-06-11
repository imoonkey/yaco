import { existsSync } from 'fs'
import { readdir, stat, readFile, writeFile, mkdir, realpath, rename as fsRename, rm } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { join, relative, dirname, normalize, basename, extname } from 'path'
import { Hono } from 'hono'
import { getProjectGitignore } from '../lib/gitignore'
import { getColocatedRepos } from '../lib/colocatedRepos'
import { GIT_MAX_BUFFER, FILE_SIZE_LIMIT, RAW_FILE_SIZE_LIMIT, SEARCH_INDEX_BUDGET } from '../lib/constants'
import { fail } from '../lib/response'
import { withProject, type ProjectEnv } from '../middleware/project'

const execFileAsync = promisify(execFile)

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

/** List one directory level, marking gitignored entries. Dirs get children: [] (expandable).
 *  relPrefix overrides relative-path computation (needed for symlinked dirs outside the project). */
async function listDir(absDir: string, basePath: string, ig: ReturnType<typeof import('ignore').default> | null, relPrefix?: string): Promise<FileNode[]> {
  let entries
  try {
    entries = await readdir(absDir, { withFileTypes: true })
  } catch (e) {
    console.warn(`[files] failed to read directory ${absDir}:`, e)
    return []
  }

  const filtered = entries.filter(e => !shouldIgnoreEntry(e.name))

  // Resolve symlinks to determine actual type (Dirent.isDirectory() returns false for symlinks)
  const resolved = await Promise.all(filtered.map(async (entry) => {
    let isDir = entry.isDirectory()
    if (entry.isSymbolicLink()) {
      try {
        const info = await stat(join(absDir, entry.name))
        isDir = info.isDirectory()
      } catch { /* broken symlink — treat as file */ }
    }
    return { entry, isDir }
  }))

  resolved.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.entry.name.localeCompare(b.entry.name)
  })

  return resolved.map(({ entry, isDir }) => {
    const relPath = relPrefix ? join(relPrefix, entry.name) : relative(basePath, join(absDir, entry.name))
    const ignored = ig ? ig.ignores(isDir ? relPath + '/' : relPath) : false

    if (isDir) {
      return { name: entry.name, path: relPath, type: 'dir', children: [], ...(ignored && { gitignored: true }) } satisfies FileNode
    }
    return { name: entry.name, path: relPath, type: 'file', ...(ignored && { gitignored: true }) } satisfies FileNode
  })
}

/** Resolve real path and verify it stays within the project */
type ResolveResult = { path: string } | { error: 'not_found' | 'forbidden' }

async function resolveAndValidate(projectPath: string, filePath: string): Promise<ResolveResult> {
  const absPath = join(projectPath, filePath)
  if (!existsSync(absPath)) return { error: 'not_found' }
  // Block ../../ traversal in the request path itself, but allow symlinks that point outside
  const normalizedProject = normalize(projectPath).replace(/\/+$/, '')
  if (!normalize(absPath).startsWith(normalizedProject + '/')) return { error: 'forbidden' }
  const resolved = await realpath(absPath)
  return { path: resolved }
}

/** Validate a relative path for creation (path may not exist yet) */
function validateNewPath(projectPath: string, filePath: string): string | null {
  if (!filePath || filePath.includes('..') || normalize(filePath) !== filePath.replace(/\\/g, '/')) return null
  const normalizedProject = normalize(projectPath).replace(/\/+$/, '')
  const absPath = join(normalizedProject, filePath)
  if (!absPath.startsWith(normalizedProject + '/')) return null
  return absPath
}

/** Recursively list every file under an already-known symlinked directory.
 *  ancestors holds realpath()s of dirs we're currently inside (per recursion path),
 *  so cycles like loop -> . terminate while two distinct top-level aliases pointing
 *  to the same target can both still be indexed. */
async function walkSymlinkedDir(
  dir: string, relPrefix: string, seen: Set<string>,
  files: { name: string; path: string; type: string }[],
  ancestors: Set<string>
) {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (shouldIgnoreEntry(entry.name)) continue
    const relPath = join(relPrefix, entry.name)
    const abs = join(dir, entry.name)
    let isDir = entry.isDirectory()
    if (entry.isSymbolicLink()) {
      try { isDir = (await stat(abs)).isDirectory() } catch { continue }
    }
    if (isDir) {
      let real
      try { real = await realpath(abs) } catch { continue }
      if (ancestors.has(real)) continue
      ancestors.add(real)
      await walkSymlinkedDir(abs, relPath, seen, files, ancestors)
      ancestors.delete(real)
    } else if (!seen.has(relPath)) {
      seen.add(relPath)
      files.push({ name: entry.name, path: relPath, type: 'file' })
    }
  }
}

/** Find top-level symlinked directories and collect the files inside them.
 *  git ls-files doesn't follow symlinks, so we recover those here.
 *  Top-level only: avoids walking the entire project tree (which can be 100k+ dirs
 *  on monorepos with large gitignored data dirs). Nested symlinked dirs are not indexed.
 *  skipNames holds top-level names already indexed via their own git ls-files (a
 *  symlinked-in colocated repo) — re-walking them would leak their .gitignored files. */
async function collectSymlinkedFiles(
  projectPath: string, seen: Set<string>,
  files: { name: string; path: string; type: string }[],
  skipNames: Set<string> = new Set()
) {
  let entries
  try { entries = await readdir(projectPath, { withFileTypes: true }) } catch { return }
  let projectReal: string
  try { projectReal = await realpath(projectPath) } catch { return }
  for (const entry of entries) {
    if (!entry.isSymbolicLink() || shouldIgnoreEntry(entry.name) || skipNames.has(entry.name)) continue
    const abs = join(projectPath, entry.name)
    let isDir, real
    try {
      isDir = (await stat(abs)).isDirectory()
      real = await realpath(abs)
    } catch { continue }
    if (!isDir) continue
    // Skip self/ancestor links (loop -> ., link -> ..) that would re-enter the project tree
    if (real === projectReal || projectReal.startsWith(real + '/')) continue
    await walkSymlinkedDir(abs, entry.name, seen, files, new Set([real]))
  }
}

const app = new Hono<ProjectEnv>()

// GET /:project — root-level entries (lazy: dirs have children: [])
app.get('/:project', withProject, async (c) => {
  const proj = c.var.project

  const ig = await getProjectGitignore(proj.path)
  const tree = await listDir(proj.path, proj.path, ig)
  return c.json(tree)
})

// GET /:project/search-index — flat list of all file paths (for Cmd+P search)
// ?ignored=true to also include gitignored files (filtered by hardcoded IGNORE list)
app.get('/:project/search-index', withProject, async (c) => {
  const proj = c.var.project
  const includeIgnored = c.req.query('ignored') === 'true'

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

  const lsFiles = (cwd: string, args: string[]) =>
    execFileAsync('git', ['ls-files', ...args], { cwd, maxBuffer: GIT_MAX_BUFFER })

  try {
    const { stdout } = await lsFiles(proj.path, ['--cached', '--others', '--exclude-standard'])
    const files = stdout.trimEnd().split('\n').filter(Boolean).map(toFile)
    // One seen-set spans host + ignored + colocated + symlink-recovery, so a path
    // surfaced by one source is never re-listed by another (deterministic order).
    const seen = new Set(files.map(f => f.path))

    if (includeIgnored) {
      try {
        const { stdout: ignored } = await lsFiles(proj.path, ['--others', '--ignored', '--exclude-standard'])
        for (const p of ignored.trimEnd().split('\n')) {
          if (!p || seen.has(p)) continue
          // Skip files under hardcoded IGNORE dirs
          const topDir = p.split('/')[0]
          if (shouldIgnoreEntry(topDir)) continue
          seen.add(p)
          files.push(toFile(p))
        }
      } catch (e) { console.warn('[files] git ls-files --ignored failed (may be shallow clone):', e) }
    }

    // Colocated repos: git ls-files never descends into a nested repo, so run it
    // per repo (host first, then repos sorted by prefix) and merge with a <repo>/
    // prefix. The repo's own .gitignore (logs/locks) is honored by --exclude-standard.
    const repos = await getColocatedRepos(proj.path)
    for (const repo of repos) {
      try {
        const { stdout: sub } = await lsFiles(join(proj.path, repo), ['--cached', '--others', '--exclude-standard'])
        for (const p of sub.trimEnd().split('\n')) {
          if (!p) continue
          const full = `${repo}/${p}`
          if (seen.has(full)) continue
          seen.add(full)
          files.push(toFile(full))
        }
      } catch (e) { console.warn(`[files] git ls-files in colocated repo ${repo} failed:`, e) }
    }

    // git ls-files doesn't follow symlinked directories — walk top-level symlinks
    // separately (skipping any symlinked-in colocated repo already indexed above).
    await collectSymlinkedFiles(proj.path, seen, files, new Set(repos))

    addDirs(files)
    return c.json(files)
  } catch {
    // Non-git project: fall back to recursive walk (colocated repos, if any, are
    // plain dirs on disk and get walked here — no separate ls-files merge).
    const ig = includeIgnored ? null : await getProjectGitignore(proj.path)
    const files: { name: string; path: string; type: string }[] = []

    async function walk(dir: string) {
      if (files.length >= SEARCH_INDEX_BUDGET) return
      let entries
      try { entries = await readdir(dir, { withFileTypes: true }) } catch (e) { console.warn(`[files] walk readdir failed for ${dir}:`, e); return }
      for (const entry of entries) {
        if (files.length >= SEARCH_INDEX_BUDGET) return
        if (shouldIgnoreEntry(entry.name)) continue
        const relPath = relative(proj.path, join(dir, entry.name))
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
app.get('/:project/children', withProject, async (c) => {
  const proj = c.var.project
  const dirPath = c.req.query('dir')
  if (!dirPath) return c.json({ error: 'dir query param required' }, 400)

  const result = await resolveAndValidate(proj.path, dirPath)
  if ('error' in result) return fail(c, result.error === 'not_found' ? 404 : 403, result.error === 'not_found' ? 'Directory not found' : 'Path traversal denied')

  const info = await stat(result.path)
  if (!info.isDirectory()) return c.json({ error: 'not a directory' }, 400)

  const ig = await getProjectGitignore(proj.path)
  const children = await listDir(result.path, proj.path, ig, dirPath)
  return c.json(children)
})

app.get('/:project/content', withProject, async (c) => {
  const proj = c.var.project
  const filePath = c.req.query('path')
  if (!filePath) return c.json({ error: 'path required' }, 400)

  const result = await resolveAndValidate(proj.path, filePath)
  if ('error' in result) return fail(c, result.error === 'not_found' ? 404 : 403, result.error === 'not_found' ? 'File not found' : 'Path traversal denied')

  const info = await stat(result.path)
  if (info.isDirectory()) return c.json({ error: 'is a directory' }, 400)
  if (info.size > FILE_SIZE_LIMIT) return c.json({ error: 'file too large' }, 413)

  const content = await readFile(result.path, 'utf-8')
  return c.json({ content, path: filePath, revision: info.mtimeMs })
})

const RAW_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
}

app.get('/:project/raw', withProject, async (c) => {
  const proj = c.var.project
  const filePath = c.req.query('path')
  if (!filePath) return fail(c, 400, 'path required')

  const result = await resolveAndValidate(proj.path, filePath)
  if ('error' in result) return fail(c, result.error === 'not_found' ? 404 : 403, result.error === 'not_found' ? 'File not found' : 'Path traversal denied')

  const info = await stat(result.path)
  if (info.isDirectory()) return fail(c, 400, 'is a directory')
  if (info.size > RAW_FILE_SIZE_LIMIT) return fail(c, 413, 'file too large')

  const ext = extname(result.path).toLowerCase()
  const mime = RAW_MIME[ext] ?? 'application/octet-stream'
  const buffer = await readFile(result.path)
  return new Response(buffer, {
    headers: {
      'Content-Type': mime,
      'Content-Disposition': 'inline',
      'Cache-Control': 'no-cache',
    },
  })
})

app.put('/:project/content', withProject, async (c) => {
  const proj = c.var.project
  const filePath = c.req.query('path')
  if (!filePath) return c.json({ error: 'path required' }, 400)

  const result = await resolveAndValidate(proj.path, filePath)
  if ('error' in result) return fail(c, result.error === 'not_found' ? 404 : 403, result.error === 'not_found' ? 'File not found' : 'Path traversal denied')

  const { content, baseRevision } = await c.req.json<{ content: string; baseRevision?: number }>()

  if (baseRevision != null) {
    const info = await stat(result.path)
    if (info.mtimeMs !== baseRevision) {
      return c.json({ error: 'revision conflict', currentRevision: info.mtimeMs }, 409)
    }
  }

  await writeFile(result.path, content, 'utf-8')
  const updated = await stat(result.path)
  return c.json({ revision: updated.mtimeMs })
})

app.post('/:project/create-file', withProject, async (c) => {
  const proj = c.var.project
  const { path: filePath } = await c.req.json<{ path: string }>()
  if (!filePath) return c.json({ error: 'path required' }, 400)

  const absPath = validateNewPath(proj.path, filePath)
  if (!absPath) return c.json({ error: 'invalid path' }, 400)
  if (existsSync(absPath)) return c.json({ error: 'already exists' }, 409)

  await mkdir(dirname(absPath), { recursive: true })
  await writeFile(absPath, '', 'utf-8')
  return c.json({ path: filePath })
})

app.post('/:project/create-dir', withProject, async (c) => {
  const proj = c.var.project
  const { path: dirPath } = await c.req.json<{ path: string }>()
  if (!dirPath) return c.json({ error: 'path required' }, 400)

  const absPath = validateNewPath(proj.path, dirPath)
  if (!absPath) return c.json({ error: 'invalid path' }, 400)
  if (existsSync(absPath)) return c.json({ error: 'already exists' }, 409)

  await mkdir(absPath, { recursive: true })
  return c.json({ path: dirPath })
})

app.post('/:project/rename', withProject, async (c) => {
  const proj = c.var.project
  const { oldPath, newPath } = await c.req.json<{ oldPath: string; newPath: string }>()
  if (!oldPath || !newPath) return c.json({ error: 'oldPath and newPath required' }, 400)

  const resolvedOld = await resolveAndValidate(proj.path, oldPath)
  if ('error' in resolvedOld) return fail(c, resolvedOld.error === 'not_found' ? 404 : 403, resolvedOld.error === 'not_found' ? 'Source not found' : 'Path traversal denied')

  const absNew = validateNewPath(proj.path, newPath)
  if (!absNew) return c.json({ error: 'invalid new path' }, 400)

  await fsRename(resolvedOld.path, absNew)
  return c.json({})
})

app.post('/:project/move', withProject, async (c) => {
  const proj = c.var.project
  const { sourcePath, destDir } = await c.req.json<{ sourcePath: string; destDir: string }>()
  if (!sourcePath || !destDir) return c.json({ error: 'sourcePath and destDir required' }, 400)

  const resolvedSource = await resolveAndValidate(proj.path, sourcePath)
  if ('error' in resolvedSource) return fail(c, resolvedSource.error === 'not_found' ? 404 : 403, resolvedSource.error === 'not_found' ? 'Source not found' : 'Path traversal denied')

  const targetRel = join(destDir, basename(sourcePath))
  const absTarget = validateNewPath(proj.path, targetRel)
  if (!absTarget) return c.json({ error: 'invalid target path' }, 400)
  if (existsSync(absTarget)) return c.json({ error: 'target already exists' }, 409)

  await fsRename(resolvedSource.path, absTarget)
  return c.json({ newPath: targetRel })
})

app.post('/:project/reveal', withProject, async (c) => {
  const proj = c.var.project
  const { path: filePath } = await c.req.json<{ path: string }>()
  if (!filePath) return c.json({ error: 'path required' }, 400)

  const result = await resolveAndValidate(proj.path, filePath)
  if ('error' in result) return fail(c, result.error === 'not_found' ? 404 : 403, result.error === 'not_found' ? 'File not found' : 'Path traversal denied')

  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'darwin' ? ['-R', result.path] : [dirname(result.path)]
  execFile(cmd, args, (err) => { if (err) console.warn('[files] reveal failed:', err) })
  return c.json({})
})

app.post('/:project/delete', withProject, async (c) => {
  const proj = c.var.project
  const { path: filePath } = await c.req.json<{ path: string }>()
  if (!filePath) return c.json({ error: 'path required' }, 400)

  const result = await resolveAndValidate(proj.path, filePath)
  if ('error' in result) return fail(c, result.error === 'not_found' ? 404 : 403, result.error === 'not_found' ? 'File not found' : 'Path traversal denied')

  await rm(result.path, { recursive: true })
  return c.json({})
})

export const fileRoutes = app
