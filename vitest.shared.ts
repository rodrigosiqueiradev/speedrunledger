import { defineConfig } from 'vitest/config'

// Resolve workspace packages to their TypeScript sources, so tests never
// depend on a stale build.
const conditions = ['@speedrunledger/source', 'module', 'node', 'development|production']

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
