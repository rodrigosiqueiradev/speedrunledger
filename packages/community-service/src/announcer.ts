import { TID } from '@atproto/common-web'
import type { CommunityService } from './service.js'

const FEED = 'app.bsky.feed.generator'
const POST = 'app.bsky.feed.post'
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

export interface AnnouncerOptions {
  /** Where the Runner app is, for links to runs. */
  runnerAppUrl: string
  /** The feed generator's DID (the AppView), named in each feed declaration. */
  feedServiceDid: string
}

/** 15:02.340 or 1:02:03.000. */
export function formatMs(ms: number): string {
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const sec = Math.floor((ms % 60_000) / 1000)
  const rest = String(ms % 1000).padStart(3, '0')
  return `${h > 0 ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(sec).padStart(2, '0')}.${rest}`
}

type Facet = { index: { byteStart: number; byteEnd: number }; features: Record<string, unknown>[] }

/** Builds post text piece by piece, recording mention and link facets at their UTF-8 byte offsets. */
class RichText {
  text = ''
  facets: Facet[] = []
  add(part: string, feature?: Record<string, unknown>): this {
    const byteStart = Buffer.byteLength(this.text)
    this.text += part
    if (feature) this.facets.push({ index: { byteStart, byteEnd: Buffer.byteLength(this.text) }, features: [feature] })
    return this
  }
  mention(did: string, handle: string | null): this {
    return handle ? this.add(`@${handle}`, { $type: 'app.bsky.richtext.facet#mention', did }) : this.add('a runner')
  }
}

/**
 * Brings world records to Bluesky for the communities this service manages:
 * a feed declaration per game, pointing at the AppView's feed generator, and
 * a post from the community's account for each new record. The post mentions
 * the new holder and the one they beat, which is what notifies them on
 * Bluesky, and links to the run in the Runner app.
 */
export class Announcer {
  private timer?: NodeJS.Timeout
  private running?: Promise<number>
  private declared = new Set<string>()

  constructor(
    private readonly service: CommunityService,
    private readonly opts: AnnouncerOptions,
  ) {}

  start(intervalMs: number): void {
    const tick = async () => {
      try {
        await this.runOnce()
      } catch (err) {
        this.service.logger.error({ err }, 'announcer failed')
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

  /** Declares missing feeds and posts unannounced records once; returns how many posts it wrote. */
  runOnce(): Promise<number> {
    this.running ??= (async () => {
      await this.declareFeeds()
      return this.announce()
    })().finally(() => (this.running = undefined))
    return this.running
  }

  private async declareFeeds(): Promise<void> {
    const { db } = this.service
    const games = await db
      .selectFrom('game as g')
      .innerJoin('community_credential as cc', 'cc.did', 'g.community_did')
      .leftJoin('community as c', 'c.did', 'g.community_did')
      .select(['g.uri', 'g.title', 'g.community_did', 'cc.pds_url', 'c.name'])
      .where('cc.kind', '=', 'community')
      .execute()
    for (const game of games) {
      if (this.declared.has(game.uri)) continue
      const rkey = game.uri.split('/').pop()!
      if (!(await this.service.hasRecord(game.pds_url, game.community_did, FEED, rkey))) {
        const name = game.title.length > 20 ? `${game.title.slice(0, 19)}…` : game.title
        await this.service.putForeignRecord(game.community_did, FEED, rkey, {
          did: this.opts.feedServiceDid,
          displayName: `${name} WRs`,
          description: `New ${game.title} world records, as the ${game.name ?? 'community'} moderators verify them on SpeedrunLedger.`,
          createdAt: new Date().toISOString(),
        })
        this.service.logger.info({ game: game.uri }, 'feed declared')
      }
      this.declared.add(game.uri)
    }
  }

  private async announce(): Promise<number> {
    const { db, logger } = this.service
    const pending = await db
      .selectFrom('world_record as w')
      .innerJoin('community_credential as cc', 'cc.did', 'w.community_did')
      .leftJoin('announcement as a', 'a.world_record_id', 'w.id')
      .selectAll('w')
      .where('cc.kind', '=', 'community')
      .where('w.quiet', '=', false)
      .where('w.set_at', '>', new Date(Date.now() - WEEK_MS))
      .where('a.posted_at', 'is', null)
      .orderBy('w.id')
      .execute()
    let posted = 0
    for (const record of pending) {
      if (await this.service.isFrozen(record.community_did)) continue
      const context = await db
        .selectFrom('run as r')
        .innerJoin('category as c', 'c.uri', 'r.category_uri')
        .innerJoin('game as g', 'g.uri', 'c.game_uri')
        .leftJoin('community as cm', 'cm.did', 'r.community_did')
        .select(['r.uri', 'c.name as category', 'g.uri as game_uri', 'g.title as game', 'cm.name as community'])
        .where('r.uri', '=', record.run_uri)
        .executeTakeFirst()
      // The run was deleted before we got to it; there is nothing to link to.
      if (!context) continue
      try {
        const post = await this.post(record, context)
        await this.save(record.id, record.community_did, context.game_uri, { post_uri: post.uri, post_cid: post.cid, error: null, posted_at: new Date() })
        logger.info({ run: record.run_uri, post: post.uri }, 'world record announced')
        posted++
      } catch (err) {
        await this.save(record.id, record.community_did, context.game_uri, { post_uri: null, post_cid: null, error: String((err as Error).message ?? err), posted_at: null })
        logger.error({ err, run: record.run_uri }, 'could not announce world record')
      }
    }
    return posted
  }

  private async post(
    record: { id: number; set_at: Date; community_did: string; run_uri: string; runner_did: string; ranked_ms: number; previous_runner_did: string | null; previous_ranked_ms: number | null },
    context: { category: string; game: string; community: string | null },
  ) {
    const dids = [record.runner_did, ...(record.previous_runner_did ? [record.previous_runner_did] : [])]
    const handles = new Map(
      (await this.service.db.selectFrom('actor').select(['did', 'handle']).where('did', 'in', dids).execute()).map((a) => [a.did, a.handle]),
    )
    const runUrl = `${this.opts.runnerAppUrl}/run?${new URLSearchParams({ uri: record.run_uri })}`
    const text = new RichText()
      .add('New world record! ')
      .mention(record.runner_did, handles.get(record.runner_did) ?? null)
      .add(` ran ${context.game} ${context.category} in ${formatMs(record.ranked_ms)}`)
    const beaten = record.previous_runner_did
    if (beaten && record.previous_ranked_ms !== null) {
      if (beaten === record.runner_did) text.add(`, beating their own ${formatMs(record.previous_ranked_ms)}`)
      else text.add(', beating ').mention(beaten, handles.get(beaten) ?? null).add(`’s ${formatMs(record.previous_ranked_ms)}`)
    }
    text.add('. ').add('See the run', { $type: 'app.bsky.richtext.facet#link', uri: runUrl })
    // A deterministic key, so a retry after a crash rewrites the same post.
    const rkey = TID.fromTime(record.set_at.getTime() * 1000, record.id % 1024).toString()
    return this.service.putForeignRecord(record.community_did, POST, rkey, {
      text: text.text,
      facets: text.facets,
      embed: {
        $type: 'app.bsky.embed.external',
        external: {
          uri: runUrl,
          title: `${context.game} ${context.category} in ${formatMs(record.ranked_ms)}`,
          description: `Verified by the ${context.community ?? 'community'} moderators on SpeedrunLedger.`,
        },
      },
      langs: ['en'],
      createdAt: new Date().toISOString(),
    })
  }

  private async save(
    id: number,
    community: string,
    gameUri: string,
    fields: { post_uri: string | null; post_cid: string | null; error: string | null; posted_at: Date | null },
  ) {
    await this.service.db
      .insertInto('announcement')
      .values({ world_record_id: id, community_did: community, game_uri: gameUri, ...fields })
      .onConflict((oc) => oc.column('world_record_id').doUpdateSet(fields))
      .execute()
  }
}
