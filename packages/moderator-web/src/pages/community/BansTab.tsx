import type { BanView } from '@speedrunledger/lexicon'
import { type FormEvent, useEffect, useState } from 'react'
import { api, P } from '../../api.js'
import { useAction, useHandle } from '../../hooks.js'
import { type CommunityContext, ReasonField } from '../CommunityPage.js'

export function BansTab({ ctx }: { ctx: CommunityContext }) {
  const did = ctx.detail.community.did
  const [bans, setBans] = useState<BanView[]>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    api.listBans(did).then((r) => setBans(r.bans), (e) => setError(e.message))
  }, [did, ctx.version])
  const canAct = !ctx.frozen && ctx.moderators.some((m) => m.actor.did === ctx.me.did && m.status === 'active')

  if (error) return <p className="error">{error}</p>
  if (!bans) return <p className="muted">Loading bans…</p>
  return (
    <>
      <p className="muted small">
        Any moderator can ban a runner on their own. Banned runners’ runs leave the boards and the queue. Lifting a ban takes
        a majority vote.
      </p>
      {bans.length === 0 ? (
        <p className="muted">Nobody is banned.</p>
      ) : (
        <table className="queue">
          <thead>
            <tr>
              <th>Runner</th>
              <th>Reason</th>
              <th>Banned by</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {bans.map((b) => (
              <BanRow key={b.uri} ban={b} ctx={ctx} canAct={canAct} />
            ))}
          </tbody>
        </table>
      )}
      {canAct && <BanForm ctx={ctx} />}
    </>
  )
}

function BanRow({ ban, ctx, canAct }: { ban: BanView; ctx: CommunityContext; canAct: boolean }) {
  const subject = useHandle(ban.subject.did, ban.subject.handle)
  const moderator = useHandle(ban.moderator.did, ban.moderator.handle)
  const [lifting, setLifting] = useState(false)
  const [reason, setReason] = useState('')
  const action = useAction()

  async function lift(e: FormEvent) {
    e.preventDefault()
    const ok = await action.run(() =>
      api.propose({
        community: ctx.detail.community.did,
        action: { $type: `${P}#liftBan`, ban: { uri: ban.uri, cid: ban.cid } },
        reason,
      }),
    )
    if (ok) ctx.proposed()
  }

  return (
    <>
      <tr>
        <td>@{subject ?? ban.subject.did}</td>
        <td>{ban.reason}</td>
        <td className="muted">
          @{moderator ?? ban.moderator.did}, {ban.indexedAt.slice(0, 10)}
        </td>
        <td>
          {canAct && !lifting && (
            <button className="link" onClick={() => setLifting(true)}>
              Propose lifting
            </button>
          )}
        </td>
      </tr>
      {lifting && (
        <tr>
          <td colSpan={4}>
            <form className="form" onSubmit={lift}>
              <ReasonField label="Why lift it?" value={reason} onChange={setReason} />
              <div className="actions">
                <button disabled={action.busy}>Propose lifting the ban</button>
                <button type="button" className="secondary" onClick={() => setLifting(false)}>
                  Cancel
                </button>
              </div>
              {action.error && <p className="error">{action.error}</p>}
            </form>
          </td>
        </tr>
      )}
    </>
  )
}

function BanForm({ ctx }: { ctx: CommunityContext }) {
  const [who, setWho] = useState('')
  const [reason, setReason] = useState('')
  const [done, setDone] = useState<string>()
  const action = useAction()

  async function submit(e: FormEvent) {
    e.preventDefault()
    setDone(undefined)
    const ok = await action.run(async () => {
      const { did, handle } = await api.resolve(who)
      await api.createBan({ community: ctx.detail.community.did, subject: did, reason })
      setDone(handle)
    })
    if (ok) {
      setWho('')
      setReason('')
      ctx.refresh()
    }
  }

  return (
    <form className="panel form narrow" onSubmit={submit}>
      <h3>Ban a runner</h3>
      <label>
        Handle
        <input name="banned" placeholder="cheater.bsky.social" value={who} onChange={(e) => setWho(e.target.value)} required />
      </label>
      <ReasonField label="Public reason" value={reason} onChange={setReason} />
      <button className="danger-inline" disabled={action.busy}>
        Ban
      </button>
      {done && <p className="notice ok">Banned @{done}. The ban is a public record in the community’s repo.</p>}
      {action.error && <p className="error">{action.error}</p>}
    </form>
  )
}
