import type { RequestView } from '@speedrunledger/lexicon'
import { type FormEvent, useEffect, useState } from 'react'
import { api } from '../api.js'
import type { Me } from '../main.js'

const STATUS = { pending: 'Waiting for a sysadmin', approved: 'Community created', denied: 'Denied' } as const

export function RequestPage({ me }: { me: Me | null | undefined }) {
  const [requests, setRequests] = useState<RequestView[]>()
  const [title, setTitle] = useState('')
  const [year, setYear] = useState('')
  const [platforms, setPlatforms] = useState('')
  const [founders, setFounders] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [sent, setSent] = useState(false)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    if (!me) return
    api.listMyRequests(me.did).then((r) => setRequests(r.requests.reverse()), (e) => setError(e.message))
  }, [me, version])

  useEffect(() => {
    if (me?.handle && !founders) setFounders(me.handle)
  }, [me, founders])

  if (me === undefined) return <p className="muted">Loading…</p>
  if (me === null) return <p className="muted">Sign in to ask for a community.</p>

  const list = (text: string) =>
    text
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(undefined)
    setBusy(true)
    try {
      await api.requestCommunity({
        game: { title: title.trim(), releaseYear: year ? Number(year) : undefined, platforms: platforms ? platforms.split(',').map((p) => p.trim()).filter(Boolean) : undefined },
        founders: list(founders),
        note: note.trim() || undefined,
      })
      setSent(true)
      setTitle('')
      setYear('')
      setPlatforms('')
      setNote('')
      for (const ms of [700, 2000, 5000]) setTimeout(() => setVersion((v) => v + 1), ms)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="narrow">
      <h1>Start a community</h1>
      <p>
        Each game’s boards are run by a community of moderators. Ask the sysadmins for one and name its founding moderators;
        they become moderators once a sysadmin creates the community and they accept. The request is a public record in your
        account.
      </p>
      <form className="form" onSubmit={submit}>
        <label>
          Game
          <input name="title" value={title} onChange={(e) => setTitle(e.target.value)} required />
        </label>
        <label>
          Release year
          <input name="year" type="number" min={1950} max={2200} value={year} onChange={(e) => setYear(e.target.value)} />
        </label>
        <label>
          Platforms, comma separated
          <input name="platforms" value={platforms} onChange={(e) => setPlatforms(e.target.value)} />
        </label>
        <label>
          Founding moderators: handles, separated by commas or spaces
          <input name="founders" value={founders} onChange={(e) => setFounders(e.target.value)} required />
        </label>
        <label>
          Anything the sysadmins should know
          <textarea name="note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <button disabled={busy}>Send request</button>
        {sent && <p className="notice ok">Request sent. You’ll see the answer below.</p>}
        {error && <p className="error">{error}</p>}
      </form>
      <h2>Your requests</h2>
      {!requests ? (
        <p className="muted">Loading…</p>
      ) : requests.length === 0 ? (
        <p className="muted">None yet.</p>
      ) : (
        <ul className="verdicts requests">
          {requests.map((r) => (
            <li key={r.uri}>
              <strong>{r.game.title}</strong> <span className={`status ${r.status === 'approved' ? 'verified' : r.status === 'denied' ? 'rejected' : 'pending'}`}>{STATUS[r.status as keyof typeof STATUS] ?? r.status}</span>
              <p className="muted small">Founders: {r.founders.map((f) => `@${f.handle ?? f.did}`).join(', ')}</p>
              {r.denialReason && <p>Reason: {r.denialReason}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
