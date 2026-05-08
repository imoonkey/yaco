import { createAuthStore } from '../channels/auth'

const whatsappAuth = createAuthStore('whatsapp', 'WHATSAPP_CONVERSATION_WHITELIST')

export const authorize = whatsappAuth.authorize
export const getAuthSnapshot = whatsappAuth.getAuthSnapshot
