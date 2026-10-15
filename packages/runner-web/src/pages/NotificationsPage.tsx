import type { NotificationView } from '@speedrunledger/lexicon'
import { useEffect, useState } from 'react'
import { api } from '../api.js'
import type { Me } from '../main.js'
import { Link, runHref } from '../router.js'

const SEEN_KEY = 'ledger:notifications-seen'

/** When the runner last opened their notifications, in this browser. */
export function lastSeen(): string {
  try {
    return localStorage.getItem(SEEN_KEY) ?? ''
  } catch {
    return ''
  }
}

function markSeen(at: string) {
  try {
    localStorage.setItem(SEEN_KEY, at)
  } catch {
    // Private windows may refuse storage; the page still works.
  }
}

const who = (n: NotificationView) => (n.author ? `@${n.author.handle ?? n.author.did}` : 'Someone')

function describe(n: NotificationView): string {
  switch (n.reason) {
    case 'verified':
      return `${who(n)} verified your run`
    case 'rejected':
      return `${who(n)} rejected your run`
    case 'changesRequested':
      return `${who(n)} asked for changes to your run`
    case 'worldRecord':
      return 'Your run is a new world record'
    case 'worldRecordBeaten':
      return `${who(n)} beat your world record`
    case 'flagged':
      return `${who(n)} flagged your run as suspected cheating`
    case 'invited':
      return 'You were invited to moderate'
    case 'vote':
      return `${who(n)} proposed a change you can vote on`
    default:
      return n.reason
  }
}

export function NotificationsPage({ me, onSeen }: { me: Me | null | undefined; onSeen: () => void }) {
  const [items, setItems] = useState<NotificationView[]>()
  const [error, setError] = useState<string>()
  const [seen] = useState(lastSeen)
  useEffect(() => {
    if (!me) return
    api.listNotifications(me.did).then(
      ({ notifications }) => {
        setItems(notifications)
        if (notifications[0]) markSeen(notifications[0].indexedAt)
        onSeen()
      },
      (e) => setError(e.message),
    )
  }, [me, onSeen])

  if (me === undefined) return <p className="muted">Loading…</p>
  if (me === null) return <p className="muted">Sign in to see your notifications.</p>
  if (error) return <p className="error">{error}</p>
  if (!items) return <p className="muted">Loading notifications…</p>
  return (
    <section className="narrow">
      <h1>Notifications</h1>
      {items.length === 0 ? (
        <p className="muted">Nothing yet. Verdicts on your runs and world records show up here.</p>
      ) : (
        <ul className="verdicts notifications">
          {items.map((n) => (
            <li key={`${n.reason}-${n.subject}-${n.indexedAt}`} className={n.indexedAt > seen ? 'new' : undefined}>
              <strong>{describe(n)}</strong>
              {n.community && <span className="muted"> in {n.community.name}</span>}
              <span className="muted small"> · {n.indexedAt.slice(0, 10)}</span>
              {n.text && <p>{n.text}</p>}
              {n.subject.includes('/app.speedrunledger-prototype.run/') && <Link href={runHref(n.subject)}>See the run</Link>}
              {(n.reason === 'invited' || n.reason === 'vote') && <p className="muted small">Answer in the Moderator app.</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
