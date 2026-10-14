import * as ledgerLexicons from './lexicons/app/speedrunledger-prototype.js'
import { com } from './lexicons/index.js'
import type * as LexRun from './lexicons/app/speedrunledger-prototype/run.js'
import type * as LexRunParticipant from './lexicons/app/speedrunledger-prototype/runParticipant.js'
import type * as LexGame from './lexicons/app/speedrunledger-prototype/game.js'
import type * as LexCategory from './lexicons/app/speedrunledger-prototype/category.js'
import type * as LexRuleset from './lexicons/app/speedrunledger-prototype/ruleset.js'
import type * as LexVerification from './lexicons/app/speedrunledger-prototype/verification.js'
import type * as LexCommunityRequest from './lexicons/app/speedrunledger-prototype/community/request.js'
import type * as LexCommunityProfile from './lexicons/app/speedrunledger-prototype/community/profile.js'
import type * as LexCommunityMember from './lexicons/app/speedrunledger-prototype/community/member.js'
import type * as LexCommunityMemberAccept from './lexicons/app/speedrunledger-prototype/community/memberAccept.js'
import type * as LexCommunityProposal from './lexicons/app/speedrunledger-prototype/community/proposal.js'
import type * as LexCommunityVote from './lexicons/app/speedrunledger-prototype/community/vote.js'
import type * as LexCommunityBan from './lexicons/app/speedrunledger-prototype/community/ban.js'
import type * as LexPlatformSysadmin from './lexicons/app/speedrunledger-prototype/platform/sysadmin.js'

/** Generated schemas for every app.speedrunledger-prototype.* lexicon. */
export const ledger = ledgerLexicons
export { com }

export const NSID_PREFIX = 'app.speedrunledger-prototype'

export const ids = {
  run: ledger.run.$nsid,
  runParticipant: ledger.runParticipant.$nsid,
  game: ledger.game.$nsid,
  category: ledger.category.$nsid,
  ruleset: ledger.ruleset.$nsid,
  verification: ledger.verification.$nsid,
  communityRequest: ledger.community.request.$nsid,
  communityProfile: ledger.community.profile.$nsid,
  communityMember: ledger.community.member.$nsid,
  communityMemberAccept: ledger.community.memberAccept.$nsid,
  communityProposal: ledger.community.proposal.$nsid,
  communityVote: ledger.community.vote.$nsid,
  communityBan: ledger.community.ban.$nsid,
  platformSysadmin: ledger.platform.sysadmin.$nsid,
} as const

export type Collection = (typeof ids)[keyof typeof ids]

/** Record schemas keyed by collection NSID. */
export const recordSchemas = {
  [ids.run]: ledger.run,
  [ids.runParticipant]: ledger.runParticipant,
  [ids.game]: ledger.game,
  [ids.category]: ledger.category,
  [ids.ruleset]: ledger.ruleset,
  [ids.verification]: ledger.verification,
  [ids.communityRequest]: ledger.community.request,
  [ids.communityProfile]: ledger.community.profile,
  [ids.communityMember]: ledger.community.member,
  [ids.communityMemberAccept]: ledger.community.memberAccept,
  [ids.communityProposal]: ledger.community.proposal,
  [ids.communityVote]: ledger.community.vote,
  [ids.communityBan]: ledger.community.ban,
  [ids.platformSysadmin]: ledger.platform.sysadmin,
} as const

export const collections = Object.keys(recordSchemas) as Collection[]

export const isLedgerCollection = (nsid: string): nsid is Collection =>
  Object.hasOwn(recordSchemas, nsid)

export type RunRecord = LexRun.Main
export type RunParticipantRecord = LexRunParticipant.Main
export type GameRecord = LexGame.Main
export type CategoryRecord = LexCategory.Main
export type RulesetRecord = LexRuleset.Main
export type VerificationRecord = LexVerification.Main
export type CommunityRequestRecord = LexCommunityRequest.Main
export type CommunityProfileRecord = LexCommunityProfile.Main
export type CommunityMemberRecord = LexCommunityMember.Main
export type CommunityMemberAcceptRecord = LexCommunityMemberAccept.Main
export type CommunityProposalRecord = LexCommunityProposal.Main
export type CommunityVoteRecord = LexCommunityVote.Main
export type CommunityBanRecord = LexCommunityBan.Main
export type PlatformSysadminRecord = LexPlatformSysadmin.Main

export type RunTimes = LexRun.Times
export type TimingMethod = 'realTime' | 'realTimeNoLoads' | 'gameTime'

/** The field of `RunTimes` that holds a timing method's value. */
export const timeField = {
  realTime: 'realTimeMs',
  realTimeNoLoads: 'realTimeNoLoadsMs',
  gameTime: 'gameTimeMs',
} as const satisfies Record<TimingMethod, keyof RunTimes>

export type ParseResult<T> =
  | { success: true; value: T }
  | { success: false; error: string }

/**
 * Validates a record against its collection's lexicon and applies schema
 * defaults (for example a category's `requiredApprovals`).
 */
export function parseRecord<C extends Collection>(
  collection: C,
  value: unknown,
): ParseResult<RecordFor<C>> {
  const schema = recordSchemas[collection] as unknown as {
    $safeParse: (v: unknown) => { success: true; value: unknown } | { success: false; reason: unknown }
  }
  const result = schema.$safeParse(value)
  if (result.success) return { success: true, value: result.value as RecordFor<C> }
  return { success: false, error: String(result.reason) }
}

export type RecordFor<C extends Collection> = C extends typeof ids.run
  ? RunRecord
  : C extends typeof ids.runParticipant
    ? RunParticipantRecord
    : C extends typeof ids.game
      ? GameRecord
      : C extends typeof ids.category
        ? CategoryRecord
        : C extends typeof ids.ruleset
          ? RulesetRecord
          : C extends typeof ids.verification
            ? VerificationRecord
            : C extends typeof ids.communityRequest
              ? CommunityRequestRecord
              : C extends typeof ids.communityProfile
                ? CommunityProfileRecord
                : C extends typeof ids.communityMember
                  ? CommunityMemberRecord
                  : C extends typeof ids.communityMemberAccept
                    ? CommunityMemberAcceptRecord
                    : C extends typeof ids.communityProposal
                      ? CommunityProposalRecord
                      : C extends typeof ids.communityVote
                        ? CommunityVoteRecord
                        : C extends typeof ids.communityBan
                          ? CommunityBanRecord
                          : C extends typeof ids.platformSysadmin
                            ? PlatformSysadminRecord
                            : never
