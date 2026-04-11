import { useState, useRef } from 'react'
import { ChevronDown, ArrowUpDown } from 'lucide-react'
import { RefSearchDropdown } from './RefSearchDropdown'

interface CompareRefPickerProps {
  base: string
  compare: string
  onChange: (base: string, compare: string) => void
  projectName: string
}

export function CompareRefPicker({ base, compare, onChange, projectName }: CompareRefPickerProps) {
  const [openRow, setOpenRow] = useState<'base' | 'compare' | null>(null)
  const baseRef = useRef<HTMLDivElement>(null)
  const compareRef = useRef<HTMLDivElement>(null)

  return (
    <div className="px-2 py-1" style={{ borderTop: '2px solid var(--sol-accent)' }}>
      {/* Base row */}
      <div
        ref={baseRef}
        className="flex items-center h-[20px] cursor-pointer rounded hover:bg-sol-hover-bg"
        onClick={() => setOpenRow(openRow === 'base' ? null : 'base')}
      >
        <span className="w-[55px] shrink-0 text-[10px]" style={{ color: 'var(--sol-muted)' }}>base</span>
        <span className="flex-1 text-[12px] truncate" style={{ color: 'var(--sol-text-dark)' }}>{base}</span>
        <ChevronDown size={10} style={{ color: 'var(--sol-muted)' }} />
      </div>

      {/* Swap button */}
      <div className="flex justify-center h-[16px] items-center">
        <button
          className="flex items-center justify-center cursor-pointer"
          style={{ color: 'var(--sol-muted)', transition: 'color 120ms' }}
          onMouseEnter={e => (e.currentTarget.style.color = 'var(--sol-accent)')}
          onMouseLeave={e => (e.currentTarget.style.color = 'var(--sol-muted)')}
          onClick={() => onChange(compare, base)}
        >
          <ArrowUpDown size={10} />
        </button>
      </div>

      {/* Compare row */}
      <div
        ref={compareRef}
        className="flex items-center h-[20px] cursor-pointer rounded hover:bg-sol-hover-bg"
        onClick={() => setOpenRow(openRow === 'compare' ? null : 'compare')}
      >
        <span className="w-[55px] shrink-0 text-[10px]" style={{ color: 'var(--sol-muted)' }}>compare</span>
        <span className="flex-1 text-[12px] truncate" style={{ color: 'var(--sol-text-dark)' }}>{compare}</span>
        <ChevronDown size={10} style={{ color: 'var(--sol-muted)' }} />
      </div>

      {/* Dropdown for whichever row is open */}
      <RefSearchDropdown
        open={openRow === 'base'}
        anchorRef={baseRef}
        projectName={projectName}
        onSelect={ref => onChange(ref, compare)}
        onClose={() => setOpenRow(null)}
      />
      <RefSearchDropdown
        open={openRow === 'compare'}
        anchorRef={compareRef}
        projectName={projectName}
        onSelect={ref => onChange(base, ref)}
        onClose={() => setOpenRow(null)}
      />
    </div>
  )
}
