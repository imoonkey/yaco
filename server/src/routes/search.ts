import { Hono } from 'hono'
import { spawn, execFileSync } from 'child_process'
import { withProject, type ProjectEnv } from '../middleware/project'
import { fail } from '../lib/response'

const MATCH_CAP = 5000

const HARD_IGNORE = ['.git', 'node_modules', 'dist', 'build']

function isRgAvailable(): boolean {
  try {
    execFileSync('rg', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const app = new Hono<ProjectEnv>()

// GET /:project/text — cross-file text search via ripgrep
app.get('/:project/text', withProject, async (c) => {
  const proj = c.var.project
  const q = c.req.query('q')
  if (!q) return fail(c, 400, 'q parameter is required')

  if (!isRgAvailable()) {
    return fail(c, 503, 'ripgrep (rg) is not installed')
  }

  const regex = c.req.query('regex') === 'true'
  const caseSensitive = c.req.query('caseSensitive')
  const wholeWord = c.req.query('wholeWord') === 'true'
  const glob = c.req.query('glob')
  const contextLines = Math.max(0, Math.min(5, Number(c.req.query('context') ?? 1)))

  const args = ['--json', '--line-number', '--column', '--hidden']

  // Case sensitivity: smart-case by default, override if explicit
  if (caseSensitive === 'true') {
    args.push('--case-sensitive')
  } else if (caseSensitive === 'false') {
    args.push('--ignore-case')
  } else {
    args.push('--smart-case')
  }

  if (!regex) args.push('--fixed-strings')
  if (wholeWord) args.push('--word-regexp')
  if (contextLines > 0) args.push('-C', String(contextLines))

  for (const pattern of HARD_IGNORE) {
    args.push('--glob', `!${pattern}`)
  }

  if (glob) args.push('--glob', glob)

  args.push('--', q, '.')

  const startMs = Date.now()
  const rg = spawn('rg', args, { cwd: proj.path, stdio: ['ignore', 'pipe', 'pipe'] })

  let matchCount = 0
  const matchedFiles = new Set<string>()
  let killed = false

  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()

  function writeLine(obj: Record<string, unknown>) {
    return writer.write(encoder.encode(JSON.stringify(obj) + '\n'))
  }

  // Handle client disconnect
  c.req.raw.signal.addEventListener('abort', () => {
    if (!killed) {
      killed = true
      rg.kill('SIGTERM')
    }
  })

  let remainder = ''

  rg.stdout.on('data', (chunk: Buffer) => {
    if (killed) return
    remainder += chunk.toString()
    const lines = remainder.split('\n')
    remainder = lines.pop()!

    for (const line of lines) {
      if (!line) continue
      try {
        const msg = JSON.parse(line)
        if (msg.type === 'match') {
          const data = msg.data
          const filePath = data.path?.text ?? ''
          const lineNumber = data.line_number
          const submatches = data.submatches ?? []
          const lineText = data.lines?.text?.replace(/\n$/, '') ?? ''

          for (const sub of submatches) {
            matchCount++
            matchedFiles.add(filePath)
            writeLine({
              type: 'match',
              file: filePath,
              line: lineNumber,
              column: (sub.start ?? 0) + 1,
              matchLength: (sub.end ?? 0) - (sub.start ?? 0),
              text: lineText,
            })
          }

          if (matchCount >= MATCH_CAP && !killed) {
            killed = true
            rg.kill('SIGTERM')
          }
        } else if (msg.type === 'context') {
          const data = msg.data
          writeLine({
            type: 'context',
            file: data.path?.text ?? '',
            line: data.line_number,
            text: data.lines?.text?.replace(/\n$/, '') ?? '',
          })
        }
      } catch {
        // skip unparseable lines
      }
    }
  })

  rg.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim()
    if (text) {
      writeLine({ type: 'error', message: text })
    }
  })

  rg.on('close', () => {
    writeLine({
      type: 'done',
      matchCount,
      fileCount: matchedFiles.size,
      durationMs: Date.now() - startMs,
      capped: matchCount >= MATCH_CAP,
    }).then(() => writer.close())
  })

  return new Response(readable, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      'Transfer-Encoding': 'chunked',
    },
  })
})

export const searchRoutes = app
