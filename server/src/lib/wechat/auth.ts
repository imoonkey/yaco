import { createAuthStore } from '../channels/auth'

const wechatAuth = createAuthStore('wechat', 'WECHAT_CONVERSATION_WHITELIST')

export const authorize = wechatAuth.authorize
export const getAuthSnapshot = wechatAuth.getAuthSnapshot
