import { ids } from '@speedrunledger/lexicon'
import { createAccount, type DevEnv, now, putRecord, type TestAccount, type WrittenRecord } from './index.js'

export interface TestCommunity {
  account: TestAccount
  profile: WrittenRecord
  game: WrittenRecord
  categories: { sixteenStar: WrittenRecord; seventyStar: WrittenRecord }
  moderators: { account: TestAccount; grant: WrittenRecord; accept: WrittenRecord }[]
}

/**
 * Sets up a Super Mario 64 community by hand, the way a sysadmin would before
 * the admin CLI exists: the community account with its profile, game and two
 * categories, and moderators who have accepted their membership.
 */
export async function setupCommunity(env: DevEnv, opts: { moderators?: number } = {}): Promise<TestCommunity> {
  const account = await createAccount(env, 'sm64')
  const profile = await putRecord(account, ids.communityProfile, { name: 'Super Mario 64', createdAt: now() }, { rkey: 'self' })
  const game = await putRecord(account, ids.game, {
    title: 'Super Mario 64',
    releaseYear: 1996,
    platforms: ['N64', 'Wii VC', 'Wii U VC'],
    createdAt: now(),
  })
  const category = (name: string) =>
    putRecord(account, ids.category, {
      game,
      name,
      kind: 'time',
      sort: 'asc',
      primaryTiming: 'realTime',
      variables: [{ id: 'platform', name: 'Platform', values: ['N64', 'VC', 'EMU'], subcategory: false }],
      createdAt: now(),
    })
  const sixteenStar = await category('16 Star')
  const seventyStar = await category('70 Star')

  const moderators: TestCommunity['moderators'] = []
  for (let i = 0; i < (opts.moderators ?? 1); i++) {
    const mod = await createAccount(env, 'mod')
    const grant = await putRecord(account, ids.communityMember, { subject: mod.did, createdAt: now() })
    const accept = await putRecord(mod, ids.communityMemberAccept, { member: grant, createdAt: now() })
    moderators.push({ account: mod, grant, accept })
  }
  return { account, profile, game, categories: { sixteenStar, seventyStar }, moderators }
}

/** A valid run record for a category, with overrides. */
export const runRecord = (category: WrittenRecord, overrides: Record<string, unknown> = {}) => ({
  category,
  times: { realTimeMs: 15 * 60_000 + 2_340 },
  videos: [{ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }],
  variables: [{ variable: 'platform', value: 'N64' }],
  performedAt: now(),
  createdAt: now(),
  ...overrides,
})
