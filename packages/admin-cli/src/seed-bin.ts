#!/usr/bin/env node
import { seedDemo } from './seed.js'

try {
  await seedDemo()
} catch (err) {
  console.error('seed failed:', err)
  process.exit(1)
}
