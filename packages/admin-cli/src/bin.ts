#!/usr/bin/env node
import { LedgerAdmin, readEnv, UsageError } from './cli.js'
import { AdminApiError } from './client.js'

try {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    await new LedgerAdmin({ communityServiceUrl: '', adminToken: '', appviewUrl: '', plcUrl: '' }).run(['--help'])
  } else {
    await new LedgerAdmin(readEnv()).run(argv)
  }
} catch (err) {
  console.error(err instanceof UsageError || err instanceof AdminApiError ? `ledger-admin: ${err.message}` : err)
  process.exit(1)
}
