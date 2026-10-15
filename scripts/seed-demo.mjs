// Seeds the local stack with the demo community, moderators, runners and runs.
// Run after `pnpm infra:up`: pnpm seed
import { runAdminCli } from './lib.mjs'

runAdminCli('seed-bin.ts')
