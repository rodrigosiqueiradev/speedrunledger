import type { CommunityDetail, ModeratorView } from '@speedrunledger/lexicon'
import { useAction, useRefresh } from '@speedrunledger/web-ui'
import { type FormEvent, useEffect, useState } from 'react'
import { actorLabel, api, gameLabel } from '../api.js'
import { useGameFields } from '../game.js'
import { Link } from '../router.js'

export function CommunityPage({ did }: { did: string }) {
  const [detail, setDetail] = useState<CommunityDetail>()
  const [moderators, setModerators] = useState<ModeratorView[]>()
  const [error, setError] = useState<string>()
  const [version, refresh] = useRefresh()
  useEffect(() => {
    Promise.all([api.getCommunity(did), api.listModerators(did)]).then(
      ([c, m]) => {
        setDetail(c.community)
        setModerators(m.moderators)
      },
      (e) => setError(e.message),
    )
  }, [did, version])

  if (error) return <p className="error">{error}</p>
  if (!detail || !moderators) return <p className="muted">Loading community…</p>
  const { community, games } = detail
  const frozen = community.frozen === true
  const active = moderators.filter((m) => m.status === 'active')

  return (
    <section>
      <p className="crumbs">
        <Link href="/communities">Communities</Link>
      </p>
      <div className="title-row">
        <h1>{community.name}</h1>
        <a className="button secondary" href={api.exportHref(did)} download>
          Export repo
        </a>
      </div>
      <p className="muted small">
        @{community.handle ?? community.did}
        {frozen && <span className="tag">frozen</span>}
      </p>
      {community.description && <p>{community.description}</p>}
      {frozen && (
        <p className="notice">Frozen: boards stay visible, but the community accepts no verdicts, votes or changes.</p>
      )}

      <h2>Games</h2>
      <ul className="list">
        {games.map((g) => (
          <li key={g.game.uri}>
            <span>{gameLabel(g.game)}</span>
            <span className="muted small">{g.categories.length} categor{g.categories.length === 1 ? 'y' : 'ies'}</span>
          </li>
        ))}
      </ul>
      <AddGame did={did} added={refresh} />

      <h2>Moderators</h2>
      {moderators.length === 0 ? (
        <p className="muted">No moderators.</p>
      ) : (
        <ul className="list">
          {moderators.map((m) => (
            <li key={m.actor.did}>
              <span>{actorLabel(m.actor)}</span>
              <span className="muted small">{m.status === 'active' ? 'Active' : 'Invited, has not accepted yet'}</span>
            </li>
          ))}
        </ul>
      )}
      {active.length === 0 ? (
        <Appoint did={did} appointed={refresh} />
      ) : (
        <p className="muted small">
          The community has active moderators, so new ones join by their vote in the Moderator app, not by appointment.
        </p>
      )}

      <h2>{frozen ? 'Unfreeze' : 'Freeze'}</h2>
      <Freeze did={did} frozen={frozen} changed={refresh} />
    </section>
  )
}

function AddGame({ did, added }: { did: string; added: () => void }) {
  const game = useGameFields()
  const action = useAction()
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (await action.run(() => api.addGame(did, game.game()))) {
      game.reset()
      added()
    }
  }
  return (
    <form className="form panel" onSubmit={submit}>
      <h3>Add a game</h3>
      {game.fields}
      <p className="muted small">The community’s moderators then add its categories and rules by vote.</p>
      <div className="actions">
        <button disabled={action.busy}>Add game</button>
      </div>
      {action.error && <p className="error">{action.error}</p>}
    </form>
  )
}

/** Only when no moderator is active: a sysadmin appoints one, with a public reason. */
function Appoint({ did, appointed }: { did: string; appointed: () => void }) {
  const [actor, setActor] = useState('')
  const [reason, setReason] = useState('')
  const [done, setDone] = useState<string>()
  const action = useAction()
  async function submit(e: FormEvent) {
    e.preventDefault()
    await action.run(async () => {
      const { subject } = await api.appoint(did, actor, reason)
      setDone(actorLabel(subject))
      setActor('')
      setReason('')
      appointed()
    })
  }
  return (
    <form className="form panel narrow" onSubmit={submit}>
      <h3>Appoint a moderator</h3>
      <p className="muted small">
        This community has no active moderator, so a sysadmin may appoint one. The appointment and its reason are public.
      </p>
      <label>
        Handle
        <input name="appointee" placeholder="peach.test" value={actor} onChange={(e) => setActor(e.target.value)} required />
      </label>
      <label>
        Public reason
        <textarea name="reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} required />
      </label>
      <div className="actions">
        <button disabled={action.busy}>Appoint</button>
      </div>
      {done && <p className="notice ok">Appointed {done}. They become a moderator once they accept in the Moderator app.</p>}
      {action.error && <p className="error">{action.error}</p>}
    </form>
  )
}

function Freeze({ did, frozen, changed }: { did: string; frozen: boolean; changed: () => void }) {
  const [reason, setReason] = useState('')
  const action = useAction()
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (await action.run(() => api.setFrozen(did, !frozen, reason))) {
      setReason('')
      changed()
    }
  }
  return (
    <form className="form panel narrow" onSubmit={submit}>
      <p className="muted small">
        {frozen
          ? 'Unfreezing lets the moderators review runs and vote again.'
          : 'Freezing keeps the boards visible but stops all verdicts, votes and changes, for a community breaking the rules.'}
      </p>
      <label>
        Public reason
        <textarea name="freezeReason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} required />
      </label>
      <div className="actions">
        <button className={frozen ? undefined : 'danger-inline'} disabled={action.busy}>
          {frozen ? 'Unfreeze community' : 'Freeze community'}
        </button>
      </div>
      {action.error && <p className="error">{action.error}</p>}
    </form>
  )
}
