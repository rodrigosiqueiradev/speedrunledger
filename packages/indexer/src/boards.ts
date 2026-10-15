import { boardKey, type CategoryVariable, type Database, json } from '@speedrunledger/db'
import { sql } from 'kysely'

interface EligibleRun {
  run_uri: string
  run_cid: string
  runner_did: string
  co_runners: string[]
  variables: Record<string, string>
  ranked_ms: number | string
  indexed_at: Date
  verification_uri: string
}

/**
 * Rebuilds every board of one category from public records. A run is
 * eligible when its latest verdict from an active moderator says "verified"
 * for the run's current CID, enough distinct moderators approved that CID,
 * its reference checks pass, the runner is not banned and their account is
 * active, and every listed co-runner has confirmed. Each entrant's best run
 * is ranked; equal times share a rank and the run indexed first is listed first.
 */
export async function rebuildCategoryBoards(db: Database, categoryUri: string): Promise<void> {
  await db.transaction().execute(async (tx) => {
    // Serialize rebuilds of the same category so the last one to commit read the latest data.
    await sql`SELECT pg_advisory_xact_lock(hashtext(${categoryUri}))`.execute(tx)

    const category = await tx.selectFrom('category').selectAll().where('uri', '=', categoryUri).executeTakeFirst()
    await tx.deleteFrom('board_entry').where('category_uri', '=', categoryUri).execute()
    if (!category) return

    const { rows } = await sql<EligibleRun>`
      WITH latest AS (
        SELECT DISTINCT ON (v.subject_uri) v.*
        FROM verification v
        JOIN run r ON r.uri = v.subject_uri AND r.community_did = v.community_did
        WHERE r.category_uri = ${categoryUri} AND v.reviewer_active
        ORDER BY v.subject_uri, v.indexed_at DESC, v.uri DESC
      ),
      approvals AS (
        SELECT v.subject_uri, count(DISTINCT v.reviewer_did) AS n
        FROM verification v
        JOIN run r ON r.uri = v.subject_uri AND r.cid = v.subject_cid AND r.community_did = v.community_did
        WHERE r.category_uri = ${categoryUri} AND v.reviewer_active AND v.status = 'verified'
        GROUP BY v.subject_uri
      )
      SELECT
        r.uri AS run_uri,
        r.cid AS run_cid,
        r.runner_did,
        r.co_runners,
        r.variables,
        r.indexed_at,
        l.uri AS verification_uri,
        CASE ${category.primary_timing}
          WHEN 'realTime' THEN COALESCE(l.verified_real_time_ms, r.real_time_ms)
          WHEN 'realTimeNoLoads' THEN COALESCE(l.verified_real_time_no_loads_ms, r.real_time_no_loads_ms)
          WHEN 'gameTime' THEN COALESCE(l.verified_game_time_ms, r.game_time_ms)
        END AS ranked_ms
      FROM run r
      JOIN latest l ON l.subject_uri = r.uri AND l.status = 'verified' AND l.subject_cid = r.cid
      JOIN approvals a ON a.subject_uri = r.uri AND a.n >= ${category.required_approvals}
      LEFT JOIN actor ac ON ac.did = r.runner_did
      WHERE r.category_uri = ${categoryUri}
        AND r.problems = '[]'::jsonb
        AND COALESCE(ac.active, true)
        AND NOT EXISTS (
          SELECT 1 FROM ban b WHERE b.community_did = r.community_did AND b.subject_did = r.runner_did
        )
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(r.co_runners) AS cr(did)
          WHERE NOT EXISTS (
            SELECT 1 FROM run_participant p
            WHERE p.run_uri = r.uri AND p.run_cid = r.cid AND p.participant_did = cr.did
          )
        )
    `.execute(tx)

    const subcategoryVars = (category.variables as CategoryVariable[]).filter((v) => v.subcategory).map((v) => v.id)
    const direction = category.sort === 'desc' ? -1 : 1
    const boards = new Map<string, { subcategory: Record<string, string>; best: Map<string, EligibleRun> }>()
    for (const run of rows) {
      if (run.ranked_ms === null) continue
      run.ranked_ms = Number(run.ranked_ms)
      const subcategory = Object.fromEntries(subcategoryVars.map((id) => [id, run.variables[id]]))
      const key = boardKey(categoryUri, subcategory)
      let board = boards.get(key)
      if (!board) {
        board = { subcategory, best: new Map() }
        boards.set(key, board)
      }
      const entrant = [run.runner_did, ...run.co_runners].sort().join(',')
      const current = board.best.get(entrant)
      if (!current || compare(run, current, direction) < 0) board.best.set(entrant, run)
    }

    for (const [key, board] of boards) {
      const ordered = [...board.best.entries()].sort(([, a], [, b]) => compare(a, b, direction))
      let rank = 0
      let previous: number | undefined
      const values = ordered.map(([entrant, run], index) => {
        if (run.ranked_ms !== previous) rank = index + 1
        previous = run.ranked_ms as number
        return {
          board_key: key,
          entrant_key: entrant,
          category_uri: categoryUri,
          subcategory: json(board.subcategory),
          rank,
          runner_did: run.runner_did,
          run_uri: run.run_uri,
          run_cid: run.run_cid,
          verification_uri: run.verification_uri,
          ranked_ms: run.ranked_ms as number,
          indexed_at: run.indexed_at,
        }
      })
      if (values.length > 0) await tx.insertInto('board_entry').values(values).execute()
    }
  })
}

const compare = (a: EligibleRun, b: EligibleRun, direction: number): number =>
  ((a.ranked_ms as number) - (b.ranked_ms as number)) * direction || a.indexed_at.getTime() - b.indexed_at.getTime()
