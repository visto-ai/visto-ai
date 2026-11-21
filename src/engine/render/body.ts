import type { Discussed, Finding, NotReviewed, ReviewResult, Side, UnplacedFinding } from '../types.ts';
import type { BlockScore, FileLevelSource, FileScore, ScoreEntry, Span } from '../score/types.ts';

export interface InlineComment { path: string; side: Side; line: number; body: string }
export const MAX_BODY_CHARS = 65_536;

const MAX_LISTED = 25;
const MAX_REVIEW_ENTRIES = 50;
const FIRST_LINE_CHARS = 300;
const UNPLACED_HEADING = '## Findings not placed on the diff';
const OVERALL_HEADING = '## Overall';
const UNPLACED_NOTE = "GitHub cannot show these inline: the line is outside this pull request's diff, or the file has no diff GitHub can comment on. They do not block the merge.";

type FileRef = { path: string; previousPath: string | null };
type Meta = {
  trigger: 'automatic' | 'manual';
  requestedBy: string | null;
  // Builds a link to a span of a file; null when the service has no such link.
  lineUrl: ((file: FileRef, span: Span) => string) | null;
  // true: each finding is an inline comment; false: its whole text is written in the body.
  inline: boolean;
  // Builds a link to a comment by its id; absent or null when the service has no such link.
  commentUrl?: ((commentId: string) => string) | null;
};

const WHOLE_FILE_TEXT: Record<Exclude<FileLevelSource, 'whole_file' | 'team_file_invalid'>, string> = {
  builtin_floor: "it changes the reviewer's own file, code owners or CI",
  team_floor: 'a path the team marked as always needing a person',
  hidden_characters: 'a changed line holds invisible or direction-changing characters',
  not_scored: 'not read, or left without a score',
  rule_rename: 'scored by rule',
  rule_asset: 'scored by rule',
};

// Cut a string to at most `limit` UTF-16 units without splitting a surrogate pair.
function safeSlice(text: string, limit: number): string {
  let end = Math.max(0, Math.min(limit, text.length));
  const last = text.charCodeAt(end - 1);
  if (end > 0 && end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function firstLine(body: string): string {
  const line = body.split(/\r\n|\r|\n/).map((l) => l.trim()).find((l) => l !== '') ?? '';
  return line.length > FIRST_LINE_CHARS ? `${safeSlice(line, FIRST_LINE_CHARS - 1)}\u2026` : line;
}

// A path shown in a bullet stays on its line: newlines and tabs become spaces first.
function codeSpan(raw: string): string {
  const text = raw.replace(/[\r\n\t]/g, ' ');
  if (!text.includes('`')) return `\`${text}\``;
  const longest = Math.max(...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence} ${text} ${fence}`;
}

// What may stand before a heading's # on its line: at most three spaces, then any mix of quote marks, bullets and ordered marks, with spaces and tabs between.
const BEFORE_HASH = /^ {0,3}(?:(?:>|[-*+][ \t]|[0-9]{1,9}[.)][ \t])[ \t]*)*#/;
// A setext underline, at the first column or after quote marks.
const UNDERLINE = /^ {0,3}(?:>[ \t]*)*(=+|-+)[ \t]*$/;

// A model-written line must not become a heading of the review body: not with a #, and not as a setext underline, at the top level, in a quote or in a list item. A fence is left as it is.
function noHeading(text: string): string {
  let open: Fence | null = null;
  let before = ''; // the line above, or '' when it is blank or closed a fence
  return text.split('\n').map((line) => {
    const prev = before;
    before = line;
    if (open !== null) {
      if (fenceCloses(line, open)) {
        open = null;
        before = '';
      }
      return line;
    }
    open = fenceOpens(line);
    if (open !== null) return line;
    if (BEFORE_HASH.test(line)) return line.replace(BEFORE_HASH, (m) => `${m.slice(0, -1)}\\#`);
    if (!BLANK.test(prev) && UNDERLINE.test(line)) return line.replace(/[=-]/, '\\$&');
    return line;
  }).join('\n');
}

const ZW = '\u200b';

const STARTS = new RegExp('@(?=[A-Za-z0-9])|<(?=[A-Za-z/!?])|&(?=(?:[A-Za-z][A-Za-z0-9]{0,31}|#[0-9]{1,7}|#[xX][0-9A-Fa-f]{1,6});)', 'g');

// A zero-width space after what starts a mention, raw HTML or a character reference. Nothing is rewritten, so the text reads the same inside an inline span as outside one.
// Decided once for each run without white space: in an address, after its ://, an @ is written %40; a < before http:// or https:// is left, as it cannot start raw HTML.
function inertProse(line: string): string {
  return line.replace(/\S+/g, (run) => {
    const scheme = run.indexOf('://');
    return run.replace(STARTS, (m, at: number) => {
      if (m === '@') {
        if (/[A-Za-z0-9]/.test(run[at - 1] ?? '')) return m;
        return scheme >= 0 && at > scheme ? '%40' : `${m}${ZW}`;
      }
      if (m === '<' && (run.startsWith('http://', at + 1) || run.startsWith('https://', at + 1))) return m;
      return `${m}${ZW}`;
    });
  });
}

type Fence = { indent: string; char: string; size: number };

// A line that opens with three or more backticks or tildes, indented by at most three spaces; for backticks the rest of the line holds none.
// The rest of the line is any character: U+2028 and U+2029 do not end a line.
function fenceOpens(line: string): Fence | null {
  const m = /^( *)(`{3,}|~{3,})([^]*)$/.exec(line);
  if (m === null || m[1]!.length > 3 || (m[2]![0] === '`' && m[3]!.includes('`'))) return null;
  return { indent: m[1]!, char: m[2]![0]!, size: m[2]!.length };
}

// The same character at the same or a greater length, then nothing but spaces and tabs.
function fenceCloses(line: string, open: Fence): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return m !== null && m[1]![0] === open.char && m[1]!.length >= open.size;
}

const fenceLine = (open: Fence): string => `${open.indent}${open.char.repeat(open.size)}`;

// A line is blank when it holds nothing but spaces and tabs.
const BLANK = /^[ \t]*$/;

// Leading tabs become spaces, each tab reaching the next multiple of four columns: under a bullet a tab would reach another column.
function untab(line: string): string {
  const lead = /^[ \t]*/.exec(line)![0];
  let col = 0;
  for (const c of lead) col = c === '\t' ? col + 4 - (col % 4) : col + 1;
  return ' '.repeat(col) + line.slice(lead.length);
}

// Model-written text made inert line by line; `fences` says whether a fence can open in it.
function inertText(text: string, fences: boolean): string {
  let open: Fence | null = null;
  const lines: string[] = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    // Inside a fence only a line that could close it is touched.
    const line: string = open === null || new RegExp(`^[ \\t]*\\${open.char}{${open.size},}[ \\t]*$`).test(raw) ? untab(raw) : raw;
    if (open !== null) {
      const closes = fenceCloses(line, open);
      if (closes) open = null;
      lines.push(closes ? line.trimStart() : line);
      continue;
    }
    open = fences ? fenceOpens(line) : null;
    if (open === null) lines.push(inertProse(line));
    else {
      open = { ...open, indent: '' };
      lines.push(line.trimStart());
    }
  }
  return open === null ? lines.join('\n') : `${lines.join('\n')}\n${fenceLine(open)}`;
}

// Text that follows the service's own words on one line: no fence can open in it, and nothing is appended.
export const inertInline = (text: string): string => inertText(text, false);

/** Text the model wrote, made safe to post. Outside a fence a zero-width space follows every `@` that starts a mention, every `<` that starts raw HTML and every `&` that starts a character reference. Fence lines are moved to the first column, and a fence left open is closed. */
export function inert(text: string): string {
  return inertText(text, true);
}

function bullets(items: string[], cap: boolean = true): string[] {
  const shown = cap ? items.slice(0, MAX_LISTED) : items;
  return items.length > shown.length ? [...shown, `- \u2026and ${items.length - shown.length} more.`] : shown;
}

const located = (f: Pick<Finding, 'path' | 'line' | 'severity' | 'body'>): string =>
  `- **\\[${f.severity}]** ${codeSpan(`${f.path}:${f.line}`)} \u2014 ${inertInline(firstLine(f.body))}`;
const unplacedLine = (f: UnplacedFinding): string =>
  `- ${codeSpan(`${f.path}:${f.line}`)}${f.side === 'LEFT' ? ' (old file)' : ''} \u2014 ${inertInline(firstLine(f.body))}`;
// A bullet with the whole text of its finding under it, as a continuation of the item.
const locatedWhole = (f: Finding): string => {
  const note = movedNote(f);
  const text = [note, noHeading(inert(f.body))].filter((t) => t !== '').join('\n\n').split('\n').map((l) => (l === '' ? l : `  ${l}`)).join('\n');
  return `${located(f)}\n\n${text}`;
};
const DISCUSSED_HEADING = '## Already discussed';
const DISCUSSED_NOTE = 'These were raised in an earlier review. They are not posted again.';
const discussedLine = (d: Discussed, commentUrl: Meta['commentUrl']): string =>
  `${located(d)}${commentUrl == null ? '' : ` ([earlier thread](${commentUrl(d.commentId)}))`}`;
const notReviewedLine = (n: NotReviewed): string => `- ${codeSpan(n.path)}: ${n.reason}`;

const movedNote = (f: Finding): string =>
  f.requestedLine === null ? '' : `_(Refers to ${f.side === 'LEFT' ? 'old line' : 'line'} ${f.requestedLine}, just outside the diff.)_`;

// The service's own first line, an empty line, then the model's text.
function commentBody(f: Finding): string {
  const note = movedNote(f);
  return `**\\[${f.severity}]**${note === '' ? '' : ` ${note}`}\n\n${inert(f.body)}`;
}

// The part after the score: the category in a code span, then the dash and the reason when there is one.
function scoreTail(entry: ScoreEntry): string {
  const reason = inertInline(firstLine(entry.reason));
  return `${codeSpan(entry.category)}${reason === '' ? '' : ` \u2014 ${reason}`}`;
}

function wholeFileLine(file: FileScore, level: NonNullable<FileScore['fileLevel']>, teamFileInvalid: string | null): string {
  const head = `- whole file, ${level.score}%`;
  if (level.source === 'team_file_invalid') {
    return `${head} \u2014 the repository's .visto-ai.yml cannot be used (${teamFileInvalid ?? 'unknown'}), so every file needs a person`;
  }
  if (level.source !== 'whole_file') return `${head} \u2014 ${WHOLE_FILE_TEXT[level.source]}`;
  return file.wholeFile === null ? head : `${head} ${scoreTail(file.wholeFile)}`;
}

function blockLine(file: FileScore, block: BlockScore, entry: ScoreEntry, lineUrl: Meta['lineUrl']): string {
  const { span } = block;
  const range = span.first === span.last ? `line ${span.first}` : `lines ${span.first}-${span.last}`;
  const label = `${span.side === 'LEFT' ? 'old ' : ''}${range}`;
  const shown = lineUrl === null ? label : `[${label}](${lineUrl(file, span)})`;
  // A reason written on another pull request is not shown here: only its category.
  const base = `- ${shown}, ${entry.score}% ${block.origin === 'other_pull_request' ? codeSpan(entry.category) : scoreTail(entry)}`;
  if (Number.isInteger(block.raisedFrom) && block.raisedFrom! >= 0 && block.raisedFrom! <= 100) return `${base} _(${block.raisedFrom}% was given; a block this file lost had scored ${entry.score}%)_`;
  if (block.origin === 'earlier_run') return `${base} _(kept from an earlier review)_`;
  if (block.origin === 'other_pull_request') return `${base} _(scored on another pull request)_`;
  return base;
}

// The lines a person should read, grouped by file; a file's heading is not an entry.
function humanReviewSection(result: ReviewResult, lineUrl: Meta['lineUrl']): string {
  const { threshold, highest } = result.verdict;
  const groups: { file: FileScore; lines: string[] }[] = [];
  const files = result.scores
    .map((file, index) => ({ file, index }))
    .sort((a, b) => b.file.finalScore - a.file.finalScore || (a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : a.index - b.index))
    .map((x) => x.file);
  for (const file of files) {
    const lines: string[] = [];
    if (file.fileLevel !== null && file.fileLevel.score >= threshold) lines.push(wholeFileLine(file, file.fileLevel, result.teamFileInvalid));
    const flagged = file.blocks
      .map((block, index) => ({ block, index, entry: block.entry }))
      .filter((x): x is { block: BlockScore; index: number; entry: ScoreEntry } => x.entry !== null && x.entry.score >= threshold)
      .sort((a, b) => b.entry.score - a.entry.score || a.index - b.index);
    for (const x of flagged) lines.push(blockLine(file, x.block, x.entry, lineUrl));
    if (lines.length > 0) groups.push({ file, lines });
  }
  if (groups.length === 0) return `## Human review\n\nNothing here is at or above ${threshold}%. The highest score is ${highest}%.`;
  const total = groups.reduce((n, g) => n + g.lines.length, 0);
  let room = MAX_REVIEW_ENTRIES;
  const out: string[] = [`## Human review\n\nA person should read these parts. Each is at or above ${threshold}%.`];
  for (const { file, lines } of groups) {
    if (room === 0) break;
    const written = lines.slice(0, room);
    room -= written.length;
    out.push([`**${codeSpan(file.path)}**`, ...written].join('\n'));
  }
  if (total > MAX_REVIEW_ENTRIES) out[out.length - 1] += `\n- \u2026and ${total - MAX_REVIEW_ENTRIES} more.`;
  return out.join('\n\n');
}

const UNCHANGED_HEADING = '## On code unchanged since the last review';
const UNCHANGED_NOTE = 'These are on lines that have not changed since the reviewer last read their file. They are not posted as comments and do not hold a merge.';
const SEVERITIES: readonly unknown[] = ['blocker', 'major', 'minor'];
// A stored list may be damaged: only an item with every field this code reads, of the right kind, is kept; a requested line that is not a line reads as none.
const unchangedOf = (result: ReviewResult): Finding[] => {
  if (!Array.isArray(result.unchanged)) return [];
  return (result.unchanged as unknown[]).filter((x): x is Finding => {
    if (typeof x !== 'object' || x === null) return false;
    const f = x as Record<string, unknown>;
    return typeof f.path === 'string' && typeof f.body === 'string' && SEVERITIES.includes(f.severity) && Number.isInteger(f.line);
  }).map((f) => ({ ...f, requestedLine: Number.isInteger(f.requestedLine) ? f.requestedLine : null }));
};

// A stored result may hold a mode or a since that this code does not know: the first reads as full, the second as absent.
function firstLineOf(result: ReviewResult, meta: Meta): string | null {
  const since = typeof result.since === 'string' && /^[0-9a-f]{7,64}$/.test(result.since) ? result.since.slice(0, 12) : null;
  const who = meta.requestedBy === null ? '' : ` by @${meta.requestedBy}`;
  if (result.mode === 'incremental') {
    const changes = since === null ? '' : `, of the changes since \`${since}\``;
    if (meta.trigger === 'manual') return `**Incremental review** requested${who}${changes}.`;
    return since === null ? '**Incremental review**.' : `**Incremental review** of the changes since \`${since}\`.`;
  }
  if (result.mode === 'recheck') {
    const judged = Array.isArray(result.threadVerdicts) && result.threadVerdicts.length > 0;
    const middle = (result.threadsDue ?? 0) === 0 ? 'No earlier thread was waiting for a verdict'
      : judged ? 'The earlier threads were judged again' : 'No earlier thread could be judged';
    return `**Re-check** requested${who}. ${middle}; code that was reviewed before was not reviewed again.`;
  }
  return meta.trigger === 'manual' ? `**Full review** requested${who}.` : null;
}

function overallLine(result: ReviewResult): string {
  const discussed = result.alreadyDiscussed?.length ?? 0;
  const kept = result.threadVerdicts ?? [];
  const due = result.threadsDue ?? 0;
  const placed = result.findings;
  const count = (s: Finding['severity']) => placed.filter((f) => f.severity === s).length;
  const u = result.unplaced.length;
  const k = result.coverage.notReviewed.length;
  const unchanged = unchangedOf(result).length;
  const parts: string[] = [];
  if (placed.length === 0 && u === 0) parts.push(discussed > 0 || unchanged > 0 ? 'No new findings.' : 'No findings.');
  else {
    parts.push(`${count('blocker')} blocker, ${count('major')} major, ${count('minor')} minor.`);
    if (u > 0) parts.push(`${u} could not be placed on the diff.`);
  }
  if (unchanged > 0) parts.push(`${unchanged} major on code unchanged since the last review.`);
  if (k > 0) parts.push(`${k} files were not reviewed.`);
  if (due > 0) {
    const cleared = kept.filter((v) => v.verdict !== 'open').length;
    const open = kept.length - cleared;
    const unjudged = due - kept.length;
    parts.push(`Earlier threads: ${cleared} cleared, ${open} still open.${unjudged > 0 ? ` ${unjudged} could not be judged.` : ''}`);
  }
  const { needsHuman, highest } = result.verdict;
  parts.push(`Human review: ${needsHuman ? 'needed' : 'not needed'} (highest score ${highest}%).`);
  return parts.join(' ');
}

const NUL = String.fromCharCode(0);

// Text that storing leaves as it is: every NUL becomes U+FFFD, as CommonMark reads it, and a lone surrogate becomes U+FFFD too. Lengths do not change.
export const asRead = (text: string): string => text.replaceAll(NUL, '\ufffd').toWellFormed();

/** The review's body and inline comments, as they are posted and as they are stored: storing them changes nothing. */
export function renderReview(result: ReviewResult, meta: Meta): { body: string; comments: InlineComment[] } {
  const { body, comments } = rendered(result, meta);
  return { body: asRead(body), comments: comments.map((c) => ({ ...c, body: asRead(c.body) })) };
}

function rendered(result: ReviewResult, meta: Meta): { body: string; comments: InlineComment[] } {
  const prefix: string[] = [];
  const opening = firstLineOf(result, meta);
  if (opening !== null) prefix.push(opening);
  if (result.status === 'failed') {
    const failure = result.failure === null ? 'unknown' : `${result.failure.stage}: ${result.failure.code}`;
    return { body: [...prefix, `${OVERALL_HEADING}\n\nThe review could not be completed (${failure}).\n\nHuman review: needed, because the review did not finish.`].join('\n\n'), comments: [] };
  }
  // The tail is kept whole when the body is cut: from the unplaced section on, or the Overall section alone.
  const head: string[] = [...prefix];
  const tail: string[] = [];
  const overview = result.overview.trim();
  if (overview !== '') head.push(`## Summary\n\n${noHeading(inert(overview))}`);
  head.push(humanReviewSection(result, meta.lineUrl));
  if (result.findings.length > 0) {
    const items = meta.inline ? bullets(result.findings.map(located)) : bullets(result.findings.map(locatedWhole), false);
    head.push(['## Findings', '', ...items].join('\n'));
  }
  // Always in the head, uncapped: a long section is cut there and never takes room from the tail.
  const unchanged = unchangedOf(result);
  if (unchanged.length > 0) {
    head.push([UNCHANGED_HEADING, '', UNCHANGED_NOTE, '', ...bullets(unchanged.map(locatedWhole), false)].join('\n'));
  }
  const rest = result.unplaced.length > 0 ? tail : head;
  if (result.unplaced.length > 0) {
    tail.push([UNPLACED_HEADING, '', UNPLACED_NOTE, '', ...bullets(result.unplaced.map(unplacedLine))].join('\n'));
  }
  const discussed = result.alreadyDiscussed ?? [];
  if (discussed.length > 0) {
    rest.push([DISCUSSED_HEADING, '', DISCUSSED_NOTE, '', ...bullets(discussed.map((d) => discussedLine(d, meta.commentUrl)))].join('\n'));
  }
  if (result.beyondDiff.length > 0) rest.push(['## Beyond the diff', '', ...bullets(result.beyondDiff.map(located))].join('\n'));
  if (result.coverage.notReviewed.length > 0) {
    rest.push(['## Coverage', '', 'These files were not reviewed:', '', ...bullets(result.coverage.notReviewed.map(notReviewedLine))].join('\n'));
  }
  tail.push(`${OVERALL_HEADING}\n\n${overallLine(result)}`);
  const comments = !meta.inline ? [] : result.findings.map((f) => ({ path: f.path, side: f.side, line: f.line, body: commentBody(f) }));
  return { body: fitBody(head.join('\n\n'), tail.join('\n\n')), comments };
}

const cutMarker = (removed: number): string => `_\\[\u2026 ${removed} characters of the review were cut to fit GitHub's limit]_`;

// Close a code fence that a cut left open, at the opening fence's own indent.
function closeOpenFence(text: string): string {
  let open: Fence | null = null;
  for (const line of text.split('\n')) {
    if (open === null) open = fenceOpens(line);
    else if (fenceCloses(line, open)) open = null;
  }
  return open === null ? text : `${text}\n${fenceLine(open)}`;
}

// The longest prefix that fits and ends at a line break, or a plain cut when no line break fits.
function cutAtLineBreak(text: string, room: number): string {
  if (room >= text.length) return text;
  const slice = safeSlice(text, room);
  if (text[slice.length] === '\n') return slice;
  const at = slice.lastIndexOf('\n');
  return at > 0 ? slice.slice(0, at) : slice;
}

// Keep as much of `head` as fits in `room` after the cut, then the marker, then `tail`.
function assemble(head: string, tail: string, limit: number): string {
  let room = limit - tail.length - cutMarker(head.length).length - 4;
  while (room > 0) {
    const kept = cutAtLineBreak(head, room).trimEnd();
    const out = `${closeOpenFence(kept)}\n\n${cutMarker(head.length - kept.length)}${tail === '' ? '' : `\n\n${tail}`}`;
    if (out.length <= limit) return out;
    room -= out.length - limit;
  }
  const compact = `${cutMarker(head.length)}\n\n${tail}`;
  return compact.length <= limit ? compact : tail;
}

/** `tail` is kept whole when it fits: the cut takes the end of `head`. */
export function fitBody(head: string, tail: string, limit: number = MAX_BODY_CHARS): string {
  const body = head === '' ? tail : tail === '' ? head : `${head}\n\n${tail}`;
  if (body.length <= limit) return body;
  if (head !== '' && tail !== '' && tail.length <= limit) return assemble(head, tail, limit);
  // No tail to protect, or the tail alone is over the limit: cut from the end.
  return assemble(body, '', limit);
}
