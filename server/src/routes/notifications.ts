import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { addSSEClient, removeSSEClient } from '../lib/notify'
import type { NotificationEvent } from '../lib/notify'

const app = new Hono()

app.get('/stream', (c) => {
  return streamSSE(c, async (stream) => {
    const writer = (event: NotificationEvent) => {
      stream.writeSSE({ data: JSON.stringify(event), event: 'notification' })
    }
    addSSEClient(writer)
    stream.onAbort(() => removeSSEClient(writer))

    // Heartbeat every 30s to keep connection alive through proxies
    while (true) {
      await stream.writeSSE({ data: '', event: 'heartbeat' })
      await stream.sleep(30_000)
    }
  })
})

export const notificationRoutes = app
