import { useEffect, useState } from 'react'

export function useIsMobile(maxWidth = 768): boolean {
  const query = `(max-width: ${maxWidth}px)`
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia(query).matches
  })

  useEffect(() => {
    const media = window.matchMedia(query)
    const update = () => setIsMobile(media.matches)

    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [query])

  return isMobile
}
