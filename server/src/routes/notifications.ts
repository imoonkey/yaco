import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { addSSEClient, removeSSEClient, broadcastChange } from '../lib/notify'
import * as notificationsStore from '../lib/notifications-store'
import { fail } from '../lib/response'
import { SSE_HEARTBEAT_MS } from '../lib/constants'

const app = new Hono()

app.get('/stream', (c) => {
  return streamSSE(c, async (stream) => {
    const writer = (event: string, data: string) => {
      stream.writeSSE({ data, event })
    }
    addSSEClient(writer)
    stream.onAbort(() => removeSSEClient(writer))

    // Heartbeat every 30s to keep connection alive through proxies
    while (true) {
      await stream.writeSSE({ data: '', event: 'heartbeat' })
      await stream.sleep(SSE_HEARTBEAT_MS)
    }
  })
})

app.get('/', async (c) => {
  const items = await notificationsStore.list()
  return c.json(items)
})

app.post('/read-all', async (c) => {
  const flipped = await notificationsStore.markAllRead()
  if (flipped > 0) broadcastChange('notifications:changed')
  return c.json({ flipped })
})

app.post('/:id/read', async (c) => {
  const id = c.req.param('id')
  const flipped = await notificationsStore.markRead(id)
  if (!flipped) return fail(c, 404, 'notification not found')
  broadcastChange('notifications:changed')
  return c.body(null, 204)
})

app.delete('/', async (c) => {
  await notificationsStore.clearAll()
  broadcastChange('notifications:changed')
  return c.body(null, 204)
})

export const notificationRoutes = app
