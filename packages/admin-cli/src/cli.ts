import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { AdminClient, type AdminClientEnv } from './client.js'

export interface CliEnv extends AdminClientEnv {
  /** The acting sysadmin's DID or handle. */
  sysadmin?: string
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
  sysadmin remove <did|handle>                        the last sysadmin cannot be removed

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
  announcements run                                   post new world records to Bluesky now
  videos check                                        check every ranked run's video links now

Options: --as <did|handle> (acting sysadmin; or LEDGER_SYSADMIN), --json.
Environment: COMMUNITY_ADMIN_TOKEN (required), COMMUNITY_SERVICE_URL, APPVIEW_URL, PDS_URL, PLC_URL.`

type Out = (line: string) => void

export class LedgerAdmin {
  readonly client: AdminClient

  constructor(
    readonly env: CliEnv,
    readonly out: Out = (line) => console.log(line),
  ) {
    this.client = new AdminClient(env)
  }

  resolve(actor: string): Promise<string> {
    return this.client.resolve(actor)
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

    const { client } = this
    switch (`${group} ${command ?? ''}`.trim()) {
      case 'platform init': {
        const sysadmin = await this.resolve(need(values.sysadmin ?? values.as ?? this.env.sysadmin, '--sysadmin'))
        const out = await client.initPlatform({ handle: need(values.handle, '--handle'), sysadmin })
        return print(`platform account ${out.handle} (${out.did}); sysadmin ${sysadmin}`, out)
      }
      case 'sysadmin list': {
        const sysadmins = await client.listSysadmins()
        return print(sysadmins.join('\n') || 'no sysadmins (run platform init)', sysadmins)
      }
      case 'sysadmin add': {
        const subject = await this.resolve(need(args[0], 'a DID or handle'))
        const out = await client.addSysadmin(await this.sysadmin(values.as), subject)
        return print(`${subject} is now a sysadmin`, out)
      }
      case 'sysadmin remove': {
        const subject = await this.resolve(need(args[0], 'a DID or handle'))
        await client.removeSysadmin(await this.sysadmin(values.as), subject)
        return print(`${subject} is no longer a sysadmin`, { subject })
      }
      case 'requests list': {
        const requests = await client.listRequests(values.all ? 'all' : 'pending')
        const lines = requests.map(
          (r) =>
            `${r.uri}\n  ${r.game.title}${r.game.releaseYear ? ` (${r.game.releaseYear})` : ''}, requested by @${r.requester.handle ?? r.requester.did}` +
            `\n  founders: ${r.founders.map((f) => `@${f.handle ?? f.did}`).join(', ')}` +
            (r.note ? `\n  note: ${r.note}` : '') +
            (values.all ? `\n  status: ${r.status}${r.denialReason ? ` (${r.denialReason})` : ''}` : ''),
        )
        return print(lines.join('\n') || 'no pending requests', requests)
      }
      case 'requests deny': {
        const out = await client.denyRequest(await this.sysadmin(values.as), need(args[0], 'the request URI'), need(values.reason, '--reason'))
        return print(`denied; the requester sees the reason (${out.uri})`, out)
      }
      case 'community list': {
        const managed = await client.listCommunities()
        const lines = managed.map(({ did, detail: c }) => {
          const games = c?.games.map((g) => g.game.title).join(', ')
          return `${did}  ${c?.community.name ?? '(not indexed yet)'}${c?.community.frozen ? ' [frozen]' : ''}${games ? `: ${games}` : ''}`
        })
        return print(lines.join('\n') || 'no communities', managed.map(({ detail, ...m }) => ({ ...m, ...detail })))
      }
      case 'community create': {
        const founders = await Promise.all((values.founder ?? []).map((f) => this.resolve(f)))
        const out = await client.createCommunity({
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
        need(this.env.pdsUrl, 'PDS_URL')
        const out = await client.registerCommunity(need(values.identifier, '--identifier'), need(values.password, '--password'))
        return print(`the community service now writes for ${out.handle} (${out.did})`, out)
      }
      case 'community add-game': {
        const community = await this.resolve(need(args[0], 'the community'))
        const g = game()
        if (!g) throw new UsageError('--game is required')
        const out = await client.addGame(await this.sysadmin(values.as), community, g)
        return print(`added ${g.title}: ${out.uri}`, out)
      }
      case 'community appoint': {
        const community = await this.resolve(need(args[0], 'the community'))
        const subject = await this.resolve(need(args[1], 'the moderator to appoint'))
        const out = await client.appoint(await this.sysadmin(values.as), community, subject, need(values.reason, '--reason'))
        return print(`appointed ${subject}; they become a moderator once they accept\n  intervention: ${out.intervention}`, out)
      }
      case 'community freeze':
      case 'community unfreeze': {
        const community = await this.resolve(need(args[0], 'the community'))
        const out = await client.setFrozen(await this.sysadmin(values.as), community, command === 'freeze', need(values.reason, '--reason'))
        return print(`${command === 'freeze' ? 'froze' : 'unfroze'} ${community}: ${out.uri}`, out)
      }
      case 'community export': {
        const community = await this.resolve(need(args[0], 'the community'))
        const pds = await client.pdsOf(community)
        const res = await fetch(await client.exportUrl(community))
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
        const out = await client.executeProposals()
        return print(`carried out ${out.executed} proposal(s)`, out)
      }
      case 'announcements run': {
        const out = await client.runAnnouncements()
        return print(`posted ${out.posted} world record(s)`, out)
      }
      case 'videos check': {
        const out = await client.checkVideos()
        return print(`checked ${out.checked} link(s), ${out.dead} dead`, out)
      }
      default:
        throw new UsageError(`unknown command "${positionals.join(' ')}"\n\n${USAGE}`)
    }
  }
}
