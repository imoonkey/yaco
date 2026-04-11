import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { Fzf } from 'fzf'
import { DialogShell } from '../components/DialogShell'
import { fetchGitRefs, type GitRefsResult } from '../hooks/useApi'

interface RefItem {
  label: string
  group: 'special' | 'branches' | 'tags' | 'commits'
  /** For commits: short hash displayed in mono */
  hash?: string
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
      for (const c of refs.recentCommits) items.push({ label: `${c.hash} ${c.subject}`, group: 'commits', hash: c.hash })
    }
    return items
  }, [refs])

  // Fuzzy filter
  const filtered = useMemo(() => {
    const trimmed = query.trim()
    if (!trimmed) return allItems
    const fzf = new Fzf(allItems, { selector: (item: RefItem) => item.label, limit: 50 })
    return fzf.find(trimmed).map(r => r.item)
  }, [allItems, query])

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
  }, [filtered, focusIdx, selectItem])

  const groups = groupItems(filtered)

  return (
    <DialogShell
      onClose={onClose}
      overlay={false}
      animation="panel"
      autoFocusRef={inputRef}
      className="rounded-lg overflow-hidden z-50"
      style={posStyle}
    >
      <input
        ref={inputRef}
        value={query}
        onChange={e => { setQuery(e.target.value); setFocusIdx(0) }}
        onKeyDown={handleKey}
        placeholder="Search branches, tags, commits..."
        className="w-full px-2 py-1.5 text-[12px] bg-transparent outline-none"
        style={{ color: 'var(--sol-text-dark)', borderBottom: '1px solid var(--sol-border)' }}
      />
      <div ref={listRef} className="overflow-y-auto" style={{ maxHeight: 'min(300px, 50vh)' }}>
        {groups.map(group => (
          <div key={group.label}>
            <div
              className="sticky top-0 px-2 py-1 text-[10px] uppercase tracking-wider font-semibold"
              style={{ color: 'var(--sol-muted)', backgroundColor: 'var(--sol-glass-bg)' }}
            >
              {group.label}
            </div>
            {group.items.map(item => {
              const flatIdx = filtered.indexOf(item)
              const isFocused = flatIdx === clampedIdx
              return (
                <div
                  key={item.hash ? `${item.group}-${item.hash}` : `${item.group}-${item.label}`}
                  data-ref-item
                  className="flex items-center px-2 h-[22px] text-[12px] cursor-pointer truncate"
                  style={{
                    backgroundColor: isFocused ? 'color-mix(in srgb, var(--sol-blue) 15%, transparent)' : undefined,
                    color: isFocused ? 'var(--sol-blue)' : 'var(--sol-text)',
                    transition: 'background-color 120ms',
                  }}
                  onClick={() => selectItem(item)}
                  onMouseEnter={() => setFocusIdx(flatIdx)}
                >
                  {item.group === 'commits' && item.hash ? (
                    <>
                      <span style={{ fontFamily: 'var(--font-mono)', marginRight: 6 }}>{item.hash}</span>
                      <span className="truncate">{item.label.slice(item.hash.length + 1)}</span>
                    </>
                  ) : (
                    <span className="truncate">{item.label}</span>
                  )}
                </div>
              )
            })}
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="px-2 py-3 text-[12px] text-center" style={{ color: 'var(--sol-muted)' }}>
            No matches
          </div>
        )}
      </div>
    </DialogShell>
  )
}

const GROUP_LABELS: Record<RefItem['group'], string> = {
  special: 'Special',
  branches: 'Branches',
  tags: 'Tags',
  commits: 'Recent Commits',
}

function groupItems(items: RefItem[]): { label: string; items: RefItem[] }[] {
  const map = new Map<RefItem['group'], RefItem[]>()
  for (const item of items) {
    let arr = map.get(item.group)
    if (!arr) { arr = []; map.set(item.group, arr) }
    arr.push(item)
  }
  const order: RefItem['group'][] = ['special', 'branches', 'tags', 'commits']
  return order
    .filter(g => map.has(g))
    .map(g => ({ label: GROUP_LABELS[g], items: map.get(g)! }))
}
