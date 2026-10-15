import { useAction, useRefresh } from '@speedrunledger/web-ui'
import { type FormEvent, useEffect, useState } from 'react'
import { type Actor, actorLabel, api, type WhoAmI } from '../api.js'

export function SysadminsPage({ me }: { me: WhoAmI }) {
  const [sysadmins, setSysadmins] = useState<Actor[]>()
  const [error, setError] = useState<string>()
  const [version, refresh] = useRefresh()
  useEffect(() => {
    api.listSysadmins().then((r) => setSysadmins(r.sysadmins), (e) => setError(e.message))
  }, [version])

  return (
    <section className="narrow">
      <h1>Sysadmins</h1>
      <p className="muted small">
        Sysadmins are listed in the platform account’s repo, so anyone can see who they are. The last one can’t be removed.
      </p>
      {error && <p className="error">{error}</p>}
      {!sysadmins && !error && <p className="muted">Loading…</p>}
      <ul className="list">
        {sysadmins?.map((s) => (
          <Sysadmin key={s.did} sysadmin={s} me={me} last={sysadmins.length === 1} removed={refresh} />
        ))}
      </ul>
      <AddSysadmin added={refresh} />
    </section>
  )
}

function Sysadmin({ sysadmin, me, last, removed }: { sysadmin: Actor; me: WhoAmI; last: boolean; removed: () => void }) {
  const action = useAction()
  const [confirming, setConfirming] = useState(false)
  const self = sysadmin.did === me.did
  return (
    <li>
      <span>
        {actorLabel(sysadmin)} {self && <span className="tag">you</span>}
      </span>
      {!last &&
        (confirming ? (
          <span className="actions">
            <button
              className="danger-inline"
              disabled={action.busy}
              onClick={async () => {
                if (await action.run(() => api.removeSysadmin(sysadmin.did))) {
                  if (self) window.location.reload()
                  else removed()
                }
              }}
            >
              {self ? 'Remove myself' : `Remove ${actorLabel(sysadmin)}`}
            </button>
            <button className="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button className="link" onClick={() => setConfirming(true)}>
            Remove
          </button>
        ))}
      {action.error && <p className="error">{action.error}</p>}
    </li>
  )
}

function AddSysadmin({ added }: { added: () => void }) {
  const [actor, setActor] = useState('')
  const [done, setDone] = useState<string>()
  const action = useAction()
  async function submit(e: FormEvent) {
    e.preventDefault()
    await action.run(async () => {
      setDone(actorLabel(await api.addSysadmin(actor)))
      setActor('')
      added()
    })
  }
  return (
    <form className="form panel" onSubmit={submit}>
      <h3>Add a sysadmin</h3>
      <label>
        Handle
        <input name="newSysadmin" placeholder="rosalina.test" value={actor} onChange={(e) => setActor(e.target.value)} required />
      </label>
      <div className="actions">
        <button disabled={action.busy}>Add sysadmin</button>
      </div>
      {done && <p className="notice ok">{done} is now a sysadmin.</p>}
      {action.error && <p className="error">{action.error}</p>}
    </form>
  )
}
