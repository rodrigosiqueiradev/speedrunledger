import type { Selectable } from 'kysely'
import type { Database } from './index.js'
import type { DatabaseSchema } from './schema.js'

// Rules shared by the indexer, the AppView and the community service: who the
// sysadmins are, when a community is frozen, and how a proposal's votes count.

/** Proposals expire after at most this long, whatever their expiresAt says. */
export const PROPOSAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export type ProposalStatus = 'open' | 'passed' | 'failed' | 'expired' | 'invalid'
export type ProposalRow = Selectable<DatabaseSchema['proposal']>
export type VoteRow = Selectable<DatabaseSchema['vote']>

/** The platform account (its repo lists the sysadmins), as registered with the community service. */
export async function platformDid(db: Database): Promise<string | undefined> {
  const row = await db.selectFrom('community_credential').select('did').where('kind', '=', 'platform').executeTakeFirst()
  return row?.did
}

/** Sysadmin DIDs: platform.sysadmin records in the platform account's repo. */
export async function sysadmins(db: Database): Promise<Set<string>> {
  const platform = await platformDid(db)
  if (!platform) return new Set()
  const rows = await db.selectFrom('sysadmin').select('subject_did').where('owner_did', '=', platform).execute()
  return new Set(rows.map((r) => r.subject_did))
}

/** Periods a community was frozen, from interventions by listed sysadmins. `to` is null while still frozen. */
export type FreezeIntervals = { from: Date; to: Date | null }[]

export async function freezeIntervals(db: Database, communityDids: string[]): Promise<Map<string, FreezeIntervals>> {
  const result = new Map<string, FreezeIntervals>(communityDids.map((did) => [did, []]))
  if (communityDids.length === 0) return result
  const admins = await sysadmins(db)
  if (admins.size === 0) return result
  const rows = await db
    .selectFrom('intervention')
    .select(['community_did', 'action', 'indexed_at'])
    .where('community_did', 'in', communityDids)
    .where('action', 'in', ['freeze', 'unfreeze'])
    .where('sysadmin_did', 'in', [...admins])
    .orderBy('indexed_at')
    .orderBy('uri')
    .execute()
  for (const row of rows) {
    const intervals = result.get(row.community_did)!
    const open = intervals.at(-1)
    if (row.action === 'freeze' && (!open || open.to)) intervals.push({ from: row.indexed_at, to: null })
    if (row.action === 'unfreeze' && open && !open.to) open.to = row.indexed_at
  }
  return result
}

export const frozenAt = (intervals: FreezeIntervals | undefined, at: Date): boolean =>
  (intervals ?? []).some(({ from, to }) => at >= from && (to === null || at < to))

export const isFrozen = (intervals: FreezeIntervals | undefined): boolean => (intervals ?? []).some(({ to }) => to === null)

export interface Tally {
  status: ProposalStatus
  electorateSize: number
  /** Yes votes needed: more than half the electorate. */
  needed: number
  yes: number
  no: number
  /** Each voter's counted vote; the proposer counts as yes. */
  votes: { voter: string; value: 'yes' | 'no'; reason: string | null; indexedAt: Date }[]
  expiresAt: Date
  decidedAt?: Date
}

/** When a proposal stops taking votes: its own expiresAt, but never more than seven days after it was first seen. */
export const proposalDeadline = (p: ProposalRow): Date => {
  const claimed = new Date(p.expires_at).getTime()
  const cap = p.first_indexed_at.getTime() + PROPOSAL_MAX_AGE_MS
  return new Date(Number.isNaN(claimed) ? cap : Math.min(claimed, cap))
}

/**
 * Counts a proposal's votes in the order the indexer saw them. Each voter's
 * latest vote counts; votes for another version of the proposal, from outside
 * the electorate, after the deadline or while the community was frozen are
 * ignored. The proposal is decided the moment yes votes reach a majority of
 * the electorate (passed) or can no longer reach it (failed).
 */
export function tallyProposal(p: ProposalRow, votes: VoteRow[], frozen: FreezeIntervals | undefined, now = new Date()): Tally {
  const electorate = new Set(p.electorate)
  const needed = Math.floor(electorate.size / 2) + 1
  const expiresAt = proposalDeadline(p)
  const current = new Map<string, Tally['votes'][number]>()
  if (electorate.has(p.proposer_did)) {
    current.set(p.proposer_did, { voter: p.proposer_did, value: 'yes', reason: null, indexedAt: p.first_indexed_at })
  }
  const result = (status: ProposalStatus, decidedAt?: Date): Tally => {
    const counted = [...current.values()]
    return {
      status,
      electorateSize: electorate.size,
      needed,
      yes: counted.filter((v) => v.value === 'yes').length,
      no: counted.filter((v) => v.value === 'no').length,
      votes: counted,
      expiresAt,
      decidedAt,
    }
  }
  const decide = (at: Date): Tally | undefined => {
    const counted = [...current.values()]
    const yes = counted.filter((v) => v.value === 'yes').length
    const undecided = electorate.size - counted.length
    if (yes >= needed) return result('passed', at)
    if (yes + undecided < needed) return result('failed', at)
    return undefined
  }

  if (p.problems.length > 0 || electorate.size === 0) return result('invalid')
  const initial = decide(p.first_indexed_at)
  if (initial) return initial
  const ordered = [...votes].sort((a, b) => a.indexed_at.getTime() - b.indexed_at.getTime() || a.uri.localeCompare(b.uri))
  for (const vote of ordered) {
    if (vote.indexed_at > expiresAt) break
    if (vote.proposal_uri !== p.uri || vote.proposal_cid !== p.cid) continue
    if (!electorate.has(vote.voter_did) || vote.voter_did === p.proposer_did) continue
    if (vote.value !== 'yes' && vote.value !== 'no') continue
    if (frozenAt(frozen, vote.indexed_at)) continue
    current.set(vote.voter_did, { voter: vote.voter_did, value: vote.value, reason: vote.reason, indexedAt: vote.indexed_at })
    const decided = decide(vote.indexed_at)
    if (decided) return decided
  }
  return result(now > expiresAt ? 'expired' : 'open')
}

/** Tallies proposals with their votes and their communities' freeze history. */
export async function tallyProposals(db: Database, proposals: ProposalRow[], now = new Date()): Promise<Map<string, Tally>> {
  const tallies = new Map<string, Tally>()
  if (proposals.length === 0) return tallies
  const [votes, frozen] = await Promise.all([
    db.selectFrom('vote').selectAll().where('proposal_uri', 'in', proposals.map((p) => p.uri)).execute(),
    freezeIntervals(db, [...new Set(proposals.map((p) => p.community_did))]),
  ])
  for (const p of proposals) {
    tallies.set(p.uri, tallyProposal(p, votes.filter((v) => v.proposal_uri === p.uri), frozen.get(p.community_did), now))
  }
  return tallies
}

/** What a proposal targets, for the one-open-proposal-per-category rule. */
export function proposalCategory(p: Pick<ProposalRow, 'action_type' | 'action' | 'community_did'>): string | undefined {
  if (p.action_type !== 'putRecord') return undefined
  const action = p.action as { collection?: string; rkey?: string; record?: { category?: { uri?: string } } }
  if (action.collection === 'app.speedrunledger-prototype.category' && action.rkey) {
    return `at://${p.community_did}/${action.collection}/${action.rkey}`
  }
  if (action.collection === 'app.speedrunledger-prototype.ruleset') return action.record?.category?.uri
  return undefined
}
