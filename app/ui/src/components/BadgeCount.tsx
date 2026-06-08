export function BadgeCount({ count, className = '' }: { count: number; className?: string }) {
  if (count <= 0) return null
  return (
    <span
      className={`min-w-[16px] h-[16px] rounded-full text-ui-2xs font-bold text-white flex items-center justify-center px-1 ${className}`}
      style={{ backgroundColor: 'var(--sol-orange)' }}
    >
      {count}
    </span>
  )
}
