import type { SessionProvider } from '../types'
import { Terminal } from 'lucide-react'

export function ProviderIcon({ provider, className = 'w-4 h-4' }: { provider: SessionProvider; className?: string }) {
  if (provider === 'claude') {
    return <img src="/claude-code-symbol.svg" alt="" aria-hidden="true" className={className} />
  }

  if (provider === 'codex') {
    return <img src="/chatgpt-logo.svg" alt="" aria-hidden="true" className={className} />
  }

  return <Terminal className={className} aria-hidden="true" />
}
