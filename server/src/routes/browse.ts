import { Hono } from 'hono'
import { readdir, stat } from 'fs/promises'
import { homedir } from 'os'
import { join, resolve } from 'path'

const HOME = homedir()

const app = new Hono()

app.get('/', async (c) => {
  const raw = c.req.query('prefix')
  if (!raw) {
    return c.json({ error: 'prefix query parameter required' }, 400)
  }

  // Expand ~ to $HOME
  const expanded = raw.startsWith('~') ? HOME + raw.slice(1) : raw
  const prefix = resolve(expanded)

  // Security: only allow paths under $HOME
  if (!prefix.startsWith(HOME)) {
    return c.json({ error: 'path must be under $HOME' }, 400)
  }

  let dirents
  try {
    dirents = await readdir(prefix, { withFileTypes: true })
  } catch {
    return c.json({ entries: [] })
  }

  const dirs = dirents.filter((d) => d.isDirectory() && !d.name.startsWith('.'))

  const entries = await Promise.all(
    dirs.map(async (d) => {
      const fullPath = join(prefix, d.name)
      let isGit = false
      try {
        const gitStat = await stat(join(fullPath, '.git'))
        isGit = gitStat.isDirectory()
      } catch {
        // no .git
      }
      return { name: d.name, path: fullPath, isGit }
    }),
  )

  entries.sort((a, b) => a.name.localeCompare(b.name))

  return c.json({ entries })
})

export const browseRoutes = app
