import { describe, expect, it } from 'vitest'
import { type FreezeIntervals, type ProposalRow, proposalCategory, tallyProposal, type VoteRow } from '../src/governance.js'

const t0 = new Date('2026-10-01T00:00:00Z')
const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000)

const proposal = (overrides: Partial<ProposalRow> = {}): ProposalRow => ({
  uri: 'at://did:plc:alice/app.speedrunledger-prototype.community.proposal/p1',
  cid: 'cid1',
  proposer_did: 'did:plc:alice',
  community_did: 'did:plc:sm64',
  action_type: 'invite',
  action: { subject: 'did:plc:zed' },
  reason: 'helps a lot',
  expires_at: at(60 * 24 * 7).toISOString(),
  created_at: t0.toISOString(),
  indexed_at: t0,
  first_indexed_at: t0,
  electorate: ['did:plc:alice', 'did:plc:bob', 'did:plc:carol'],
  problems: [],
  ...overrides,
})

let n = 0
const vote = (voter: string, value: string, minutes: number, overrides: Partial<VoteRow> = {}): VoteRow => ({
  uri: `at://${voter}/app.speedrunledger-prototype.community.vote/v${n++}`,
  cid: `vcid${n}`,
  voter_did: voter,
  proposal_uri: proposal().uri,
  proposal_cid: 'cid1',
  value,
  reason: null,
  indexed_at: at(minutes),
  ...overrides,
})

describe('proposal tally', () => {
  it('passes once yes votes are more than half the electorate, counting the proposer', () => {
    const open = tallyProposal(proposal(), [], undefined, at(1))
    expect(open).toMatchObject({ status: 'open', yes: 1, no: 0, needed: 2, electorateSize: 3 })
    const passed = tallyProposal(proposal(), [vote('did:plc:bob', 'yes', 5)], undefined, at(10))
    expect(passed).toMatchObject({ status: 'passed', yes: 2, decidedAt: at(5) })
  })

  it('fails as soon as passing is impossible, and stays decided', () => {
    const votes = [vote('did:plc:bob', 'no', 5), vote('did:plc:carol', 'no', 6), vote('did:plc:carol', 'yes', 7)]
    expect(tallyProposal(proposal(), votes, undefined, at(10))).toMatchObject({ status: 'failed', no: 2, decidedAt: at(6) })
  })

  it('lets a lone moderator decide alone', () => {
    expect(tallyProposal(proposal({ electorate: ['did:plc:alice'] }), [], undefined, at(1))).toMatchObject({
      status: 'passed',
      needed: 1,
    })
  })

  it('needs 3 of 4 and 3 of 5', () => {
    const four = proposal({ electorate: ['did:plc:alice', 'did:plc:bob', 'did:plc:carol', 'did:plc:dan'] })
    expect(tallyProposal(four, [vote('did:plc:bob', 'yes', 1)], undefined, at(2)).status).toBe('open')
    expect(tallyProposal(four, [vote('did:plc:bob', 'yes', 1), vote('did:plc:dan', 'yes', 2)], undefined, at(3)).status).toBe('passed')
    const five = proposal({ electorate: ['did:plc:alice', 'did:plc:bob', 'did:plc:carol', 'did:plc:dan', 'did:plc:eve'] })
    expect(tallyProposal(five, [vote('did:plc:bob', 'yes', 1)], undefined, at(2)).needed).toBe(3)
  })

  it('ignores outsiders, other versions, late votes and votes cast while frozen', () => {
    const frozen: FreezeIntervals = [{ from: at(10), to: at(20) }]
    const votes = [
      vote('did:plc:mallory', 'yes', 1),
      vote('did:plc:bob', 'yes', 2, { proposal_cid: 'old' }),
      vote('did:plc:bob', 'yes', 15),
      vote('did:plc:carol', 'yes', 60 * 24 * 8),
    ]
    expect(tallyProposal(proposal(), votes, frozen, at(60 * 24 * 9))).toMatchObject({ status: 'expired', yes: 1 })
  })

  it('caps the deadline at seven days after the proposal was first seen', () => {
    const p = proposal({ expires_at: at(60 * 24 * 30).toISOString() })
    expect(tallyProposal(p, [], undefined, at(60 * 24 * 7 + 1)).status).toBe('expired')
  })

  it('marks proposals with problems invalid', () => {
    expect(tallyProposal(proposal({ problems: ['not_moderator'] }), [], undefined, at(1)).status).toBe('invalid')
  })

  it('finds the category a proposal targets', () => {
    expect(
      proposalCategory({
        action_type: 'putRecord',
        community_did: 'did:plc:sm64',
        action: { collection: 'app.speedrunledger-prototype.category', rkey: 'abc', record: {} },
      }),
    ).toBe('at://did:plc:sm64/app.speedrunledger-prototype.category/abc')
    expect(
      proposalCategory({
        action_type: 'putRecord',
        community_did: 'did:plc:sm64',
        action: { collection: 'app.speedrunledger-prototype.ruleset', record: { category: { uri: 'at://x/c/1' } } },
      }),
    ).toBe('at://x/c/1')
  })
})
