import type { ModeratorView } from '@speedrunledger/lexicon'
import { type FormEvent, useState } from 'react'
import { api, P } from '../../api.js'
import { useAction, useHandle } from '../../hooks.js'
import { type CommunityContext, ReasonField } from '../CommunityPage.js'

const DAY = 24 * 60 * 60 * 1000

/** "today", "3 days ago", or "never". */
function ago(iso?: string): string {
  if (!iso) return 'never'
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / DAY)
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`
}

export function ModeratorsTab({ ctx }: { ctx: CommunityContext }) {
  const active = ctx.moderators.filter((m) => m.status === 'active')
  const canAct = !ctx.frozen && active.some((m) => m.actor.did === ctx.me.did)
  return (
    <>
      <p className="muted small">
        Everyone listed as active counts toward a majority, whether or not they have been around lately. Last activity is
        the newest verdict, proposal or vote here; removing an inactive moderator is the community’s call.
      </p>
      <table className="queue roster">
        <thead>
          <tr>
            <th>Moderator</th>
            <th>Status</th>
            <th>Last active</th>
            <th>Since</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {ctx.moderators.map((m) => (
            <Row key={m.actor.did} m={m} ctx={ctx} canKick={canAct && m.status === 'active' && m.actor.did !== ctx.me.did} />
          ))}
        </tbody>
      </table>
      {canAct && <InviteForm ctx={ctx} />}
    </>
  )
}

function Row({ m, ctx, canKick }: { m: ModeratorView; ctx: CommunityContext; canKick: boolean }) {
  const handle = useHandle(m.actor.did, m.actor.handle)
  const [kicking, setKicking] = useState(false)
  const [reason, setReason] = useState('')
  const action = useAction()
  const name = `@${handle ?? m.actor.did}`

  async function kick(e: FormEvent) {
    e.preventDefault()
    const ok = await action.run(() =>
      api.propose({ community: ctx.detail.community.did, action: { $type: `${P}#kick`, subject: m.actor.did }, reason }),
    )
    if (ok) ctx.proposed()
  }

  return (
    <>
      <tr>
        <td>{name}</td>
        <td>{m.status === 'active' ? 'Active' : 'Invited'}</td>
        <td>{ago(m.lastActiveAt)}</td>
        <td className="muted">{m.since?.slice(0, 10)}</td>
        <td>
          {canKick && !kicking && (
            <button className="link" onClick={() => setKicking(true)}>
              Propose removal
            </button>
          )}
        </td>
      </tr>
      {kicking && (
        <tr>
          <td colSpan={5}>
            <form className="form" onSubmit={kick}>
              <ReasonField label={`Why remove ${name}?`} value={reason} onChange={setReason} />
              <div className="actions">
                <button disabled={action.busy}>Propose removal</button>
                <button type="button" className="secondary" onClick={() => setKicking(false)}>
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

function InviteForm({ ctx }: { ctx: CommunityContext }) {
  const [who, setWho] = useState('')
  const [reason, setReason] = useState('')
  const action = useAction()

  async function submit(e: FormEvent) {
    e.preventDefault()
    const ok = await action.run(async () => {
      const { did } = await api.resolve(who)
      await api.propose({ community: ctx.detail.community.did, action: { $type: `${P}#invite`, subject: did }, reason })
    })
    if (ok) ctx.proposed()
  }

  return (
    <form className="panel form narrow" onSubmit={submit}>
      <h3>Invite a moderator</h3>
      <label>
        Handle
        <input name="invitee" placeholder="runner.bsky.social" value={who} onChange={(e) => setWho(e.target.value)} required />
      </label>
      <ReasonField value={reason} onChange={setReason} />
      <p className="muted small">If the vote passes, they are invited and become a moderator once they accept.</p>
      <button disabled={action.busy}>Propose invite</button>
      {action.error && <p className="error">{action.error}</p>}
    </form>
  )
}
