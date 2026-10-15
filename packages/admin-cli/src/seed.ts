import { AtpAgent } from '@atproto/api'
import { LedgerAdmin, readEnv } from './cli.js'

/**
 * Seeds the local stack with a demo: a platform with one sysadmin, a Super
 * Mario 64 community created from a request by its three founding moderators,
 * its 16 Star and 70 Star categories and rules passed by vote, and five
 * runners with verified, pending and sent-back runs. Everything goes through
 * the same paths the apps use: records in people's own repos, ledger-admin,
 * and the community service.
 */

const NS = 'app.speedrunledger-prototype'
export const DEMO_PASSWORD = 'demo-password'
export const DEMO = {
  sysadmin: 'rosalina.test',
  platform: 'ledger.test',
  community: 'sm64.test',
  moderators: ['peach.test', 'luigi.test', 'toad.test'],
  runners: ['bobomb.test', 'koopa.test', 'goomba.test', 'boo.test', 'lakitu.test'],
}

type Ref = { uri: string; cid: string }
type Log = (line: string) => void

class Account {
  constructor(
    readonly agent: AtpAgent,
    readonly handle: string,
  ) {}

  get did() {
    return this.agent.session!.did
  }

  async create(collection: string, record: Record<string, unknown>): Promise<Ref> {
    const { data } = await this.agent.com.atproto.repo.createRecord({
      repo: this.did,
      collection: `${NS}.${collection}`,
      record: { $type: `${NS}.${collection}`, createdAt: new Date().toISOString(), ...record },
    })
    return { uri: data.uri, cid: data.cid }
  }
}

async function account(pdsUrl: string, handle: string): Promise<Account> {
  const agent = new AtpAgent({ service: pdsUrl })
  try {
    await agent.login({ identifier: handle, password: DEMO_PASSWORD })
  } catch {
    await agent.createAccount({ handle, password: DEMO_PASSWORD, email: `${handle}@example.com` })
  }
  return new Account(agent, handle)
}

async function until<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn().catch(() => undefined)
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
}

export async function seedDemo(log: Log = (line) => console.log(line)): Promise<void> {
  const env = readEnv()
  const pdsUrl = env.pdsUrl ?? 'http://localhost:2583'
  const lines: string[] = []
  const admin = new LedgerAdmin({ ...env, pdsUrl }, (line) => lines.push(line))
  const ledger = async (argv: string[]) => {
    lines.length = 0
    await admin.run([...argv, '--json'])
    return JSON.parse(lines.join('\n'))
  }
  const appview = async (method: string, params: Record<string, string>) => {
    const res = await fetch(`${env.appviewUrl}/xrpc/${NS}.${method}?${new URLSearchParams(params)}`)
    if (!res.ok) throw new Error(`${method} returned ${res.status}`)
    return (await res.json()) as any
  }

  const existing = await fetch(`${pdsUrl}/xrpc/com.atproto.identity.resolveHandle?handle=${DEMO.community}`)
  if (existing.ok) {
    log(`${DEMO.community} already exists; the demo is seeded. Run \`pnpm infra:down --volumes\` and \`pnpm infra:up\` to start over.`)
    return
  }

  log('creating accounts')
  const sysadmin = await account(pdsUrl, DEMO.sysadmin)
  const [peach, luigi, toad] = await Promise.all(DEMO.moderators.map((h) => account(pdsUrl, h)))
  const runners = await Promise.all(DEMO.runners.map((h) => account(pdsUrl, h)))

  const sysadmins: string[] = await ledger(['sysadmin', 'list'])
  if (sysadmins.length === 0) {
    log(`creating the platform account ${DEMO.platform}; ${DEMO.sysadmin} is its sysadmin`)
    await ledger(['platform', 'init', '--handle', DEMO.platform, '--sysadmin', sysadmin.did])
  } else if (!sysadmins.includes(sysadmin.did)) {
    throw new Error(`the platform already has other sysadmins; add ${DEMO.sysadmin} first`)
  }

  log('peach.test asks for a Super Mario 64 community')
  const request = await peach.create('community.request', {
    game: { title: 'Super Mario 64', releaseYear: 1996, platforms: ['N64', 'Wii VC', 'Wii U VC'] },
    founders: [peach.did, luigi.did, toad.did],
    note: 'We moderate the SM64 boards on our Discord and want them on the ledger.',
  })
  await until('the request to be indexed', async () => {
    const { requests } = await appview('listCommunityRequests', { status: 'pending' })
    return requests.some((r: any) => r.uri === request.uri) || undefined
  })

  log(`the sysadmin creates ${DEMO.community} from the request`)
  const community = await ledger([
    'community', 'create',
    '--as', sysadmin.did,
    '--request', request.uri,
    '--handle', DEMO.community,
    '--name', 'Super Mario 64',
    '--description', 'Any% boards for Super Mario 64, run by the community’s moderators.',
  ])

  log('the founders accept')
  const founders = [peach, luigi, toad]
  await until('the founders’ grants to be indexed', async () => {
    const { moderators } = await appview('listModerators', { community: community.did })
    return moderators.length === founders.length || undefined
  })
  for (const founder of founders) {
    const { memberships } = await appview('listMemberships', { actor: founder.did })
    const membership = memberships.find((m: any) => m.community.did === community.did)
    await founder.create('community.memberAccept', { member: membership.grant })
  }
  await until('the founders to be active', async () => {
    const { moderators } = await appview('listModerators', { community: community.did })
    return moderators.every((m: any) => m.status === 'active') || undefined
  })

  /** Proposes, has `voters` vote yes, and waits for the community service to carry it out. */
  const pass = async (proposer: Account, action: Record<string, unknown>, reason: string, voters: Account[]) => {
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    const proposal = await proposer.create('community.proposal', { community: community.did, action, reason, expiresAt })
    await until('the proposal to be indexed', () => appview('getProposal', { uri: proposal.uri }))
    for (const voter of voters) await voter.create('community.vote', { proposal, value: 'yes' })
    const view = await until('the proposal to pass and be carried out', async () => {
      const { proposal: p } = await appview('getProposal', { uri: proposal.uri })
      if (p.status === 'invalid' || p.status === 'failed') throw new Error(`proposal ${p.status}: ${p.problems?.join(', ')}`)
      return p.executed ? p : undefined
    })
    return view as { result?: string }
  }

  const { community: detail } = await appview('getCommunity', { community: community.did })
  const game: Ref = { uri: detail.games[0].game.uri, cid: detail.games[0].game.cid }
  const category = (name: string, description: string) => ({
    $type: `${NS}.community.proposal#putRecord`,
    collection: `${NS}.category`,
    record: {
      game,
      name,
      description,
      kind: 'time',
      sort: 'asc',
      primaryTiming: 'realTime',
      timingMethods: ['realTime'],
      variables: [{ id: 'platform', name: 'Platform', values: ['N64', 'VC', 'EMU'], subcategory: false }],
      requiresVideo: true,
      requiredApprovals: 1,
      createdAt: new Date().toISOString(),
    },
  })
  log('the moderators vote in the 16 Star and 70 Star categories')
  const sixteen = await pass(peach, category('16 Star', 'Beat Bowser in the Sky with 16 stars or more.'), 'Our main category', [luigi])
  const seventy = await pass(luigi, category('70 Star', 'Beat Bowser in the Sky with 70 stars, no BLJs past the infinite stairs.'), 'The other big one', [toad])

  const categoryRef = async (uri: string): Promise<Ref> => {
    const { category: c } = await appview('getLeaderboard', { category: uri, limit: '1' })
    return { uri: c.uri, cid: c.cid }
  }
  const sixteenRef = await until('16 Star to be indexed', () => categoryRef(sixteen.result!))
  const seventyRef = await until('70 Star to be indexed', () => categoryRef(seventy.result!))
  const rules = (cat: Ref, text: string) => ({
    $type: `${NS}.community.proposal#putRecord`,
    collection: `${NS}.ruleset`,
    record: { category: cat, text, createdAt: new Date().toISOString() },
  })
  log('and their rules')
  await pass(
    toad,
    rules(sixteenRef, 'Timing starts when the screen fades from the Nintendo logo and ends on the final Bowser star grab.\nVideo is required.\nEmulator runs must use an approved emulator.'),
    'Rules from the Discord pins',
    [peach],
  )
  await pass(
    peach,
    rules(seventyRef, 'Timing as in 16 Star.\nAll 70 stars must be collected before entering Bowser in the Sky.\nVideo is required.'),
    'Rules from the Discord pins',
    [luigi],
  )

  log('runners submit runs')
  const t = (min: number, sec: number, ms = 0) => (min * 60 + sec) * 1000 + ms
  const runs: { runner: Account; category: Ref; ms: number; platform: string; verdict?: 'verified' | 'changesRequested'; by?: Account; retime?: number; reason?: string }[] = [
    { runner: runners[0], category: sixteenRef, ms: t(14, 58, 400), platform: 'N64', verdict: 'verified', by: peach },
    { runner: runners[1], category: sixteenRef, ms: t(15, 3, 120), platform: 'VC', verdict: 'verified', by: luigi, retime: t(15, 2, 980) },
    { runner: runners[2], category: sixteenRef, ms: t(15, 21, 700), platform: 'N64', verdict: 'verified', by: toad },
    { runner: runners[3], category: sixteenRef, ms: t(15, 40, 0), platform: 'EMU' },
    { runner: runners[4], category: sixteenRef, ms: t(16, 5, 330), platform: 'N64', verdict: 'changesRequested', by: peach, reason: 'The end of the video is cut off before the star grab.' },
    { runner: runners[0], category: seventyRef, ms: t(47, 12, 600), platform: 'N64', verdict: 'verified', by: luigi },
    { runner: runners[2], category: seventyRef, ms: t(48, 30, 0), platform: 'VC', verdict: 'verified', by: toad },
    { runner: runners[3], category: seventyRef, ms: t(49, 2, 250), platform: 'N64' },
  ]
  const flagged: Ref[] = []
  for (const run of runs) {
    const ref = await run.runner.create('run', {
      category: run.category,
      times: { realTimeMs: run.ms },
      videos: [{ url: `https://example.com/videos/${run.runner.handle.split('.')[0]}-${run.ms}` }],
      variables: [{ variable: 'platform', value: run.platform }],
      performedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    })
    if (run.runner === runners[3] && run.category === seventyRef) flagged.push(ref)
    if (!run.verdict || !run.by) continue
    await until('the run to be indexed', () => appview('getRun', { uri: ref.uri }))
    const { data } = await run.by.agent.com.atproto.server.getServiceAuth({
      aud: process.env.COMMUNITY_SERVICE_DID ?? 'did:web:localhost%3A2586',
      lxm: `${NS}.moderation.createVerdict`,
    })
    const res = await fetch(`${env.communityServiceUrl}/xrpc/${NS}.moderation.createVerdict`, {
      method: 'POST',
      headers: { authorization: `Bearer ${data.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        run: ref,
        status: run.verdict,
        reason: run.reason,
        verifiedTimes: run.retime ? { realTimeMs: run.retime } : undefined,
      }),
    })
    if (!res.ok) throw new Error(`verdict failed: ${await res.text()}`)
  }

  log('toad.test flags a pending run as suspected cheating')
  const call = async (as: Account, nsid: string, body: unknown) => {
    const { data } = await as.agent.com.atproto.server.getServiceAuth({
      aud: process.env.COMMUNITY_SERVICE_DID ?? 'did:web:localhost%3A2586',
      lxm: `${NS}.${nsid}`,
    })
    const res = await fetch(`${env.communityServiceUrl}/xrpc/${NS}.${nsid}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${data.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`${nsid} failed: ${await res.text()}`)
  }
  const suspicious = flagged[0]
  if (suspicious) {
    await until('the run to be indexed', () => appview('getRun', { uri: suspicious.uri }))
    await call(toad, 'moderation.flagRun', { run: suspicious.uri, flag: true, reason: 'The audio drifts out of sync around Bowser in the Fire Sea.' })
  }

  log('a runner asks for a second community, left for the sysadmin to answer')
  await runners[1].create('community.request', {
    game: { title: 'Super Mario Sunshine', releaseYear: 2002, platforms: ['GameCube'] },
    founders: [runners[1].did, runners[2].did],
    note: 'Sunshine runners would like boards here too.',
  })

  log('')
  log(`Seeded. Every account's password is "${DEMO_PASSWORD}".`)
  log(`  sysadmin:   ${DEMO.sysadmin} (use with ledger-admin --as ${DEMO.sysadmin})`)
  log(`  moderators: ${DEMO.moderators.join(', ')} (Moderator app, http://127.0.0.1:2587)`)
  log(`  runners:    ${DEMO.runners.join(', ')} (Runner app, http://127.0.0.1:2585)`)
  log(`  community:  ${DEMO.community} (${community.did})`)
  log('World records are announced from sm64.test as Bluesky posts within a few seconds (the community service checks every 2s).')
}
