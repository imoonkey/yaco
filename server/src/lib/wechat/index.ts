import { isLoggedIn, start, type Bot } from 'weixin-agent-sdk'
import { wechatAgent } from './agent'
import { getAuthSnapshot } from './auth'
import { sweepStaleTaps, shutdownAllTaps } from './pty-tap'

let bot: Bot | null = null
let abortController: AbortController | null = null

export function getBot(): Bot | null {
  return bot
}

export function isInitialized(): boolean {
  return bot !== null
}

export async function initWeChat(): Promise<void> {
  if (bot) {
    console.log('[wechat] already initialized')
    return
  }

  // Reap orphaned tap fifos from a prior crashed run before any tap acquire.
  sweepStaleTaps()

  if (!isLoggedIn()) {
    console.warn('[wechat] no account configured — POST /api/wechat/login to scan QR (route lands in phase 4)')
    return
  }

  abortController = new AbortController()
  try {
    bot = start(wechatAgent, {
      abortSignal: abortController.signal,
      log: (msg) => console.log(`[wechat] ${msg}`),
    })
    const auth = getAuthSnapshot()
    console.log(`[wechat] bot started (auth mode: ${auth.mode}${auth.tofuBound ? `, tofuBound: ${auth.tofuBound}` : ''})`)

    bot.wait()
      .catch((err) => { console.error('[wechat] bot monitor error:', err) })
      .finally(() => { bot = null })
  } catch (err) {
    console.error('[wechat] failed to start bot:', err)
    bot = null
  }
}

export function shutdownWeChat(): void {
  if (abortController) {
    abortController.abort()
    abortController = null
  }
  bot = null
  void shutdownAllTaps()
}
