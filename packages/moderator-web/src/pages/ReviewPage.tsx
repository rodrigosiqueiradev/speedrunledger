import type { CategoryView, RunView } from '@speedrunledger/lexicon'
import { formatMs, parseTime, StatusBadge } from '@speedrunledger/web-ui'
import { type FormEvent, useEffect, useState } from 'react'
import { api, type VerdictInput } from '../api.js'
import type { Me } from '../main.js'
import { Link, navigate, queueHref } from '../router.js'

const timeFields = { realTime: 'realTimeMs', realTimeNoLoads: 'realTimeNoLoadsMs', gameTime: 'gameTimeMs' } as const
const timeNames = { realTime: 'Real time (RTA)', realTimeNoLoads: 'Real time without loads', gameTime: 'In-game time' } as const
type Method = keyof typeof timeFields

export function ReviewPage({ uri, me }: { uri: string; me: Me }) {
  const [run, setRun] = useState<RunView>()
  const [category, setCategory] = useState<CategoryView>()
  const [error, setError] = useState<string>()
  const [status, setStatus] = useState<VerdictInput['status']>('verified')
  const [retime, setRetime] = useState<Record<string, string>>({})
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api
      .getRun(uri)
      .then(async ({ run }) => {
        setRun(run)
        setCategory((await api.getLeaderboard(run.category)).category)
      })
      .catch((e) => setError(e.message))
  }, [uri])

  if (!run || !category) return error ? <p className="error">{error}</p> : <p className="muted">Loading run…</p>
  const methods = category.timingMethods as Method[]
  const ownRun = run.runner.did === me.did
  // Approvals of this version so far, while no later verdict overturned them.
  const current = (run.verdicts ?? []).filter((v) => v.current)
  const approvers = current[0]?.status === 'verified' ? [...new Set(current.filter((v) => v.status === 'verified').map((v) => v.reviewer.did))] : []
  const approvedByMe = approvers.some((d) => d === me.did)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!run) return
    setError(undefined)
    const verifiedTimes: Record<string, number> = {}
    if (status === 'verified') {
      for (const m of methods) {
        const text = retime[m]?.trim()
        if (!text) continue
        const ms = parseTime(text)
        if (ms === undefined) return setError(`${timeNames[m]}: use a time like 15:02.340`)
        verifiedTimes[timeFields[m]] = ms
      }
    }
    if (status !== 'verified' && !reason.trim()) return setError('Tell the runner why')
    setBusy(true)
    try {
      await api.createVerdict({
        run: { uri: run.uri, cid: run.cid },
        status,
        reason: reason.trim() || undefined,
        verifiedTimes: Object.keys(verifiedTimes).length ? { ...run.times, ...verifiedTimes } : undefined,
      })
      navigate(`${queueHref(run.community)}&reviewed=${status}`)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="run">
      <p className="crumbs">
        <Link href={queueHref(run.community)}>Review queue</Link>
      </p>
      <h1>
        {category.name}: {formatMs(run.times[timeFields[category.primaryTiming as Method]])} by{' '}
        {run.runner.handle ?? run.runner.did}
      </h1>
      <p>
        <StatusBadge status={run.status} />
      </p>
      <dl className="facts">
        <dt>Times</dt>
        <dd>
          {methods.map((m) => (
            <span key={m}>
              {timeNames[m]}: {formatMs(run.times[timeFields[m]])}
            </span>
          ))}
        </dd>
        <dt>Video</dt>
        <dd>
          {run.videos.length === 0
            ? 'none'
            : run.videos.map((v) => (
                <span key={v.url} className="video">
                  <a href={v.url} target="_blank" rel="noreferrer noopener">
                    {v.label ?? v.url}
                  </a>
                  {run.deadVideos?.some((u) => u === v.url) && <span className="error small"> (dead link)</span>}{' '}
                </span>
              ))}
        </dd>
        {run.variables.length > 0 && (
          <>
            <dt>Variables</dt>
            <dd>{run.variables.map((v) => `${v.variable}: ${v.value}`).join(', ')}</dd>
          </>
        )}
        {(run.platform || run.emulated) && (
          <>
            <dt>Platform</dt>
            <dd>
              {run.platform ?? 'not given'}
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
        <dd className="mono small">
          {run.uri} @ {run.cid}
        </dd>
      </dl>
      {category.ruleset && (
        <details className="rules">
          <summary>Rules</summary>
          <pre>{category.ruleset.text}</pre>
        </details>
      )}

      <h2>Verdict</h2>
      {ownRun ? (
        <p className="muted">You ran in this run, so another moderator has to review it.</p>
      ) : (
        <form className="form narrow verdict-form" onSubmit={submit}>
          <fieldset>
            <legend>Decision</legend>
            {(
              [
                ['verified', 'Verify'],
                ['changesRequested', 'Request changes'],
                ['rejected', 'Reject'],
              ] as const
            ).map(([value, label]) => (
              <label className="check" key={value}>
                <input type="radio" name="status" value={value} checked={status === value} onChange={() => setStatus(value)} />{' '}
                {label}
              </label>
            ))}
          </fieldset>
          {status === 'verified' &&
            methods.map((m) => (
              <label key={m}>
                Retime {timeNames[m]} (optional)
                <input
                  name={`retime-${m}`}
                  inputMode="decimal"
                  placeholder={formatMs(run.times[timeFields[m]])}
                  value={retime[m] ?? ''}
                  onChange={(e) => setRetime({ ...retime, [m]: e.target.value })}
                />
              </label>
            ))}
          <label>
            {status === 'verified' ? 'Note (optional)' : 'Reason (the runner sees this)'}
            <textarea name="reason" rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          {category.requiredApprovals > 1 && status === 'verified' && (
            <p className="muted small">
              This category needs {category.requiredApprovals} moderators to verify a run; {approvers.length} approved this version so far.
              {approvedByMe && ' You already approved it, so it is waiting for another moderator.'}
              {!approvedByMe && approvers.length > 0 && ' Leave the retime empty to keep the earlier approver’s.'}
            </p>
          )}
          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={busy || (status === 'verified' && approvedByMe)}>
            {busy ? 'Saving…' : 'Record verdict'}
          </button>
        </form>
      )}
      {!ownRun && <FlagPanel run={run} onChange={(labels) => setRun({ ...run, labels })} />}
      {run.verdicts && run.verdicts.length > 0 && (
        <>
          <h2>Earlier verdicts</h2>
          <ul className="verdicts">
            {run.verdicts.map((v) => (
              <li key={v.uri}>
                <StatusBadge status={v.status} /> by @{v.reviewer.handle ?? v.reviewer.did} on {v.indexedAt.slice(0, 10)}
                {!v.current && <span className="tag">earlier version</span>}
                {v.reason && <p>{v.reason}</p>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

/**
 * Flags a run as suspected cheating: a signed label Bluesky clients can show,
 * separate from the verdict, and removable by any moderator.
 */
function FlagPanel({ run, onChange }: { run: RunView; onChange: (labels: RunView['labels']) => void }) {
  const flag = run.labels?.find((l) => l.val === 'suspected-cheating')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  async function toggle() {
    setBusy(true)
    setError(undefined)
    try {
      await api.flagRun({ run: run.uri, flag: !flag, reason: reason.trim() || undefined })
      const { run: fresh } = await api.getRun(run.uri)
      onChange(fresh.labels)
      setReason('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel flag-panel">
      <h3>Suspected cheating</h3>
      {flag ? (
        <p>
          Flagged by @{flag.moderator?.handle ?? flag.moderator?.did ?? 'a moderator'}
          {flag.reason ? `: ${flag.reason}` : ''}.
        </p>
      ) : (
        <p className="muted small">
          A flag is a public warning label that Bluesky clients can show on the run. It is not a verdict and does not change the
          board.
        </p>
      )}
      <div className="row">
        {!flag && <input placeholder="What looks wrong (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />}
        <button className={flag ? 'secondary' : 'danger-inline'} disabled={busy} onClick={toggle}>
          {flag ? 'Remove flag' : 'Flag run'}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  )
}
