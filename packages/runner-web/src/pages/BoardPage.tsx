import type { WorldRecordView } from '@speedrunledger/lexicon'
import { useEffect, useState } from 'react'
import { api } from '../api.js'
import type { Me } from '../main.js'
import { boardHref, Link, navigate, runHref, submitHref } from '../router.js'
import { formatMs } from '@speedrunledger/web-ui'

type Board = Awaited<ReturnType<typeof api.getLeaderboard>>

const timeKey = { realTime: 'realTimeMs', realTimeNoLoads: 'realTimeNoLoadsMs', gameTime: 'gameTimeMs' } as const
const timeLabel = { realTime: 'RTA', realTimeNoLoads: 'LRT', gameTime: 'IGT' } as const

export function BoardPage({ category, variables, me }: { category: string; variables: string[]; me: Me | null | undefined }) {
  const [board, setBoard] = useState<Board>()
  const [error, setError] = useState<string>()
  const [records, setRecords] = useState<WorldRecordView[]>()
  const key = [category, ...variables].join('|')
  useEffect(() => {
    setBoard(undefined)
    setError(undefined)
    api.getLeaderboard(category, variables).then(setBoard, (e) => setError(e.message))
    api.listWorldRecords(category).then((r) => setRecords(r.records), () => setRecords([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  if (error) return <p className="error">{error}</p>
  if (!board) return <p className="muted">Loading board…</p>
  const { category: cat, game, entries, subcategory } = board
  const subVars = cat.variables.filter((v) => v.subcategory)
  const columns = cat.timingMethods as (keyof typeof timeKey)[]
  const chosen = Object.fromEntries(subcategory.map((s) => [s.variable, s.value]))

  return (
    <section>
      <p className="crumbs">
        <Link href="/">Games</Link> / {game.title}
      </p>
      <div className="title-row">
        <h1>
          {game.title} — {cat.name}
        </h1>
        {!cat.retired && me && (
          <Link className="button" href={submitHref(cat.uri)}>
            Submit a run
          </Link>
        )}
      </div>
      {cat.description && <p className="muted category-description">{cat.description}</p>}
      {subVars.map((v) => (
        <div className="tabs" key={v.id} role="tablist" aria-label={v.name}>
          {v.values.map((value) => (
            <button
              key={value}
              role="tab"
              aria-selected={chosen[v.id] === value}
              onClick={() =>
                navigate(boardHref(cat.uri, Object.entries({ ...chosen, [v.id]: value }).map(([id, val]) => `${id}=${val}`)))
              }
            >
              {value}
            </button>
          ))}
        </div>
      ))}
      {entries.length === 0 ? (
        <p className="muted">No verified runs yet.</p>
      ) : (
        <table className="board">
          <thead>
            <tr>
              <th>#</th>
              <th>Runner</th>
              {columns.map((c) => (
                <th key={c} className={c === cat.primaryTiming ? 'primary' : undefined}>
                  {timeLabel[c]}
                </th>
              ))}
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(({ rank, rankedMs, run }) => (
              <tr key={run.uri}>
                <td className="rank">{rank}</td>
                <td>
                  <Link href={runHref(run.uri)}>{run.runner.handle ?? run.runner.did}</Link>
                </td>
                {columns.map((c) => (
                  <td key={c} className="time">
                    {c === cat.primaryTiming ? formatMs(rankedMs) : formatMs((run.verifiedTimes ?? run.times)[timeKey[c]])}
                  </td>
                ))}
                <td className="muted">{run.performedAt.slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {records && records.length > 0 && <Progression records={records} subcategory={subcategory} />}
      {cat.ruleset && (
        <details className="rules">
          <summary>Rules</summary>
          <pre>{cat.ruleset.text}</pre>
        </details>
      )}
    </section>
  )
}

/** The world record history of the board being shown, newest first. */
function Progression({ records, subcategory }: { records: WorldRecordView[]; subcategory: { variable: string; value: string }[] }) {
  const same = (r: WorldRecordView) =>
    subcategory.every((s) => r.subcategory?.some((x) => x.variable === s.variable && x.value === s.value))
  const shown = records.filter(same)
  if (shown.length === 0) return null
  return (
    <details className="rules progression">
      <summary>World record history</summary>
      <ol className="verdicts">
        {shown.map((r) => (
          <li key={r.run.uri}>
            <Link href={runHref(r.run.uri)}>{formatMs(r.rankedMs)}</Link> by @{r.run.runner.handle ?? r.run.runner.did}
            <span className="muted small"> · {r.setAt.slice(0, 10)}</span>
            {r.previous && r.previousRankedMs !== undefined && (
              <span className="muted small">
                {' '}
                (beat @{r.previous.handle ?? r.previous.did}’s {formatMs(r.previousRankedMs)})
              </span>
            )}
          </li>
        ))}
      </ol>
    </details>
  )
}
