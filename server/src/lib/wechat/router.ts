import { createRouter } from '../channels/router'
import { wechatStore } from './state'

/** The singleton wechat router. Imported by agent.ts and re-exported below
 *  for legacy router.ts importers (state, currentProject map are shared). */
export const wechatRouter = createRouter(wechatStore)

export const parseCommand = wechatRouter.parseCommand
export const dispatch = wechatRouter.dispatch
export const passthroughText = async (ctx: { conversationId: string }, text: string): Promise<string> => {
  const chunks: string[] = []
  await wechatRouter.handleMessage(ctx, text, async (reply) => { chunks.push(reply) })
  return chunks.join('\n\n')
}
export const getCurrentProject = wechatRouter.getCurrentProject

/** Test hook: clear in-memory router state */
export function _resetRouterState(): void {
  wechatRouter._resetState()
}
