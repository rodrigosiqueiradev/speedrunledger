// Helpers shared by the dev scripts. Plain Node so they run the same from
// bash, WSL and Windows PowerShell.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Where dev-up writes dev.env; the testkit reads the same place. */
export const devDir =
  process.env.LEDGER_DEV_DIR ??
  join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'speedrunledger')
export const envFile = join(devDir, 'dev.env')

/** Parses dev.env (KEY=value lines) into an object; empty when it doesn't exist yet. */
export function readEnvFile(file = envFile) {
  if (!existsSync(file)) return {}
  const env = {}
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (m) env[m[1]] = m[2]
  }
  return env
}

/** Runs a command with inherited stdio; exits with its status if it fails, unless allowFailure. */
export function run(cmd, args, { allowFailure = false, quiet = false, ...opts } = {}) {
  const res = spawnSync(cmd, args, { stdio: quiet ? 'ignore' : 'inherit', cwd: root, ...opts })
  if (res.error) {
    if (res.error.code === 'ENOENT') {
      console.error(`${cmd} not found; is it installed and on your PATH?`)
      process.exit(1)
    }
    throw res.error
  }
  if (res.status !== 0 && !allowFailure) process.exit(res.status ?? 1)
  return res.status
}

/** Runs one of the admin CLI's TypeScript entry points with the dev.env values in its environment. */
export function runAdminCli(entry) {
  const env = { ...readEnvFile(), ...process.env }
  env.APPVIEW_URL ??= 'http://localhost:2584'
  const tsx = pathToFileURL(join(root, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href
  // pnpm runs scripts from the repo root; keep relative paths (like --out) relative to where you ran it.
  const status = run(
    process.execPath,
    ['--conditions=@speedrunledger/source', '--import', tsx, join(root, 'packages', 'admin-cli', 'src', entry), ...process.argv.slice(2)],
    { cwd: process.env.INIT_CWD ?? process.cwd(), env, allowFailure: true },
  )
  process.exit(status ?? 1)
}
