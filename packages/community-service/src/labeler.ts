import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { Secp256k1Keypair } from '@atproto/crypto'
import { encode } from '@atproto/lex-cbor'
import { WebSocketServer } from 'ws'
import { type CommunityService, fail } from './service.js'

export const SUSPECTED_CHEATING = 'suspected-cheating'

/** A label as atproto signs and serves it (com.atproto.label.defs#label). */
export interface SignedLabel {
  ver: 1
  src: string
  uri: string
  cid?: string
  val: string
  neg?: boolean
  cts: string
  sig: Uint8Array
}

type LabelRow = { seq: number; src: string; uri: string; cid: string | null; val: string; neg: boolean; cts: string; sig: Uint8Array }

const toLabel = (row: LabelRow): SignedLabel => ({
  ver: 1,
  src: row.src,
  uri: row.uri,
  ...(row.cid ? { cid: row.cid } : {}),
  val: row.val,
  ...(row.neg ? { neg: true } : {}),
  cts: row.cts,
  sig: new Uint8Array(row.sig),
})

/** The label without its signature, encoded as DAG-CBOR: the bytes that get signed. */
export const unsignedBytes = (label: Omit<SignedLabel, 'sig'> & { sig?: unknown }): Uint8Array => {
  const { sig: _sig, ...rest } = label
  return encode(rest as never)
}

/**
 * An atproto labeler run by the community service. Moderators flag runs as
 * suspected cheating; the service signs each label with its labeler key and
 * serves them over com.atproto.label.queryLabels and subscribeLabels, so
 * Bluesky clients that subscribe to it can show the warning. A label is not
 * a verdict and does not change any board.
 */
export class Labeler {
  private wss?: WebSocketServer
  private sockets = new Set<{ send: (data: Uint8Array) => void; seq: number }>()
  private poll?: NodeJS.Timeout

  private constructor(
    private readonly service: CommunityService,
    private readonly keypair: Secp256k1Keypair,
  ) {}

  static async create(service: CommunityService, signingKeyHex: string): Promise<Labeler> {
    return new Labeler(service, await Secp256k1Keypair.import(signingKeyHex))
  }

  get did(): string {
    return this.service.config.serviceDid
  }

  /** The key's did:key, whose multibase part goes in the DID document as #atproto_label. */
  get didKey(): string {
    return this.keypair.did()
  }

  async flagRun(moderatorDid: string, input: { run: string; flag: boolean; reason?: string }): Promise<{ seq: number }> {
    const { db } = this.service
    const run = await db.selectFrom('run').select(['uri', 'cid', 'community_did', 'runner_did', 'co_runners']).where('uri', '=', input.run).executeTakeFirst()
    if (!run) throw fail(404, 'RunNotFound', 'The run is not in the index')
    await this.service.requireModerator(moderatorDid, run.community_did)
    if (run.runner_did === moderatorDid || run.co_runners.includes(moderatorDid)) throw fail(403, 'OwnRun', 'You cannot flag a run you ran in')
    const current = await db
      .selectFrom('label')
      .select('neg')
      .where('uri', '=', run.uri)
      .where('src', '=', this.did)
      .where('val', '=', SUSPECTED_CHEATING)
      .orderBy('seq', 'desc')
      .executeTakeFirst()
    const flagged = current ? !current.neg : false
    if (flagged === input.flag) throw fail(409, 'NoChange', input.flag ? 'The run is already flagged' : 'The run is not flagged')
    const unsigned = { ver: 1 as const, src: this.did, uri: run.uri, val: SUSPECTED_CHEATING, ...(input.flag ? {} : { neg: true }), cts: new Date().toISOString() }
    const sig = await this.keypair.sign(unsignedBytes(unsigned))
    const row = await db
      .insertInto('label')
      .values({
        src: unsigned.src,
        uri: unsigned.uri,
        cid: null,
        val: unsigned.val,
        neg: !input.flag,
        cts: unsigned.cts,
        sig,
        community_did: run.community_did,
        moderator_did: moderatorDid,
        reason: input.reason?.trim() || null,
      })
      .returning('seq')
      .executeTakeFirstOrThrow()
    this.service.logger.info({ run: run.uri, flag: input.flag, moderator: moderatorDid }, 'run labeled')
    void this.push()
    return { seq: row.seq }
  }

  /** com.atproto.label.queryLabels: labels on URIs matching the patterns (a trailing * matches a prefix). */
  async queryLabels(params: URLSearchParams): Promise<Response> {
    const patterns = params.getAll('uriPatterns')
    if (patterns.length === 0) return Response.json({ error: 'InvalidRequest', message: 'uriPatterns is required' }, { status: 400 })
    const sources = params.getAll('sources')
    if (sources.length > 0 && !sources.includes(this.did)) return Response.json({ labels: [] })
    const limit = Math.min(Math.max(Number(params.get('limit') ?? 50) || 50, 1), 250)
    const after = Number(params.get('cursor') ?? 0) || 0
    const rows = await this.service.db
      .selectFrom('label')
      .select(['seq', 'src', 'uri', 'cid', 'val', 'neg', 'cts', 'sig'])
      .where('seq', '>', after)
      .where(({ or, eb }) =>
        or(patterns.map((p) => (p.endsWith('*') ? eb('uri', 'like', `${p.slice(0, -1).replace(/[\\%_]/g, '\\$&')}%`) : eb('uri', '=', p)))),
      )
      .orderBy('seq')
      .limit(limit)
      .execute()
    return Response.json({
      cursor: rows.length ? String(rows.at(-1)!.seq) : undefined,
      labels: rows.map((r) => {
        const label = toLabel(r)
        return { ...label, sig: { $bytes: Buffer.from(label.sig).toString('base64').replace(/=+$/, '') } }
      }),
    })
  }

  /** Serves com.atproto.label.subscribeLabels on the HTTP server's upgrade requests. */
  attach(server: Server): void {
    this.wss = new WebSocketServer({ noServer: true })
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname !== '/xrpc/com.atproto.label.subscribeLabels') return socket.destroy()
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        const sub = { send: (data: Uint8Array) => ws.send(data), seq: Number(url.searchParams.get('cursor') ?? 0) || 0 }
        this.sockets.add(sub)
        ws.on('close', () => this.sockets.delete(sub))
        void this.push()
      })
    })
    // Labels written by another instance reach subscribers too.
    this.poll = setInterval(() => void this.push(), 1000)
  }

  private pushing?: Promise<void>

  /** Sends each subscriber the labels after its cursor, one #labels frame per label. */
  private push(): Promise<void> {
    this.pushing ??= (async () => {
      if (this.sockets.size === 0) return
      const from = Math.min(...[...this.sockets].map((s) => s.seq))
      const rows = await this.service.db
        .selectFrom('label')
        .select(['seq', 'src', 'uri', 'cid', 'val', 'neg', 'cts', 'sig'])
        .where('seq', '>', from)
        .orderBy('seq')
        .limit(500)
        .execute()
      for (const row of rows) {
        const header = encode({ op: 1, t: '#labels' })
        const body = encode({ seq: row.seq, labels: [toLabel(row)] } as never)
        const frame = Buffer.concat([header, body])
        for (const sub of this.sockets) {
          if (sub.seq >= row.seq) continue
          sub.send(frame)
          sub.seq = row.seq
        }
      }
    })()
      .catch((err) => this.service.logger.error({ err }, 'label push failed'))
      .finally(() => (this.pushing = undefined))
    return this.pushing
  }

  async close(): Promise<void> {
    clearInterval(this.poll)
    for (const client of this.wss?.clients ?? []) client.terminate()
    await new Promise((resolve) => (this.wss ? this.wss.close(resolve) : resolve(undefined)))
  }
}
