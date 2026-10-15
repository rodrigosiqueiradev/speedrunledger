import type { VideoProblemView } from '@speedrunledger/lexicon'
import { useEffect, useState } from 'react'
import { api } from '../../api.js'
import { useHandle } from '../../hooks.js'
import { Link, reviewHref } from '../../router.js'
import type { CommunityContext } from '../CommunityPage.js'

export function VideosTab({ ctx }: { ctx: CommunityContext }) {
  const did = ctx.detail.community.did
  const [problems, setProblems] = useState<VideoProblemView[]>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    api.listVideoProblems(did).then((r) => setProblems(r.problems), (e) => setError(e.message))
  }, [did, ctx.version])

  if (error) return <p className="error">{error}</p>
  if (!problems) return <p className="muted">Loading video checks…</p>
  return (
    <>
      <p className="muted small">
        The community service checks the video links of ranked runs every week. These links no longer work. The runner is
        notified; the run stays on the board until a moderator decides otherwise.
      </p>
      {problems.length === 0 ? (
        <p className="muted">Every checked link works.</p>
      ) : (
        <table className="queue">
          <thead>
            <tr>
              <th>Runner</th>
              <th>Rank</th>
              <th>Link</th>
              <th>Checked</th>
            </tr>
          </thead>
          <tbody>
            {problems.map((p) => (
              <ProblemRow key={`${p.run.uri} ${p.url}`} problem={p} />
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

function ProblemRow({ problem }: { problem: VideoProblemView }) {
  const runner = useHandle(problem.run.runner.did, problem.run.runner.handle)
  return (
    <tr>
      <td>
        <Link href={reviewHref(problem.run.uri)}>@{runner}</Link>
      </td>
      <td>{problem.run.rank ?? '–'}</td>
      <td>
        <a href={problem.url} target="_blank" rel="noreferrer noopener">
          {problem.url}
        </a>
        <span className="muted small">
          {' '}
          {problem.detail ?? 'Not found'}
          {problem.httpStatus ? ` (HTTP ${problem.httpStatus})` : ''}
        </span>
      </td>
      <td>{problem.checkedAt.slice(0, 10)}</td>
    </tr>
  )
}
