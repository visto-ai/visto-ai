import type { FileContext } from './context/build.ts';

/** The overview of a zero-call review that is not a full one. */
export const NOTHING_READ = 'No file was read in this review: every file that can be sent was read, as it is now, by an earlier review.';

const isCovered = (c: FileContext): boolean => c.kept?.covered === true;
const holdsDue = (c: FileContext): boolean => (c.threads ?? []).some((t) => t.due);

/** The files a run goes on with, in the order they are packed, and the ones it leaves out because an earlier review covers them. */
export function filesToSend(contexts: FileContext[], mode: 'full' | 'incremental' | 'recheck'): { send: FileContext[]; leftOut: FileContext[] } {
  const leftOut: FileContext[] = [];
  const due: FileContext[] = [];
  const uncovered: FileContext[] = [];
  const rest: FileContext[] = [];
  for (const c of contexts) {
    // A moved file has no diff to read: once it has its score, it is left out in every mode.
    if (c.plan.kind === 'model_whole' && isCovered(c)) leftOut.push(c);
    else if (mode !== 'full' && c.plan.kind === 'model' && isCovered(c) && !holdsDue(c)) leftOut.push(c);
    else if (holdsDue(c)) due.push(c);
    else if (!isCovered(c)) uncovered.push(c);
    else rest.push(c);
  }
  return { send: [...due, ...uncovered, ...rest], leftOut };
}
