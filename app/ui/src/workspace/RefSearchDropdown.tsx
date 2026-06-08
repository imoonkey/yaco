import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { Fzf } from 'fzf'
import { DialogShell } from '../components/DialogShell'
import { fetchGitRefs, type GitRefsResult } from '../hooks/useApi'

type RefGroup = 'special' | 'branches' | 'tags' | 'commits'
type FilterTab = 'all' | 'branches' | 'tags' | 'commits'

interface RefItem {
  label: string
  group: RefGroup
  /** For commits: short hash displayed in mono */
  hash?: string
  /** For commits: author name */
  author?: string
  /** For commits: relative time string */
  relTime?: string
}

const FILTER_TABS: { id: FilterTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'branches', label: 'Branches' },
  { id: 'tags', label: 'Tags' },
  { id: 'commits', label: 'Commits' },
]

/** Convert ISO date to short relative time */
function relativeTime(dateStr: string): string {
  const d = new Date(dateStr)
  const now = Date.now()
  const diffMs = now - d.getTime()
  if (diffMs < 0) return 'now'
  const mins = Math.floor(diffMs / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`
  return `${Math.floor(months / 12)}y`
}

export function RefSearchDropdown({ open, anchorRef, onSelect, onClose, projectName }: {
  open: boolean
  anchorRef: React.RefObject<HTMLElement | null>
  onSelect: (ref: string) => void
  onClose: () => void
  projectName: string
}) {
  // Compute position from anchor in an effect (avoid ref access during render)
  const [posStyle, setPosStyle] = useState<React.CSSProperties>({ position: 'fixed', left: 0, top: 0, width: 200 })
  useEffect(() => {
    if (!open) return
    const anchor = anchorRef.current
    if (!anchor) return
    const rect = anchor.getBoundingClientRect()
    setPosStyle({ position: 'fixed', left: rect.left, top: rect.bottom + 2, width: Math.max(rect.width, 200) })
  }, [open, anchorRef])

  if (!open) return null

  return (
    <RefSearchDropdownInner
      anchorRef={anchorRef}
      onSelect={onSelect}
      onClose={onClose}
      projectName={projectName}
      posStyle={posStyle}
    />
  )
}

/** Inner component — mounts fresh each open so state resets naturally */
function RefSearchDropdownInner({ onSelect, onClose, projectName, posStyle }: {
  anchorRef: React.RefObject<HTMLElement | null>
  onSelect: (ref: string) => void
  onClose: () => void
  projectName: string
  posStyle: React.CSSProperties
}) {
  const [query, setQuery] = useState('')
  const [focusIdx, setFocusIdx] = useState(0)
  const [refs, setRefs] = useState<GitRefsResult | null>(null)
  const [activeTab, setActiveTab] = useState<FilterTab>('all')
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Fetch refs on mount
  useEffect(() => {
    const controller = new AbortController()
    fetchGitRefs(projectName)
      .then(data => { if (!controller.signal.aborted) setRefs(data) })
      .catch(() => {})
    return () => controller.abort()
  }, [projectName])

  // Build flat item list
  const allItems = useMemo((): RefItem[] => {
    const items: RefItem[] = [
      { label: 'Working Tree', group: 'special' },
      { label: 'HEAD', group: 'special' },
    ]
    if (refs) {
      for (const b of refs.branches) items.push({ label: b, group: 'branches' })
      for (const t of refs.tags) items.push({ label: t, group: 'tags' })
      for (const c of refs.recentCommits) items.push({
        label: `${c.hash} ${c.subject}`,
        group: 'commits',
        hash: c.hash,
        author: c.author,
        relTime: relativeTime(c.date),
      })
    }
    return items
  }, [refs])

  // Filter by active tab
  const tabFiltered = useMemo(() => {
    if (activeTab === 'all') return allItems
    // In specific tabs, keep special items only in 'branches' tab
    return allItems.filter(item => {
      if (item.group === 'special') return activeTab === 'branches'
      return item.group === activeTab
    })
  }, [allItems, activeTab])

  // Fuzzy filter on top of tab filter
  const filtered = useMemo(() => {
    const trimmed = query.trim()
    if (!trimmed) return tabFiltered
    const fzf = new Fzf(tabFiltered, { selector: (item: RefItem) => item.label, limit: 50 })
    return fzf.find(trimmed).map(r => r.item)
  }, [tabFiltered, query])

  // Derive clamped focus index (no effect needed)
  const clampedIdx = Math.min(focusIdx, Math.max(0, filtered.length - 1))

  // Scroll focused item into view
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const items = list.querySelectorAll<HTMLElement>('[data-ref-item]')
    items[clampedIdx]?.scrollIntoView({ block: 'nearest' })
  }, [clampedIdx])

  const selectItem = useCallback((item: RefItem) => {
    onSelect(item.hash ?? item.label)
    onClose()
  }, [onSelect, onClose])

  const handleKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setFocusIdx(i => Math.min(i + 1, filtered.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setFocusIdx(i => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      const idx = Math.min(focusIdx, Math.max(0, filtered.length - 1))
      if (filtered[idx]) selectItem(filtered[idx])
    }
    else if (e.key === 'Tab') {
      // Tab cycles through filter tabs
      e.preventDefault()
      const tabIds = FILTER_TABS.map(t => t.id)
      const currentIdx = tabIds.indexOf(activeTab)
      const nextIdx = e.shiftKey
        ? (currentIdx - 1 + tabIds.length) % tabIds.length
        : (currentIdx + 1) % tabIds.length
      setActiveTab(tabIds[nextIdx])
      setFocusIdx(0)
    }
  }, [filtered, focusIdx, selectItem, activeTab])

  const groups = groupItems(filtered)

  // Compute tab counts for badges
  const tabCounts = useMemo(() => {
    if (!refs) return { branches: 0, tags: 0, commits: 0 }
    return {
      branches: refs.branches.length,
      tags: refs.tags.length,
      commits: refs.recentCommits.length,
    }
  }, [refs])

  return (
    <DialogShell
      onClose={onClose}
      overlay={false}
      animation="panel"
      autoFocusRef={inputRef}
      className="rounded-lg overflow-hidden z-50"
      style={posStyle}
    >
      {/* Search input */}
      <input
        ref={inputRef}
        value={query}
        onChange={e => { setQuery(e.target.value); setFocusIdx(0) }}
        onKeyDown={handleKey}
        placeholder="Search refs..."
        className="w-full px-2 py-1.5 text-ui-md bg-transparent outline-none"
        style={{ color: 'var(--sol-text-dark)', borderBottom: '1px solid var(--sol-border)' }}
      />

      {/* Filter tabs */}
      <div
        className="flex px-1 py-0.5 gap-0.5"
        style={{ borderBottom: '1px solid var(--sol-border)', backgroundColor: 'color-mix(in srgb, var(--sol-bg) 60%, var(--sol-header-bg))' }}
      >
        {FILTER_TABS.map(tab => {
          const isActive = activeTab === tab.id
          const count = tab.id === 'all' ? null : tabCounts[tab.id as keyof typeof tabCounts]
          return (
            <button
              key={tab.id}
              onClick={() => { setActiveTab(tab.id); setFocusIdx(0) }}
              className={`px-1.5 py-0.5 rounded text-ui-xs cursor-pointer ${isActive ? 'font-semibold' : 'font-normal'}`}
              style={{
                color: isActive ? 'var(--sol-accent)' : 'var(--sol-text)',
                backgroundColor: isActive ? 'color-mix(in srgb, var(--sol-accent) 10%, transparent)' : 'transparent',
                transition: 'all 100ms',
              }}
            >
              {tab.label}
              {count != null && count > 0 && (
                <span
                  className="ml-0.5 text-ui-2xs"
                  style={{ opacity: 0.6 }}
                >{count}</span>
              )}
            </button>
          )
        })}
      </div>

      {/* Item list */}
      <div ref={listRef} className="overflow-y-auto" style={{ maxHeight: 'min(300px, 50vh)' }}>
        {groups.map(group => (
          <div key={group.label}>
            {/* Only show group headers in "all" tab */}
            {activeTab === 'all' && (
              <div
                className="sticky top-0 px-2 py-0.5 text-ui-2xs uppercase tracking-wider font-semibold"
                style={{ color: 'var(--sol-text)', backgroundColor: 'var(--sol-glass-bg)' }}
              >
                {group.label}
              </div>
            )}
            {group.items.map(item => {
              const flatIdx = filtered.indexOf(item)
              const isFocused = flatIdx === clampedIdx
              return (
                <div
                  key={item.hash ? `${item.group}-${item.hash}` : `${item.group}-${item.label}`}
                  data-ref-item
                  className="flex items-center px-2 h-[24px] text-ui-md cursor-pointer"
                  style={{
                    backgroundColor: isFocused ? 'color-mix(in srgb, var(--sol-blue) 12%, transparent)' : undefined,
                    color: isFocused ? 'var(--sol-blue)' : 'var(--sol-text)',
                    transition: 'background-color 80ms',
                  }}
                  onClick={() => selectItem(item)}
                  onMouseEnter={() => setFocusIdx(flatIdx)}
                >
                  {item.group === 'commits' && item.hash ? (
                    <CommitRow item={item} />
                  ) : (
                    <span className="truncate">{item.label}</span>
                  )}
                </div>
              )
            })}
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="px-2 py-3 text-ui-md text-center" style={{ color: 'var(--sol-text)' }}>
            No matches
          </div>
        )}
      </div>
    </DialogShell>
  )
}

/** Commit row with hash, message, author, and relative time */
function CommitRow({ item }: { item: RefItem }) {
  return (
    <div className="flex items-center gap-1.5 w-full min-w-0">
      <span
        className="shrink-0 text-ui-sm font-semibold"
        style={{ fontFamily: 'var(--font-mono)', color: 'var(--sol-accent)' }}
      >{item.hash}</span>
      <span className="truncate flex-1 min-w-0">{item.label.slice((item.hash?.length ?? 0) + 1)}</span>
      <span
        className="shrink-0 text-ui-2xs"
        style={{ color: 'var(--sol-text-faint)', whiteSpace: 'nowrap' }}
      >
        {item.author && <span>{item.author}</span>}
        {item.author && item.relTime && <span> · </span>}
        {item.relTime && <span>{item.relTime}</span>}
      </span>
    </div>
  )
}

const GROUP_LABELS: Record<RefGroup, string> = {
  special: 'Special',
  branches: 'Branches',
  tags: 'Tags',
  commits: 'Recent Commits',
}

function groupItems(items: RefItem[]): { label: string; items: RefItem[] }[] {
  const map = new Map<RefGroup, RefItem[]>()
  for (const item of items) {
    let arr = map.get(item.group)
    if (!arr) { arr = []; map.set(item.group, arr) }
    arr.push(item)
  }
  const order: RefGroup[] = ['special', 'branches', 'tags', 'commits']
  return order
    .filter(g => map.has(g))
    .map(g => ({ label: GROUP_LABELS[g], items: map.get(g)! }))
}
