import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AtpAgent } from '@atproto/api'
import pg from 'pg'

/**
 * Helpers for integration tests. Tests run against the real local stack
 * started by `pnpm infra:up` (Postgres, PLC directory and PDS under Podman);
 * nothing is mocked.
 */

export interface DevEnv {
  databaseUrl: string
  pdsUrl: string
  plcUrl: string
}

/** Reads the stack's URLs from the environment, falling back to the file dev-up.mjs writes. */
export function loadDevEnv(): DevEnv {
  const file = join(
    process.env.LEDGER_DEV_DIR ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'speedrunledger'),
    'dev.env',
  )
  const fromFile: Record<string, string> = {}
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const eq = line.indexOf('=')
      if (eq > 0) fromFile[line.slice(0, eq)] = line.slice(eq + 1)
    }
  }
  const get = (key: string) => process.env[key] ?? fromFile[key]
  const databaseUrl = get('DATABASE_URL')
  if (!databaseUrl) {
    throw new Error(`DATABASE_URL is not set and ${file} does not exist; run \`pnpm infra:up\` first`)
  }
  return {
    databaseUrl,
    pdsUrl: get('PDS_URL') ?? 'http://localhost:2583',
    plcUrl: get('PLC_URL') ?? 'http://localhost:2582',
  }
}

export async function assertStackUp(env: DevEnv): Promise<void> {
  for (const [name, url] of [
    ['PDS', `${env.pdsUrl}/xrpc/_health`],
    ['PLC', `${env.plcUrl}/_health`],
  ] as const) {
    const ok = await fetch(url).then((r) => r.ok, () => false)
    if (!ok) throw new Error(`${name} is not reachable at ${url}; run \`pnpm infra:up\` first`)
  }
}

export const randomId = (bytes = 5): string => randomBytes(bytes).toString('hex')

/** Creates an empty database for one test file and returns its URL; drop it with the returned function. */
export async function createTestDatabase(env: DevEnv): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `test_${randomId(6)}`
  const admin = new pg.Client({ connectionString: env.databaseUrl })
  await admin.connect()
  await admin.query(`CREATE DATABASE ${name}`)
  await admin.end()
  const url = new URL(env.databaseUrl)
  url.pathname = `/${name}`
  return {
    url: url.toString(),
    drop: async () => {
      const client = new pg.Client({ connectionString: env.databaseUrl })
      await client.connect()
      await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      await client.end()
    },
  }
}

export interface TestAccount {
  did: string
  handle: string
  password: string
  agent: AtpAgent
}

/** Creates an account on the local PDS with a unique `.test` handle. */
export async function createAccount(env: DevEnv, prefix = 'u'): Promise<TestAccount> {
  const handle = `${prefix}${randomId(4)}.test`
  const password = `pw-${randomId(8)}`
  const agent = new AtpAgent({ service: env.pdsUrl })
  await agent.createAccount({ handle, password, email: `${handle}@example.com` })
  return { did: agent.session!.did, handle, password, agent }
}

export interface WrittenRecord {
  uri: string
  cid: string
}

/** Writes a record to the account's own repo. `validate: false` skips the PDS's own lexicon check. */
export async function putRecord(
  account: TestAccount,
  collection: string,
  record: Record<string, unknown>,
  opts: { rkey?: string; validate?: boolean } = {},
): Promise<WrittenRecord> {
  const body = { $type: collection, ...record }
  const repo = account.did
  const res = opts.rkey
    ? await account.agent.com.atproto.repo.putRecord({ repo, collection, rkey: opts.rkey, record: body, validate: opts.validate })
    : await account.agent.com.atproto.repo.createRecord({ repo, collection, record: body, validate: opts.validate })
  return { uri: res.data.uri, cid: res.data.cid }
}

export async function deleteRecord(account: TestAccount, uri: string): Promise<void> {
  const parts = uri.replace('at://', '').split('/')
  await account.agent.com.atproto.repo.deleteRecord({ repo: parts[0], collection: parts[1], rkey: parts[2] })
}

/** Polls until `check` returns a value other than undefined, or fails after the timeout. */
export async function waitFor<T>(
  check: () => Promise<T | undefined>,
  opts: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000)
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value !== undefined) return value
    } catch (err) {
      last = err
    }
    await new Promise((resolve) => setTimeout(resolve, opts.intervalMs ?? 100))
  }
  throw new Error(`timed out waiting for ${opts.message ?? 'condition'}`, { cause: last })
}

export const now = (): string => new Date().toISOString()
export * from './community.js'
