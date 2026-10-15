import { useEffect, useState } from 'react'
import type { RunView } from '@speedrunledger/lexicon'
import { ApiError, api } from '../api.js'
import type { Me } from '../main.js'
import { boardHref, editHref, Link, navigate } from '../router.js'
import { formatMs, StatusBadge } from '@speedrunledger/web-ui'

export function RunPage({ uri, me, share }: { uri: string; me: Me | null | undefined; share?: boolean }) {
  const [run, setRun] = useState<RunView>()
  const [error, setError] = useState<string>()
  const [shared, setShared] = useState<'sharing' | 'shared' | string>()
  const own = me?.did !== undefined && me?.did === run?.runner.did

  async function shareRun() {
    if (!run) return
    setShared('sharing')
    try {
      await api.shareRun(run.uri.split('/').pop()!)
      setShared('shared')
    } catch (err) {
      setShared((err as Error).message)
    }
  }

  // Arriving from the submit form with "post it on Bluesky" ticked: share once the run is indexed.
  useEffect(() => {
    if (share && own && shared === undefined) {
      void shareRun()
      history.replaceState(null, '', location.href.replace(/&share=1/, ''))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [share, own])
  useEffect(() => {
    // A run just submitted takes a moment to reach the index; keep asking for a while.
    let cancelled = false
    let attempts = 0
    const load = () =>
      api.getRun(uri).then(
        (r) => !cancelled && setRun(r.run),
        (e) => {
          if (cancelled) return
          if (e instanceof ApiError && e.status === 404 && ++attempts < 20) setTimeout(load, 500)
          else setError(e.message)
        },
      )
    load()
    return () => {
      cancelled = true
    }
  }, [uri])

  if (error) return <p className="error">{error}</p>
  if (!run) return <p className="muted">Loading run…</p>
  const times = run.verifiedTimes ?? run.times

  return (
    <section className="run">
      <p className="crumbs">
        <Link href={boardHref(run.category, run.variables.map((v) => `${v.variable}=${v.value}`))}>Back to the board</Link>
      </p>
      <h1>
        {formatMs(times.realTimeMs ?? times.realTimeNoLoadsMs ?? times.gameTimeMs)} by {run.runner.handle ?? run.runner.did}
      </h1>
      <p>
        <StatusBadge status={run.status} /> {run.rank !== undefined && <strong>Rank {run.rank}</strong>}
      </p>
      {run.problems.length > 0 && <p className="error">Problems: {run.problems.join(', ')}</p>}
      {run.labels?.some((l) => l.val === 'suspected-cheating') && (
        <p className="notice flag">
          <strong>Flagged as suspected cheating</strong> by a moderator
          {run.labels
            .filter((l) => l.val === 'suspected-cheating')
            .map((l) => (l.moderator ? ` (@${l.moderator.handle ?? l.moderator.did})` : ''))
            .join('')}
          {run.labels.find((l) => l.reason)?.reason ? `: ${run.labels.find((l) => l.reason)!.reason}` : ''}. This is a warning, not a
          verdict; the board is unchanged.
        </p>
      )}
      <dl className="facts">
        <dt>Times</dt>
        <dd>
          {(['realTimeMs', 'realTimeNoLoadsMs', 'gameTimeMs'] as const)
            .filter((k) => run.times[k] !== undefined)
            .map((k) => (
              <span key={k}>
                {k.replace('Ms', '')}: {formatMs(run.times[k])}{' '}
              </span>
            ))}
          {run.verifiedTimes && <em>(retimed by a moderator to {formatMs(run.verifiedTimes.realTimeMs ?? run.verifiedTimes.gameTimeMs)})</em>}
        </dd>
        <dt>Video</dt>
        <dd>
          {run.videos.map((v) => (
            <span key={v.url} className="video">
              <a href={v.url} target="_blank" rel="noreferrer noopener">
                {v.label ?? v.url}
              </a>
              {run.deadVideos?.some((u) => u === v.url) && <span className="error small"> (this link no longer works; edit the run to replace it)</span>}{' '}
            </span>
          ))}
        </dd>
        {run.variables.length > 0 && (
          <>
            <dt>Variables</dt>
            <dd>{run.variables.map((v) => `${v.variable}: ${v.value}`).join(', ')}</dd>
          </>
        )}
        {run.platform && (
          <>
            <dt>Platform</dt>
            <dd>
              {run.platform}
              {run.emulated ? ' (emulator)' : ''}
            </dd>
          </>
        )}
        {run.comment && (
          <>
            <dt>Comment</dt>
            <dd>{run.comment}</dd>
          </>
        )}
        <dt>Played</dt>
        <dd>{run.performedAt.slice(0, 10)}</dd>
        <dt>Record</dt>
        <dd className="mono small">{run.uri}</dd>
      </dl>
      <h2>Review history</h2>
      {run.verdicts && run.verdicts.length > 0 ? (
        <ul className="verdicts">
          {run.verdicts.map((v) => (
            <li key={v.uri}>
              <StatusBadge status={v.status} /> by @{v.reviewer.handle ?? v.reviewer.did} on {v.indexedAt.slice(0, 10)}
              {!v.current && <span className="tag">earlier version</span>}
              {v.reason && <p>{v.reason}</p>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No verdicts yet.</p>
      )}
      {own && (
        <Link className="button" href={editHref(run.uri)}>
          Edit run
        </Link>
      )}{' '}
      {own && (
        <button className="secondary" disabled={shared === 'sharing' || shared === 'shared'} onClick={shareRun}>
          {shared === 'shared' ? 'Posted to Bluesky' : shared === 'sharing' ? 'Posting…' : 'Share to Bluesky'}
        </button>
      )}{' '}
      {shared && !['sharing', 'shared'].includes(shared) && <p className="error">Could not post: {shared}</p>}
      {own && (
        <button
          className="danger"
          onClick={async () => {
            if (!confirm('Delete this run from your repo? Copies other services made may remain.')) return
            await api.deleteRun(run.uri.split('/').pop()!)
            navigate('/me')
          }}
        >
          Delete run
        </button>
      )}
    </section>
  )
}
