import { defineConfig, mergeConfig } from 'vitest/config'
import shared from '../../vitest.shared.js'

// Every indexer under test follows the same PDS, so run files one at a time
// to keep event processing (and timing) predictable.
export default mergeConfig(shared, defineConfig({ test: { fileParallelism: false } }))
