import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely'

type Timestamp = ColumnType<Date, Date | string, Date | string>
type Json<T> = ColumnType<T, string, string>

/** Firehose cursor per upstream service. */
export interface SubscriptionStateTable {
  service: string
  cursor: ColumnType<number, number | bigint, number | bigint>
  updated_at: Timestamp
}

export interface ActorTable {
  did: string
  handle: string | null
  pds_endpoint: string | null
  /** Newest repo revision applied to the index, used to order backfill and live events. */
  repo_rev: string | null
  active: Generated<boolean>
  status: string | null
  indexed_at: Timestamp
  updated_at: Timestamp
}

/** Every indexed record, raw, in one place. Typed tables below hold parsed fields. */
export interface RecordTable {
  uri: string
  cid: string
  did: string
  collection: string
  rkey: string
  json: Json<unknown>
  rev: string
  indexed_at: Timestamp
}

export interface CommunityTable {
  did: string
  profile_uri: string
  profile_cid: string
  name: string
  description: string | null
  indexed_at: Timestamp
}

export interface GameTable {
  uri: string
  cid: string
  community_did: string
  title: string
  release_year: number | null
  platforms: Json<string[]>
  indexed_at: Timestamp
}

export interface CategoryVariable {
  id: string
  name: string
  values: string[]
  subcategory: boolean
}

export interface CategoryTable {
  uri: string
  cid: string
  community_did: string
  game_uri: string
  name: string
  description: string | null
  kind: string
  sort: string
  primary_timing: string
  timing_methods: Json<string[]>
  variables: Json<CategoryVariable[]>
  requires_video: boolean
  required_approvals: number
  retired: boolean
  indexed_at: Timestamp
}

export interface RulesetTable {
  uri: string
  cid: string
  community_did: string
  category_uri: string
  text: string
  created_at: string
  indexed_at: Timestamp
}

export interface RunTable {
  uri: string
  cid: string
  runner_did: string
  community_did: string
  category_uri: string
  category_cid: string
  ruleset_uri: string | null
  variables: Json<Record<string, string>>
  platform: string | null
  emulated: boolean | null
  real_time_ms: number | null
  real_time_no_loads_ms: number | null
  game_time_ms: number | null
  videos: Json<{ url: string; label?: string }[]>
  comment: string | null
  co_runners: Json<string[]>
  performed_at: string
  created_at: string
  /** When the indexer first saw this run URI. */
  first_indexed_at: Timestamp
  /** When the indexer saw the current CID; ties on boards break on this. */
  indexed_at: Timestamp
  /** Reference checks that failed (empty when the run is well formed). */
  problems: Json<string[]>
}

export interface VerificationTable {
  uri: string
  cid: string
  community_did: string
  subject_uri: string
  subject_cid: string
  status: string
  reviewer_did: string
  verified_real_time_ms: number | null
  verified_real_time_no_loads_ms: number | null
  verified_game_time_ms: number | null
  has_verified_times: boolean
  ruleset_uri: string | null
  reason: string | null
  /** Whether the reviewer was an active moderator of the community when this was indexed. */
  reviewer_active: boolean
  created_at: string
  indexed_at: Timestamp
}

export interface CommunityMemberTable {
  /** URI of the community.member grant in the community's repo. */
  uri: string
  cid: string
  community_did: string
  member_did: string
  via_uri: string | null
  /** URI of the matching memberAccept in the moderator's repo, once it exists. */
  accept_uri: string | null
  active: boolean
  /** The grant's createdAt, as written by the community. */
  created_at: string
  indexed_at: Timestamp
}

export interface MemberAcceptTable {
  uri: string
  cid: string
  member_did: string
  grant_uri: string
  indexed_at: Timestamp
}

export interface CommunityRequestTable {
  uri: string
  cid: string
  requester_did: string
  game_title: string
  game: Json<unknown>
  founders: Json<string[]>
  note: string | null
  indexed_at: Timestamp
}

export interface ProposalTable {
  uri: string
  cid: string
  proposer_did: string
  community_did: string
  action_type: string
  action: Json<unknown>
  reason: string
  expires_at: string
  created_at: string
  indexed_at: Timestamp
  /** When the indexer first saw this proposal; its electorate was fixed then. */
  first_indexed_at: ColumnType<Date, Date | string, Date | string>
  /** DIDs that may vote: active moderators when first indexed, minus a kick's target. */
  electorate: Json<string[]>
  /** Why the proposal does not count (empty when valid). */
  problems: Json<string[]>
  /** The account it is about: an invite's or kick's subject, or a lifted ban's runner (kept after the ban is deleted). */
  subject_did: string | null
}

export interface VoteTable {
  uri: string
  cid: string
  voter_did: string
  proposal_uri: string
  proposal_cid: string
  value: string
  reason: string | null
  indexed_at: Timestamp
}

export interface BanTable {
  uri: string
  cid: string
  community_did: string
  subject_did: string
  moderator_did: string
  reason: string
  indexed_at: Timestamp
}

export interface RunParticipantTable {
  uri: string
  cid: string
  participant_did: string
  run_uri: string
  run_cid: string
  indexed_at: Timestamp
}

export interface SysadminTable {
  uri: string
  cid: string
  /** The repo the record lives in; only the platform account's records count. */
  owner_did: string
  subject_did: string
  indexed_at: Timestamp
}

/** One runner's best eligible run on one board. Derived; rebuilt from the tables above. */
export interface BoardEntryTable {
  /** Category URI plus the run's value for each subcategory variable. */
  board_key: string
  /** The runner's DID (for co-op, the sorted DIDs of the team). */
  entrant_key: string
  category_uri: string
  subcategory: Json<Record<string, string>>
  rank: number
  runner_did: string
  run_uri: string
  run_cid: string
  verification_uri: string
  ranked_ms: number
  indexed_at: Timestamp
}

/** OAuth authorization requests in flight (web apps). */
export interface OAuthStateTable {
  key: string
  value: Json<unknown>
  created_at: Timestamp
}

/** OAuth sessions of signed-in users, keyed by DID (web apps). */
export interface OAuthSessionTable {
  key: string
  value: Json<unknown>
  updated_at: Timestamp
}

export interface CommunityCredentialTable {
  did: string
  /** Handle or DID the community service logs in with. */
  identifier: string
  pds_url: string
  /** The account's (app) password, AES-256-GCM encrypted with the service's key. */
  secret: string
  /** 'community', or 'platform' for the platform account that lists sysadmins. */
  kind: ColumnType<string, string | undefined, string>
  created_at: Timestamp
  updated_at: Timestamp
}

export interface InterventionTable {
  uri: string
  cid: string
  community_did: string
  action: string
  subject_did: string | null
  reason: string
  sysadmin_did: string
  created_at: string
  indexed_at: Timestamp
}

export interface RequestDenialTable {
  uri: string
  cid: string
  /** The repo the record lives in; only the platform account's records count. */
  owner_did: string
  request_uri: string
  reason: string
  sysadmin_did: string
  indexed_at: Timestamp
}

/** The community service's progress carrying out passed proposals. */
export interface ProposalExecutionTable {
  proposal_uri: string
  community_did: string
  result_uri: string | null
  error: string | null
  executed_at: Timestamp | null
  updated_at: Timestamp
}

/** A board's new first place, as the indexer saw it happen. */
export interface WorldRecordTable {
  id: Generated<number>
  board_key: string
  category_uri: string
  community_did: string
  run_uri: string
  runner_did: string
  ranked_ms: number
  previous_run_uri: string | null
  previous_runner_did: string | null
  previous_ranked_ms: number | null
  quiet: Generated<boolean>
  set_at: Generated<Date>
}

/** The community service's post announcing a world record. */
export interface AnnouncementTable {
  world_record_id: number
  community_did: string
  game_uri: string
  post_uri: string | null
  post_cid: string | null
  error: string | null
  posted_at: Timestamp | null
}

/** A label the community service signed, in order of `seq`. */
export interface LabelTable {
  seq: Generated<number>
  src: string
  uri: string
  cid: string | null
  val: string
  neg: boolean
  cts: string
  sig: Uint8Array
  community_did: string
  moderator_did: string
  reason: string | null
}

/** The community service's last check of one video link on a ranked run. */
export interface VideoCheckTable {
  run_uri: string
  url: string
  community_did: string
  status: 'ok' | 'dead' | 'unknown'
  http_status: number | null
  detail: string | null
  checked_at: Timestamp
}

export interface DatabaseSchema {
  video_check: VideoCheckTable
  world_record: WorldRecordTable
  announcement: AnnouncementTable
  label: LabelTable
  community_credential: CommunityCredentialTable
  intervention: InterventionTable
  request_denial: RequestDenialTable
  proposal_execution: ProposalExecutionTable
  oauth_state: OAuthStateTable
  oauth_session: OAuthSessionTable
  board_entry: BoardEntryTable
  subscription_state: SubscriptionStateTable
  actor: ActorTable
  record: RecordTable
  community: CommunityTable
  game: GameTable
  category: CategoryTable
  ruleset: RulesetTable
  run: RunTable
  verification: VerificationTable
  community_member: CommunityMemberTable
  member_accept: MemberAcceptTable
  community_request: CommunityRequestTable
  proposal: ProposalTable
  vote: VoteTable
  ban: BanTable
  run_participant: RunParticipantTable
  sysadmin: SysadminTable
}

export type Actor = Selectable<ActorTable>
export type Run = Selectable<RunTable>
export type NewRun = Insertable<RunTable>
export type RunUpdate = Updateable<RunTable>
export type Category = Selectable<CategoryTable>
export type Verification = Selectable<VerificationTable>
export type CommunityMember = Selectable<CommunityMemberTable>
