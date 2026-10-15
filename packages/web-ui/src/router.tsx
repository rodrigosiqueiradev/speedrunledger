import { type AnchorHTMLAttributes, useEffect, useState } from 'react'

/** A tiny History API router: the app has a handful of pages keyed by path. */
export function useLocation(): URL {
  const [url, setUrl] = useState(() => new URL(window.location.href))
  useEffect(() => {
    const update = () => setUrl(new URL(window.location.href))
    window.addEventListener('popstate', update)
    window.addEventListener('ledger:navigate', update)
    return () => {
      window.removeEventListener('popstate', update)
      window.removeEventListener('ledger:navigate', update)
    }
  }, [])
  return url
}

export function navigate(to: string): void {
  window.history.pushState(null, '', to)
  window.dispatchEvent(new Event('ledger:navigate'))
  window.scrollTo(0, 0)
}

export function Link(props: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a
      {...props}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
        e.preventDefault()
        navigate(props.href)
      }}
    />
  )
}
