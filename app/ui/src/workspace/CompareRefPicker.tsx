import { useState, useRef, useCallback } from 'react'
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
  const [swapKey, setSwapKey] = useState(0)
  const baseRef = useRef<HTMLDivElement>(null)
  const compareRef = useRef<HTMLDivElement>(null)

  const handleSwap = useCallback(() => {
    setSwapKey(k => k + 1)
    onChange(compare, base)
  }, [base, compare, onChange])

  return (
    <div
      className="mx-1 mb-1 rounded-md"
      style={{
        borderTop: '2px solid var(--sol-accent)',
        backgroundColor: 'color-mix(in srgb, var(--sol-accent) 3%, var(--sol-bg))',
      }}
    >
      {/* Base row */}
      <div
        ref={baseRef}
        className="flex items-center h-[22px] cursor-pointer rounded-sm mx-1 mt-1"
        style={{ transition: 'background-color 120ms' }}
        onClick={() => setOpenRow(openRow === 'base' ? null : 'base')}
        onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--sol-hover-bg)')}
        onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
      >
        <span
          className="w-[50px] shrink-0 text-ui-2xs uppercase tracking-wider font-semibold px-1.5"
          style={{ color: 'var(--sol-text)' }}
        >base</span>
        <span
          className="flex-1 text-ui-md truncate font-medium"
          style={{ color: 'var(--sol-text-dark)', fontFamily: 'var(--font-mono)', letterSpacing: '-0.01em' }}
        >{base}</span>
        <ChevronDown
          size={10}
          className="shrink-0 mr-1"
          style={{
            color: openRow === 'base' ? 'var(--sol-accent)' : 'var(--sol-text)',
            transform: openRow === 'base' ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 200ms cubic-bezier(0.2, 0, 0, 1), color 120ms',
          }}
        />
      </div>

      {/* Swap button */}
      <div className="flex justify-center h-[14px] items-center">
        <button
          key={swapKey}
          className="flex items-center justify-center cursor-pointer rounded-sm w-[18px] h-[14px]"
          style={{
            color: 'var(--sol-text)',
            transition: 'color 120ms, background-color 120ms',
            animation: swapKey > 0 ? 'swap-rotate 300ms cubic-bezier(0.2, 0, 0, 1)' : undefined,
          }}
          onMouseEnter={e => { e.currentTarget.style.color = 'var(--sol-accent)'; e.currentTarget.style.backgroundColor = 'var(--sol-hover-bg)' }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--sol-text)'; e.currentTarget.style.backgroundColor = '' }}
          onClick={handleSwap}
          title="Swap base and compare"
        >
          <ArrowUpDown size={10} />
        </button>
      </div>

      {/* Compare row */}
      <div
        ref={compareRef}
        className="flex items-center h-[22px] cursor-pointer rounded-sm mx-1 mb-1"
        style={{ transition: 'background-color 120ms' }}
        onClick={() => setOpenRow(openRow === 'compare' ? null : 'compare')}
        onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--sol-hover-bg)')}
        onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
      >
        <span
          className="w-[50px] shrink-0 text-ui-2xs uppercase tracking-wider font-semibold px-1.5"
          style={{ color: 'var(--sol-text)' }}
        >head</span>
        <span
          className="flex-1 text-ui-md truncate font-medium"
          style={{ color: 'var(--sol-text-dark)', fontFamily: 'var(--font-mono)', letterSpacing: '-0.01em' }}
        >{compare}</span>
        <ChevronDown
          size={10}
          className="shrink-0 mr-1"
          style={{
            color: openRow === 'compare' ? 'var(--sol-accent)' : 'var(--sol-text)',
            transform: openRow === 'compare' ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 200ms cubic-bezier(0.2, 0, 0, 1), color 120ms',
          }}
        />
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
