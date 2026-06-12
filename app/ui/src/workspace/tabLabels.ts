// Pure tab-label helpers shared by the editor tab strip (WorkspaceTabBar) and the
// working-area group strip (GroupTabBar): a tab's display name and same-basename
// disambiguation. Kept out of the component files so fast-refresh stays happy.
import { isDiffTab, isFileTab, parseDiffTab } from '../hooks/useWorkspaceState'

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
    return `${filename} (diff)`
  }
  return tab.split('/').pop() || tab
}

/** For tabs sharing a basename, compute the shortest parent suffix that disambiguates them. */
export function computeDisambigSuffixes(tabs: string[]): Map<string, string> {
  const suffixes = new Map<string, string>()

  // Group file tabs by basename
  const byBasename = new Map<string, string[]>()
  for (const tab of tabs) {
    if (!isFileTab(tab)) continue
    const basename = tab.split('/').pop() || tab
    const group = byBasename.get(basename)
    if (group) group.push(tab)
    else byBasename.set(basename, [tab])
  }

  for (const [, group] of byBasename) {
    if (group.length < 2) continue
    // For each tab in the group, find shortest parent dir suffix that's unique
    const parentSegments = group.map(tab => {
      const parts = tab.split('/')
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
