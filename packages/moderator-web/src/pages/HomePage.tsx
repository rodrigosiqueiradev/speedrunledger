import type { MembershipView } from '@speedrunledger/lexicon'
import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { useAction, useRefresh } from '../hooks.js'
import type { Me } from '../main.js'
import { communityHref, Link, queueHref } from '../router.js'

export function HomePage({ me }: { me: Me }) {
  const [memberships, setMemberships] = useState<MembershipView[]>()
  const [error, setError] = useState<string>()
  const [version, refresh] = useRefresh()
  useEffect(() => {
    api.listMemberships(me.did).then((r) => setMemberships(r.memberships), (e) => setError(e.message))
  }, [me.did, version])

  if (error) return <p className="error">{error}</p>
  if (!memberships) return <p className="muted">Loading your communities…</p>
  if (memberships.length === 0) {
    return (
      <section className="narrow">
        <h1>Your communities</h1>
        <p className="muted">
          You don’t moderate any community yet. A community lists you as a moderator when its moderators vote you in, or
          when a sysadmin creates it with you as a founder.
        </p>
      </section>
    )
  }
  return (
    <section>
      <h1>Your communities</h1>
      <div className="cards">
        {memberships.map((m) => (
          <Membership key={m.community.did} membership={m} accepted={refresh} />
        ))}
      </div>
    </section>
  )
}

function Membership({ membership: { community, status, grant }, accepted }: { membership: MembershipView; accepted: () => void }) {
  const action = useAction()
  const [sent, setSent] = useState(false)
  return (
    <article className="card">
      <h2>{community.name}</h2>
      <p className="muted small">
        @{community.handle ?? community.did}
        {community.frozen ? <span className="tag">frozen</span> : null}
      </p>
      {status === 'active' ? (
        <div className="actions">
          <Link className="button" href={queueHref(community.did)}>
            Review queue
          </Link>
          <Link className="button secondary" href={communityHref(community.did)}>
            Manage
          </Link>
        </div>
      ) : (
        <>
          <p className="muted small">
            You have been invited. Accepting writes a public record to your own account saying you agreed to moderate.
          </p>
          <button
            disabled={action.busy || sent}
            onClick={async () => {
              if (await action.run(() => api.accept(grant))) {
                setSent(true)
                accepted()
              }
            }}
          >
            {sent ? 'Accepted' : 'Accept invitation'}
          </button>
          {action.error && <p className="error">{action.error}</p>}
        </>
      )}
    </article>
  )
}
