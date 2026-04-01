import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { addSSEClient, removeSSEClient } from '../lib/notify'
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

export const notificationRoutes = app
