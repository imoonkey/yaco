import type { CSSProperties, ReactNode } from 'react'

export function SearchHighlightedText({
  text,
  positions,
  className,
  style,
}: {
  text: string
  positions?: Set<number> | null
  className?: string
  style?: CSSProperties
}) {
  if (!positions || positions.size === 0) {
    return <span className={className} style={style}>{text}</span>
  }

  const parts: ReactNode[] = []
  let run = ''
  let runStart = 0
  let inMatch = positions.has(0)

  for (let i = 0; i <= text.length; i++) {
    const nextInMatch = i < text.length && positions.has(i)
    if (i === text.length || nextInMatch !== inMatch) {
      if (run) {
        parts.push(inMatch
          ? <span key={runStart} className="font-semibold text-[var(--sol-blue)]">{run}</span>
          : <span key={runStart}>{run}</span>)
      }
      run = i < text.length ? text[i] : ''
      runStart = i
      inMatch = nextInMatch
    } else {
      run += text[i]
    }
  }

  return <span className={className} style={style}>{parts}</span>
}
