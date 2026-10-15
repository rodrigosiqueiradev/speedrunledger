import { type ReactElement, useState } from 'react'
import type { GameInput } from './api.js'

/** Title, release year and platforms ("N64, Wii VC") for a game, and the game they describe. */
export function useGameFields(): { fields: ReactElement; game: () => GameInput; reset: () => void } {
  const [title, setTitle] = useState('')
  const [year, setYear] = useState('')
  const [platforms, setPlatforms] = useState('')
  const fields = (
    <div className="row">
      <label>
        Game
        <input name="gameTitle" placeholder="Super Mario 64" value={title} onChange={(e) => setTitle(e.target.value)} required />
      </label>
      <label>
        Year <span className="muted small">(optional)</span>
        <input name="gameYear" inputMode="numeric" pattern="[0-9]{4}" value={year} onChange={(e) => setYear(e.target.value)} />
      </label>
      <label>
        Platforms <span className="muted small">(comma-separated)</span>
        <input name="gamePlatforms" placeholder="N64, Wii VC" value={platforms} onChange={(e) => setPlatforms(e.target.value)} />
      </label>
    </div>
  )
  return {
    fields,
    game: () => ({
      title: title.trim(),
      releaseYear: year ? Number(year) : undefined,
      platforms: platforms
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean),
    }),
    reset: () => {
      setTitle('')
      setYear('')
      setPlatforms('')
    },
  }
}
