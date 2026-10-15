import { useAction, useRefresh } from '@speedrunledger/web-ui'
import { type FormEvent, type ReactNode, useEffect, useState } from 'react'
import { actorLabel, api, type CommunityRequest, gameLabel } from '../api.js'
import { communityHref, Link } from '../router.js'

export function RequestsPage() {
  const [all, setAll] = useState(false)
  const [requests, setRequests] = useState<CommunityRequest[]>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<ReactNode>()
  const [version, refresh] = useRefresh()
  // An answered request leaves the pending list, so what happened is said up here.
  const answered = (what: ReactNode) => {
    setNotice(what)
    refresh()
  }
  useEffect(() => {
    api.listRequests(all ? 'all' : 'pending').then((r) => setRequests(r.requests), (e) => setError(e.message))
  }, [all, version])

  return (
    <section>
      <div className="title-row">
        <h1>Community requests</h1>
        <label className="check">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show answered requests
        </label>
      </div>
      <p className="muted small">
        Anyone signed in to the Runner app can ask for a community for a game, naming its founding moderators. Create the
        community, or deny the request with a reason the requester will see.
      </p>
      {notice && <p className="notice ok">{notice}</p>}
      {error && <p className="error">{error}</p>}
      {!requests && !error && <p className="muted">Loading requests…</p>}
      {requests?.length === 0 && <p className="muted">{all ? 'No requests yet.' : 'No requests waiting for an answer.'}</p>}
      {requests?.map((r) => <Request key={r.uri} request={r} answered={answered} />)}
    </section>
  )
}

type Answered = (what: ReactNode) => void

function Request({ request: r, answered }: { request: CommunityRequest; answered: Answered }) {
  const [mode, setMode] = useState<'create' | 'deny'>()
  return (
    <article className={`panel request${r.status === 'pending' ? '' : ' answered'}`}>
      <h3>{gameLabel(r.game)}</h3>
      <dl className="facts">
        <dt>Requested by</dt>
        <dd>{actorLabel(r.requester)}</dd>
        <dt>Founders</dt>
        <dd>{r.founders.map(actorLabel).join(', ')}</dd>
        {r.note && (
          <>
            <dt>Note</dt>
            <dd>{r.note}</dd>
          </>
        )}
        <dt>Asked</dt>
        <dd>{r.indexedAt.slice(0, 10)}</dd>
        {r.status !== 'pending' && (
          <>
            <dt>Answer</dt>
            <dd>
              {r.status === 'approved' && r.community ? (
                <Link href={communityHref(r.community)}>Community created</Link>
              ) : r.status === 'denied' ? (
                `Denied: ${r.denialReason ?? ''}`
              ) : (
                r.status
              )}
            </dd>
          </>
        )}
      </dl>
      {r.status === 'pending' && !mode && (
        <div className="actions">
          <button onClick={() => setMode('create')}>Create community</button>
          <button className="secondary" onClick={() => setMode('deny')}>
            Deny
          </button>
        </div>
      )}
      {mode === 'create' && <CreateFromRequest request={r} cancel={() => setMode(undefined)} done={answered} />}
      {mode === 'deny' && <Deny request={r} cancel={() => setMode(undefined)} done={answered} />}
    </article>
  )
}

function CreateFromRequest({ request, cancel, done }: { request: CommunityRequest; cancel: () => void; done: Answered }) {
  const [handle, setHandle] = useState('')
  const [name, setName] = useState(request.game.title)
  const [description, setDescription] = useState('')
  const [recoveryKey, setRecoveryKey] = useState('')
  const action = useAction()

  async function submit(e: FormEvent) {
    e.preventDefault()
    await action.run(async () => {
      const created = await api.createCommunity({ handle, name, description, recoveryKey, request: request.uri })
      done(
        <>
          Created <Link href={communityHref(created.did)}>@{created.handle}</Link> for {request.game.title}. The founders become
          its moderators once they accept in the Moderator app.
        </>,
      )
    })
  }

  return (
    <form className="form" onSubmit={submit}>
      <div className="row">
        <label>
          Community handle
          <input name="handle" placeholder="sm64.test" value={handle} onChange={(e) => setHandle(e.target.value)} required />
        </label>
        <label>
          Name
          <input name="name" value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
      </div>
      <label>
        Description <span className="muted small">(optional)</span>
        <textarea name="description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label>
        Founders’ recovery key <span className="muted small">(optional did:key, so they can move the community without us)</span>
        <input name="recoveryKey" placeholder="did:key:…" value={recoveryKey} onChange={(e) => setRecoveryKey(e.target.value)} />
      </label>
      <p className="muted small">The game and the founding moderators come from the request.</p>
      <div className="actions">
        <button disabled={action.busy}>{action.busy ? 'Creating…' : 'Create community'}</button>
        <button type="button" className="secondary" onClick={cancel}>
          Cancel
        </button>
      </div>
      {action.error && <p className="error">{action.error}</p>}
    </form>
  )
}

function Deny({ request, cancel, done }: { request: CommunityRequest; cancel: () => void; done: Answered }) {
  const [reason, setReason] = useState('')
  const action = useAction()

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (await action.run(() => api.denyRequest(request.uri, reason))) {
      done(`Denied the request for ${request.game.title}. The requester sees your reason in the Runner app.`)
    }
  }

  return (
    <form className="form" onSubmit={submit}>
      <label>
        Reason the requester will see
        <textarea name="reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} required />
      </label>
      <div className="actions">
        <button className="danger-inline" disabled={action.busy}>
          Deny request
        </button>
        <button type="button" className="secondary" onClick={cancel}>
          Cancel
        </button>
      </div>
      {action.error && <p className="error">{action.error}</p>}
    </form>
  )
}
