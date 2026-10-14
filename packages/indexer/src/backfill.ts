import type { IdResolver } from '@atproto/identity'
import { getAndParseRecord, readCarWithRoot, verifyRepo } from '@atproto/repo'
import { isLedgerCollection } from '@speedrunledger/lexicon'
import type { Indexer } from './indexing.js'

const fetchJson = async <T>(url: URL): Promise<T> => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} returned ${res.status}: ${await res.text()}`)
  return (await res.json()) as T
}

/** Lists every repo a service hosts (com.atproto.sync.listRepos). */
export async function* listRepos(service: string): AsyncGenerator<{ did: string; active?: boolean }> {
  let cursor: string | undefined
  do {
    const url = new URL('/xrpc/com.atproto.sync.listRepos', service)
    url.searchParams.set('limit', '1000')
    if (cursor) url.searchParams.set('cursor', cursor)
    const page = await fetchJson<{ cursor?: string; repos: { did: string; active?: boolean }[] }>(url)
    yield* page.repos
    cursor = page.repos.length > 0 ? page.cursor : undefined
  } while (cursor)
}

export type RepoSyncResult = { status: 'synced'; rev: string; indexed: number; deleted: number } | { status: 'skipped'; reason: string }

/**
 * Downloads a whole repo, verifies its commit signature against the DID's
 * signing key, and makes the index match it exactly: every ledger record in
 * the repo is indexed and indexed records missing from it are deleted.
 *
 * Callers must serialize this with live events for the same DID.
 */
export async function syncRepo(indexer: Indexer, idResolver: IdResolver, did: string): Promise<RepoSyncResult> {
  const identity = await idResolver.did.resolveAtprotoData(did, true)
  await indexer.ensureActor(did, { handle: identity.handle, pdsEndpoint: identity.pds })

  const url = new URL('/xrpc/com.atproto.sync.getRepo', identity.pds)
  url.searchParams.set('did', did)
  const res = await fetch(url)
  if (!res.ok) return { status: 'skipped', reason: `getRepo returned ${res.status}` }
  const car = await readCarWithRoot(new Uint8Array(await res.arrayBuffer()))
  const verified = await verifyRepo(car.blocks, car.root, did, identity.signingKey)
  const rev = verified.commit.rev

  const known = await indexer.getRepoRev(did)
  if (known !== null && known >= rev) return { status: 'skipped', reason: `index already at ${known}` }

  const seen = new Set<string>()
  let indexed = 0
  for (const create of verified.creates) {
    if (!isLedgerCollection(create.collection)) continue
    seen.add(`${create.collection}/${create.rkey}`)
    const { record } = await getAndParseRecord(car.blocks, create.cid)
    const outcome = await indexer.indexRecord({
      did,
      collection: create.collection,
      rkey: create.rkey,
      cid: create.cid.toString(),
      record,
      rev,
    })
    if (outcome === 'indexed') indexed++
  }

  let deleted = 0
  for (const row of await indexer.listRepoRecords(did)) {
    if (seen.has(`${row.collection}/${row.rkey}`)) continue
    if (await indexer.deleteRecord({ did, collection: row.collection, rkey: row.rkey })) deleted++
  }

  await indexer.setRepoRev(did, rev)
  return { status: 'synced', rev, indexed, deleted }
}
