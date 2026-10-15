import { AtUri } from '@atproto/syntax'
import { type Database, freezeIntervals, frozenAt, proposalCategory, type ProposalRow, tallyProposals } from '@speedrunledger/db'
import { ids, parseRecord } from '@speedrunledger/lexicon'

export interface ProposalCheck {
  /** Active moderators at this moment, minus a kick's target. */
  electorate: string[]
  /** Why the proposal does not count; empty when it does. */
  problems: string[]
}

type Action = Record<string, unknown> & { $type?: string }

const hostOf = (uri: unknown): string | undefined => {
  if (typeof uri !== 'string') return undefined
  try {
    return new AtUri(uri).host
  } catch {
    return undefined
  }
}

/**
 * Checks a proposal against the community as the index stands now: the
 * proposer must be an active moderator of an unfrozen community, the action
 * must make sense, and neither the proposer nor the targeted category may
 * already have an open proposal. Also fixes the electorate.
 */
export async function checkProposal(
  db: Database,
  p: Pick<ProposalRow, 'uri' | 'proposer_did' | 'community_did' | 'action_type'> & { action: Action },
  at: Date,
  electorate?: string[],
): Promise<ProposalCheck> {
  const problems: string[] = []
  const community = p.community_did
  const members = await db
    .selectFrom('community_member')
    .select(['member_did', 'active'])
    .where('community_did', '=', community)
    .execute()
  const active = members.filter((m) => m.active).map((m) => m.member_did)
  const kickTarget = p.action_type === 'kick' ? String(p.action.subject ?? '') : undefined
  const voters = electorate ?? active.filter((did) => did !== kickTarget).sort()

  if (!active.includes(p.proposer_did)) problems.push('not_moderator')
  const frozen = await freezeIntervals(db, [community])
  if (frozenAt(frozen.get(community), at)) problems.push('community_frozen')

  switch (p.action_type) {
    case 'invite':
      if (members.some((m) => m.member_did === p.action.subject)) problems.push('already_member')
      break
    case 'kick':
      if (!kickTarget || !active.includes(kickTarget)) problems.push('not_member')
      else if (voters.length === 0) problems.push('last_moderator')
      break
    case 'putRecord': {
      const collection = p.action.collection
      if (collection !== ids.category && collection !== ids.ruleset) {
        problems.push('unsupported_collection')
        break
      }
      const record: Record<string, unknown> = { ...(p.action.record as Record<string, unknown>), $type: collection }
      if (!parseRecord(collection, record).success) {
        problems.push('invalid_record')
        break
      }
      const ref = collection === ids.category ? (record.game as { uri?: string }) : (record.category as { uri?: string })
      if (hostOf(ref?.uri) !== community) problems.push(collection === ids.category ? 'game_not_in_community' : 'category_not_in_community')
      break
    }
    case 'liftBan': {
      const ban = (p.action.ban as { uri?: string } | undefined)?.uri
      const exists = ban
        ? await db.selectFrom('ban').select('uri').where('uri', '=', ban).where('community_did', '=', community).executeTakeFirst()
        : undefined
      if (!exists) problems.push('ban_not_found')
      break
    }
    case 'migrate':
      break
    default:
      problems.push('unknown_action')
  }

  // One open proposal per person, and per category, at a time.
  const others = await db
    .selectFrom('proposal')
    .selectAll()
    .where('community_did', '=', community)
    .where('uri', '!=', p.uri)
    .where('first_indexed_at', '<=', at)
    .execute()
  const target = proposalCategory({ ...p, action: p.action })
  const competing = others.filter((o) => o.proposer_did === p.proposer_did || (target && proposalCategory(o) === target))
  if (competing.length > 0) {
    const tallies = await tallyProposals(db, competing, at)
    for (const o of competing) {
      if (tallies.get(o.uri)?.status !== 'open') continue
      if (o.proposer_did === p.proposer_did && !problems.includes('proposer_has_open_proposal')) problems.push('proposer_has_open_proposal')
      if (target && proposalCategory(o) === target && !problems.includes('category_has_open_proposal')) {
        problems.push('category_has_open_proposal')
      }
    }
  }
  if (voters.length === 0 && !problems.includes('last_moderator')) problems.push('no_electorate')
  return { electorate: voters, problems }
}
