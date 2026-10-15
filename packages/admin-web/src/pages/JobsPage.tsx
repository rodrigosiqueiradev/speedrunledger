import { useAction } from '@speedrunledger/web-ui'
import { useState } from 'react'
import { api } from '../api.js'

/** The community service runs these on a timer; here they run now. */
const JOBS = [
  {
    name: 'Carry out passed proposals',
    about: 'Invites, kicks, category and rule changes, and lifted bans that won their vote.',
    run: async () => `Carried out ${(await api.executeProposals()).executed} proposal(s).`,
  },
  {
    name: 'Announce world records',
    about: 'Posts new world records on Bluesky from each community’s account.',
    run: async () => `Posted ${(await api.runAnnouncements()).posted} world record(s).`,
  },
  {
    name: 'Check video links',
    about: 'Checks every ranked run’s video links and marks the dead ones.',
    run: async () => {
      const out = await api.checkVideos()
      return `Checked ${out.checked} link(s), ${out.dead} dead.`
    },
  },
]

export function JobsPage() {
  return (
    <section className="narrow">
      <h1>Jobs</h1>
      <p className="muted small">The community service runs these on its own schedule. Run one now when you don’t want to wait.</p>
      {JOBS.map((job) => (
        <Job key={job.name} {...job} />
      ))}
    </section>
  )
}

function Job({ name, about, run }: (typeof JOBS)[number]) {
  const action = useAction()
  const [result, setResult] = useState<string>()
  return (
    <div className="panel">
      <h3>{name}</h3>
      <p className="muted small">{about}</p>
      <button disabled={action.busy} onClick={() => action.run(async () => setResult(await run()))}>
        {action.busy ? 'Running…' : 'Run now'}
      </button>
      {result && <p className="notice ok">{result}</p>}
      {action.error && <p className="error">{action.error}</p>}
    </div>
  )
}
