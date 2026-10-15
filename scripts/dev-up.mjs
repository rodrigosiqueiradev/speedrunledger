// Starts the local stack (Postgres, indexer, PLC directory, PDS, AppView,
// community service, the three web apps) with podman kube play.
//
// First run generates random dev secrets into dev.env in LEDGER_DEV_DIR
// (default ~/.local/share/speedrunledger) and stores them as the `ledger-dev`
// podman secret. Delete that file and run `pnpm infra:down --volumes` to start over.
// Pass --build to rebuild our own services' images after code changes, and --deps to
// start only the PDS, PLC directory and Postgres (all the tests need).
import { randomBytes } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { devDir, envFile, readEnvFile, run } from './lib.mjs'
import { buildImage, images } from './podman-build.mjs'

const hex = (bytes) => randomBytes(bytes).toString('hex')

mkdirSync(devDir, { recursive: true })
try { chmodSync(devDir, 0o700) } catch {}

if (!existsSync(envFile)) {
  const pg = hex(16)
  writeFileSync(envFile, [
    `POSTGRES_PASSWORD=${pg}`,
    `PDS_JWT_SECRET=${hex(32)}`,
    `PDS_ADMIN_PASSWORD=${hex(16)}`,
    `PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX=${hex(32)}`,
    `DATABASE_URL=postgres://ledger:${pg}@localhost:5433/ledger`,
    'PDS_URL=http://localhost:2583',
    'PLC_URL=http://localhost:2582',
    '',
  ].join('\n'), { mode: 0o600 })
  console.log(`generated dev secrets in ${envFile}`)
}
// Secrets added after a dev.env was first generated.
let env = readEnvFile()
for (const key of ['COOKIE_SECRET', 'COMMUNITY_SECRET_KEY', 'COMMUNITY_ADMIN_TOKEN', 'LABELER_SIGNING_KEY']) {
  if (!(key in env)) appendFileSync(envFile, `${key}=${hex(32)}\n`)
}
if (!('COMMUNITY_SERVICE_URL' in env)) appendFileSync(envFile, 'COMMUNITY_SERVICE_URL=http://localhost:2586\n')
env = readEnvFile()

const b64 = (s) => Buffer.from(s).toString('base64')
const secret = {
  postgresPassword: env.POSTGRES_PASSWORD,
  databaseUrl: env.DATABASE_URL,
  plcDatabaseUrl: env.DATABASE_URL,
  pdsJwtSecret: env.PDS_JWT_SECRET,
  pdsAdminPassword: env.PDS_ADMIN_PASSWORD,
  pdsRotationKeyHex: env.PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX,
  cookieSecret: env.COOKIE_SECRET,
  communitySecretKey: env.COMMUNITY_SECRET_KEY,
  communityAdminToken: env.COMMUNITY_ADMIN_TOKEN,
  labelerSigningKey: env.LABELER_SIGNING_KEY,
}
const secretYaml = [
  'apiVersion: v1',
  'kind: Secret',
  'metadata:',
  '  name: ledger-dev',
  'data:',
  ...Object.entries(secret).map(([k, v]) => `  ${k}: ${b64(v)}`),
  '',
].join('\n')
run('podman', ['secret', 'rm', 'ledger-dev'], { allowFailure: true, quiet: true })
const tmp = mkdtempSync(join(tmpdir(), 'ledger-'))
try {
  const file = join(tmp, 'secret.yaml')
  writeFileSync(file, secretYaml, { mode: 0o600 })
  run('podman', ['kube', 'play', file], { stdio: ['ignore', 'ignore', 'inherit'] })
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

// Images are built once; --build rebuilds our own services after code changes.
const depsOnly = process.argv.includes('--deps')
const rebuild = process.argv.includes('--build')
for (const image of depsOnly ? ['plc', 'pds'] : images) {
  const own = image !== 'plc' && image !== 'pds'
  const exists = run('podman', ['image', 'exists', `localhost/speedrunledger/${image}:dev`], { allowFailure: true, quiet: true }) === 0
  if (!exists || (rebuild && own)) buildImage(image)
}

run('podman', ['kube', 'play', '--replace', 'infra/deps.yaml'])
if (!depsOnly) run('podman', ['kube', 'play', '--replace', 'infra/dev.yaml'])

async function waitFor(name, url) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (res.ok) { console.log(`${name} is up`); return }
    } catch {}
    await sleep(1000)
  }
  console.error(`${name} did not come up; see: podman pod logs`)
  process.exit(1)
}
async function waitForPostgres() {
  for (let i = 0; i < 60; i++) {
    const open = await new Promise((resolve) => {
      const socket = connect(5433, 'localhost', () => { socket.end(); resolve(true) })
      socket.on('error', () => resolve(false))
    })
    if (open) { console.log('postgres is up'); return }
    await sleep(1000)
  }
  console.error('postgres did not come up; see: podman pod logs ledger-data')
  process.exit(1)
}
await waitForPostgres()
await waitFor('plc', 'http://localhost:2582/_health')
await waitFor('pds', 'http://localhost:2583/xrpc/_health')
if (depsOnly) {
  console.log(`PDS, PLC directory and Postgres are up; env for tools and tests: ${envFile}`)
  process.exit(0)
}
await waitFor('appview', 'http://localhost:2584/xrpc/app.speedrunledger-prototype.listCommunities')
await waitFor('community-service', 'http://localhost:2586/_health')
await waitFor('runner-web', 'http://127.0.0.1:2585/')
await waitFor('moderator-web', 'http://127.0.0.1:2587/')
await waitFor('admin-web', 'http://127.0.0.1:2589/')
console.log('Runner app:    http://127.0.0.1:2585')
console.log('Moderator app: http://127.0.0.1:2587')
console.log('Admin app:     http://127.0.0.1:2589')
console.log('(open the apps at 127.0.0.1, not localhost, for OAuth)')
console.log(`env for tools and tests: ${envFile}`)
