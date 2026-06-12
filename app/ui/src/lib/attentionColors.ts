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

/** Soft wash of a badge color over `base` (default transparent), for surfaces —
 *  row backgrounds, section-header bands, colored borders — that should echo the
 *  badge palette at lower intensity. Null color → neutral: returns `base`
 *  unchanged (fyi/Recent carries no badge color). */
export function badgeTint(color: BadgeColor, pct: number, base = 'transparent'): string {
  if (color === null) return base
  return `color-mix(in srgb, ${badgeColorVar(color)} ${pct}%, ${base})`
}
