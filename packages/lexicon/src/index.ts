import * as ledgerLexicons from './lexicons/app/speedrunledger-prototype.js'
import { com } from './lexicons/index.js'
import type * as LexDefs from './lexicons/app/speedrunledger-prototype/defs.js'
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
import type * as LexCommunityIntervention from './lexicons/app/speedrunledger-prototype/community/intervention.js'
import type * as LexPlatformSysadmin from './lexicons/app/speedrunledger-prototype/platform/sysadmin.js'
import type * as LexPlatformRequestDenial from './lexicons/app/speedrunledger-prototype/platform/requestDenial.js'

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
  communityIntervention: ledger.community.intervention.$nsid,
  platformSysadmin: ledger.platform.sysadmin.$nsid,
  platformRequestDenial: ledger.platform.requestDenial.$nsid,
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
  [ids.communityIntervention]: ledger.community.intervention,
  [ids.platformSysadmin]: ledger.platform.sysadmin,
  [ids.platformRequestDenial]: ledger.platform.requestDenial,
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
export type CommunityInterventionRecord = LexCommunityIntervention.Main
export type PlatformSysadminRecord = LexPlatformSysadmin.Main
export type PlatformRequestDenialRecord = LexPlatformRequestDenial.Main

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

interface RecordTypes {
  [ids.run]: RunRecord
  [ids.runParticipant]: RunParticipantRecord
  [ids.game]: GameRecord
  [ids.category]: CategoryRecord
  [ids.ruleset]: RulesetRecord
  [ids.verification]: VerificationRecord
  [ids.communityRequest]: CommunityRequestRecord
  [ids.communityProfile]: CommunityProfileRecord
  [ids.communityMember]: CommunityMemberRecord
  [ids.communityMemberAccept]: CommunityMemberAcceptRecord
  [ids.communityProposal]: CommunityProposalRecord
  [ids.communityVote]: CommunityVoteRecord
  [ids.communityBan]: CommunityBanRecord
  [ids.communityIntervention]: CommunityInterventionRecord
  [ids.platformSysadmin]: PlatformSysadminRecord
  [ids.platformRequestDenial]: PlatformRequestDenialRecord
}

export type RecordFor<C extends Collection> = RecordTypes[C]

/** AppView view types (app.speedrunledger-prototype.defs). */
export type ActorView = LexDefs.ActorView
export type CommunityView = LexDefs.CommunityView
export type GameView = LexDefs.GameView
export type CategoryView = LexDefs.CategoryView
export type RulesetView = LexDefs.RulesetView
export type CommunityDetail = LexDefs.CommunityDetail
export type VerdictView = LexDefs.VerdictView
export type RunView = LexDefs.RunView
export type BoardEntry = LexDefs.BoardEntry
export type QueueItem = LexDefs.QueueItem
export type MembershipView = LexDefs.MembershipView
export type ProposalView = LexDefs.ProposalView
export type VoteView = LexDefs.VoteView
export type ModeratorView = LexDefs.ModeratorView
export type BanView = LexDefs.BanView
export type RequestView = LexDefs.RequestView
export type LabelView = LexDefs.LabelView
export type WorldRecordView = LexDefs.WorldRecordView
export type NotificationView = LexDefs.NotificationView
export type VideoProblemView = LexDefs.VideoProblemView
