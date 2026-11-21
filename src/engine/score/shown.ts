const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const byText = (a: unknown, b: unknown): number => {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * What a review tells a person about scores and coverage, as one text that can be compared: the threshold, every file's path and final score,
 * every block at or above the threshold by path, hash and score, every file's whole-file score at or above the threshold by path, score and source,
 * and the files not reviewed by path and reason, each list sorted. Null when the result cannot be read.
 */
export function shownOf(result: unknown): string | null {
  if (!isObject(result)) return null;
  const scores = result['scores'];
  const verdict = result['verdict'];
  const coverage = result['coverage'];
  if (!Array.isArray(scores) || !isObject(verdict) || !isObject(coverage)) return null;
  const threshold = verdict['threshold'];
  const notReviewed = coverage['notReviewed'];
  if (typeof threshold !== 'number' || !Array.isArray(notReviewed)) return null;
  const files: Array<[string, number]> = [];
  const blocks: Array<[string, string, number]> = [];
  const levels: Array<[string, number, string]> = [];
  for (const f of scores) {
    if (!isObject(f) || typeof f['path'] !== 'string') continue;
    const path = f['path'];
    if (typeof f['finalScore'] === 'number') files.push([path, f['finalScore']]);
    const level = f['fileLevel'];
    if (isObject(level) && typeof level['score'] === 'number' && level['score'] >= threshold) {
      levels.push([path, level['score'], typeof level['source'] === 'string' ? level['source'] : '']);
    }
    for (const b of Array.isArray(f['blocks']) ? f['blocks'] : []) {
      if (!isObject(b) || typeof b['hash'] !== 'string' || !isObject(b['entry'])) continue;
      const score = b['entry']['score'];
      if (typeof score === 'number' && score >= threshold) blocks.push([path, b['hash'], score]);
    }
  }
  const paths = notReviewed.flatMap((n): Array<[string, string]> =>
    (isObject(n) && typeof n['path'] === 'string' ? [[n['path'], typeof n['reason'] === 'string' ? n['reason'] : '']] : []));
  return JSON.stringify([threshold, files.sort(byText), blocks.sort(byText), levels.sort(byText), paths.sort(byText)]);
}
