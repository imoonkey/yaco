// Pure tab-label helpers for the working-area group strip (GroupTabBar) and the
// mobile editor tab strip: a tab's display name and same-basename
// disambiguation. Kept out of the component files so fast-refresh stays happy.
import { isDiffTab, parseDiffTab } from '../hooks/useWorkspaceState'

function truncateRef(ref: string, max = 12): string {
  return ref.length > max ? ref.slice(0, max - 1) + '…' : ref
}

export function tabName(tab: string): string {
  if (isDiffTab(tab)) {
    const parsed = parseDiffTab(tab)
    if (!parsed) return tab
    const filename = parsed.path.split('/').pop() || parsed.path
    if (parsed.base && parsed.compare) {
      return `${filename} (${truncateRef(parsed.base)}..${truncateRef(parsed.compare)})`
    }
    return filename
  }
  return tab.split('/').pop() || tab
}

function labelPath(tab: string): string {
  return parseDiffTab(tab)?.path ?? tab
}

/**
 * Accessible label for a tab's close button. A plain diff tab (no base/compare)
 * renders the same basename as its file sibling — distinguished on screen only by
 * an aria-hidden icon — so mark it "(diff)" to keep the accessible name unique.
 * Compare diffs already carry a "(base..compare)" suffix and need no marker.
 */
export function tabCloseLabel(tab: string): string {
  const parsed = parseDiffTab(tab)
  const isPlainDiff = parsed !== null && !(parsed.base && parsed.compare)
  return `Close ${tabName(tab)}${isPlainDiff ? ' (diff)' : ''}`
}

/** For tabs sharing a basename, compute the shortest parent suffix that disambiguates them. */
export function computeDisambigSuffixes(tabs: string[]): Map<string, string> {
  const suffixes = new Map<string, string>()

  // Group by rendered label inside each tab class. A file tab and a diff tab for
  // the same path are already visually distinct, so they should not force a path
  // suffix on each other.
  const byLabel = new Map<string, string[]>()
  for (const tab of tabs) {
    const key = `${isDiffTab(tab) ? 'diff' : 'file'}:${tabName(tab)}`
    const group = byLabel.get(key)
    if (group) group.push(tab)
    else byLabel.set(key, [tab])
  }

  for (const [, group] of byLabel) {
    if (group.length < 2) continue
    // For each tab in the group, find shortest parent dir suffix that's unique
    const parentSegments = group.map(tab => {
      const parts = labelPath(tab).split('/')
      return parts.slice(0, -1) // dir segments only
    })
    for (let gi = 0; gi < group.length; gi++) {
      const myParts = parentSegments[gi]
      // Try 1 parent segment, then 2, etc.
      for (let depth = 1; depth <= myParts.length; depth++) {
        const suffix = myParts.slice(-depth).join('/')
        const unique = parentSegments.every((other, oi) =>
          oi === gi || other.slice(-depth).join('/') !== suffix
        )
        if (unique) { suffixes.set(group[gi], suffix); break }
      }
      // If no unique suffix found (identical paths), use full parent
      if (!suffixes.has(group[gi]) && myParts.length > 0) {
        suffixes.set(group[gi], myParts.join('/'))
      }
    }
  }
  return suffixes
}
