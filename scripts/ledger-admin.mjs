// Runs ledger-admin against the local stack, with the admin token and URLs
// from the dev.env that dev-up wrote. Example: pnpm ledger-admin community list
import { runAdminCli } from './lib.mjs'

runAdminCli('bin.ts')
