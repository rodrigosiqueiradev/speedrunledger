import { type FormEvent, useEffect, useState } from 'react'
import type { RunView } from '@speedrunledger/lexicon'
import { api } from '../api.js'
import type { Me } from '../main.js'
import { boardHref, Link, navigate, runHref } from '../router.js'
import { formatMs, parseTime } from '@speedrunledger/web-ui'

type Board = Awaited<ReturnType<typeof api.getLeaderboard>>
const timeFields = { realTime: 'realTimeMs', realTimeNoLoads: 'realTimeNoLoadsMs', gameTime: 'gameTimeMs' } as const
const timeNames = { realTime: 'Real time (RTA)', realTimeNoLoads: 'Real time without loads', gameTime: 'In-game time' } as const

/** The run form, for a new run in `category` or, with `edit`, for changing one of your runs. */
export function SubmitPage({ category, edit, me }: { category: string; edit?: string; me: Me | null | undefined }) {
  const [board, setBoard] = useState<Board>()
  const [original, setOriginal] = useState<RunView>()
  const [firstRun, setFirstRun] = useState(false)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [times, setTimes] = useState<Record<string, string>>({})
  const [video, setVideo] = useState('')
  const [variables, setVariables] = useState<Record<string, string>>({})
  const [platform, setPlatform] = useState('')
  const [emulated, setEmulated] = useState(false)
  const [performedAt, setPerformedAt] = useState(() => new Date().toISOString().slice(0, 10))
  const [comment, setComment] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)

  useEffect(() => {
    if (edit) {
      api.getRun(edit).then(({ run }) => {
        setOriginal(run)
        const shown: Record<string, string> = {}
        for (const [m, field] of Object.entries(timeFields)) {
          const ms = run.times[field]
          if (ms !== undefined) shown[m] = formatMs(ms)
        }
        setTimes(shown)
        setVideo(run.videos[0]?.url ?? '')
        setVariables(Object.fromEntries(run.variables.map((v) => [v.variable, v.value])))
        setPlatform(run.platform ?? '')
        setEmulated(run.emulated ?? false)
        setPerformedAt(run.performedAt.slice(0, 10))
        setComment(run.comment ?? '')
        return api.getLeaderboard(run.category, []).then(setBoard)
      }).catch((e) => setError(e.message))
    } else {
      api.getLeaderboard(category, []).then(setBoard, (e) => setError(e.message))
    }
  }, [category, edit])
  useEffect(() => {
    if (!me || edit) return
    api.getRunner(me.did).then(
      (r) => setFirstRun(r.runs.length === 0),
      () => setFirstRun(true),
    )
  }, [me, edit])

  if (me === null) return <p className="muted">Sign in to submit a run.</p>
  if (original && me && original.runner.did !== me.did) return <p className="error">You can only edit your own runs.</p>
  if (!board) return error ? <p className="error">{error}</p> : <p className="muted">Loading category…</p>
  const cat = board.category
  const methods = cat.timingMethods as (keyof typeof timeFields)[]

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(undefined)
    const parsed: Record<string, number> = {}
    for (const m of methods) {
      const text = times[m]?.trim()
      if (!text) continue
      const ms = parseTime(text)
      if (ms === undefined) return setError(`${timeNames[m]}: use a time like 15:02.340`)
      parsed[timeFields[m]] = ms
    }
    if (parsed[timeFields[cat.primaryTiming as keyof typeof timeFields]] === undefined) {
      return setError(`${timeNames[cat.primaryTiming as keyof typeof timeNames]} is required for this category`)
    }
    if (firstRun && !acknowledged) return setError('Please confirm you understand runs are public')
    setBusy(true)
    try {
      const run = {
        category: { uri: cat.uri, cid: cat.cid },
        ruleset: cat.ruleset ? { uri: cat.ruleset.uri, cid: cat.ruleset.cid } : undefined,
        times: parsed,
        videos: video.trim() ? [{ url: video.trim() }] : [],
        variables: Object.entries(variables)
          .filter(([, v]) => v)
          .map(([variable, value]) => ({ variable, value })),
        platform: platform || undefined,
        emulated: emulated || undefined,
        comment: comment.trim() || undefined,
        performedAt: new Date(`${performedAt}T12:00:00Z`).toISOString(),
      }
      const out = original ? await api.updateRun(original.uri.split('/').pop()!, run) : await api.submitRun(run)
      navigate(runHref(out.uri))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="narrow">
      <p className="crumbs">
        <Link href={boardHref(cat.uri)}>
          {board.game.title} — {cat.name}
        </Link>
      </p>
      <h1>{original ? 'Edit run' : 'Submit a run'}</h1>
      <p className="muted">
        The run is saved as a record in your own repo, then reviewed by the {board.community.name} moderators.
      </p>
      {original && original.status !== 'pending' && (
        <p className="notice">Saving a change sends this run back to review, and it leaves the board until it is verified again.</p>
      )}
      <form className="form" onSubmit={submit}>
        {methods.map((m) => (
          <label key={m}>
            {timeNames[m]}
            {m === cat.primaryTiming ? ' (ranked)' : ' (optional)'}
            <input
              name={m}
              inputMode="decimal"
              placeholder="15:02.340"
              value={times[m] ?? ''}
              onChange={(e) => setTimes({ ...times, [m]: e.target.value })}
              required={m === cat.primaryTiming}
            />
          </label>
        ))}
        <label>
          Video link{cat.requiresVideo ? '' : ' (optional)'}
          <input
            name="video"
            type="url"
            placeholder="https://www.youtube.com/watch?v=…"
            value={video}
            onChange={(e) => setVideo(e.target.value)}
            required
          />
        </label>
        {cat.variables.map((v) => (
          <label key={v.id}>
            {v.name}
            {v.subcategory ? '' : ' (optional)'}
            <select
              name={`var-${v.id}`}
              value={variables[v.id] ?? ''}
              onChange={(e) => setVariables({ ...variables, [v.id]: e.target.value })}
              required={v.subcategory}
            >
              <option value="">—</option>
              {v.values.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
        ))}
        {board.game.platforms.length > 0 && (
          <label>
            Platform (optional)
            <select name="platform" value={platform} onChange={(e) => setPlatform(e.target.value)}>
              <option value="">—</option>
              {board.game.platforms.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={emulated} onChange={(e) => setEmulated(e.target.checked)} /> Played on an emulator
        </label>
        <label>
          Date played
          <input name="performedAt" type="date" value={performedAt} onChange={(e) => setPerformedAt(e.target.value)} required />
        </label>
        <label>
          Comment (optional)
          <textarea name="comment" rows={3} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />
        </label>
        {firstRun && (
          <div className="notice">
            <strong>Runs are public.</strong> This is your first run on SpeedrunLedger. It will be stored in your atproto repo where
            anyone can read it, and copies other services make may outlive a deletion.
            <label className="check">
              <input
                name="acknowledge"
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />{' '}
              I understand
            </label>
          </div>
        )}
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : original ? 'Save changes' : 'Submit run'}
        </button>
      </form>
    </section>
  )
}
