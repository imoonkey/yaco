import { Hono } from 'hono'
import { fail } from '../lib/response'
import {
  initWhatsApp,
  logoutWhatsApp,
  shutdownWhatsApp,
  getLoginState,
  isReady,
  isInitialized,
} from '../lib/whatsapp'
import { getAuthSnapshot } from '../lib/whatsapp/auth'
import { isChannelEnabled, setChannelEnabled } from '../lib/channels/enabled'

const app = new Hono()

app.get('/status', (c) => {
  return c.json({
    enabled: isChannelEnabled('whatsapp'),
    initialized: isInitialized(),
    loggedIn: isReady(),
    auth: getAuthSnapshot(),
    login: getLoginState(),
  })
})

/** Switch the channel on or off at runtime.
 *
 *  Off releases the resources — for WhatsApp that is a headless Chrome costing
 *  hundreds of MB, charged to this server's cgroup — but deliberately keeps the
 *  linked-device session on disk, so switching back on reconnects without a QR
 *  scan. Dropping the pairing is `/logout`, a separate and destructive action. */
app.post('/enabled', async (c) => {
  const { enabled } = await c.req.json<{ enabled?: unknown }>()
  if (typeof enabled !== 'boolean') return fail(c, 400, 'enabled must be a boolean')

  setChannelEnabled('whatsapp', enabled)
  if (enabled) {
    // Not awaited: puppeteer takes 10-30s to launch Chrome and restore the
    // session. The client polls /status for the phase.
    void initWhatsApp()
  } else {
    await shutdownWhatsApp()
  }
  return c.json({ enabled, login: getLoginState() })
})

app.post('/login', async (c) => {
  if (!isChannelEnabled('whatsapp')) {
    return fail(c, 400, 'whatsapp channel is off')
  }
  // initWhatsApp is idempotent; just kick it off and return the latest state.
  void initWhatsApp()
  return c.json(getLoginState())
})

/** Drop the linked-device pairing. The next login needs a fresh QR scan — to
 *  merely stop the channel, use `/enabled`. */
app.post('/logout', async (c) => {
  await logoutWhatsApp()
  return c.json(getLoginState())
})

export const whatsappRoutes = app
