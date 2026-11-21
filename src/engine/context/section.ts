import type { FileContext } from './build.ts';
import { changedText } from './increment.ts';
import { inlineText, wrapData } from './untrusted.ts';

// A token that never occurs in stripped text, so measuring never deletes anything
// and the measured size is an upper bound of the size sent.
export const MEASURE_TOKEN = '\u0000'.repeat(16);
export const MEASURE_NUMBER = 9999;

// One file's part of the batch message, as the model receives it.
export function fileSection(c: FileContext, k: number, fileCount: number, token: string): string {
  const path = c.file.path;
  const lines = [
    `## File ${k}/${fileCount}: ${inlineText(path)}`,
    `status: ${c.file.status}`,
    `additions: ${c.file.additions}`,
    `deletions: ${c.file.deletions}`,
  ];
  if (c.file.previousPath !== null) {
    lines.push(`previous path: ${inlineText(c.file.previousPath)}`);
  }
  if (c.plan.kind === 'model') {
    lines.push(c.kept?.settled === true
      ? 'whole-file score: not allowed. Every block of this file already has its score.'
      : 'whole-file score: allowed');
  } else if (c.plan.kind === 'model_whole') {
    lines.push('whole-file score: required. The file moved to another directory and its content did not change. Score the move itself.');
  }
  if (c.changed !== undefined) {
    lines.push(`lines changed since this file was last reviewed: ${changedText(c.changed)}`);
  }
  if (c.diffText !== null) {
    lines.push(wrapData(`diff ${path}`, c.diffText, token));
  }
  if (c.full !== null) {
    lines.push(
      c.full.kind === 'full'
        ? '### Full file (kind: full)'
        : `### Full file (kind: excerpt of ${c.full.totalLines} lines)`,
      wrapData(`full file ${path}`, c.full.text, token),
    );
  }
  if (c.test !== null) {
    lines.push(
      `### Paired test: ${inlineText(c.test.path)}`,
      wrapData(`test ${c.test.path}`, c.test.text, token),
    );
  }
  return lines.join('\n');
}
