import type { QueueItem } from '@speedrunledger/lexicon'
import { formatMs } from '@speedrunledger/web-ui'
import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { Link, reviewHref, useLocation } from '../router.js'

const timeKey = { realTime: 'realTimeMs', realTimeNoLoads: 'realTimeNoLoadsMs', gameTime: 'gameTimeMs' } as const

export function QueuePage({ community, me }: { community: string; me: { did: string } }) {
  const location = useLocation()
  const [items, setItems] = useState<QueueItem[]>()
  const [cursor, setCursor] = useState<string>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    setItems(undefined)
    api.listReviewQueue(community).then(
      (r) => {
        setItems(r.runs)
        setCursor(r.cursor)
      },
      (e) => setError(e.message),
    )
  }, [community, location.search])

  const reviewed = location.searchParams.get('reviewed')
  if (error) return <p className="error">{error}</p>
  return (
    <section>
      <p className="crumbs">
        <Link href="/">Your communities</Link>
      </p>
      <h1>Review queue</h1>
      {reviewed && <p className="notice ok">Verdict recorded. It reaches boards once the indexer sees it.</p>}
      {!items ? (
        <p className="muted">Loading queue…</p>
      ) : items.length === 0 ? (
        <p className="muted">Nothing to review. New runs appear here as soon as the indexer sees them.</p>
      ) : (
        <>
          <table className="queue">
            <thead>
              <tr>
                <th>Category</th>
                <th>Runner</th>
                <th>Time</th>
                <th>Submitted</th>
                <th>Approvals</th>
              </tr>
            </thead>
            <tbody>
              {items.map(({ run, category, approvals, requiredApprovals, approvedBy }) => (
                <tr key={run.uri}>
                  <td>{category.name}</td>
                  <td>
                    <Link href={reviewHref(run.uri)}>{run.runner.handle ?? run.runner.did}</Link>
                  </td>
                  <td className="time">{formatMs(run.times[timeKey[category.primaryTiming as keyof typeof timeKey]])}</td>
                  <td className="muted">{run.indexedAt.slice(0, 10)}</td>
                  <td>
                    {approvals} of {requiredApprovals}
                    {approvedBy?.some((d) => d === me.did) && <span className="tag">you approved</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {cursor && (
            <button
              className="link"
              onClick={async () => {
                const next = await api.listReviewQueue(community, cursor)
                setItems([...items, ...next.runs])
                setCursor(next.cursor)
              }}
            >
              Load more
            </button>
          )}
        </>
      )}
    </section>
  )
}
