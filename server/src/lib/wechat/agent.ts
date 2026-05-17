import type { Agent, ChatRequest, ChatResponse } from 'weixin-agent-sdk'
import { authorize } from './auth'
import { wechatRouter } from './router'

// Per-conversation FIFO queue — SDK fires chat() concurrently but our session
// is single-threaded. Serialize per conversationId.
const queues = new Map<string, Promise<unknown>>()

function serialize<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(conversationId) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  const tail = next.catch(() => undefined)
  queues.set(conversationId, tail)
  void tail.then(() => {
    if (queues.get(conversationId) === tail) queues.delete(conversationId)
  })
  return next
}

async function handle(request: ChatRequest): Promise<ChatResponse> {
  const { conversationId, text, media } = request

  if (await authorize(conversationId) === 'deny') return {}

  if (media) return { text: 'media messages not supported' }

  const chunks: string[] = []
  await wechatRouter.handleMessage({ conversationId }, text ?? '', async (reply) => {
    chunks.push(reply.kind === 'text' ? reply.text : `[attachment: ${reply.filename}]`)
  })
  return { text: chunks.join('\n\n') }
}

export const wechatAgent: Agent = {
  async chat(request: ChatRequest): Promise<ChatResponse> {
    return serialize(request.conversationId, () => handle(request))
  },
}
