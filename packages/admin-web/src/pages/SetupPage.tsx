import { useAction } from '@speedrunledger/web-ui'
import { type FormEvent, useState } from 'react'
import { actorLabel, api, type WhoAmI } from '../api.js'

/** First run: no platform account yet, so whoever holds the setup code creates it and becomes the first sysadmin. */
export function SetupPage({ me, done }: { me: WhoAmI; done: () => void }) {
  const [handle, setHandle] = useState('')
  const [setupCode, setSetupCode] = useState('')
  const action = useAction()

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (await action.run(() => api.initPlatform({ handle, setupCode }))) done()
  }

  return (
    <section className="narrow">
      <h1>Set up the platform</h1>
      <p>
        SpeedrunLedger has no platform account yet. Creating it lists you, {actorLabel(me)}, as the first sysadmin. The
        platform account holds the sysadmin list and the answers to community requests, all as public records.
      </p>
      <form className="form panel" onSubmit={submit}>
        <label>
          Platform account handle
          <input name="platformHandle" placeholder="ledger.test" value={handle} onChange={(e) => setHandle(e.target.value)} required />
        </label>
        <label>
          Setup code
          <input
            name="setupCode"
            type="password"
            autoComplete="off"
            value={setupCode}
            onChange={(e) => setSetupCode(e.target.value)}
            required
          />
        </label>
        <p className="muted small">
          The setup code is the community service’s admin token (<code>COMMUNITY_ADMIN_TOKEN</code>; locally it is in
          dev.env). It proves you run this platform, so the first person to sign in can’t claim it.
        </p>
        <button disabled={action.busy}>Create the platform account</button>
        {action.error && <p className="error">{action.error}</p>}
      </form>
    </section>
  )
}
