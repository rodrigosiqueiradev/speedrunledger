import { IdResolver, MemoryCache } from '@atproto/identity'
import { type Event, Firehose, MemoryRunner } from '@atproto/sync'
import { createDb, type Database, migrateToLatest } from '@speedrunledger/db'
import { NSID_PREFIX } from '@speedrunledger/lexicon'
import { pino, type Logger } from 'pino'
import { listRepos, syncRepo } from './backfill.js'
import type { IndexerConfig } from './config.js'
import { Indexer } from './indexing.js'

const RETRY_DELAYS_MS = [100, 500, 1000, 2000, 5000]
const BACKFILL_CONCURRENCY = 8

/** Retries an operation until it succeeds; used for database writes so no event is ever skipped. */
async function withRetry<T>(logger: Logger, what: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]
      logger.warn({ err, attempt, what }, 'indexing failed, retrying')
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

export class IndexerService {
  readonly indexer: Indexer
  readonly idResolver: IdResolver
  private runner?: MemoryRunner
  private firehose?: Firehose
  private firehoseDone?: Promise<void>
  private readonly cursorKey: string

  constructor(
    readonly config: IndexerConfig,
    readonly db: Database,
    readonly logger: Logger,
  ) {
    this.indexer = new Indexer(db, logger)
    this.idResolver = new IdResolver({
      plcUrl: config.plcUrl,
      didCache: new MemoryCache(),
      ...(config.devMode ? { fetch: globalThis.fetch } : {}),
    })
    this.cursorKey = config.firehoseUrl
  }

  static create(config: IndexerConfig, logger?: Logger): IndexerService {
    const log = logger ?? pino({ level: config.logLevel, name: 'indexer' })
    return new IndexerService(config, createDb(config.databaseUrl), log)
  }

  async migrate(): Promise<void> {
    await migrateToLatest(this.db)
  }

  async getCursor(): Promise<number | undefined> {
    const row = await this.db
      .selectFrom('subscription_state')
      .select('cursor')
      .where('service', '=', this.cursorKey)
      .executeTakeFirst()
    return row?.cursor
  }

  private async saveCursor(cursor: number): Promise<void> {
    await this.db
      .insertInto('subscription_state')
      .values({ service: this.cursorKey, cursor, updated_at: new Date() })
      .onConflict((oc) => oc.column('service').doUpdateSet({ cursor, updated_at: new Date() }))
      .execute()
  }

  /**
   * Starts the live stream, then backfills when the index is new (or when
   * forced). The stream starts first so nothing written during backfill is
   * missed; per-DID ordering and repo revisions keep the two from racing.
   */
  async start(): Promise<void> {
    const startCursor = await this.getCursor()
    const runner = new MemoryRunner({
      startCursor,
      setCursor: (cursor) => withRetry(this.logger, 'save cursor', () => this.saveCursor(cursor)),
    })
    this.runner = runner
    this.firehose = new Firehose({
      service: this.config.firehoseUrl,
      idResolver: this.idResolver,
      runner,
      filterCollections: [`${NSID_PREFIX}.*`],
      handleEvent: (evt) => this.handleEvent(evt),
      onError: (err) => this.logger.error({ err }, 'firehose error'),
    })
    this.firehoseDone = this.firehose.start()
    this.logger.info({ service: this.config.firehoseUrl, cursor: startCursor }, 'subscribed to repo events')

    if (!this.config.skipBackfill && (startCursor === undefined || this.config.forceBackfill)) {
      await this.backfill()
    }
  }

  async backfill(): Promise<{ repos: number }> {
    return this.indexer.withDeferredBoards(() => this.backfillRepos())
  }

  private async backfillRepos(): Promise<{ repos: number }> {
    let repos = 0
    for (const source of this.config.backfillSources) {
      this.logger.info({ source }, 'backfill started')
      // Repos are independent; sync several at once (each still ordered with its own live events).
      const inFlight = new Set<Promise<void>>()
      for await (const repo of listRepos(source)) {
        if (repo.active === false) continue
        repos++
        const sync: Promise<void> = this.syncRepo(repo.did).finally(() => inFlight.delete(sync))
        inFlight.add(sync)
        if (inFlight.size >= BACKFILL_CONCURRENCY) await Promise.race(inFlight)
      }
      await Promise.all(inFlight)
      this.logger.info({ source, repos }, 'backfill finished')
    }
    return { repos }
  }

  /** Re-syncs one repo from its PDS, ordered after any live events already queued for it. */
  async syncRepo(did: string): Promise<void> {
    const task = async () => {
      try {
        const result = await syncRepo(this.indexer, this.idResolver, did)
        this.logger.debug({ did, ...result }, 'repo synced')
      } catch (err) {
        this.logger.error({ err, did }, 'repo sync failed')
      }
    }
    if (this.runner) await this.runner.addTask(did, task)
    else await task()
  }

  async handleEvent(evt: Event): Promise<void> {
    const { indexer } = this
    switch (evt.event) {
      case 'create':
      case 'update':
      case 'delete': {
        const known = await withRetry(this.logger, 'read repo rev', () => indexer.getRepoRev(evt.did))
        // Ops of one commit share a rev, so only strictly older revs are stale.
        if (known !== null && evt.rev < known) return
        await withRetry(this.logger, `${evt.event} ${evt.uri}`, async () => {
          if (evt.event === 'delete') {
            await indexer.deleteRecord({ did: evt.did, collection: evt.collection, rkey: evt.rkey })
          } else {
            await indexer.ensureActor(evt.did)
            await indexer.indexRecord({
              did: evt.did,
              collection: evt.collection,
              rkey: evt.rkey,
              cid: evt.cid.toString(),
              record: evt.record,
              rev: evt.rev,
            })
          }
          await indexer.setRepoRev(evt.did, evt.rev)
        })
        return
      }
      case 'identity':
        await withRetry(this.logger, `identity ${evt.did}`, () =>
          indexer.ensureActor(evt.did, { handle: evt.handle ?? null }),
        )
        return
      case 'account':
        await withRetry(this.logger, `account ${evt.did}`, () =>
          indexer.setAccountStatus(evt.did, evt.active, evt.status ?? null),
        )
        return
      case 'sync':
        // The repo was reset or we fell out of step: fetch it whole. We are
        // already inside this DID's partition, so call directly.
        try {
          await syncRepo(indexer, this.idResolver, evt.did)
        } catch (err) {
          this.logger.error({ err, did: evt.did }, 'repo resync failed')
        }
        return
    }
  }

  /** Waits until every event received so far has been processed. */
  async drain(): Promise<void> {
    await this.runner?.processAll()
  }

  async destroy(): Promise<void> {
    await this.firehose?.destroy()
    await this.firehoseDone
    await this.runner?.destroy()
    await this.db.destroy()
  }
}
