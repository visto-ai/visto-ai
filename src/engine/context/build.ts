import type { AuditEntry, ChangedFile, PullRequestInfo, Source } from '../types.ts';
import { blocksOf } from '../score/blocks.ts';
import { scorePlan } from '../score/rules.ts';
import type { KeptScores } from '../score/history.ts';
import type { ScorePlan } from '../score/rules.ts';
import type { Block } from '../score/types.ts';
import { commentableRanges, parsePatch, patchFromContents, renderAnchoredDiff } from './diff.ts';
import type { Hunk, HunkLine, Ranges } from './diff.ts';
import type { Changed } from './increment.ts';
import { fullFileContext, numberLines } from './full-file.ts';
import type { FullFile } from './full-file.ts';
import { isLowPriority, orderByPriority } from './priority.ts';
import { testCandidates } from './test-pair.ts';
import type { ShownThread } from './threads.ts';
import { hasHidden, stripControl } from './untrusted.ts';

export interface FileContext {
  file: ChangedFile;
  hunks: Hunk[];
  ranges: Ranges | null; // null: the file has no diff to comment on
  diffText: string | null; // anchored diff, control characters stripped
  full: FullFile | null;
  test: { path: string; text: string } | null;
  // Why the file has nothing to send; null when it has a diff.
  skip: 'no_diff' | 'too_large' | 'unchanged' | null;
  blocks: Block[]; // one per hunk; the same objects are passed on, never copied
  plan: ScorePlan; // who scores the file: the model, a fixed rule, or nobody
  // An added or removed line held a character that was stripped before anyone saw it.
  hidden: boolean;
  // The earlier threads on this file, when a later review shows them; absent in a first review.
  threads?: ShownThread[];
  // What the pull request's earlier runs, or other pull requests, already settle for this file; absent when nothing does.
  kept?: KeptScores;
  // In an incremental review and a re-check: what changed since a published review last read the file; absent otherwise.
  changed?: Changed;
}

const isNoNewlineMarker = (line: HunkLine | undefined): boolean => line?.kind === 'meta' && line.text.startsWith('\\');

/**
 * The one way a patch becomes hunks. The hunks are built from the cleaned text, so a
 * character stripped from a changed line leaves no trace in them: `hidden` keeps it.
 *
 * A patch from the service keeps a file's carriage return at the end of each content line, so
 * one trailing carriage return is a line ending, unless the line is marked as having none.
 * A computed patch was diffed with line endings already turned into line feeds, so any carriage
 * return left on a line is part of its text.
 */
export function hunksOf(patch: string, computed = false): { hunks: Hunk[]; text: string; removed: number; hidden: boolean } {
  const clean = stripControl(patch);
  const hidden = parsePatch(patch).some((h) =>
    h.lines.some((l, i) => {
      if (l.kind !== 'add' && l.kind !== 'del') return false;
      const lineEnding = !computed && l.text.endsWith('\r') && !isNoNewlineMarker(h.lines[i + 1]);
      return hasHidden(lineEnding ? l.text.slice(0, -1) : l.text);
    }),
  );
  return { hunks: parsePatch(clean.text), text: clean.text, removed: clean.removed, hidden };
}

const MAX_TEST_PROBES = 20;
const SHORT_CODE = /^[a-z][a-z0-9_]{0,39}$/;

function stripped(count: number, subject: string): AuditEntry[] {
  return count === 0
    ? []
    : [{ stage: 'context', action: 'control_characters_stripped', subject, reason: String(count) }];
}

export async function buildFileContexts(
  pr: PullRequestInfo,
  files: ChangedFile[],
  source: Source,
): Promise<{ contexts: FileContext[]; audit: AuditEntry[]; content: (path: string, sha: string) => Promise<string | null> }> {
  const cache = new Map<string, string | null>();
  let attempts = 0;
  const fetchContent = async (path: string, sha: string): Promise<string | null> => {
    const key = `${sha}:${path}`;
    if (cache.has(key)) return cache.get(key)!;
    const content = await source.getFileContent(pr, path, sha);
    cache.set(key, content);
    return content;
  };
  const changedPaths = new Set(files.map((f) => f.path));
  const contexts: FileContext[] = [];
  const audit: AuditEntry[] = [];

  const findTest = async (path: string): Promise<{ path: string; content: string } | null> => {
    for (const candidate of testCandidates(path)) {
      if (changedPaths.has(candidate)) return null;
      if (!cache.has(`${pr.headSha}:${candidate}`)) {
        if (attempts >= MAX_TEST_PROBES) return null;
        attempts += 1;
      }
      let content: string | null;
      try {
        content = await fetchContent(candidate, pr.headSha);
      } catch (error) {
        // A failed probe means no test file at that path; the review goes on.
        const reason = error instanceof Error && SHORT_CODE.test(error.message) ? error.message : 'source_error';
        audit.push({ stage: 'context', action: 'test_probe_failed', subject: candidate, reason });
        cache.set(`${pr.headSha}:${candidate}`, null);
        continue;
      }
      if (content !== null) return { path: candidate, content };
    }
    return null;
  };

  for (const file of orderByPriority(files)) {
    let removed = 0;
    let patch: string | null = null;
    let tooLarge = false;
    let head: string | null = null; // cleaned head content, fetched at most once
    let headRaw: string | null = null; // the same content with only CRLF turned into LF
    let headFetched = false;
    const loadHead = async (): Promise<void> => {
      if (headFetched) return;
      headFetched = true;
      const raw = await fetchContent(file.path, pr.headSha);
      if (raw === null) return;
      const clean = stripControl(raw);
      removed += clean.removed;
      head = clean.text;
      headRaw = raw.replaceAll('\r\n', '\n');
    };

    let fromService = false;
    if (file.patch !== null) {
      patch = file.patch;
      fromService = true;
    } else if (file.status !== 'removed') {
      const old = file.status === 'added' ? '' : await fetchContent(file.previousPath ?? file.path, pr.baseSha);
      await loadHead();
      if (old !== null && headRaw !== null) {
        // Diffed before stripping, so two contents that differ only in a stripped character still differ.
        removed += stripControl(old).removed;
        patch = patchFromContents(old.replaceAll('\r\n', '\n'), headRaw);
        tooLarge = patch === null;
      }
    }

    let hunks: Hunk[] = [];
    let ranges: Ranges | null = null;
    let diffText: string | null = null;
    let hidden = false;
    let skip: FileContext['skip'] = tooLarge ? 'too_large' : 'no_diff';
    if (patch !== null) {
      const parsed = hunksOf(patch, !fromService);
      // Characters stripped from computed hunks were already counted in the two contents.
      if (fromService) removed += parsed.removed;
      if (parsed.hunks.length > 0) {
        hunks = parsed.hunks;
        ranges = commentableRanges(hunks);
        diffText = renderAnchoredDiff(hunks);
        hidden = parsed.hidden;
        skip = null;
      } else {
        skip = 'unchanged';
      }
    }

    let full: FullFile | null = null;
    let test: FileContext['test'] = null;
    if (ranges !== null) {
      if (file.status !== 'removed' && !isLowPriority(file.path)) {
        await loadHead();
        if (head !== null) full = fullFileContext(head, hunks);
      }
      if (file.status !== 'removed') {
        const found = await findTest(file.path);
        if (found !== null) {
          const clean = stripControl(found.content);
          test = { path: found.path, text: numberLines(clean.text) };
          audit.push(...stripped(clean.removed, found.path));
        }
      }
    }
    audit.push(...stripped(removed, file.path));
    contexts.push({ file, hunks, ranges, diffText, full, test, skip, blocks: blocksOf(hunks), plan: scorePlan(file, skip), hidden });
  }
  return { contexts, audit, content: fetchContent };
}
