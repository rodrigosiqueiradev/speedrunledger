import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

export interface CliEnv {
  /** The community service; admin endpoints live under /admin. */
  communityServiceUrl: string
  adminToken: string
  /** The acting sysadmin's DID or handle. */
  sysadmin?: string
  appviewUrl: string
  /** Resolves .test handles locally, and is where new accounts are created. */
  pdsUrl?: string
  plcUrl: string
}

export function readEnv(env: NodeJS.ProcessEnv = process.env): CliEnv {
  const token = env.COMMUNITY_ADMIN_TOKEN
  if (!token) throw new UsageError('COMMUNITY_ADMIN_TOKEN is required')
  return {
    communityServiceUrl: env.COMMUNITY_SERVICE_URL ?? 'http://localhost:2586',
    adminToken: token,
    sysadmin: env.LEDGER_SYSADMIN,
    appviewUrl: env.APPVIEW_URL ?? 'http://localhost:2584',
    pdsUrl: env.PDS_URL,
    plcUrl: env.PLC_URL ?? 'https://plc.directory',
  }
}

export class UsageError extends Error {}

export const USAGE = `ledger-admin: run SpeedrunLedger as a sysadmin.

  platform init --handle <handle> --sysadmin <you>   create the platform account; you become the first sysadmin
  sysadmin list
  sysadmin add <did|handle>

  requests list [--all]                               community requests (pending unless --all)
  requests deny <request-uri> --reason <text>

  community list
  community create --handle <handle> --name <name>    create a community account, its game and founders
      [--request <request-uri>]                       take the game and founders from a request
      [--game <title>] [--year <n>] [--platform <p>]...
      [--founder <did|handle>]...  [--description <text>]
      [--recovery-key <did:key>]                      founders' PLC rotation key, so they can migrate without us
  community register --identifier <handle> --password <app password>
                                                      hand an existing community account to the community service
  community add-game <community> --game <title> [--year <n>] [--platform <p>]...
  community appoint <community> <did|handle> --reason <text>   only when it has no active moderator
  community freeze <community> --reason <text>
  community unfreeze <community> --reason <text>
  community export <community> [--out <file.car>]     the community's whole repo as a signed CAR file

  proposals execute                                   carry out passed proposals now

Options: --as <did|handle> (acting sysadmin; or LEDGER_SYSADMIN), --json.
Environment: COMMUNITY_ADMIN_TOKEN (required), COMMUNITY_SERVICE_URL, APPVIEW_URL, PDS_URL, PLC_URL.`

type Out = (line: string) => void

export class LedgerAdmin {
  constructor(
    readonly env: CliEnv,
    readonly out: Out = (line) => console.log(line),
  ) {}

  private async admin<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(new URL(path, this.env.communityServiceUrl), {
      method,
      headers: { authorization: `Bearer ${this.env.adminToken}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = (await res.json().catch(() => ({}))) as any
    if (!res.ok) throw new UsageError(`${data.error ?? res.status}: ${data.message ?? res.statusText}`)
    return data as T
  }

  private async appview<T = any>(nsid: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`/xrpc/app.speedrunledger-prototype.${nsid}`, this.env.appviewUrl)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
    const res = await fetch(url)
    if (!res.ok) throw new UsageError(`AppView ${nsid} returned ${res.status}`)
    return (await res.json()) as T
  }

  /** A DID for a DID or handle: the local PDS knows .test handles; anything else uses the handle's well-known file. */
  async resolve(actor: string): Promise<string> {
    if (actor.startsWith('did:')) return actor
    const handle = actor.replace(/^@/, '')
    if (this.env.pdsUrl) {
      const res = await fetch(new URL(`/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`, this.env.pdsUrl))
      if (res.ok) return ((await res.json()) as { did: string }).did
    }
    const res = await fetch(`https://${handle}/.well-known/atproto-did`).catch(() => undefined)
    const did = res?.ok ? (await res.text()).trim() : ''
    if (!did.startsWith('did:')) throw new UsageError(`could not resolve handle ${handle}`)
    return did
  }

  private async sysadmin(as?: string): Promise<string> {
    const who = as ?? this.env.sysadmin
    if (!who) throw new UsageError('say which sysadmin you are with --as or LEDGER_SYSADMIN')
    return this.resolve(who)
  }

  async run(argv: string[]): Promise<void> {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        as: { type: 'string' },
        json: { type: 'boolean' },
        all: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        handle: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        request: { type: 'string' },
        game: { type: 'string' },
        year: { type: 'string' },
        platform: { type: 'string', multiple: true },
        founder: { type: 'string', multiple: true },
        'recovery-key': { type: 'string' },
        identifier: { type: 'string' },
        password: { type: 'string' },
        reason: { type: 'string' },
        sysadmin: { type: 'string' },
        out: { type: 'string' },
      },
    })
    const [group, command, ...args] = positionals
    if (values.help || !group) return this.out(USAGE)
    const print = (human: string, data: unknown) => this.out(values.json ? JSON.stringify(data, null, 2) : human)
    const need = (value: string | undefined, what: string): string => {
      if (!value) throw new UsageError(`${what} is required`)
      return value
    }
    const game = () =>
      values.game
        ? { title: values.game, releaseYear: values.year ? Number(values.year) : undefined, platforms: values.platform }
        : undefined

    switch (`${group} ${command ?? ''}`.trim()) {
      case 'platform init': {
        const sysadmin = await this.resolve(need(values.sysadmin ?? values.as ?? this.env.sysadmin, '--sysadmin'))
        const out = await this.admin('POST', '/admin/platform', { handle: need(values.handle, '--handle'), sysadmin })
        return print(`platform account ${out.handle} (${out.did}); sysadmin ${sysadmin}`, out)
      }
      case 'sysadmin list': {
        const { sysadmins } = await this.admin<{ sysadmins: string[] }>('GET', '/admin/sysadmins')
        return print(sysadmins.join('\n') || 'no sysadmins (run platform init)', sysadmins)
      }
      case 'sysadmin add': {
        const subject = await this.resolve(need(args[0], 'a DID or handle'))
        const out = await this.admin('POST', '/admin/sysadmins', { sysadmin: await this.sysadmin(values.as), subject })
        return print(`${subject} is now a sysadmin`, out)
      }
      case 'requests list': {
        const { requests } = await this.appview<{ requests: any[] }>('listCommunityRequests', { status: values.all ? 'all' : 'pending' })
        const lines = requests.map(
          (r) =>
            `${r.uri}\n  ${r.game.title}${r.game.releaseYear ? ` (${r.game.releaseYear})` : ''}, requested by @${r.requester.handle ?? r.requester.did}` +
            `\n  founders: ${r.founders.map((f: any) => `@${f.handle ?? f.did}`).join(', ')}` +
            (r.note ? `\n  note: ${r.note}` : '') +
            (values.all ? `\n  status: ${r.status}${r.denialReason ? ` (${r.denialReason})` : ''}` : ''),
        )
        return print(lines.join('\n') || 'no pending requests', requests)
      }
      case 'requests deny': {
        const out = await this.admin('POST', '/admin/requests/deny', {
          sysadmin: await this.sysadmin(values.as),
          request: need(args[0], 'the request URI'),
          reason: need(values.reason, '--reason'),
        })
        return print(`denied; the requester sees the reason (${out.uri})`, out)
      }
      case 'community list': {
        const { communities: managed } = await this.admin<{ communities: { did: string; identifier: string }[] }>('GET', '/admin/communities')
        const details = await Promise.all(
          managed.map((m) => this.appview<{ community: any }>('getCommunity', { community: m.did }).then((r) => r.community, () => undefined)),
        )
        const byDid = new Map(managed.map((m, i) => [m.did, details[i]]))
        const lines = managed.map((m) => {
          const c = byDid.get(m.did)
          const games = c?.games.map((g: any) => g.game.title).join(', ')
          return `${m.did}  ${c?.community.name ?? '(not indexed yet)'}${c?.community.frozen ? ' [frozen]' : ''}${games ? `: ${games}` : ''}`
        })
        return print(lines.join('\n') || 'no communities', managed.map((m) => ({ ...m, ...byDid.get(m.did) })))
      }
      case 'community create': {
        const founders = await Promise.all((values.founder ?? []).map((f) => this.resolve(f)))
        const out = await this.admin('POST', '/admin/communities/create', {
          sysadmin: await this.sysadmin(values.as),
          handle: need(values.handle, '--handle'),
          name: need(values.name, '--name'),
          description: values.description,
          request: values.request,
          game: game(),
          founders: founders.length ? founders : undefined,
          recoveryKey: values['recovery-key'],
        })
        return print(
          `created ${out.handle} (${out.did})\n  game: ${out.game}\n  ${out.grants.length} founder grant(s); founders become moderators once they accept in the Moderator app`,
          out,
        )
      }
      case 'community register': {
        const out = await this.admin('POST', '/admin/communities', {
          identifier: need(values.identifier, '--identifier'),
          password: need(values.password, '--password'),
          pdsUrl: need(this.env.pdsUrl, 'PDS_URL'),
        })
        return print(`the community service now writes for ${out.handle} (${out.did})`, out)
      }
      case 'community add-game': {
        const community = await this.resolve(need(args[0], 'the community'))
        const g = game()
        if (!g) throw new UsageError('--game is required')
        const out = await this.admin('POST', `/admin/communities/${encodeURIComponent(community)}/games`, {
          sysadmin: await this.sysadmin(values.as),
          ...g,
        })
        return print(`added ${g.title}: ${out.uri}`, out)
      }
      case 'community appoint': {
        const community = await this.resolve(need(args[0], 'the community'))
        const subject = await this.resolve(need(args[1], 'the moderator to appoint'))
        const out = await this.admin('POST', `/admin/communities/${encodeURIComponent(community)}/appoint`, {
          sysadmin: await this.sysadmin(values.as),
          subject,
          reason: need(values.reason, '--reason'),
        })
        return print(`appointed ${subject}; they become a moderator once they accept\n  intervention: ${out.intervention}`, out)
      }
      case 'community freeze':
      case 'community unfreeze': {
        const community = await this.resolve(need(args[0], 'the community'))
        const out = await this.admin('POST', `/admin/communities/${encodeURIComponent(community)}/${command}`, {
          sysadmin: await this.sysadmin(values.as),
          reason: need(values.reason, '--reason'),
        })
        return print(`${command === 'freeze' ? 'froze' : 'unfroze'} ${community}: ${out.uri}`, out)
      }
      case 'community export': {
        const community = await this.resolve(need(args[0], 'the community'))
        const pds = await this.pdsOf(community)
        const res = await fetch(new URL(`/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(community)}`, pds))
        if (!res.ok) throw new UsageError(`getRepo returned ${res.status}`)
        const bytes = new Uint8Array(await res.arrayBuffer())
        const file = values.out ?? `${community.replaceAll(':', '_')}.car`
        await writeFile(file, bytes)
        return print(`wrote ${bytes.length} bytes to ${file} (blobs: ${pds}/xrpc/com.atproto.sync.listBlobs?did=${community})`, {
          file,
          bytes: bytes.length,
          pds,
        })
      }
      case 'proposals execute': {
        const out = await this.admin('POST', '/admin/proposals/execute', {})
        return print(`carried out ${out.executed} proposal(s)`, out)
      }
      default:
        throw new UsageError(`unknown command "${positionals.join(' ')}"\n\n${USAGE}`)
    }
  }

  /** The PDS hosting a DID, from its DID document. */
  private async pdsOf(did: string): Promise<string> {
    const url = did.startsWith('did:web:')
      ? `https://${decodeURIComponent(did.slice('did:web:'.length))}/.well-known/did.json`
      : new URL(`/${did}`, this.env.plcUrl).toString()
    const res = await fetch(url)
    if (!res.ok) throw new UsageError(`could not resolve ${did}`)
    const doc = (await res.json()) as { service?: { id: string; serviceEndpoint: string }[] }
    const pds = doc.service?.find((s) => s.id.endsWith('#atproto_pds'))?.serviceEndpoint
    if (!pds) throw new UsageError(`${did} names no PDS`)
    return pds
  }
}
