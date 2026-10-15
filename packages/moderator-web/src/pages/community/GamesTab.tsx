import type { CategoryView, GameView } from '@speedrunledger/lexicon'
import { type FormEvent, useState } from 'react'
import { api, CATEGORY, P, RULESET } from '../../api.js'
import { useAction } from '../../hooks.js'
import { type CommunityContext, ReasonField } from '../CommunityPage.js'

const METHODS = { realTime: 'Real time (RTA)', realTimeNoLoads: 'Real time without loads', gameTime: 'In-game time' } as const
type Method = keyof typeof METHODS
const rkeyOf = (uri: string) => uri.split('/').pop()!

export function GamesTab({ ctx }: { ctx: CommunityContext }) {
  const canAct = !ctx.frozen && ctx.moderators.some((m) => m.actor.did === ctx.me.did && m.status === 'active')
  return (
    <>
      <p className="muted small">
        Any moderator can fix a game’s details directly. Adding or changing a category, or its rules, takes a majority vote;
        the vote carries the exact record that will be written.
      </p>
      {ctx.detail.games.map(({ game, categories }) => (
        <Game key={game.uri} game={game} categories={categories} ctx={ctx} canAct={canAct} />
      ))}
    </>
  )
}

type Editing = { kind: 'game' } | { kind: 'category'; category?: CategoryView } | { kind: 'rules'; category: CategoryView }

function Game({ game, categories, ctx, canAct }: { game: GameView; categories: CategoryView[]; ctx: CommunityContext; canAct: boolean }) {
  const [editing, setEditing] = useState<Editing>()
  const close = () => setEditing(undefined)
  return (
    <article className="panel">
      <div className="title-row">
        <h2>
          {game.title}
          {game.releaseYear ? ` (${game.releaseYear})` : ''}
        </h2>
        {canAct && (
          <div className="actions">
            <button className="secondary" onClick={() => setEditing({ kind: 'game' })}>
              Edit game
            </button>
            <button className="secondary" onClick={() => setEditing({ kind: 'category' })}>
              Propose a category
            </button>
          </div>
        )}
      </div>
      {game.platforms?.length ? <p className="muted small">{game.platforms.join(', ')}</p> : null}
      {editing?.kind === 'game' && <GameForm game={game} ctx={ctx} close={close} />}
      {editing?.kind === 'category' && !editing.category && <CategoryForm game={game} ctx={ctx} close={close} />}
      <table className="queue">
        <thead>
          <tr>
            <th>Category</th>
            <th>Ranked by</th>
            <th>Approvals</th>
            <th>Video</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {categories.map((c) => (
            <tr key={c.uri}>
              <td>
                {c.name}
                {c.retired ? <span className="tag">retired</span> : null}
              </td>
              <td>{METHODS[c.primaryTiming as Method] ?? c.primaryTiming}</td>
              <td>{c.requiredApprovals ?? 1}</td>
              <td>{c.requiresVideo === false ? 'optional' : 'required'}</td>
              <td>
                {canAct && (
                  <div className="actions">
                    <button className="link" onClick={() => setEditing({ kind: 'category', category: c })}>
                      Propose changes
                    </button>
                    <button className="link" onClick={() => setEditing({ kind: 'rules', category: c })}>
                      Propose rules
                    </button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing?.kind === 'category' && editing.category && (
        <CategoryForm game={game} category={editing.category} ctx={ctx} close={close} />
      )}
      {editing?.kind === 'rules' && <RulesForm category={editing.category} ctx={ctx} close={close} />}
    </article>
  )
}

function GameForm({ game, ctx, close }: { game: GameView; ctx: CommunityContext; close: () => void }) {
  const [title, setTitle] = useState(game.title)
  const [year, setYear] = useState(game.releaseYear ? String(game.releaseYear) : '')
  const [platforms, setPlatforms] = useState((game.platforms ?? []).join(', '))
  const action = useAction()

  async function submit(e: FormEvent) {
    e.preventDefault()
    const ok = await action.run(() =>
      api.updateGame({
        game: game.uri,
        title: title.trim(),
        releaseYear: year ? Number(year) : undefined,
        platforms: platforms
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean),
      }),
    )
    if (ok) {
      ctx.refresh()
      close()
    }
  }

  return (
    <form className="form narrow" onSubmit={submit}>
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} required />
      </label>
      <label>
        Release year
        <input type="number" min={1950} max={2200} value={year} onChange={(e) => setYear(e.target.value)} />
      </label>
      <label>
        Platforms, comma separated
        <input name="platforms" value={platforms} onChange={(e) => setPlatforms(e.target.value)} />
      </label>
      <FormButtons busy={action.busy} label="Save game" close={close} />
      {action.error && <p className="error">{action.error}</p>}
    </form>
  )
}

function CategoryForm({ game, category, ctx, close }: { game: GameView; category?: CategoryView; ctx: CommunityContext; close: () => void }) {
  const [name, setName] = useState(category?.name ?? '')
  const [description, setDescription] = useState(category?.description ?? '')
  const [primary, setPrimary] = useState<Method>((category?.primaryTiming as Method) ?? 'realTime')
  const [methods, setMethods] = useState<Method[]>((category?.timingMethods as Method[]) ?? ['realTime'])
  const [requiresVideo, setRequiresVideo] = useState(category?.requiresVideo !== false)
  const [approvals, setApprovals] = useState(String(category?.requiredApprovals ?? 1))
  const [retired, setRetired] = useState(category?.retired === true)
  const [reason, setReason] = useState('')
  const action = useAction()

  async function submit(e: FormEvent) {
    e.preventDefault()
    const timingMethods = Array.from(new Set([primary, ...methods]))
    const record = {
      game: { uri: game.uri, cid: game.cid },
      name: name.trim(),
      description: description.trim() || undefined,
      kind: 'time',
      sort: 'asc',
      primaryTiming: primary,
      timingMethods,
      variables: category?.variables ?? [],
      requiresVideo,
      requiredApprovals: Number(approvals),
      retired,
      createdAt: new Date().toISOString(),
    }
    const ok = await action.run(() =>
      api.propose({
        community: ctx.detail.community.did,
        action: { $type: `${P}#putRecord`, collection: CATEGORY, rkey: category ? rkeyOf(category.uri) : undefined, record },
        reason,
      }),
    )
    if (ok) ctx.proposed()
  }

  const toggle = (m: Method) => setMethods((ms) => (ms.includes(m) ? ms.filter((x) => x !== m) : [...ms, m]))
  return (
    <form className="form narrow category-form" onSubmit={submit}>
      <h3>{category ? `Change “${category.name}”` : 'New category'}</h3>
      <label>
        Name
        <input name="name" value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <label>
        Description
        <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label>
        Ranked by
        <select value={primary} onChange={(e) => setPrimary(e.target.value as Method)}>
          {(Object.keys(METHODS) as Method[]).map((m) => (
            <option key={m} value={m}>
              {METHODS[m]}
            </option>
          ))}
        </select>
      </label>
      <fieldset>
        <legend>Also show</legend>
        {(Object.keys(METHODS) as Method[]).map((m) => (
          <label key={m} className="check">
            <input type="checkbox" checked={m === primary || methods.includes(m)} disabled={m === primary} onChange={() => toggle(m)} />
            {METHODS[m]}
          </label>
        ))}
      </fieldset>
      <label>
        Approvals to verify a run
        <input name="approvals" type="number" min={1} max={10} value={approvals} onChange={(e) => setApprovals(e.target.value)} />
      </label>
      <label className="check">
        <input type="checkbox" checked={requiresVideo} onChange={(e) => setRequiresVideo(e.target.checked)} />
        Runs need video proof
      </label>
      {category && (
        <label className="check">
          <input type="checkbox" checked={retired} onChange={(e) => setRetired(e.target.checked)} />
          Retired: accepts no new runs, board stays visible
        </label>
      )}
      <ReasonField value={reason} onChange={setReason} />
      <FormButtons busy={action.busy} label="Propose" close={close} />
      {action.error && <p className="error">{action.error}</p>}
    </form>
  )
}

function RulesForm({ category, ctx, close }: { category: CategoryView; ctx: CommunityContext; close: () => void }) {
  const [text, setText] = useState(category.ruleset?.text ?? '')
  const [reason, setReason] = useState('')
  const action = useAction()

  async function submit(e: FormEvent) {
    e.preventDefault()
    const record = { category: { uri: category.uri, cid: category.cid }, text, createdAt: new Date().toISOString() }
    const ok = await action.run(() =>
      api.propose({ community: ctx.detail.community.did, action: { $type: `${P}#putRecord`, collection: RULESET, record }, reason }),
    )
    if (ok) ctx.proposed()
  }

  return (
    <form className="form" onSubmit={submit}>
      <h3>Rules for “{category.name}”</h3>
      <label>
        Rules
        <textarea name="rules" rows={10} value={text} onChange={(e) => setText(e.target.value)} required />
      </label>
      <ReasonField value={reason} onChange={setReason} />
      <FormButtons busy={action.busy} label="Propose rules" close={close} />
      {action.error && <p className="error">{action.error}</p>}
    </form>
  )
}

function FormButtons({ busy, label, close }: { busy: boolean; label: string; close: () => void }) {
  return (
    <div className="actions">
      <button disabled={busy}>{label}</button>
      <button type="button" className="secondary" onClick={close}>
        Cancel
      </button>
    </div>
  )
}
