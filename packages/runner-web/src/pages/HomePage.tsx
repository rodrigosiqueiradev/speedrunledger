import { useEffect, useState } from 'react'
import type { CommunityDetail } from '@speedrunledger/lexicon'
import { api } from '../api.js'
import { boardHref, Link } from '../router.js'

export function HomePage() {
  const [communities, setCommunities] = useState<CommunityDetail[]>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    api.listCommunities().then((r) => setCommunities(r.communities), (e) => setError(e.message))
  }, [])

  if (error) return <p className="error">{error}</p>
  if (!communities) return <p className="muted">Loading games…</p>
  const games = communities.flatMap((c) => c.games.map((g) => ({ ...g, community: c.community })))
  if (games.length === 0) return <p className="muted">No communities yet.</p>

  return (
    <section>
      <h1>Games</h1>
      <div className="cards">
        {games.map(({ game, categories, community }) => (
          <article className="card" key={game.uri}>
            <h2>{game.title}</h2>
            <p className="muted small">
              {[game.releaseYear, game.platforms.join(', ')].filter(Boolean).join(' · ')} · run by {community.name}
            </p>
            {categories.length === 0 ? (
              <p className="muted small">No categories yet.</p>
            ) : (
              <ul className="categories">
                {categories.map((c) => (
                  <li key={c.uri}>
                    <Link href={boardHref(c.uri)}>{c.name}</Link>
                    {c.retired && <span className="tag">retired</span>}
                  </li>
                ))}
              </ul>
            )}
          </article>
        ))}
      </div>
    </section>
  )
}
