import ignore, { type Ignore } from 'ignore'
import { readFile, stat } from 'fs/promises'
import { join } from 'path'

interface CacheEntry {
  ig: Ignore
  mtime: number
}

const cache = new Map<string, CacheEntry>()

/** Load and cache the root .gitignore for a project. Returns null if no .gitignore exists. */
export async function getProjectGitignore(projectPath: string): Promise<Ignore | null> {
  const filePath = join(projectPath, '.gitignore')

  let info
  try {
    info = await stat(filePath)
  } catch {
    return null
  }

  const cached = cache.get(projectPath)
  if (cached && cached.mtime === info.mtimeMs) return cached.ig

  let content
  try {
    content = await readFile(filePath, 'utf-8')
  } catch {
    return null
  }

  const ig = ignore().add(content)
  cache.set(projectPath, { ig, mtime: info.mtimeMs })
  return ig
}

/** Clear cached gitignore for a project (call when .gitignore changes). */
export function clearGitignoreCache(projectPath: string): void {
  cache.delete(projectPath)
}
