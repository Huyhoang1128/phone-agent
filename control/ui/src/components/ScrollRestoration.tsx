import { useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'

// Remembers the scroll offset of the main content area per history entry, so
// browser back/forward (and the in-app "back" button) return the user to where
// they were instead of jumping to the top of the page.
const scrollOffsets = new Map<string, number>()

interface ScrollRestorationProps {
  /** id of the scrollable element to track. */
  containerId: string
}

export default function ScrollRestoration({ containerId }: ScrollRestorationProps) {
  const location = useLocation()
  const navigationType = useNavigationType()

  // The scroll listener needs the *current* history key; a ref keeps it fresh.
  const locationKeyRef = useRef(location.key)
  locationKeyRef.current = location.key

  // Continuously record the scroll offset for the active history entry.
  useLayoutEffect(() => {
    const el = document.getElementById(containerId)
    if (!el) return
    const handleScroll = () => {
      scrollOffsets.set(locationKeyRef.current, el.scrollTop)
    }
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [containerId])

  // On navigation: restore the offset on back/forward (POP), or reset to the
  // top on a brand-new navigation (PUSH/REPLACE).
  useLayoutEffect(() => {
    const el = document.getElementById(containerId)
    if (!el) return

    if (navigationType !== 'POP') {
      el.scrollTop = 0
      return
    }

    const target = scrollOffsets.get(location.key) ?? 0
    // The page content may still be growing (async data); reapply the offset
    // for a few animation frames so the restore "sticks".
    let rafId = 0
    let attempts = 0
    const apply = () => {
      el.scrollTop = target
      attempts += 1
      if (attempts < 5) rafId = requestAnimationFrame(apply)
    }
    apply()
    return () => cancelAnimationFrame(rafId)
  }, [location.key, navigationType, containerId])

  return null
}
