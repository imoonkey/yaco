import { Hono } from 'hono'
import { isLoggedIn, logout as sdkLogout } from 'weixin-agent-sdk'
import { getAuthSnapshot } from '../lib/wechat/auth'
import { isInitialized, shutdownWeChat } from '../lib/wechat'
import { getLoginState, startLogin, resetLoginState, isLoginInflight } from '../lib/wechat/login-flow'
import { fail } from '../lib/response'

const app = new Hono()

app.get('/status', (c) => {
  return c.json({
    enabled: process.env.WECHAT_ENABLED === '1',
    initialized: isInitialized(),
    loggedIn: isLoggedIn(),
    auth: getAuthSnapshot(),
    login: getLoginState(),
  })
})

app.post('/login', (c) => {
  if (process.env.WECHAT_ENABLED !== '1') {
    return fail(c, 400, 'WECHAT_ENABLED is not set')
  }
  return c.json(startLogin())
})

app.post('/login/reset', (c) => {
  resetLoginState()
  return c.json(getLoginState())
})

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
