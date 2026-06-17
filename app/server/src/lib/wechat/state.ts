import { createBindingStore } from '../channels/state'

export const wechatStore = createBindingStore('wechat')

export type { Binding as WeChatBinding, BindingFile as WeChatStateFile } from '../channels/state'
