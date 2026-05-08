import type { Agent, ChatRequest, ChatResponse } from 'weixin-agent-sdk'
import { authorize } from './auth'
import { dispatch, parseCommand, passthroughText } from './router'

/** Per-conversation FIFO queue — SDK fires chat() concurrently but our session
 *  is single-threaded. Serialize per conversationId. */
const queues = new Map<string, Promise<unknown>>()

function serialize<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(conversationId) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  const tail = next.catch(() => undefined)
  queues.set(conversationId, tail)
  // Drop the queue entry once this task settles, but only if it's still ours
  // (newer enqueues replace tail and must not be deleted).
  void tail.then(() => {
    if (queues.get(conversationId) === tail) queues.delete(conversationId)
  })
  return next
}

async function handle(request: ChatRequest): Promise<ChatResponse> {
  const { conversationId, text, media } = request

  if (await authorize(conversationId) === 'deny') return {}

  if (media) return { text: '暂不支持 media 消息' }

  const command = parseCommand(text ?? '')
  if (command) {
    const reply = await dispatch({ conversationId }, command)
    return { text: reply }
  }

  const reply = await passthroughText({ conversationId }, text ?? '')
  return { text: reply }
}

export const wechatAgent: Agent = {
  async chat(request: ChatRequest): Promise<ChatResponse> {
    return serialize(request.conversationId, () => handle(request))
  },
}
