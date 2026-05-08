import { createBindingStore } from '../channels/state'

export const wechatStore = createBindingStore('wechat')

// Re-export legacy names so existing imports continue to work.
export const getBinding = wechatStore.getBinding
export const setBinding = wechatStore.setBinding
export const clearBinding = wechatStore.clearBinding
export const listBindings = wechatStore.listBindings

export type { Binding as WeChatBinding, BindingFile as WeChatStateFile } from '../channels/state'
