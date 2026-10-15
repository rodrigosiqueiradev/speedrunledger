import type { BanView, CommunityDetail, ProposalView } from '@speedrunledger/lexicon'
import { useEffect, useState } from 'react'
import { api, CATEGORY, RULESET } from '../../api.js'
import { useAction, useHandle } from '../../hooks.js'
import type { CommunityContext } from '../CommunityPage.js'

const STATUS_TEXT: Record<string, string> = {
  open: 'Open',
  passed: 'Passed',
  failed: 'Failed',
  expired: 'Expired',
  invalid: 'Does not count',
}

const PROBLEM_TEXT: Record<string, string> = {
  not_moderator: 'the proposer was not an active moderator',
  community_frozen: 'the community was frozen',
  already_member: 'that account is already a moderator or invited',
  not_member: 'that account is not an active moderator',
  last_moderator: 'it would remove the last moderator',
  unsupported_collection: 'only categories and rulesets can be changed this way',
  invalid_record: 'the proposed record is not valid',
  game_not_in_community: 'the game is not in this community',
  category_not_in_community: 'the category is not in this community',
  ban_not_found: 'that ban no longer exists',
  unknown_action: 'the action is not one this prototype knows',
  proposer_has_open_proposal: 'the proposer already had an open proposal',
  category_has_open_proposal: 'that category already had an open proposal',
  no_electorate: 'nobody could vote on it',
}

export function ProposalsTab({ ctx }: { ctx: CommunityContext }) {
  const did = ctx.detail.community.did
  const [open, setOpen] = useState<ProposalView[]>()
  const [closed, setClosed] = useState<ProposalView[]>()
  const [bans, setBans] = useState<BanView[]>([])
  const [error, setError] = useState<string>()
  useEffect(() => {
    Promise.all([api.listProposals(did, 'open'), api.listProposals(did, 'closed'), api.listBans(did)]).then(
      ([o, c, b]) => {
        setOpen(o.proposals)
        setClosed(c.proposals)
        setBans(b.bans)
      },
      (e) => setError(e.message),
    )
  }, [did, ctx.version])

  if (error) return <p className="error">{error}</p>
  if (!open || !closed) return <p className="muted">Loading proposals…</p>
  return (
    <>
      <p className="muted small">
        Invites, kicks, category and rules changes, and lifting bans pass by majority of the active moderators. A proposal
        counts as its author’s yes vote and expires after 7 days. Propose from the other tabs.
      </p>
      <h2>Open</h2>
      {open.length === 0 ? (
        <p className="muted">Nothing to vote on.</p>
      ) : (
        open.map((p) => <Proposal key={p.uri} p={p} ctx={ctx} bans={bans} />)
      )}
      <h2>Decided</h2>
      {closed.length === 0 ? (
        <p className="muted">No decided proposals yet.</p>
      ) : (
        closed.map((p) => <Proposal key={p.uri} p={p} ctx={ctx} bans={bans} />)
      )}
    </>
  )
}

function Proposal({ p, ctx, bans }: { p: ProposalView; ctx: CommunityContext; bans: BanView[] }) {
  const proposer = useHandle(p.proposer.did, p.proposer.handle)
  const [reason, setReason] = useState('')
  const action = useAction()
  const mine = p.proposer.did === ctx.me.did
  const myVote = [...(p.votes ?? [])].reverse().find((v) => v.voter.did === ctx.me.did)
  const canVote = p.status === 'open' && !mine && !ctx.frozen && ctx.moderators.some((m) => m.actor.did === ctx.me.did && m.status === 'active')

  const vote = (value: 'yes' | 'no') =>
    action.run(async () => {
      await api.vote({ proposal: { uri: p.uri, cid: p.cid }, value, reason: reason.trim() || undefined })
      setReason('')
      ctx.refresh()
    })

  return (
    <article className="panel proposal" data-proposal={p.uri}>
      <h3>
        <Describe p={p} detail={ctx.detail} bans={bans} />
      </h3>
      <p className="small">
        <span className={`status ${p.status === 'passed' ? 'verified' : p.status === 'open' ? 'pending' : 'rejected'}`}>
          {STATUS_TEXT[p.status] ?? p.status}
        </span>{' '}
        <span className="tally">
          {p.yes} yes, {p.no} no; {p.needed} of {p.electorateSize} needed
        </span>
        {p.status === 'open' && <span className="muted"> · closes {p.expiresAt.slice(0, 10)}</span>}
        {p.status === 'passed' && <span className="muted"> · {p.executed ? 'carried out' : 'waiting for the community service'}</span>}
      </p>
      <p>
        <strong>@{proposer ?? p.proposer.did}</strong>: {p.reason}
      </p>
      {p.status === 'invalid' && p.problems?.length ? (
        <p className="error small">It does not count because {p.problems.map((x) => PROBLEM_TEXT[x] ?? x).join('; ')}.</p>
      ) : null}
      {p.votes && p.votes.length > 0 && (
        <ul className="votes">
          {p.votes.map((v) => (
            <Vote key={`${v.voter.did}-${v.indexedAt}`} voter={v.voter} value={v.value} reason={v.reason} />
          ))}
        </ul>
      )}
      {mine && p.status === 'open' && <p className="muted small">Your proposal counts as your yes vote.</p>}
      {canVote && (
        <div className="row">
          <input placeholder="Why (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button disabled={action.busy} onClick={() => vote('yes')}>
            {myVote?.value === 'yes' ? 'Voted yes' : 'Vote yes'}
          </button>
          <button className="secondary" disabled={action.busy} onClick={() => vote('no')}>
            {myVote?.value === 'no' ? 'Voted no' : 'Vote no'}
          </button>
          {myVote && <span className="muted small">You can change your vote until it closes.</span>}
        </div>
      )}
      {action.error && <p className="error">{action.error}</p>}
    </article>
  )
}

function Vote({ voter, value, reason }: { voter: { did: string; handle?: string }; value: string; reason?: string }) {
  const handle = useHandle(voter.did, voter.handle)
  return (
    <li>
      @{handle ?? voter.did} voted <strong>{value}</strong>
      {reason ? `: ${reason}` : ''}
    </li>
  )
}

/** One line saying what a proposal would do. */
function Describe({ p, detail, bans }: { p: ProposalView; detail: CommunityDetail; bans: BanView[] }) {
  const action = p.action as Record<string, any>
  // The AppView names who a proposal is about, even after a lifted ban's record is gone.
  const subjectDid = p.subject?.did ?? (typeof action.subject === 'string' ? action.subject : undefined)
  const subject = useHandle(subjectDid, p.subject?.handle)
  const categories = detail.games.flatMap((g) => g.categories)
  switch (p.actionType) {
    case 'invite':
      return <>Invite @{subject ?? subjectDid} as a moderator</>
    case 'kick':
      return <>Remove @{subject ?? subjectDid} as a moderator</>
    case 'putRecord': {
      const record = action.record ?? {}
      if (action.collection === CATEGORY) {
        return <>{action.rkey ? `Change category “${record.name}”` : `Add category “${record.name}”`}</>
      }
      if (action.collection === RULESET) {
        const category = categories.find((c) => c.uri === record.category?.uri)
        return <>New rules for {category ? `“${category.name}”` : 'a category'}</>
      }
      return <>Change a record</>
    }
    case 'liftBan': {
      const ban = bans.find((b) => b.uri === action.ban?.uri)
      const runner = ban ? (ban.subject.handle ?? ban.subject.did) : (subject ?? subjectDid)
      return <>Lift the ban on {runner ? `@${runner}` : 'a runner'}</>
    }
    case 'migrate':
      return <>Move the community to {action.pdsEndpoint}</>
    default:
      return <>{p.actionType}</>
  }
}
