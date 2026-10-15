import { defineConfig, mergeConfig } from 'vitest/config'
import shared from '../../vitest.shared.js'

// Tests run an indexer against the shared local PDS; one file at a time.
export default mergeConfig(shared, defineConfig({ test: { fileParallelism: false } }))
