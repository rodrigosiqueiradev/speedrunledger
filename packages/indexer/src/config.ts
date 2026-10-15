export interface IndexerConfig {
  /** Postgres connection string. */
  databaseUrl: string
  /** WebSocket base URL of the repo event stream (a PDS or a relay). */
  firehoseUrl: string
  /** HTTP base URLs of the services to backfill from (each must serve com.atproto.sync.listRepos). */
  backfillSources: string[]
  /** PLC directory used to resolve did:plc identities. */
  plcUrl: string
  /** Backfill even when a cursor is already stored. */
  forceBackfill: boolean
  /** Never backfill; only follow new events (useful in tests). */
  skipBackfill: boolean
  /**
   * Local development: identity lookups may use plain http and localhost,
   * which the default SSRF-protected fetch refuses. Defaults to on when the
   * PLC directory itself is plain http.
   */
  devMode: boolean
  logLevel: string
}

const required = (env: NodeJS.ProcessEnv, key: string): string => {
  const value = env[key]
  if (!value) throw new Error(`${key} is required`)
  return value
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): IndexerConfig {
  const pdsUrl = env.PDS_URL
  const firehoseUrl = env.FIREHOSE_URL ?? (pdsUrl ? pdsUrl.replace(/^http/, 'ws') : undefined)
  if (!firehoseUrl) throw new Error('FIREHOSE_URL or PDS_URL is required')
  const backfill = env.BACKFILL_SOURCES ?? pdsUrl ?? ''
  const plcUrl = env.PLC_URL ?? 'https://plc.directory'
  return {
    databaseUrl: required(env, 'DATABASE_URL'),
    firehoseUrl,
    backfillSources: backfill.split(',').map((s) => s.trim()).filter(Boolean),
    plcUrl,
    forceBackfill: env.FORCE_BACKFILL === 'true',
    skipBackfill: env.SKIP_BACKFILL === 'true',
    devMode: env.DEV_MODE ? env.DEV_MODE === 'true' : plcUrl.startsWith('http://'),
    logLevel: env.LOG_LEVEL ?? 'info',
  }
}
