import { useEffect, useState } from 'react'

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia(query).matches
  })

  useEffect(() => {
    const media = window.matchMedia(query)
    const update = () => setMatches(media.matches)

    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [query])

  return matches
}

export function useIsMobile(maxWidth = 768): boolean {
  const narrowWidth = useMediaQuery(`(max-width: ${maxWidth}px)`)
  const landscapePhone = useMediaQuery('(max-height: 500px) and (pointer: coarse)')
  return narrowWidth || landscapePhone
}

export function useIsTouch(): boolean {
  return useMediaQuery('(pointer: coarse)')
}

export function useIsLandscape(): boolean {
  return useMediaQuery('(orientation: landscape)')
}
