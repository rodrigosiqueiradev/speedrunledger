import { describe, expect, it } from 'vitest'
import { collections, ids, isLedgerCollection, parseRecord } from '../src/index.js'

const ref = {
  uri: 'at://did:plc:ewvi7nxzyoun6zhxrhs64oiz/app.speedrunledger-prototype.category/3mxuphnycbc2s',
  cid: 'bafyreiare7g2v577v2oinwbgwiyodyoxibfoeomme545vdcor6q66jf5wu',
}
const createdAt = '2026-10-14T12:00:00.000Z'

describe('lexicons', () => {
  it('defines the fourteen record types from the design', () => {
    expect(collections).toHaveLength(14)
    for (const nsid of collections) expect(nsid.startsWith('app.speedrunledger-prototype.')).toBe(true)
    expect(isLedgerCollection('app.bsky.feed.post')).toBe(false)
  })

  it('accepts a well-formed run', () => {
    const result = parseRecord(ids.run, {
      $type: ids.run,
      category: ref,
      times: { realTimeMs: 902_340 },
      videos: [{ url: 'https://www.youtube.com/watch?v=abc' }],
      performedAt: createdAt,
      createdAt,
    })
    expect(result.success).toBe(true)
  })

  it('rejects a run without a video or with a fractional time', () => {
    const base = { $type: ids.run, category: ref, performedAt: createdAt, createdAt }
    expect(parseRecord(ids.run, { ...base, times: { realTimeMs: 1 }, videos: [] }).success).toBe(false)
    expect(
      parseRecord(ids.run, { ...base, times: { realTimeMs: 1.5 }, videos: [{ url: 'https://x.test/v' }] }).success,
    ).toBe(false)
  })

  it('applies category defaults: video required, one approval', () => {
    const result = parseRecord(ids.category, {
      $type: ids.category,
      game: ref,
      name: '16 Star',
      kind: 'time',
      sort: 'asc',
      primaryTiming: 'realTime',
      createdAt,
    })
    expect(result.success && result.value.requiresVideo).toBe(true)
    expect(result.success && result.value.requiredApprovals).toBe(1)
  })

  it('accepts each proposal action', () => {
    const actions = [
      { $type: `${ids.communityProposal}#invite`, subject: 'did:plc:ewvi7nxzyoun6zhxrhs64oiz' },
      { $type: `${ids.communityProposal}#kick`, subject: 'did:plc:ewvi7nxzyoun6zhxrhs64oiz' },
      { $type: `${ids.communityProposal}#putRecord`, collection: ids.ruleset, record: { text: 'Timing starts on file select.' } },
      { $type: `${ids.communityProposal}#liftBan`, ban: ref },
      { $type: `${ids.communityProposal}#migrate`, pdsEndpoint: 'https://pds.example.com' },
    ]
    for (const action of actions) {
      const result = parseRecord(ids.communityProposal, {
        $type: ids.communityProposal,
        community: 'did:plc:ewvi7nxzyoun6zhxrhs64oiz',
        action,
        reason: 'because',
        expiresAt: createdAt,
        createdAt,
      })
      expect(result.success, JSON.stringify(action)).toBe(true)
    }
  })

  it('rejects a verdict with no reviewer', () => {
    const result = parseRecord(ids.verification, {
      $type: ids.verification,
      subject: ref,
      status: 'verified',
      createdAt,
    })
    expect(result.success).toBe(false)
  })
})
