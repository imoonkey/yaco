import type { BadgeColor } from '../hooks/useAttention'

/** Map an attention tier color to its Solarized CSS variable. Null → orange
 *  (the neutral "count" default used by the legacy numeric badge). */
export function badgeColorVar(color: BadgeColor): string {
  switch (color) {
    case 'red': return 'var(--sol-red)'
    case 'yellow': return 'var(--sol-yellow)'
    case 'orange':
    default: return 'var(--sol-orange)'
  }
}
