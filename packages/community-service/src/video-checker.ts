import type { CommunityService } from './service.js'

export type VideoStatus = 'ok' | 'dead' | 'unknown'
export interface VideoResult {
  status: VideoStatus
  httpStatus?: number
  detail?: string
}

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'])
const TIMEOUT_MS = 10_000

/**
 * Whether a video link still works. YouTube answers its oEmbed endpoint
 * with an error for deleted or private videos (its watch pages always say
 * 200); other hosts are asked with HEAD, then GET when HEAD is refused.
 * Only "not found" and "gone" count as dead; anything else we cannot tell.
 */
export async function checkVideo(url: string, fetcher: typeof fetch = fetch): Promise<VideoResult> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { status: 'unknown', detail: 'Not a valid link' }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { status: 'unknown', detail: 'Not a web link' }
  const ask = (target: string, method: string) =>
    fetcher(target, { method, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': 'SpeedrunLedger video check' } })
  try {
    if (YOUTUBE_HOSTS.has(parsed.hostname)) {
      const res = await ask(`https://www.youtube.com/oembed?${new URLSearchParams({ url, format: 'json' })}`, 'GET')
      if (res.ok) return { status: 'ok', httpStatus: res.status }
      if ([400, 401, 403, 404].includes(res.status)) return { status: 'dead', httpStatus: res.status, detail: 'YouTube says the video is gone or private' }
      return { status: 'unknown', httpStatus: res.status }
    }
    let res = await ask(url, 'HEAD')
    if (res.status === 405 || res.status === 501 || res.status === 403) res = await ask(url, 'GET')
    await res.body?.cancel().catch(() => undefined)
    if (res.ok) return { status: 'ok', httpStatus: res.status }
    if (res.status === 404 || res.status === 410) return { status: 'dead', httpStatus: res.status, detail: res.status === 410 ? 'Gone' : 'Not found' }
    return { status: 'unknown', httpStatus: res.status }
  } catch (err) {
    return { status: 'unknown', detail: `Could not reach it: ${(err as Error).message}` }
  }
}

/**
 * Checks the video links of every ranked run in the communities this service
 * manages, each at most once per `recheckAfterMs`, so dead links (an expired
 * Twitch VOD, a deleted upload) show up for moderators and runners before
 * anyone has to stumble on them.
 */
export class VideoChecker {
  private timer?: NodeJS.Timeout
  private running?: Promise<{ checked: number; dead: number }>

  constructor(
    private readonly service: CommunityService,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  start(intervalMs: number): void {
    const tick = async () => {
      try {
        await this.runOnce({ recheckAfterMs: intervalMs })
      } catch (err) {
        this.service.logger.error({ err }, 'video check failed')
      }
      this.timer = setTimeout(tick, Math.min(intervalMs, 60 * 60 * 1000))
    }
    this.timer = setTimeout(tick, 5000)
  }

  async stop(): Promise<void> {
    clearTimeout(this.timer)
    this.timer = undefined
    await this.running
  }

  /** Checks links not checked within `recheckAfterMs` (0: all); returns how many it checked and found dead. */
  runOnce(opts: { recheckAfterMs?: number } = {}): Promise<{ checked: number; dead: number }> {
    this.running ??= this.check(opts.recheckAfterMs ?? 0).finally(() => (this.running = undefined))
    return this.running
  }

  private async check(recheckAfterMs: number): Promise<{ checked: number; dead: number }> {
    const { db, logger } = this.service
    const runs = await db
      .selectFrom('board_entry as b')
      .innerJoin('run as r', 'r.uri', 'b.run_uri')
      .innerJoin('community_credential as cc', 'cc.did', 'r.community_did')
      .select(['r.uri', 'r.videos', 'r.community_did'])
      .where('cc.kind', '=', 'community')
      .distinct()
      .execute()
    const cutoff = new Date(Date.now() - recheckAfterMs)
    let checked = 0
    let dead = 0
    for (const run of runs) {
      const urls = (run.videos as { url: string }[]).map((v) => v.url)
      // Links the runner has since replaced no longer matter.
      await db.deleteFrom('video_check').where('run_uri', '=', run.uri).where('url', 'not in', urls.length ? urls : ['']).execute()
      const recent = new Set(
        (
          await db
            .selectFrom('video_check')
            .select('url')
            .where('run_uri', '=', run.uri)
            .where('checked_at', '>', cutoff)
            .execute()
        ).map((r) => r.url),
      )
      for (const url of urls) {
        if (recheckAfterMs > 0 && recent.has(url)) continue
        const result = await checkVideo(url, this.fetcher)
        const row = {
          status: result.status,
          http_status: result.httpStatus ?? null,
          detail: result.detail ?? null,
          checked_at: new Date(),
        }
        await db
          .insertInto('video_check')
          .values({ run_uri: run.uri, url, community_did: run.community_did, ...row })
          .onConflict((oc) => oc.columns(['run_uri', 'url']).doUpdateSet(row))
          .execute()
        if (result.status === 'dead') dead++
        if (result.status === 'dead') logger.info({ run: run.uri, url, status: result.httpStatus }, 'dead video link')
        checked++
      }
    }
    return { checked, dead }
  }
}
