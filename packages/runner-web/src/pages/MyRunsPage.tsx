import { useEffect, useState } from 'react'
import type { RunView } from '@speedrunledger/lexicon'
import { ApiError, api } from '../api.js'
import type { Me } from '../main.js'
import { Link, runHref } from '../router.js'
import { formatMs } from '../time.js'
import { StatusBadge } from './RunPage.js'

export function MyRunsPage({ me }: { me: Me | null | undefined }) {
  const [runs, setRuns] = useState<RunView[]>()
  useEffect(() => {
    if (!me) return
    api.getRunner(me.did).then(
      (r) => setRuns(r.runs),
      (e) => (e instanceof ApiError && e.status === 404 ? setRuns([]) : setRuns([])),
    )
  }, [me])

  if (me === null) return <p className="muted">Sign in to see your runs.</p>
  if (!runs) return <p className="muted">Loading your runs…</p>
  if (runs.length === 0) return <p className="muted">You haven’t submitted any runs yet. Pick a category from the games list.</p>
  return (
    <section>
      <h1>My runs</h1>
      <table className="board">
        <thead>
          <tr>
            <th>Time</th>
            <th>Status</th>
            <th>Rank</th>
            <th>Submitted</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.uri}>
              <td className="time">
                <Link href={runHref(run.uri)}>{formatMs(run.times.realTimeMs ?? run.times.realTimeNoLoadsMs ?? run.times.gameTimeMs)}</Link>
              </td>
              <td>
                <StatusBadge status={run.status} />
              </td>
              <td>{run.rank ?? '—'}</td>
              <td className="muted">{run.indexedAt.slice(0, 10)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
