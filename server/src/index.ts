import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { projectRoutes } from './routes/projects'
import { workstreamRoutes } from './routes/workstreams'
import { progressRoutes } from './routes/progress'
import { sessionRoutes } from './routes/sessions'
import { fileRoutes } from './routes/files'
import { ensureWorkflowDir, loadProjects } from './lib/projects'
import { startWatching } from './lib/watcher'
import { attachSession, type PtyHandle } from './lib/terminal'
import type { ServerWebSocket } from 'bun'

const ALLOWED_ORIGINS = (process.env.WORKFLOW_CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:5174')
  .split(',')
  .map(s => s.trim())

const SESSION_NAME_RE = /^[a-zA-Z0-9_.-]+$/

const app = new Hono()

app.use('*', cors({ origin: ALLOWED_ORIGINS }))

app.route('/api/projects', projectRoutes)
app.route('/api/workstreams', workstreamRoutes)
app.route('/api/progress', progressRoutes)
app.route('/api/sessions', sessionRoutes)
app.route('/api/files', fileRoutes)

app.get('/api/health', (c) => c.json({ ok: true }))

// Init
await ensureWorkflowDir()
const projects = await loadProjects()
await startWatching(projects, (project, workstream) => {
  console.log(`[watch] progress.json changed: ${project}/${workstream}`)
})

const port = Number(process.env.WORKFLOW_PORT ?? 3001)

interface WsData {
  sessionName: string
}

// Each WebSocket gets its own PTY process attached to the tmux session
const ptyMap = new Map<ServerWebSocket<WsData>, PtyHandle>()

const server = Bun.serve<WsData>({
  port,
  fetch(req, server) {
    const url = new URL(req.url)

    if (url.pathname.startsWith('/ws/terminal/')) {
      const origin = req.headers.get('origin')
      if (origin && !ALLOWED_ORIGINS.includes(origin)) {
        return new Response('Origin not allowed', { status: 403 })
      }

      const sessionName = decodeURIComponent(url.pathname.slice('/ws/terminal/'.length))
      if (!SESSION_NAME_RE.test(sessionName)) {
        return new Response('Invalid session name', { status: 400 })
      }

      const success = server.upgrade(req, { data: { sessionName } })
      if (success) return undefined
      return new Response('WebSocket upgrade failed', { status: 400 })
    }

    return app.fetch(req)
  },
  websocket: {
    open(ws: ServerWebSocket<WsData>) {
      const { sessionName } = ws.data
      try {
        const handle = attachSession(sessionName, 80, 24)

        handle.onData((data: string) => {
          if (ws.readyState === 1) ws.send(data)
        })

        handle.onExit(() => {
          ptyMap.delete(ws)
          if (ws.readyState === 1) ws.close()
        })

        ptyMap.set(ws, handle)
        console.log(`[ws] terminal attached: ${sessionName} (pid=${handle.proc.pid})`)
      } catch (err) {
        console.error(`[ws] failed to attach: ${sessionName}`, err)
        ws.close()
      }
    },
    message(ws: ServerWebSocket<WsData>, message: string | Buffer) {
      const handle = ptyMap.get(ws)
      if (!handle) return

      const str = typeof message === 'string' ? message : message.toString()

      if (str[0] === '{') {
        try {
          const msg = JSON.parse(str)
          if (msg.type === 'resize') {
            handle.resize(msg.cols, msg.rows)
            return
          }
          if (msg.type === 'input') {
            handle.write(msg.data)
            return
          }
        } catch {
          // not JSON, treat as raw input
        }
      }

      handle.write(str)
    },
    close(ws: ServerWebSocket<WsData>) {
      const handle = ptyMap.get(ws)
      if (handle) {
        handle.kill()
        ptyMap.delete(ws)
      }
      console.log(`[ws] terminal detached: ${ws.data.sessionName}`)
    },
  },
})

console.log(`Workflow server running on http://localhost:${server.port}`)
