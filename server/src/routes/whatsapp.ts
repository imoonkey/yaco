import { Hono } from 'hono'
import { fail } from '../lib/response'
import {
  initWhatsApp,
  logoutWhatsApp,
  getLoginState,
  isReady,
  isInitialized,
} from '../lib/whatsapp'
import { getAuthSnapshot } from '../lib/whatsapp/auth'

const app = new Hono()

app.get('/status', (c) => {
  return c.json({
    enabled: process.env.WHATSAPP_ENABLED === '1',
    initialized: isInitialized(),
    loggedIn: isReady(),
    auth: getAuthSnapshot(),
    login: getLoginState(),
  })
})

app.post('/login', async (c) => {
  if (process.env.WHATSAPP_ENABLED !== '1') {
    return fail(c, 400, 'WHATSAPP_ENABLED is not set')
  }
  // initWhatsApp is idempotent; just kick it off and return the latest state.
  void initWhatsApp()
  return c.json(getLoginState())
})

app.post('/logout', async (c) => {
  await logoutWhatsApp()
  return c.json(getLoginState())
})

export const whatsappRoutes = app
