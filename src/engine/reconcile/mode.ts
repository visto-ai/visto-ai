import { isChanged } from '../context/increment.ts';
import type { Changed } from '../context/increment.ts';
import type { AuditEntry, Block, Finding } from '../types.ts';

/** Whether a finding is on a line changed since its file was last read: the line it was placed on, or the line the model named, since placement may move it onto a neighbouring one. */
export function onChangedLine(finding: Finding, changed: Changed, blocks: Block[]): boolean {
  const at = (line: number | null): boolean => line !== null && isChanged(changed, blocks, finding.side, line);
  return at(finding.line) || at(finding.requestedLine);
}

/**
 * In an incremental review and a re-check, a placed finding on a line unchanged since its file was last read:
 * a blocker is kept, a major is listed in the body only, a minor is dropped. A file without `changed` is not touched.
 */
export function reconcileMode(
  findings: Finding[], changedOf: (path: string) => Changed | null, blocksOf: (path: string) => Block[],
): { kept: Finding[]; unchanged: Finding[]; audit: AuditEntry[] } {
  const kept: Finding[] = [];
  const unchanged: Finding[] = [];
  const audit: AuditEntry[] = [];
  for (const finding of findings) {
    const changed = changedOf(finding.path);
    if (changed === null || finding.severity === 'blocker' || onChangedLine(finding, changed, blocksOf(finding.path))) {
      kept.push(finding);
    } else if (finding.severity === 'major') {
      unchanged.push(finding);
    } else {
      audit.push({ stage: 'reconcile', action: 'dropped', subject: `${finding.path}:${finding.line}`, reason: 'unchanged_line' });
    }
  }
  return { kept, unchanged, audit };
}
