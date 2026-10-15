import { useAction, useRefresh } from '@speedrunledger/web-ui'
import { type FormEvent, useEffect, useState } from 'react'
import { api, type ManagedCommunity } from '../api.js'
import { useGameFields } from '../game.js'
import { communityHref, Link } from '../router.js'

export function CommunitiesPage() {
  const [communities, setCommunities] = useState<ManagedCommunity[]>()
  const [error, setError] = useState<string>()
  const [version, refresh] = useRefresh()
  useEffect(() => {
    api.listCommunities().then((r) => setCommunities(r.communities), (e) => setError(e.message))
  }, [version])

  return (
    <section>
      <h1>Communities</h1>
      {error && <p className="error">{error}</p>}
      {!communities && !error && <p className="muted">Loading communities…</p>}
      {communities?.length === 0 && <p className="muted">No communities yet. Create one from a request, or below.</p>}
      <div className="cards">
        {communities?.map(({ did, identifier, detail }) => (
          <article className="card" key={did}>
            <h2>
              <Link href={communityHref(did)}>{detail?.community.name ?? identifier}</Link>
            </h2>
            <p className="muted small">
              @{detail?.community.handle ?? identifier}
              {detail?.community.frozen ? <span className="tag">frozen</span> : null}
            </p>
            {detail ? (
              <p className="small">{detail.games.map((g) => g.game.title).join(', ') || 'No games yet'}</p>
            ) : (
              <p className="muted small">Not indexed yet</p>
            )}
          </article>
        ))}
      </div>
      <CreateCommunity created={refresh} />
      <RegisterCommunity registered={refresh} />
    </section>
  )
}

/** A community without a request: the sysadmin names the game and the founders. */
function CreateCommunity({ created }: { created: () => void }) {
  const [open, setOpen] = useState(false)
  const [handle, setHandle] = useState('')
  const [name, setName] = useState('')
  const [founders, setFounders] = useState('')
  const [done, setDone] = useState<{ did: string; handle: string }>()
  const game = useGameFields()
  const action = useAction()

  async function submit(e: FormEvent) {
    e.preventDefault()
    await action.run(async () => {
      const list = founders
        .split(/[\s,]+/)
        .map((f) => f.trim())
        .filter(Boolean)
      setDone(await api.createCommunity({ handle, name, game: game.game(), founders: list }))
      created()
    })
  }

  if (!open) {
    return (
      <p>
        <button className="secondary" onClick={() => setOpen(true)}>
          Create a community without a request
        </button>
      </p>
    )
  }
  return (
    <form className="form panel" onSubmit={submit}>
      <h3>New community</h3>
      {done ? (
        <p className="notice ok">
          Created <Link href={communityHref(done.did)}>@{done.handle}</Link>. The founders become its moderators once they
          accept in the Moderator app.
        </p>
      ) : (
        <>
          <div className="row">
            <label>
              Community handle
              <input name="handle" placeholder="sm64.test" value={handle} onChange={(e) => setHandle(e.target.value)} required />
            </label>
            <label>
              Name
              <input name="name" placeholder="Super Mario 64" value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
          </div>
          {game.fields}
          <label>
            Founding moderators <span className="muted small">(handles, separated by commas)</span>
            <input name="founders" placeholder="peach.test, luigi.test" value={founders} onChange={(e) => setFounders(e.target.value)} required />
          </label>
          <div className="actions">
            <button disabled={action.busy}>{action.busy ? 'Creating…' : 'Create community'}</button>
            <button type="button" className="secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
          {action.error && <p className="error">{action.error}</p>}
        </>
      )}
    </form>
  )
}

/** Hands an account that already exists to the community service, so it writes the community's records. */
function RegisterCommunity({ registered }: { registered: () => void }) {
  const [open, setOpen] = useState(false)
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [done, setDone] = useState<string>()
  const action = useAction()

  async function submit(e: FormEvent) {
    e.preventDefault()
    await action.run(async () => {
      const out = await api.registerCommunity(identifier, password)
      setDone(out.handle)
      setPassword('')
      registered()
    })
  }

  if (!open) {
    return (
      <p>
        <button className="link" onClick={() => setOpen(true)}>
          Register an existing community account
        </button>
      </p>
    )
  }
  return (
    <form className="form panel narrow" onSubmit={submit}>
      <h3>Register an existing account</h3>
      <p className="muted small">
        For a community account made elsewhere, for example after it moved here from another PDS. Use an app password; the
        community service keeps it encrypted.
      </p>
      <label>
        Handle
        <input name="identifier" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required />
      </label>
      <label>
        App password
        <input name="password" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </label>
      <div className="actions">
        <button disabled={action.busy}>Register</button>
        <button type="button" className="secondary" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {done && <p className="notice ok">The community service now writes for @{done}.</p>}
      {action.error && <p className="error">{action.error}</p>}
    </form>
  )
}
