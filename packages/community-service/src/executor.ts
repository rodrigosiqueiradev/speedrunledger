import { createHash } from 'node:crypto'
import { TID } from '@atproto/common-web'
import { type ProposalRow, tallyProposals } from '@speedrunledger/db'
import { ids, ledger } from '@speedrunledger/lexicon'
import type { CommunityService } from './service.js'

/**
 * A stable record key for what a proposal creates, so carrying it out twice
 * (after a crash, say) rewrites the same record instead of adding another.
 */
export function proposalRkey(p: Pick<ProposalRow, 'uri' | 'first_indexed_at'>): string {
  const clockId = createHash('sha256').update(p.uri).digest().readUInt16BE(0) % 1024
  return TID.fromTime(p.first_indexed_at.getTime() * 1000, clockId).toString()
}

const rkeyOf = (uri: string) => uri.split('/').pop()!

/**
 * Carries out passed proposals for the communities this service manages:
 * invites become member grants, kicks delete grants, category and ruleset
 * changes are written exactly as proposed, and lifted bans are deleted.
 * Frozen communities wait until they are unfrozen.
 */
export class ProposalExecutor {
  private timer?: NodeJS.Timeout
  private running?: Promise<number>

  constructor(private readonly service: CommunityService) {}

  start(intervalMs: number): void {
    const tick = async () => {
      try {
        await this.runOnce()
      } catch (err) {
        this.service.logger.error({ err }, 'proposal executor failed')
      }
      this.timer = setTimeout(tick, intervalMs)
    }
    this.timer = setTimeout(tick, 0)
  }

  async stop(): Promise<void> {
    clearTimeout(this.timer)
    this.timer = undefined
    await this.running
  }

  /** Executes every passed, not yet executed proposal once. Returns how many it carried out. */
  runOnce(): Promise<number> {
    this.running ??= this.execute().finally(() => (this.running = undefined))
    return this.running
  }

  private async execute(): Promise<number> {
    const { db, logger } = this.service
    const managed = await db.selectFrom('community_credential').select('did').where('kind', '=', 'community').execute()
    if (managed.length === 0) return 0
    const candidates = await db
      .selectFrom('proposal')
      .selectAll()
      .where('community_did', 'in', managed.map((m) => m.did))
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('proposal_execution as e')
              .select('e.proposal_uri')
              .whereRef('e.proposal_uri', '=', 'proposal.uri')
              .where('e.executed_at', 'is not', null),
          ),
        ),
      )
      .where(({ eb }) => eb.fn('jsonb_array_length', ['problems']), '=', 0)
      .orderBy('first_indexed_at')
      .execute()
    const tallies = await tallyProposals(db, candidates)
    let done = 0
    for (const p of candidates) {
      if (tallies.get(p.uri)?.status !== 'passed') continue
      if (await this.service.isFrozen(p.community_did)) continue
      try {
        const result = await this.carryOut(p)
        await this.record(p, { result_uri: result ?? null, error: null, executed_at: new Date() })
        logger.info({ proposal: p.uri, action: p.action_type, result }, 'proposal carried out')
        done++
      } catch (err) {
        await this.record(p, { result_uri: null, error: String((err as Error).message ?? err), executed_at: null })
        logger.error({ err, proposal: p.uri }, 'could not carry out proposal')
      }
    }
    return done
  }

  private async record(p: ProposalRow, fields: { result_uri: string | null; error: string | null; executed_at: Date | null }) {
    const row = { ...fields, updated_at: new Date() }
    await this.service.db
      .insertInto('proposal_execution')
      .values({ proposal_uri: p.uri, community_did: p.community_did, ...row })
      .onConflict((oc) => oc.column('proposal_uri').doUpdateSet(row))
      .execute()
  }

  /** Writes the proposal's result into the community's repo; returns the written record's URI, if any. */
  private async carryOut(p: ProposalRow): Promise<string | undefined> {
    const { db } = this.service
    const client = await this.service.requireClient(p.community_did)
    const action = p.action as Record<string, any>
    const via = { uri: p.uri, cid: p.cid }
    const now = new Date().toISOString()
    switch (p.action_type) {
      case 'invite': {
        const { $type: _t, ...grant } = ledger.community.member.$parse({
          $type: ledger.community.member.$type,
          subject: action.subject,
          via,
          createdAt: now,
        })
        const out = await client.put(ledger.community.member, grant, { rkey: proposalRkey(p) })
        return out.uri
      }
      case 'kick': {
        const grants = await db
          .selectFrom('community_member')
          .select('uri')
          .where('community_did', '=', p.community_did)
          .where('member_did', '=', action.subject)
          .execute()
        for (const g of grants) await client.delete(ledger.community.member, { rkey: rkeyOf(g.uri) })
        return undefined
      }
      case 'putRecord': {
        const collection = action.collection === ids.category ? ledger.category : ledger.ruleset
        // Validate, but write the record the moderators voted on: parsing adds lexicon defaults,
        // which would change the record and its CID.
        collection.$parse({ ...action.record, $type: collection.$type })
        const { $type: _t, ...record } = action.record as Record<string, unknown>
        const rkey = action.collection === ids.category && action.rkey ? String(action.rkey) : proposalRkey(p)
        const out = await this.service.putForeignRecord(p.community_did, collection.$type, rkey, record)
        return out.uri
      }
      case 'liftBan': {
        await client.delete(ledger.community.ban, { rkey: rkeyOf(action.ban.uri) })
        return undefined
      }
      case 'migrate':
        // Moving the account is done by its founders with their rotation key; the vote authorizes it.
        return undefined
      default:
        throw new Error(`unknown action ${p.action_type}`)
    }
  }
}
