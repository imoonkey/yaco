import type { SessionProvider } from '../types'

export function ProviderIcon({ provider, className = 'w-4 h-4' }: { provider: SessionProvider; className?: string }) {
  if (provider === 'claude') {
    return <img src="/claude-code-symbol.svg" alt="" aria-hidden="true" className={className} />
  }

  if (provider === 'codex') {
    return <img src="/chatgpt-logo.svg" alt="" aria-hidden="true" className={className} />
  }

  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <rect x="3.5" y="4.5" width="17" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 20h8M10 17.5h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}
