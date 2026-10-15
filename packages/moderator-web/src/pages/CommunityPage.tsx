import type { CommunityDetail, ModeratorView } from '@speedrunledger/lexicon'
import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { useRefresh } from '../hooks.js'
import type { Me } from '../main.js'
import { communityHref, Link, navigate, queueHref } from '../router.js'
import { BansTab } from './community/BansTab.js'
import { GamesTab } from './community/GamesTab.js'
import { ModeratorsTab } from './community/ModeratorsTab.js'
import { ProposalsTab } from './community/ProposalsTab.js'

export interface CommunityContext {
  me: Me
  detail: CommunityDetail
  moderators: ModeratorView[]
  /** Frozen communities accept no verdicts, votes or changes. */
  frozen: boolean
  /** Reloads this page's data, a few times while the indexer catches up. */
  refresh: () => void
  version: number
  /** Switches to the proposals tab after proposing something. */
  proposed: () => void
}

const TABS = { proposals: 'Proposals', moderators: 'Moderators', bans: 'Bans', games: 'Games and categories' } as const
type Tab = keyof typeof TABS

export function CommunityPage({ did, tab, me }: { did: string; tab: string; me: Me }) {
  const [detail, setDetail] = useState<CommunityDetail>()
  const [moderators, setModerators] = useState<ModeratorView[]>()
  const [error, setError] = useState<string>()
  const [version, refresh] = useRefresh()
  const current: Tab = tab in TABS ? (tab as Tab) : 'proposals'

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
  const { community } = detail
  const isModerator = moderators.some((m) => m.actor.did === me.did && m.status === 'active')
  const ctx: CommunityContext = {
    me,
    detail,
    moderators,
    frozen: community.frozen === true,
    refresh,
    version,
    proposed: () => {
      refresh()
      navigate(communityHref(did, 'proposals'))
    },
  }

  return (
    <section>
      <p className="crumbs">
        <Link href="/">Your communities</Link>
      </p>
      <div className="title-row">
        <h1>{community.name}</h1>
        <div className="actions">
          <Link className="button secondary" href={queueHref(did)}>
            Review queue
          </Link>
          <a className="button secondary" href={`/api/export/${encodeURIComponent(did)}`} download>
            Export repo
          </a>
        </div>
      </div>
      <p className="muted small">@{community.handle ?? community.did}</p>
      {ctx.frozen && (
        <p className="notice">
          A sysadmin froze this community. Boards stay visible, but no verdicts, votes or changes are accepted until it is
          unfrozen.
        </p>
      )}
      {!isModerator && <p className="notice">You are not an active moderator here, so you can look but not act.</p>}
      <div className="tabs" role="tablist">
        {(Object.keys(TABS) as Tab[]).map((t) => (
          <Link key={t} role="tab" aria-selected={t === current} className="tab" href={communityHref(did, t)}>
            {TABS[t]}
          </Link>
        ))}
      </div>
      {current === 'proposals' && <ProposalsTab ctx={ctx} />}
      {current === 'moderators' && <ModeratorsTab ctx={ctx} />}
      {current === 'bans' && <BansTab ctx={ctx} />}
      {current === 'games' && <GamesTab ctx={ctx} />}
    </section>
  )
}

/** A short "reason" textarea shared by the forms on this page. */
export function ReasonField({ value, onChange, label = 'Reason' }: { value: string; onChange: (v: string) => void; label?: string }) {
  return (
    <label>
      {label}
      <textarea rows={2} value={value} onChange={(e) => onChange(e.target.value)} required />
    </label>
  )
}
