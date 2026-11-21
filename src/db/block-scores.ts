import type { PullRequestRef } from '../forge/types.ts';
import { storable } from './text.ts';
import type { Db } from './types.ts';

export interface StoredBlockScore { path: string; hash: string; score: number; category: string; reason: string }

/** The most pairs asked in one statement. */
const CHUNK = 500;

/** Stores the scores a run gave, one row each. `by` says who gave them; `at` is when the run finished. */
export async function recordBlockScores(db: Db, runId: number, ref: PullRequestRef, by: 'model' | 'scorer', scores: StoredBlockScore[], at: string): Promise<void> {
  if (scores.length === 0) return;
  const rows = scores.map((s) => ({
    path: storable(s.path), hash: storable(s.hash), score: s.score, category: storable(s.category), reason: storable(s.reason),
  }));
  await db.query(
    `insert into visto_ai.block_scores (run, service, owner, repo, number, path, hash, score, category, reason, scored_by, scored_at)
     select $1, $2, $3, $4, $5, s.path, s.hash, s.score, s.category, s.reason, $6, $7::timestamptz
     from jsonb_to_recordset($8::jsonb) as s(path text, hash text, score integer, category text, reason text)`,
    [runId, ref.service, storable(ref.owner).toLowerCase(), storable(ref.repo).toLowerCase(), ref.number, by, at, JSON.stringify(rows)]);
}

/** For each (path, hash) asked: the highest score stored for it, by `by`, by another pull request of the same repository at or after `since`. */
export async function reusableScores(db: Db, ref: PullRequestRef, by: 'model' | 'scorer', blocks: Array<{ path: string; hash: string }>, since: string): Promise<StoredBlockScore[]> {
  const found: StoredBlockScore[] = [];
  for (let i = 0; i < blocks.length; i += CHUNK) {
    const pairs = blocks.slice(i, i + CHUNK).map((b) => ({ path: storable(b.path), hash: storable(b.hash) }));
    const rows = await db.query<StoredBlockScore>(
      `select distinct on (b.path, b.hash) b.path, b.hash, b.score, b.category, b.reason
       from visto_ai.block_scores b
       join jsonb_to_recordset($6::jsonb) as p(path text, hash text) on p.path = b.path and p.hash = b.hash
       where b.service = $1 and b.owner = $2 and b.repo = $3 and b.scored_by = $4
         and b.number <> $5 and b.scored_at >= $7::timestamptz
       order by b.path, b.hash, b.score desc, b.scored_at desc, b.id desc`,
      [ref.service, storable(ref.owner).toLowerCase(), storable(ref.repo).toLowerCase(), by, ref.number, JSON.stringify(pairs), since]);
    found.push(...rows);
  }
  return found;
}
