import { Hono } from 'hono'
import { isLoggedIn, logout as sdkLogout } from 'weixin-agent-sdk'
import { getAuthSnapshot } from '../lib/wechat/auth'
import { isInitialized, shutdownWeChat } from '../lib/wechat'
import { getLoginState, startLogin, resetLoginState, isLoginInflight } from '../lib/wechat/login-flow'
import { fail } from '../lib/response'
import { isChannelEnabled, setChannelEnabled } from '../lib/channels/enabled'
import { initWeChat } from '../lib/wechat'

const app = new Hono()

app.get('/status', (c) => {
  return c.json({
    enabled: isChannelEnabled('wechat'),
    initialized: isInitialized(),
    loggedIn: isLoggedIn(),
    auth: getAuthSnapshot(),
    login: getLoginState(),
  })
})

/** Switch the channel on or off at runtime. Off releases the SDK connection but
 *  keeps the credentials on disk, so switching back on reconnects without a QR
 *  scan. Dropping the account is `/logout`, a separate and destructive action. */
app.post('/enabled', async (c) => {
  const { enabled } = await c.req.json<{ enabled?: unknown }>()
  if (typeof enabled !== 'boolean') return fail(c, 400, 'enabled must be a boolean')
  if (!enabled && isLoginInflight()) {
    return fail(c, 409, 'login flow in progress; cancel it first')
  }

  setChannelEnabled('wechat', enabled)
  if (enabled) {
    await initWeChat()
  } else {
    shutdownWeChat()
  }
  return c.json({ enabled, login: getLoginState() })
})

app.post('/login', (c) => {
  if (!isChannelEnabled('wechat')) {
    return fail(c, 400, 'wechat channel is off')
  }
  return c.json(startLogin())
})

app.post('/login/reset', (c) => {
  resetLoginState()
  return c.json(getLoginState())
})

/** Drop the account credentials. The next login needs a fresh QR scan — to
 *  merely stop the channel, use `/enabled`. */
app.post('/logout', (c) => {
  if (isLoginInflight()) {
    return fail(c, 409, 'login flow in progress; cancel it first')
  }
  shutdownWeChat()
  sdkLogout({ log: (msg) => console.log(`[wechat-logout] ${msg}`) })
  resetLoginState()
  return c.json(getLoginState())
})

export const wechatRoutes = app
