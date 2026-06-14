import type { BadgeColor } from '../hooks/useAttention'
import { badgeColorVar } from '../lib/attentionColors'

export function BadgeCount({
  count,
  color = null,
  className = '',
}: {
  count: number
  /** Tier color (red→orange→yellow). Null defaults to orange. */
  color?: BadgeColor
  className?: string
}) {
  if (count <= 0) return null
  return (
    <span
      className={`min-w-[16px] h-[16px] rounded-full text-ui-xs font-bold text-white flex items-center justify-center px-1 ${className}`}
      style={{ backgroundColor: badgeColorVar(color) }}
    >
      {count}
    </span>
  )
}
