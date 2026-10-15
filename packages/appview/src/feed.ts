import type { Database } from '@speedrunledger/db'
import { ids } from '@speedrunledger/lexicon'

/** The collection and record key of a game's world-record feed: the feed shares the game's record key. */
export const FEED_COLLECTION = 'app.bsky.feed.generator'
export const feedUriForGame = (gameUri: string) => {
  const [, , did, , rkey] = gameUri.split('/')
  return `at://${did}/${FEED_COLLECTION}/${rkey}`
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const error = (status: number, name: string, message: string) => json({ error: name, message }, status)

/**
 * A Bluesky feed generator: for each game, the posts its community wrote
 * announcing new world records, newest first. Bluesky's AppView calls
 * getFeedSkeleton and hydrates the posts itself.
 */
export class FeedGenerator {
  constructor(
    private readonly db: Database,
    readonly serviceDid: string,
  ) {}

  /** Handles the feed generator's routes; undefined for anything else. */
  async handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url)
    switch (url.pathname) {
      case '/.well-known/did.json':
        return json({
          '@context': ['https://www.w3.org/ns/did/v1'],
          id: this.serviceDid,
          service: [{ id: '#bsky_fg', type: 'BskyFeedGenerator', serviceEndpoint: url.origin }],
        })
      case '/xrpc/app.bsky.feed.describeFeedGenerator': {
        const games = await this.db.selectFrom('game').select('uri').orderBy('indexed_at').execute()
        return json({ did: this.serviceDid, feeds: games.map((g) => ({ uri: feedUriForGame(g.uri) })) })
      }
      case '/xrpc/app.bsky.feed.getFeedSkeleton':
        return this.skeleton(url.searchParams)
      default:
        return undefined
    }
  }

  private async skeleton(params: URLSearchParams): Promise<Response> {
    const feed = params.get('feed') ?? ''
    const match = /^at:\/\/([^/]+)\/app\.bsky\.feed\.generator\/([^/]+)$/.exec(feed)
    if (!match) return error(400, 'InvalidRequest', 'feed must be an app.bsky.feed.generator URI')
    const gameUri = `at://${match[1]}/${ids.game}/${match[2]}`
    const game = await this.db.selectFrom('game').select('uri').where('uri', '=', gameUri).executeTakeFirst()
    if (!game) return error(400, 'UnknownFeed', 'No such feed')
    const limit = Math.min(Math.max(Number(params.get('limit') ?? 30) || 30, 1), 100)
    let query = this.db
      .selectFrom('announcement')
      .select(['world_record_id', 'post_uri', 'posted_at'])
      .where('game_uri', '=', gameUri)
      .where('post_uri', 'is not', null)
      .where('posted_at', 'is not', null)
      .orderBy('posted_at', 'desc')
      .orderBy('world_record_id', 'desc')
      .limit(limit)
    const cursor = params.get('cursor')
    if (cursor) {
      const [time, id] = cursor.split('::')
      const at = new Date(Number(time))
      query = query.where(({ eb, or, and }) =>
        or([eb('posted_at', '<', at), and([eb('posted_at', '=', at), eb('world_record_id', '<', Number(id))])]),
      )
    }
    const rows = await query.execute()
    const last = rows.at(-1)
    return json({
      feed: rows.map((r) => ({ post: r.post_uri })),
      cursor: rows.length === limit && last ? `${last.posted_at!.getTime()}::${last.world_record_id}` : undefined,
    })
  }
}
