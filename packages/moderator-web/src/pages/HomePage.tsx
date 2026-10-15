import type { MembershipView } from '@speedrunledger/lexicon'
import { useEffect, useState } from 'react'
import { api } from '../api.js'
import type { Me } from '../main.js'
import { Link, queueHref } from '../router.js'

export function HomePage({ me }: { me: Me }) {
  const [memberships, setMemberships] = useState<MembershipView[]>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    api.listMemberships(me.did).then((r) => setMemberships(r.memberships), (e) => setError(e.message))
  }, [me.did])

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
        {memberships.map(({ community, status }) => (
          <article className="card" key={community.did}>
            <h2>{community.name}</h2>
            <p className="muted small">@{community.handle ?? community.did}</p>
            {status === 'active' ? (
              <Link className="button" href={queueHref(community.did)}>
                Review queue
              </Link>
            ) : (
              <p className="muted small">You have been invited; accept the invitation to start moderating.</p>
            )}
          </article>
        ))}
      </div>
    </section>
  )
}
