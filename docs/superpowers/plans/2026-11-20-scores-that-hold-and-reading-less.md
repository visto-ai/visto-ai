# Scores That Hold, and Reading Less Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A block of a pull request is scored once and keeps its score while it stays in the diff, so pushing again cannot buy a lower score; and a later review reads only what no earlier review has read as it is now, or only the open threads when a person asks again on the same head.

**Architecture:** The review job hands the engine a pull request's score history, built from its earlier runs' stored results, and the engine is given one function to look up scores other pull requests stored in the last 30 days. Before the model is called the engine works out, for each file, what its history already settles: those blocks are shown as scored and not asked again; reconcile then applies the rules that keep a score from falling. A `mode` chosen by the job (`full`, `incremental` or `recheck`) decides which files are sent: in the two new modes only the files that hold a thread due a verdict and the files no published review covers at their present diff. A finding on a line that has not changed since a review last read the file is handled by its severity.

**Tech Stack:** Unchanged. No new library. One migration.

**Spec:** `docs/superpowers/specs/2026-11-13-visto-ai-design.md`. Executors read both. Section numbers below refer to it: 5.2 (modes, what a run reads, the increment), 5.3, 5.6 step 7, 5.7, 6.2 (blocks, scores across reviews, D17), 8.5, 12 (coverage carried between runs), 13.

**Notes:** `docs/superpowers/plans/2026-11-20-scores-that-hold-and-reading-less-notes.md` is written when the build ends. The notes of plan 6 end with "Verified with a real app": on a real pull request an unchanged file was scored on both sides of the threshold in consecutive reviews. That is what Tasks 1 to 5 are for.

**This plan was reviewed before it was built,** and its first version had seven sequences of reviews in which a score fell, could be bought, or a file was never read again. Tasks 2 to 4 and 6 to 9 are written from that review. Each of those sequences is a test below, named after what it guards. A second review of the rewrite found no such sequence left and five important defects of other kinds; they are corrected here too (Review Focus 13 to 16, calls 11 and 20 to 22).

## Scope

| In this plan | Left out, and why |
|---|---|
| 6.2, D17: a block is scored once; a block that left and came back takes its score again; a new or edited block cannot score below the highest score a block of its file had and lost; a whole-file score never falls; a renamed or moved file keeps its history; a score is reused for 30 days by other pull requests of the repository | **`file_scores` as a table:** a file's history is read from the stored results of the pull request's runs (call 2). **Reuse across pull requests for a hunk that was split:** call 5 |
| 5.2: `incremental` and the setting that chooses it (D4); `recheck`; which files a run reads, in every mode; the increment by diff hash | **"The earlier head can no longer be read":** call 8 |
| 5.3: in an incremental review and a re-check, the last review's overview | **Its acceptance rows:** stage 6, with the extensions that supply criteria |
| 12: coverage carried between runs: a file not yet covered is read by the next run in any mode, before files being read again | Nothing |
| 5.6 step 7: a finding on a line unchanged since the file was last read, by severity; and the count of such blocking findings in a `full` review of a later head | Nothing |
| 5.7: the first line of an incremental or re-check review; `On code unchanged since the last review` | Nothing |
| 8.5: the last published review, for planning, is the newest published run that is not a `recheck` | Nothing |
| | **Inline notes (D22)** and their place in the publishing fallback (8.3), and **the app manifest (10):** the next plan, before the gate |

**Dry run does not change.** A dry run never counts as an earlier run (11.1): in dry run every head is reviewed in full with no history, and nothing is stored for reuse.

## Calls made in this plan

None of these is in the design. Each is the planner's call, listed so the owner can overrule it.

1. **Inline notes and the app manifest are left to the next plan.** They need none of this, and with them the plan would have thirteen tasks.
2. **A pull request's score history is read from the stored results of its runs,** not from a `file_scores` table. The job already reads those runs, and they hold every block, every hash and every whole-file score. Only the lookup across pull requests needs a table. Cost if wrong: a table later, filled from the same results.
3. **A score is reused across pull requests through a function the engine is given,** because the engine learns a block's hash only after it has read the diff. A lookup that fails is logged and the review goes on without it: those blocks then get a fresh score, which is stored for others like any other.
4. **Storing scores for other pull requests is a best effort.** The rows are written after the run is recorded; a write that fails is logged and not tried again.
5. **A hunk that was split is not reused across pull requests,** only inside its own. The table keeps one row for each block or part by its own hash; putting a split hunk together again in another pull request would need the hunk's hash and each part's place as well. Cost: opening the same change again gives every block the model split (a long new file, mostly) a fresh score. 6.2 says reopening gives no second roll.
6. **For a hash that was scored more than once, the highest score stands:** among the blocks of one run that share their changed lines, among the runs of a pull request stored before this plan (which scored everything each time), and among the rows other pull requests stored in the window. 6.2 says "share one stored score" and does not say which.
7. **Lines changed since a file was last read are found on the new side by comparing the file at the two heads,** as the design says. On the old side (removed lines) a line counts as changed when its block is new since then. A removed line seldom takes a finding, and finding out line by line would take the file at a third commit.
8. **When the file cannot be read at the earlier head** (it is absent there, or that commit is gone), every line of it counts as changed. The run stays `incremental`; 5.2 would make it `full`.
9. **"Since the last review" is measured, for each file, from the last published review that read that file,** not from the last review of the pull request. 5.6 says "every line of a file read before"; with coverage carried between runs, the last review may have listed a file as not reviewed, and its lines must not then count as seen.
10. **The model is told which lines changed in the file's header,** as a list of line ranges, not by a mark on each line. The diff's own format does not change.
11. **No model call, and what is then posted.** When an incremental review or a re-check has no file to send, the model is not called. If such a review would tell a person exactly what the newest published review already tells (the same threshold, the same score for every file, the same blocks at or above the threshold, the same files not reviewed) and no thread is due, a push gets nothing: the job ends as `nothing_new`. In every other case, and whenever a person asked, the review is posted like any other, with its `Human review`, `Coverage` and `Overall`. Cost of `nothing_new`: that head has no published review of its own. A `/review` on it is then an incremental review with no model call, and the stages that will ask for "the review of the current head" (approval, the gate) must take a review of an earlier head that says the same, or ask for one.
12. **`newHead` is read as `incremental` when it is not written.** D4 says an unset setting gives a gated pull request `full`; there is no gate yet. The setting keeps "not written" apart from `incremental`, so the gate's plan can apply D4's rule without changing its type.
13. **A file takes no new whole-file score while its diff is the one a published review of this pull request read,** with every block of it scored, and its header then says so in words of its own (6.2: while a file's diff is unchanged nothing is scored again). A file whose diff is new, or that no published review has read under its present path, can always be given a whole-file score, or a higher one, also when every block of it already has its score. The contract files are not edited: the sentence is the file header's.
14. **A first review is sent exactly what it is sent today,** unless another pull request of the repository stored a score for one of its blocks in the last 30 days. Then that block's header says `scored`, as the contract already describes. Its stored result gains one field, and a second with a scorer: each part of a split hunk now records where it sits, and each entry a second scorer gave says so.
15. **`blockingOnUnchanged` is kept in the run's stored result and in the log entry,** not in a column of its own.
16. **A base branch is stored with each run from now on.** A run stored before has none, and a later head of such a pull request is reviewed in full once.
17. **A stored score says who gave it: the review model or the second scorer.** Only scores from the one in force are kept or reused. 6.7 says the two are not on the same scale. Cost: when a deployment names a scorer, or drops it, every open pull request is scored afresh once, and every file with blocks is sent to the review model again at its next review. Dropping a scorer brings back the scores the review model gave before it was named. A result stored before this plan under a scorer does not say so, and reads as the review model's.
18. **A split hunk whose parts cannot be put back is asked again whole.** That is a hunk a review stored before this plan had split (its parts did not record where they sat), asked again once; and any split hunk in which a line changes. No part of it can then score below the highest score one of its parts had, and the review words that as a block the file lost, though some of those lines are still there.
19. **Reuse by path and hash is built as the design has it, with no guard, and that has a cost the owner should weigh.** A block's hash is its added and removed lines and nothing else: not where they stand, not the lines around them. An author can have lines scored where they are harmless (in another pull request, or in an earlier push of the same one) and then move them to where they matter; the stored score is reused there and the model is not asked. The design's own gaps are fresh rolls; this is a score picked beforehand. A guard would make the key for reuse cover the lines around a block as well, which changes what the design's hash is. Not built; put to the owner. Two more costs come with the design's rules as written. A score stored by any pull request counts, one from a fork too, and the highest wins: anyone who can open a pull request can raise the score others reuse for a block for 30 days (that errs towards a person). And the floor holds a block only when it is scored: an author who pushes several variants of a block has each scored, and a later push that keeps the lowest keeps its score.
20. **A file this run should have read and could not** (a failed call, or no room left) **counts as 100 whatever scores it keeps,** as it does today. A file that an earlier review covers and that only found no room is not such a file: it is scored from what it keeps.
21. **A careless answer is not asked again.** A file whose answer named a block the file does not have, or gave a whole-file score that is none, counts as 100 in that review. The valid block scores of that same answer stand from the next review on, and the whole-file score it garbled is not asked for again.
22. **A moved file is shown to the model once.** Once it has a whole-file score it is left out of every later review, in every mode: it has no diff to read. It answers to the score its path, or the path it came from, was ever given as a whole, so a file that was changed, scored as a whole, then put back and moved keeps that score and the move itself is not scored.
23. **`On code unchanged since the last review` stands before `Findings not placed on the diff`** when both exist; 5.7 lists it after. The sections from the unplaced findings on are kept whole when a long body is cut, and this one has no cap: standing among them, a long one would push `Overall` out of the posted review.
24. **A file the pull request adds answers to the history of any other path that held one of its blocks.** GitHub shows a file that is new to the pull request, and that a later push renames, as added under its new name, with no earlier name; by 6.2's rule (history by path) its scores would start afresh, with no floor. The rule holds a new file that is moved or copied with its content unchanged, also when the model had scored it as a whole only. It does not hold a new file that is renamed and edited in the same push: a new file is one block, so any edit gives it a fresh score with no floor. A small added file whose whole content equals a hunk of another file takes that file's history too; the pull request's highest score does not change by it. Asked whether a new file should also be held to the scores of files that left the diff in the same push, the owner ruled that it should not.

## Global Constraints

Every constraint of plans 1 to 6 still holds. The ones that bite most often, and the new ones:

- **Runtime and language:** Node 26 or later, npm, no build step. Erasable TypeScript only. Type imports use `import type`. Relative imports end in `.ts`.
- **ASCII only in source and tests.** A non-ASCII character is written as an escape. After each task: `LC_ALL=C grep -rn -P '[^\x00-\x7F]' src contract test` prints nothing.
- **No test reaches the network or a real database.** Database tests use `testDb()`.
- **A first review's requests do not change.** With no history, no reusable score and `mode` absent or `full`, the messages, the tool and the parsing are byte for byte what they are on `main`. `contract/review-contract.md` and `contract/review-contract-scorer.md` are not edited. The eval commands pass no history and no mode and are not changed.
- **A score never falls while its block stays in the diff.** No path through reconcile may give a block, or a file as a whole, a lower score than an earlier run of the same pull request left it with, whatever the model answers: a lower block score, a whole-file score in place of a block score, nothing at all, or something malformed.
- **Nothing learned lowers a score (D8).** A stored score is only ever kept or raised.
- **A whole-file score stands only for a block somebody could have scored.** It stands for a block that a covered run left under it, and for a block of this run that no item named. Never for a block an item named without a usable score, and never for a new block under a score kept from an earlier run.
- **A stored result may be old or damaged.** A result stored before this plan has none of the new fields; every reader treats an absent field as empty, null or 0, skips an entry whose score is not a whole number from 0 to 100, and never throws.
- **Writes to the git service happen only through `ForgeWriter`,** never in dry run, each once. Nothing unpinned is ever posted (D20).
- **Boundaries, enforced by lint:** only `src/db/**` imports a Postgres client. `src/engine/**` imports nothing from `db`, `shell`, `eval` or `forge/github`. `src/db/**` imports nothing from `src/engine/**`.
- **SQL:** every value is a numbered parameter; every table is written with its schema; times come from the caller as ISO 8601 strings.
- **Nothing inside a transaction catches a statement's error and goes on.**
- **Logs** carry ids, names, codes and counts; never a score's reason, a finding's text, a token or an error's message.
- **Fixtures are synthetic and invented:** `acme/shop`, pull request 7, logins such as `octo-dev`, installation `99`.
- **Commits:** one per task unless a step says otherwise, message in the house style, ending with the co-author line the implementer's own session gives. Nothing is pushed.

## Review Focus

Sequences and inputs no happy-path test would meet. Each has a test in the task named.

1. **The model answers an edited block with a whole-file score and no entry for the block.** The block still cannot score below the floor. Task 4.
2. **A part of a split hunk becomes a hunk of its own** (the other part moved away). It keeps its score, and its score is not forgotten. Tasks 3 and 4.
3. **A score found on another pull request for an edited block** is still raised to the floor. Task 3.
4. **Two blocks of one file with the same changed lines,** scored differently: both keep the higher. Task 2.
5. **A file moved to another directory:** its whole-file score is kept, and it is not sent again. Tasks 3 and 6.
6. **A block an item named without a usable score, beside a whole-file score:** the next review asks for it again; it is never taken for a block the file's score stood for. Tasks 2 and 4.
7. **A hunk split in a first review:** in the second review the file is not sent, and its parts have the same scores. Tasks 4 and 6.
8. **A file the last review listed as not reviewed:** a re-check reads it, and its lines count as changed since the review that did read it. Task 7.
9. **A result stored before this plan** (no `range`, no `by`, no `mode`, no base branch): its scores are still history; a hunk it split is asked again; a `/review` on its head is a re-check that reads what it must. Tasks 2, 6 and 9.
10. **A rebase that only moves code:** the same block at other line numbers keeps its score, and its lines are not changed. Tasks 3 and 7.
11. **A careless answer about a file that has nothing left to score** (a score for a hunk marked `scored`, an invalid whole-file score, an id the file does not have): the file's scores do not move. Task 4.
12. **A push that changes nothing in the diff** (the base branch merged in), and **a push that only adds a file nobody can read:** the first ends as `nothing_new`, the second is posted. Tasks 6 and 9.
13. **A push that puts back a flagged block the newest review no longer listed,** or adds a file scored by a fixed rule: every score is kept and no file is sent, and still a review is posted, because it says something the newest one does not. Tasks 2 and 6.
14. **A file with a character stripped from a changed line** (a byte order mark, a direction mark in a translation): it counts as 100 and its stored result never says "covered", yet it is read once and then left out. Tasks 2 and 6.
15. **A pull request too large for one review, where every head is reviewed in full:** a file an earlier review covers and that finds no room this time keeps its scores and is not listed as not reviewed. Task 6.
16. **Two results stored before this plan, one that scored a hunk whole and a later one that split it:** the hunk does not stand below its highest part. Task 2.
17. **The same change opened again as another pull request, where the first had a whole-file score above its blocks:** the blocks are reused, and the file can still be given its whole-file score. Task 3.
18. **A file the pull request adds, renamed by a later push with the same content:** it keeps its scores. **A reviewed file moved to another directory with the same change:** it is read once where it now stands. Task 3.
19. **A hunk whose parts the model lists out of line order:** the parts are kept at the next review. Task 2.

---

### Task 1: Storage for scores other pull requests can reuse, and a run's base branch

**Files:**
- Create: `src/db/migrations/0004_scores.sql`, `src/db/block-scores.ts`
- Modify: `src/db/review-runs.ts`, `src/shell/review-job.ts` (it passes `baseBranch`; nothing else)
- Test: `src/db/block-scores.test.ts` (new), `src/db/review-runs.test.ts`, `src/db/migrate.test.ts`; and the typed fixtures that build a `RunRecord` or a `StoredRun` by hand gain `baseBranch: null`: `src/service.test.ts`, `src/shell/spend.test.ts`, `src/shell/publish.test.ts`, `src/shell/earlier.test.ts`, `src/shell/review-job.test.ts`, `src/shell/later-review.test.ts`

**Interfaces:**
- Produces:

```ts
// src/db/block-scores.ts
export interface StoredBlockScore { path: string; hash: string; score: number; category: string; reason: string }
/** Stores the scores a run gave, one row each. `by` says who gave them; `at` is when the run finished. */
export function recordBlockScores(db: Db, runId: number, ref: PullRequestRef, by: 'model' | 'scorer', scores: StoredBlockScore[], at: string): Promise<void>;
/** For each (path, hash) asked: the highest score stored for it, by `by`, by another pull request of the same repository at or after `since`. */
export function reusableScores(db: Db, ref: PullRequestRef, by: 'model' | 'scorer', blocks: Array<{ path: string; hash: string }>, since: string): Promise<StoredBlockScore[]>;
// src/db/review-runs.ts
// RunRecord.mode and StoredRun.mode become 'full' | 'incremental' | 'recheck'. RunRecord gains baseBranch: string | null.
```

**Rules:**

1. The migration creates `visto_ai.block_scores (id, run integer not null, service, owner, repo, number, path text not null, hash text not null, score integer not null check (score between 0 and 100), category text not null, reason text not null, scored_by text not null, scored_at timestamptz not null)` with an index on `(service, owner, repo, path, hash, scored_at)`, and adds `base_branch text` to `visto_ai.review_runs`.
2. `recordBlockScores` writes nothing for an empty list. Owner and repository are stored in lower case, as everywhere.
3. `reusableScores` answers for an empty list without a query. It never returns a row of the pull request `ref` names, nor one given by the other scorer. For a pair stored several times it returns the row with the highest score, the newest on a tie (call 6). A pair nobody stored is absent from the answer. At most 500 pairs are asked in one statement; more are asked in further statements.
4. `recordRun` stores `baseBranch`; the readers return it (null for a row stored before). The job passes the live pull request's base branch, and null when the run failed before the pull request was read.

- [ ] **Step 1: Write the failing tests.**

```ts
// block-scores.test.ts
const A = { path: 'src/a.ts', hash: 'h1', score: 70, category: 'calculation', reason: 'Totals.' };
test('a score stored by one pull request is found by another, and never by itself', async () => {
  await recordBlockScores(db, 1, REF, 'model', [A], at(0));
  assert.deepEqual(await reusableScores(db, OTHER, 'model', [{ path: 'src/a.ts', hash: 'h1' }, { path: 'src/a.ts', hash: 'h9' }], at(-60)), [A]);
  assert.deepEqual(await reusableScores(db, REF, 'model', [{ path: 'src/a.ts', hash: 'h1' }], at(-60)), []);
});
test('only a score of the last 30 days is reused: the caller says since when', async () => { /* since = at(1) -> [] */ });
test('the highest score stored for a block is the one reused, the newest on a tie', async () => { /* rows from three pull requests: 80 at(0), 40 at(10), 80 at(20) with another reason: the 80 of at(20) */ });
test("the review model's scores and the scorer's are kept apart", async () => { /* stored by 'scorer', asked as 'model': [] */ });
test('another repository, another path or another hash is another block', async () => { /* [] each */ });
test('owner and repository are matched whatever their case', async () => { /* stored as Acme/Shop, asked as acme/shop */ });
test('nothing asked, nothing stored: no statement is sent', async () => { /* a db whose query throws */ });
test('a score outside 0 to 100 cannot be stored', async () => { /* rejects */ });
test('more than 500 blocks are asked in several statements, and all are answered', async () => { /* 501 pairs stored and asked */ });
// review-runs.test.ts
test("a run keeps its base branch and its mode, and a row stored before has no base branch", async () => { /* baseBranch 'main', mode 'incremental'; a row inserted without the column reads null */ });
// migrate.test.ts: the ledger holds 0004_scores after the others.
```

- [ ] **Step 2: Run them and see them fail** for the missing module and column.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: storage for the scores other pull requests can reuse, and a run's base branch`.

---

### Task 2: A pull request's score history

**Files:**
- Modify: `src/engine/score/types.ts`, `src/engine/types.ts`
- Create: `src/shell/history.ts`, `src/engine/score/shown.ts`
- Test: `src/shell/history.test.ts`, `src/engine/score/shown.test.ts` (both new)

**Interfaces:**
- Produces, in `src/engine/score/types.ts`:

```ts
export type ScoredBy = 'model' | 'scorer';
/** The highest score a block or a part with this hash had of its own at the end of an earlier run. */
export interface StoredEntry { hash: string; entry: ScoreEntry; raisedFrom: number | null }
/** A hunk an earlier run split into parts that covered all its changed lines. */
export interface StoredSplit { hunkHash: string; parts: Array<{ hash: string; range: [number, number] }> }
export interface FileHistory {
  path: string;
  blocks: StoredEntry[];            // one for each hash
  splits: StoredSplit[];            // one for each hunk hash: the newest run's parts
  stoodFor: string[];               // hashes of blocks a covered run left with no entry of their own, under the file's whole-file score
  wholeFile: ScoreEntry | null;     // the highest whole-file score an earlier run left the path with
  coveredAt: string[];              // the diff hashes at which a published run read the file
  readAt: { head: string; hashes: string[] } | null;   // the newest published run that read the file: its head, and every block, part and hunk hash the file had in it
}
export interface ScoreHistory {
  by: ScoredBy;                     // whose block scores these are
  lastReview: { head: string; overview: string } | null;   // the newest published run that is not a re-check
  shown: string | null;             // what the newest published run of any mode told a person: `shownOf` its result
  files: FileHistory[];
}
```

  `BlockScore` gains four optional fields, each absent on a result stored before this plan:

```ts
origin?: 'earlier_run' | 'other_pull_request';   // the score was not given in this run
raisedFrom?: number;                              // the score that was given, before the floor raised it
range?: [number, number];                         // a part: the places of its first and last changed line among its hunk's changed lines
by?: ScoredBy;                                    // who gave the score; absent reads as 'model'
```

  `ReviewInput` gains `history?: ScoreHistory | null` and `mode?: 'full' | 'incremental' | 'recheck'` (absent reads as none, and `full`).
- Produces, in `src/shell/history.ts`:

```ts
/** What the engine is told about the scores of a pull request's earlier runs. `by` is the scorer in force. */
export function historyOf(args: { runs: StoredRun[]; last: StoredRun | null; by: ScoredBy }): ScoreHistory;
/** The newest published run that is not a re-check; null when there is none. */
export function lastReviewOf(runs: StoredRun[]): StoredRun | null;
/** The scores a run gave, for other pull requests to reuse. */
export function scoresToStore(result: unknown): Array<{ path: string; hash: string; score: number; category: string; reason: string }>;
```
- Produces, in `src/engine/score/shown.ts`:

```ts
/**
 * What a review tells a person about scores and coverage, as one text that can be compared: the threshold, every file's path and final score,
 * every block at or above the threshold by path, hash and score, every file-level score at or above it with its source, and each path not reviewed
 * with its reason, each list sorted. Null when the result cannot be read.
 */
export function shownOf(result: unknown): string | null;
```

**Rules:**

1. **Earlier runs** are the runs that are not dry runs and ended `ok`, in the order of their ids. Their stored `result` is read defensively: a file, a block or an entry that is not of the expected shape, or whose score is not a whole number from 0 to 100, is skipped, never thrown on.
2. A file's history is kept under the path each run knew it by.
3. **`blocks`.** For each hash, over every block and part of the path, in every earlier run, that had an entry and was given by `by` (a block with no `by` was given by `model`): the entry with the highest score; on a tie one that was not raised before one that was, then the newest run's; with its `raisedFrom` (null when absent). Two blocks of one run with the same hash and different scores therefore both stand at the higher (call 6). And a hunk does not stand below its own parts: when an earlier run used a hash as the `hunkHash` of parts that had entries, the entry for that hash is not below the highest of those parts; the higher stands, with its category and reason.
4. **`splits`.** For each hunk hash: the parts of the newest earlier run in which the path had blocks with that `hunkHash` that were parts (`range` present on each of them), every one of them with an entry given by `by`, and no block of that hunk without a range. A run that left a remainder, or whose parts have no `range` (a result stored before this plan), gives no split. The parts are kept in the order of their ranges, whatever order the model listed them in.
5. **`stoodFor`.** The hashes of blocks that had no entry, in an earlier run in which the file's `covered` was true and its `wholeFile` was not null. A file is covered only when every block has a score, its own or the file's (5.2), so a block an item named without a usable score, and a block of a file the model did not answer for, never get here. A hash that is in `blocks` is not in `stoodFor`. With `by` `scorer`, `stoodFor` is empty.
6. **`wholeFile`** is the highest `wholeFile` entry any earlier run left for the path, the newest on a tie; null when none did.
7. **`coveredAt`** holds every non-null `diffHash` the path had in a **published** run that had the path in `coverage.reviewed`. The stored `covered` flag is not asked: whether every block has a score is asked afresh, of what the history keeps (Task 3). A file that counts as 100 for a character stripped from a changed line is stored as not covered in every run, and would otherwise be sent again in every review.
8. **`readAt`** is taken from the newest published run that has the path in `coverage.reviewed`: its `headSha`, and the `hash` and the `hunkHash` of every block the path had in it, with or without an entry. Null when no published run read the file.
9. **`lastReview`** is null when `last` is null; else `last.headSha` and its result's `overview` (`''` when it cannot be read). **`shown`** is `shownOf` the result of the newest published earlier run of any mode, a re-check too; null when there is none.
10. `shownOf` reads the result defensively and answers null when its `scores`, its `verdict.threshold` or its `coverage.notReviewed` cannot be read. Otherwise it answers one JSON text of: the threshold; `[path, finalScore]` for every file, sorted by path; `[path, hash, score]` for every block that has an entry at or above the threshold, sorted; `[path, fileLevel.score, fileLevel.source]` for every file whose file-level score is at or above the threshold, sorted; `[path, reason]` for every file not reviewed, sorted. Two results give the same text exactly when `Human review` and `Coverage` would name the same things with the same scores.
11. `lastReviewOf`: the newest run that is `published` and whose `mode` is not `recheck`.
12. `scoresToStore`: one entry for each block of the result that has an entry and no `origin`, with the score that was given: `raisedFrom` when it is a number, else `entry.score`. A block's path is its file's. Parts are stored like any block, by their own hash.

- [ ] **Step 1: Write the failing tests** in `src/shell/history.test.ts`, with `run(id, over)` building a stored, not-dry, `ok` run whose result holds the given files, `file(path, blocks, over)` a `FileScore`, and `blk(hash, score, over)` a `BlockScore`:

```ts
const of = (runs: StoredRun[], last: StoredRun | null = null, by: ScoredBy = 'model') => historyOf({ runs, last, by });
test('a block keeps the highest score any earlier run left it with', () => {
  const h = of([run(1, { scores: [file('src/a.ts', [blk('h1', 80)])] }), run(2, { scores: [file('src/a.ts', [blk('h1', 40), blk('h2', 60)])] })]);
  assert.deepEqual(h.files[0]!.blocks.map((b) => [b.hash, b.entry.score]), [['h1', 80], ['h2', 60]]);
});
test('two blocks of one run with the same changed lines both stand at the higher score', () => {
  assert.deepEqual(of([run(1, { scores: [file('src/a.ts', [blk('h1', 30), blk('h1', 80)])] })]).files[0]!.blocks.map((b) => b.entry.score), [80]);
});
test('a score that was raised keeps what was given beside it', () => { /* blk('h1', 85, { raisedFrom: 30 }) -> raisedFrom 30 */ });
test('a dry run, a failed run, a result that is not a result and a score that is not a score are not history', () => { /* files [] ; a block with score 150, 12.5 or 'x' is skipped and the others kept */ });
test("the scorer's scores and the review model's are separate histories", () => { /* a block with by 'scorer': in the history asked with 'scorer', absent from the one asked with 'model'; a block with no by is the model's */ });
test('a hunk that was split is remembered with its parts only when they covered it', () => {
  const parts = [blk('p1', 15, { hunkHash: 'H', range: [0, 19] }), blk('p2', 92, { hunkHash: 'H', range: [20, 39] })];
  assert.deepEqual(of([run(1, { scores: [file('src/a.ts', parts)] })]).files[0]!.splits, [{ hunkHash: 'H', parts: [{ hash: 'p1', range: [0, 19] }, { hash: 'p2', range: [20, 39] }] }]);
  /* with a remainder (a block of hunk H with no range and no entry): splits []; with parts that have no range (an old result): splits [] and both hashes still in blocks */
});
test('a block is remembered as stood for only by a run that left the file covered', () => {
  const stood = (over: Partial<FileScore>) => of([run(1, { scores: [file('src/a.ts', [blkNoEntry('h1')], { wholeFile: entry(60), covered: true, ...over })] })]).files[0]!.stoodFor;
  assert.deepEqual([stood({}), stood({ covered: false }), stood({ wholeFile: null })], [['h1'], [], []]);
});
test('a whole-file score is never forgotten', () => { /* run 1: 60; run 2: none -> 60; run 3: 40 -> 60 */ });
test('a file is covered at a diff by a published run that read it there, whatever that run left unscored', () => { /* an unpublished run that read it -> coveredAt []; published and in coverage.reviewed -> ['d1'], with covered true or false; published and not in coverage.reviewed -> [] */ });
test('a file was last read at the head of the newest published run that read it, not at the last review', () => {
  /* run 1 published at h0 reads a.ts; run 2 published at h1 lists a.ts as not reviewed: readAt.head 'h0' with run 1's hashes; lastReview.head 'h1' */
});
test('the last review is the newest published run that is not a re-check, and what was last shown is the newest published run of any mode', () => {
  /* runs: published full 1, published recheck 2, unpublished 3: lastReviewOf -> run 1; lastReview { head, overview } are run 1's ('' for a result with no overview);
     shown equals shownOf(run 2's result); with no published run both are null */
});
test('a hunk one old review scored whole and a later one split does not stand below its highest part', () => {
  /* Review Focus 16. run 1: blk('H', 50); run 2: parts blk('p1', 15, { hunkHash: 'H' }) and blk('p2', 92, { hunkHash: 'H' }), no ranges:
     blocks has H at 92 with p2's category and reason, p1 at 15, p2 at 92 */
});
test('only what a run gave is stored for others, with the score that was given', () => {
  const result = { scores: [file('src/a.ts', [blk('h1', 40), blk('h2', 80, { origin: 'earlier_run' }), blk('h3', 90, { raisedFrom: 30 }), blk('h4', 70, { origin: 'other_pull_request' }), blkNoEntry('h5')])] };
  assert.deepEqual(scoresToStore(result).map((s) => [s.hash, s.score]), [['h1', 40], ['h3', 30]]);
  assert.deepEqual(scoresToStore({}), []);
});
// shown.test.ts
test('what a review shows is the same text for the same scores in any order, and another for any difference a person would see', () => {
  /* the same files and blocks in another order: equal. Each of these alone makes it differ: another threshold; a file more; another final score for a file;
     a block at or above the threshold more, or with another hash; another path not reviewed. A block below the threshold that differs does not */
});
test('a result that cannot be read shows nothing', () => { /* {}, null, a result without verdict.threshold: null */ });
```

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the suite, the type check, the lint and the ASCII check. Every test that existed passes unchanged.
- [ ] **Step 5: Commit** `feat: a pull request's score history is read from its earlier runs`.

---

### Task 3: What a file's history already settles

**Files:**
- Create: `src/engine/score/history.ts`
- Modify: `src/engine/types.ts`, `src/engine/score/blocks.ts`, `src/engine/context/build.ts`, `src/engine/context/diff.ts`, `src/engine/context/section.ts`, `src/engine/scorer/ask.ts`, `src/engine/review.ts`
- Test: `src/engine/score/history.test.ts` (new), and the tests beside each modified file

**Interfaces:**
- Consumes: `ScoreHistory`, `FileHistory`, `StoredEntry`, `StoredSplit` (Task 2); `blocksOf`, `splitBlock`, `fileDiffHash`.
- Produces:

```ts
// src/engine/types.ts: ReviewDeps gains
/** The highest scores other pull requests of the repository stored for these blocks in the last 30 days. May reject. */
reusableScores?: (blocks: Array<{ path: string; hash: string }>) => Promise<Array<{ path: string; hash: string; entry: ScoreEntry }>>;
// src/engine/score/blocks.ts
/** The places of a part's first and last changed line among its hunk's changed lines. */
export function rangeOf(hunk: Block, part: Block): [number, number];
/** The parts of a hunk at these ranges, as splitBlock cuts them; null when a range is outside the hunk or the parts leave a remainder. */
export function partsAt(hunk: Block, ranges: Array<[number, number]>): Block[] | null;
// src/engine/context/build.ts: FileContext gains
kept?: KeptScores;
// src/engine/score/history.ts
export interface KeptEntry { entry: ScoreEntry; origin: 'earlier_run' | 'other_pull_request'; raisedFrom: number | null; range: [number, number] | null }
export interface KeptScores {
  blocks: Block[];                  // the file's blocks, with a split hunk replaced by its kept parts
  entries: Map<string, KeptEntry>;  // by block id
  stoodFor: Set<string>;            // ids of blocks with no entry that the kept whole-file score stands for
  wholeFile: ScoreEntry | null;     // the whole-file score the file keeps
  floor: number;                    // the highest stored score whose hash no present block has; 0 when none
  settled: boolean;                 // every block has a kept entry or is stood for (a moved file: it keeps a whole-file score): nothing is left to ask
  covered: boolean;                 // settled, and a published run read the file with the diff it has now (a moved file: settled)
  scoredHunks: Set<string>;         // ids of hunks whose header says `scored`
  readAt: { head: string; hashes: Set<string> } | null;
}
/** Works out, for one file, what its history already settles. `reused` are the scores other pull requests stored for its blocks. */
export function keptScores(context: FileContext, history: ScoreHistory | null, reused: Array<{ hash: string; entry: ScoreEntry }>): KeptScores | null;
/** The blocks of these files that the history does not settle, for the lookup across pull requests. */
export function blocksToLookUp(contexts: FileContext[], history: ScoreHistory | null): Array<{ path: string; hash: string }>;
```

  `renderAnchoredDiff(hunks, scored?: ReadonlySet<string>)`: a hunk whose id (`B<n>`) is in `scored` is headed `### Block B3 (12 changed lines, scored)`.

**Rules:**

1. **Whose history.** A file's history is the entry of `history.files` for its `path`, joined with the entry for its `previousPath` when it has one: the higher entry for each hash, the splits of both (the path's own first), both `stoodFor`, the higher `wholeFile`, and the `readAt` of the path, else of the earlier name. `coveredAt` is the path's own: a file is covered only where it now stands. A file the pull request adds (status `added`, no earlier name) that has no history of its own answers, in the same way, to the history of every other path that held one of its blocks: as a block's own score, as a block a whole-file score stood for, or as the hunk of a split (call 24). `keptScores` returns null for a file whose plan is `rule` or `none`, and for a file with no history and no reused score.
2. **A moved file** (plan `model_whole`) has no block and no diff. It keeps `wholeFile`, and it is `settled` and `covered` when that is not null (call 22).
3. **A block of a `model` file is kept,** in this order:
   - its hash has a `StoredEntry`: the entry stands, with its `raisedFrom`, origin `earlier_run`. A part that has become a hunk of its own is kept this way;
   - else a `StoredSplit` has this block's hash as its `hunkHash`: `partsAt` is called with its ranges. When it answers parts, each part's hash is the stored part's at that place, and each of those hashes has a `StoredEntry`, the hunk is replaced by its parts, each kept with its entry and its range. Otherwise the hunk is not kept;
   - else its hash is in `stoodFor` and the file keeps a whole-file score: the block has no entry of its own and the file's score stands for it;
   - else a reused score for its hash: the entry stands with origin `other_pull_request`, raised to `floor` when it is below it, with `raisedFrom` then the reused score. Its reason is not kept: it was written about another pull request. A block found on another pull request is new to this one, and the floor holds for it.
4. With `history.by` `scorer`, a `model` file keeps no whole-file score and no block is stood for: those are the review model's.
5. **`floor`** is the highest entry score among the history's `blocks` whose hash no present block has, the parts of rule 3's second way counted as present.
6. **`settled`** and **`covered`** are one thing for a file with blocks: every block has a kept entry or is stood for, and the file's `diffHash` is in `coveredAt`. A file whose blocks all have a score and whose diff no published review has read here is not settled: it is sent, its hunks say `scored`, and it may take a whole-file score (call 13). **`scoredHunks`:** the ids of the hunks kept in any of the four ways.
7. **In `review()`,** right after the contexts are built and before the threads are attached, on the built contexts themselves (the copies `attachThreads` makes then carry `kept`): `blocksToLookUp` lists the blocks of `model` files that rule 3's first three ways do not settle; when the list is not empty and `deps.reusableScores` is given, it is called once. A rejection adds `{ stage: 'context', action: 'reuse_failed', subject: 'scores', reason: <the error's short code, else internal_error> }` and counts as an empty answer. An answer for a pair that was not asked, or whose score is not a whole number from 0 to 100, is not used. Then `keptScores` is set on each context as `kept`, and the context's `diffText` is rendered again with `scoredHunks`.
8. **The file's header** (`fileSection`): for a `model` file whose `kept.settled` is true, the line `whole-file score: allowed` is replaced by `whole-file score: not allowed. Every block of this file already has its score.`
9. **The second scorer** is asked only for the hunks of a file that are not in `scoredHunks`, and not at all for a file with none.
10. **Without history and without a reused score nothing changes (call 14):** `kept` is not set, and every message is what it was.

- [ ] **Step 1: Write the failing tests.** In `src/engine/score/history.test.ts`, with `ctx(path, patch)` building a `FileContext` through `hunksOf` and `blocksOf`, `hist(over)` a `FileHistory` for `src/a.ts`, and `H(files)` a `ScoreHistory` by `model`:

```ts
test('a block whose hash has a stored score keeps it and is not to be scored', () => {
  const c = ctx('src/a.ts', PATCH_TWO_HUNKS);
  const k = keptScores(c, H([hist({ blocks: [stored(c.blocks[0]!.hash, 70)] })]), [])!;
  assert.deepEqual([...k.entries].map(([id, v]) => [id, v.entry.score, v.origin]), [['B1', 70, 'earlier_run']]);
  assert.deepEqual([[...k.scoredHunks], k.settled, k.floor], [['B1'], false, 0]);
});
test('the same block at other line numbers is the same block', () => { /* the stored hash is from the patch shifted down by ten lines */ });
test('a hunk an earlier run split keeps its parts when they still cover it', () => { /* a 40-line hunk; a split with ranges [0,19] and [20,39] and both part hashes stored: k.blocks ids are B1.1, B1.2, both kept with their ranges; scoredHunks has B1; settled */ });
test('a split that no longer fits does not keep the hunk', () => { /* a range beyond the hunk; a part whose hash differs; a part hash with no stored entry: the hunk stays one block, not kept, and both part scores count in the floor */ });
test('a part that has become a hunk of its own keeps its score, and that score is not in the floor', () => { /* the present file is the 20 lines of the second part alone: B1 kept at 92; floor is 15, the lost part */ });
test('a block the file score stood for stays covered by it while the file keeps that score', () => { /* stoodFor has the hash, wholeFile 60: k.stoodFor has B1, scoredHunks has B1, no entry; with wholeFile null: not kept */ });
test('a score another pull request stored is used only for a block the history does not settle, and never below the floor', () => {
  /* reused 30 for B2, floor 0: entry 30, origin other_pull_request, raisedFrom null; with a lost block at 90: entry 90, raisedFrom 30; reused for B1 too, which has a stored score: earlier_run stands */
});
test('the floor is the highest score of a block the file lost', () => { /* history blocks h_gone 85 and the present B1 40: floor 85; with every stored hash present: 0 */ });
test('a file is settled when nothing is left to ask, and covered when a published run read it as it is', () => { /* both blocks kept: settled; coveredAt has the present diff hash: covered; one block not kept: neither, whatever coveredAt says */ });
test('a moved file keeps its whole-file score and is settled and covered by it', () => { /* plan model_whole, history wholeFile 75: wholeFile 75, settled, covered, blocks []; with no whole-file score: neither */ });
test("with the scorer in force the review model's whole-file score settles nothing for a file with blocks", () => { /* by 'scorer': stoodFor empty, wholeFile null */ });
test('a renamed file answers to the history of both its names', () => { /* history under old/a.ts and under src/a.ts: the higher entry for a hash, the higher whole-file score */ });
test('a renamed file with the same change is covered by the review that read it under its old name', () => { /* coveredAt and the blocks are under old/a.ts only: settled and covered */ });
test('a file with no history and no reused score, or one scored by rule, keeps nothing', () => { /* null */ });
test('the lookup asks only for blocks the history does not settle', () => { /* blocksToLookUp */ });
```

  Beside the modified files:

```ts
// blocks.test.ts
test('a part knows its place among the changed lines of its hunk, and the hunk can be cut there again', () => { /* rangeOf of the parts splitBlock made; partsAt(hunk, those ranges) gives parts with the same hashes; a range beyond the hunk, overlapping ranges and ranges that leave a remainder give null */ });
// diff.test.ts
test('a hunk that has its score says so in its header, and the others say what they said', () => { /* renderAnchoredDiff(hunks, new Set(['B2'])): 'B1 (.., not scored)', 'B2 (.., scored)'; with no set: the text of today */ });
// section.test.ts or prompt.test.ts
test('a file with nothing left to score is told it takes no whole-file score', () => { /* the header line */ });
// ask.test.ts
test('the scorer is asked only for hunks without a score, and not for a file that has none', () => { /* blocks: ['B2']; a settled file: no request */ });
// review.test.ts
test('a later review asks the model only for the blocks that have no score', async () => { /* history scores B1; the request's diff says 'B1 (.., scored)' and 'B2 (.., not scored)' */ });
test('a failed lookup across pull requests is named in the audit and the review goes on', async () => { /* reusableScores rejects Error('db_down'): audit reuse_failed db_down, status ok */ });
test('an answer of the lookup for a block that was not asked, or with a score that is none, is not used', async () => { /* */ });
test('with no history and no lookup the request is the one a first review sends today', async () => { /* deep-equal to the existing first-review request */ });
```

- [ ] **Step 2: Run them and see them fail.** The last test pins what must not change: it holds before and after.
- [ ] **Step 3: Implement.** `rangeOf` and `partsAt` first, then `keptScores`. Reconcile is not changed in this task, so a kept block the model does not answer for still counts as not scored at the end of the run; Task 4 changes that.
- [ ] **Step 4: Run** the suite, the type check, the lint and the ASCII check.
- [ ] **Step 5: Commit** `feat: a block that already has a score is shown as scored and not asked again`.

---

### Task 4: A score never falls

**Files:**
- Modify: `src/engine/reconcile/scores.ts`, `src/engine/review.ts`
- Test: `src/engine/reconcile/scores.test.ts`, `src/engine/review.test.ts`

**Interfaces:**
- Consumes: `FileContext.kept` (Task 3); `rangeOf`.
- Produces: `reconcileScores(answers, contexts, notRead, floors, by: ScoredBy = 'model')`. `BlockScore.origin`, `raisedFrom`, `range` and `by` are set as below.

**Rules (6.2, D17).**

1. **In every run, for every file:** a part the model splits off gets its `range` (`rangeOf`), and an entry given in this run gets `by` when it is `scorer`. Nothing else changes for a file without `kept`.

   For a file whose context has `kept`:

2. **Its blocks** are `kept.blocks`. A block with a kept entry has that entry, its `origin`, its `raisedFrom` when not null, its `range` when not null, and `by`.
3. **What the model may not say.** An item whose id is a kept block, a block that is stood for, or a hunk in `kept.scoredHunks` is not used: audit `{ stage: 'reconcile', action: 'block_already_scored', subject: '<path> <id>', reason: 'ignored' }`. When `kept.settled`, nothing the model sent about the file's scores is used: not a whole-file score, valid or not (audit `whole_file_settled`), and not an item for an id the file does not have (audit `block_not_in_file`, reason `ignored`). The file's scores are then exactly what it keeps.
4. **A block scored in this run** (not kept, not stood for) is scored as today. When its score is below `kept.floor`, the entry's score becomes the floor and `raisedFrom` is the score that was given; category and reason stay as given.
5. **The whole-file score** of a file that is not settled is the higher of the model's valid one and `kept.wholeFile`, the kept one on a tie; a model's lower one adds the audit entry `whole_file_kept`. A moved file that keeps a score is settled: rule 3 holds for it, and Task 6 never sends it.
6. **What a whole-file score stands for.** A block with no entry is stood for when its id is in `kept.stoodFor`, or when the model gave a valid whole-file score in this run and no item named the block. A whole-file score kept from an earlier run does not stand for any other block. When the model's whole-file score, as it was given, is below `kept.floor`, each block of the second kind gets an entry of its own at the floor, with that score's category and reason and `raisedFrom` that score: answering with a whole-file score in place of a block score cannot go under the floor.
7. **Not scored.** A file is not scored when some block has no entry and is not stood for; or, as today, when its plan is `none`, it holds hidden characters, or it is a moved file with no whole-file score, the model's or the kept one; or, for a file that is not settled, when the model sent an item for an id the file does not have, or an invalid whole-file score. A file that was left out (Task 6), or that the model sent no entry for, is scored when it is settled. A file in `notRead` is not scored and not covered, as today, whatever it keeps: a file nobody could read still counts as 100.
8. **Covered** is as today with "the model answered for it" replaced by the same test: every block has an entry or is stood for.

- [ ] **Step 1: Write the failing tests** in `src/engine/reconcile/scores.test.ts`, with `kept(over)` building a `KeptScores` for a two-hunk file, and `answer(file)` one model answer for it:

```ts
test('a kept block keeps its score whatever the model says about it', () => { /* entries B1 70 earlier_run; the model sends B1 10 and B2 30: B1 is 70 with origin earlier_run, B2 is 30; audit block_already_scored */ });
test('a new or edited block cannot score below a block the file lost', () => { /* floor 85; the model gives B2 30: entry.score 85, raisedFrom 30, the model's category and reason; a model score of 90 stays 90 with no raisedFrom */ });
test('a whole-file score in place of a block score cannot go under the floor', () => {
  /* one block, not kept; floor 90; the model answers score 20 for the file and no block: the block has an entry at 90 with raisedFrom 20, finalScore 90 */
});
test('a whole-file score at or above the floor stands for the block as it does today', () => { /* floor 40, whole-file 60, no item: no entry, stood for, finalScore 60, covered */ });
test('a whole-file score never falls', () => { /* kept 60: model 40 -> 60 and audit whole_file_kept; model 80 -> 80; no model score -> 60 */ });
test('a kept whole-file score does not stand for a new block', () => { /* kept.wholeFile 40, kept.stoodFor has B1 only; the model answers for the file with no whole-file score and no item for B2: B2 has no entry, the file is not scored, 100, not covered */ });
test('a block an item named without a usable score is not stood for', () => { /* the model sends 85.5 for B2 beside a valid whole-file 30: not scored, as today */ });
test('a file with nothing left to score cannot be moved by the answer', () => {
  /* settled, entries B1 70 and B2 40. Each of these answers leaves finalScore 70 and covered true: a score for B1; an item for the hunk id of kept parts; an item for B9; a whole-file score of 150; a whole-file score of 10; no entry for the file at all.
     The audit names each: block_already_scored for the first two, block_not_in_file (reason ignored) for B9, whole_file_settled for both whole-file scores */
});
test('a file that was not sent is scored from what it keeps', () => { /* no answer, settled, not in notRead: fileLevel is not not_scored, covered true */ });
test('a file that could not be read counts as 100 whatever it keeps', () => { /* settled and in notRead: not scored, 100, covered false, as today */ });
test('a file that was not sent and has a block with no score is not scored', () => { /* one block kept, one not: not_scored, 100, covered false */ });
test('a block the file score stands for needs no entry of its own', () => { /* stoodFor B1, wholeFile 60, B2 kept at 40: scored, covered, finalScore 60 */ });
test('a moved file that has its score keeps it whatever the model says', () => { /* kept 75, settled: no answer -> 75; answer 40 -> 75; answer 90 -> 75, audit whole_file_settled */ });
test('a part split off in any run remembers where it sits in its hunk', () => { /* a file WITHOUT kept: a 40-line hunk the model splits at R1..R20 and R21..R40: ranges [0,19] and [20,39] */ });
test('kept parts keep their scores and their places', () => { /* kept.blocks B1.1, B1.2 with entries and ranges */ });
test("an entry the scorer gave says so, in the run that gave it and in every run that keeps it", () => { /* by 'scorer' on entries of this run and on kept entries; absent with 'model' */ });
test('a file that still has something to score is not scored after a careless answer, as today', () => { /* kept B1 70, B2 not kept: an item for B9, or a whole-file score of 150: not scored, 100, not covered */ });
test('a file with nothing kept is scored as before, but for the range of its parts', () => { /* deep-equal to the result of today for a file with no split */ });
```

  In `src/engine/review.test.ts`, each built from the stored result of a first review through `historyOf`-shaped data:

```ts
test('a second review of an unchanged file gives it the same scores without asking for them', async () => { /* the model's second answer holds no block; the blocks equal the first's but for origin */ });
test('an edited block cannot buy a lower score, by a block score or by a whole-file score', async () => { /* first review: one block at 80. Second: the block edited; the model answers 20 for the block -> 80 raisedFrom 20; and, in a second case, 20 for the file and no block -> 80 raisedFrom 20 */ });
test('a hunk split in a first review keeps its parts and their scores in the second', async () => { /* the first review's result holds the parts with their ranges; in the second nothing is asked for that hunk and the parts have the same scores */ });
```

- [ ] **Step 2: Run them and see them fail.** Six of the first list are pins that hold before and after, because today's reconcile gives the same answers: `a whole-file score at or above the floor stands for the block as it does today`, `a block an item named without a usable score is not stood for`, `a file that could not be read counts as 100 whatever it keeps`, `a file that was not sent and has a block with no score is not scored`, `a file that still has something to score is not scored after a careless answer, as today`, and `a file with nothing kept is scored as before, but for the range of its parts`.
- [ ] **Step 3: Implement.** `review()` passes `by`: `scorer` when `deps.scorer` is given.
- [ ] **Step 4: Run** the suite, the type check, the lint and the ASCII check. Every score test that existed passes unchanged; a test that compares a whole part and now sees `range` is the one kind that may change, and the report lists each.
- [ ] **Step 5: Commit** `feat: a block is scored once, and pushing again cannot lower a score`.

---

### Task 5: The review says where a score came from

**Files:**
- Modify: `src/engine/render/body.ts`
- Test: `src/engine/render/body.test.ts`

**Rules:**

1. In `Human review`, a block's line ends with one of these, the first that applies: ` _(<given>% was given; a block this file lost had scored <score>%)_` when `raisedFrom` is a number; ` _(kept from an earlier review)_` when its `origin` is `earlier_run`; ` _(scored on another pull request)_` when it is `other_pull_request`. A score taken from another pull request is written with its category and without its reason: the reason was written about another pull request.
2. Nothing else changes. A result with none of these fields renders as it did.

- [ ] **Step 1: Write the failing tests:** one line for each of the three with its exact text, one for a kept block that was raised (the first form), and one that a block with none of the fields is written as today (a pin: it holds before and after).
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the suite, the type check, the lint and the ASCII check.
- [ ] **Step 5: Commit** `feat: the review says when a score was kept, reused or raised`.

---

### Task 6: Which files a run reads

**Files:**
- Create: `src/engine/plan.ts`
- Modify: `src/engine/types.ts`, `src/engine/context/prompt.ts`, `src/engine/review.ts`
- Test: `src/engine/plan.test.ts` (new), `src/engine/context/prompt.test.ts`, `src/engine/review.test.ts`

**Interfaces:**
- Consumes: `ReviewInput.mode`, `ReviewInput.history` (`lastReview`, `shown`), `shownOf` (Task 2), `FileContext.kept` (`covered`), `FileContext.threads` (plan 6).
- Produces: `ReviewResult.mode` becomes `'full' | 'incremental' | 'recheck'`; `ReviewResult` gains the optional `since?: string` (the head of the last review) and `nothingToDo?: boolean`; and

```ts
// src/engine/plan.ts
/** The files a run goes on with, in the order they are packed, and the ones it leaves out because an earlier review covers them. */
export function filesToSend(contexts: FileContext[], mode: 'full' | 'incremental' | 'recheck'): { send: FileContext[]; leftOut: FileContext[] };
/** The overview of a zero-call review that is not a full one. */
export const NOTHING_READ = 'No file was read in this review: every file that can be sent was read, as it is now, by an earlier review.';
// src/engine/context/prompt.ts
export const LAST_OVERVIEW_CHARS = 4000;
// pullRequestHeader(pr, fileCount, token, lastOverview?: string), buildMessages({ ..., lastOverview?: string }),
// fixedTokens(contract, pr, withThreads = false, lastOverview?: string)
```

**Rules (5.2, 5.3, 12):**

1. **Left out before packing.** In every mode: a moved file (plan `model_whole`) whose `kept.covered` is true (call 22). In `incremental` and `recheck` also: a file whose plan is `model`, whose `kept.covered` is true, and which holds no thread that is due.
2. **Left out for want of room.** In every mode, a file the packer lists as `over_batch_limit` whose `kept.covered` is true is treated as left out too: an earlier review read it as it is, so it is not a file nobody read (call 20).
3. **The order, in every mode:** the files that hold a thread that is due, then the files that are not covered (`kept` absent, or `kept.covered` false; a file whose plan is `rule` or `none` counts here), then the rest. Each group keeps the order given. With no history every file is "not covered", so a first review's order is today's.
4. **A file that is left out,** either way, is not a file that was not reviewed: it gets no `notReviewed` entry and one audit entry `{ stage: 'context', action: 'not_sent', subject: <path>, reason: 'covered' }`. Each of its threads is taken out of the shown list with `{ stage: 'context', action: 'thread_not_shown', subject: <key>, reason: 'file_covered' }`. It is scored from what it keeps (Task 4, rule 7).
5. **Whether a run shows threads** (the tool with verdicts, the fixed tokens) is decided from the threads still shown after rule 4 for the files of rule 1. A thread of a file of rule 2 was counted when the calls were sized; it gets the same audit entry and no verdict.
6. **The last review's overview.** In `incremental` and `recheck`, when `history.lastReview.overview` is not empty after trimming and is not `NOTHING_READ`, every call's header message ends with the line `The last review of this pull request summarized it as below. It describes an earlier state of the code and proves nothing about the code you are given.` and then the overview as data (`wrapData('last review overview', ...)`), control characters stripped and cut to `LAST_OVERVIEW_CHARS` characters without splitting a surrogate pair, with ` [cut]` after a cut. `fixedTokens` counts it. In `full` mode, and with no last review, the header is today's. The second scorer's requests do not carry it.
7. **No file to send.** In `incremental` and `recheck`, when the packer makes no batch, the model is not called. The result is `ok`, its overview is `NOTHING_READ`, it has no finding and no usage, the scores of every file (`reconcileScores` with no answer), the verdict over them, and `coverage` with nothing reviewed and what the packer listed as not reviewed, less the files of rule 2. `nothingToDo` is true when, besides, no thread is due (`threadsDue` is 0) and `shownOf` this result is not null and equals `history.shown`: the review would tell a person what the newest published one already tells. In every other case the field is absent. In `full` mode this path is what it is today, but for rules 1 and 2.
8. `mode` in every result, failed ones too, is the input's (`full` when absent). `since` is `history.lastReview.head` when the mode is not `full` and there is a last review; else absent. The engine does not check that the mode fits the history: with no history nothing is covered and every file is sent.
9. `coverage.reviewed` holds the files this run read, as today.

- [ ] **Step 1: Write the failing tests.**

```ts
// plan.test.ts, with ctx(path, { covered, due, plan }) building a context with `kept.covered` and one thread
test('a full review reads what is not covered before what it reads again, and leaves out only a moved file that has its score', () => {
  const [a, b, c, d, e] = [ctx('a.ts', { covered: true }), ctx('b.ts', {}), ctx('c.ts', { covered: true, due: true }), ctx('d.ts', { covered: false }), ctx('e.ts', { covered: true, plan: 'model_whole' })];
  const out = filesToSend([a, b, c, d, e], 'full');
  assert.deepEqual([out.send.map((x) => x.file.path), out.leftOut.map((x) => x.file.path)], [['c.ts', 'b.ts', 'd.ts', 'a.ts'], ['e.ts']]);
});
test('an incremental review leaves out a file an earlier review covers, unless a thread on it is due', () => {
  const [a, b, c, d, e] = [ctx('a.ts', { covered: true }), ctx('b.ts', { covered: false }), ctx('c.ts', { covered: true, due: true }), ctx('d.png', { plan: 'rule' }), ctx('e.ts', { covered: true, plan: 'model_whole' })];
  const out = filesToSend([a, b, c, d, e], 'incremental');
  assert.deepEqual([out.send.map((x) => x.file.path), out.leftOut.map((x) => x.file.path)], [['c.ts', 'b.ts', 'd.png'], ['a.ts', 'e.ts']]);
});
test('a re-check reads the same files as an incremental review', () => { /* same input, 'recheck': same answer */ });
test('with no history the order is the order given, in every mode', () => { /* kept absent on all, no thread: send equals the input */ });
// prompt.test.ts
test('the last review overview is shown as data at the end of the header, cut and counted', () => {
  /* pullRequestHeader(pr, 2, TOKEN, 'x'.repeat(5000)): ends with the line, then the wrapped text of 4000 x and ' [cut]';
     a control character in it is stripped; fixedTokens with it is larger by the estimate of what was added; with undefined both are today's */
});
// review.test.ts
test('an incremental review sends only the file whose diff changed, and scores the other from what it keeps', async () => {
  /* two files; history covers both at their first diffs; the second file's patch differs now: one model call whose message names only that file;
     result.scores has both files; audit not_sent for the first; mode 'incremental'; since is the last review's head; the header message holds the last review's overview */
});
test('a moved file an earlier review scored is not sent again and keeps its score, in an incremental review and in a full one', async () => { /* Review Focus 5 */ });
test('the sentence of a last review that read nothing is not passed on as its overview', async () => { /* lastReview.overview is NOTHING_READ: the header message is today's */ });
test('a hunk split in the first review does not send its file again', async () => { /* Review Focus 7: the history is built from a first result whose parts have ranges; no model call names the file */ });
test('a thread that is not due on a file left out is named in the audit and not shown', async () => { /* thread_not_shown file_covered; the call takes the tool without verdicts */ });
test('with nothing new the model is not called and the result says so', async () => {
  /* both files covered, no thread, history.shown is shownOf the first result: calls 0, nothingToDo true, status ok, overview NOTHING_READ, both files scored from what they keep */
});
test('a review that would say something the newest one does not is not nothing new', async () => {
  /* each with no model call and nothingToDo absent: a new file with no diff (coverage.notReviewed has it, it counts as 100); a due thread whose file left the diff (threadsDue 1);
     Review Focus 13: a flagged block put back into a covered file while history.shown is of a review that did not list it; a new file scored by a fixed rule; history.shown null */
});
test('a pull request with a file nobody can read still ends as nothing new when nothing else changed', async () => { /* the same file is not reviewed in history.shown and now: nothingToDo true */ });
test('a file with a stripped character on a changed line is read once, then left out, and still counts as 100', async () => {
  /* Review Focus 14: the history is built from a first result in which the file was read and stored as not covered: no model call names it, its final score is 100 */
});
test('a covered file that finds no room is scored from what it keeps and not listed as not reviewed', async () => {
  /* Review Focus 15: full mode, room for one batch of two files; four files of which two are covered: the uncovered two are read; the other two keep their scores,
     coverage.notReviewed is empty, audit not_sent for each. An uncovered file that finds no room is still listed and counts as 100 */
});
test('a failed review says the mode it was given', async () => { /* mode 'incremental', the source rejects: status failed, mode 'incremental' */ });
test('a full review of a later head reads every file, the uncovered ones first', async () => { /* mode 'full' with a history: every file in the request, in that order; no since */ });
test('a review with no mode is a full review', async () => { /* a pin: mode 'full', no since, no nothingToDo */ });
```

- [ ] **Step 2: Run them and see them fail.** The last one is a pin: it holds before and after.
- [ ] **Step 3: Implement.** In `review()`, `filesToSend` runs after the kept scores are set and the threads attached, and before packing; only what it sends is packed. Rule 2 is applied to the packer's answer before anything reads its `notReviewed`.
- [ ] **Step 4: Run** the suite, the type check, the lint and the ASCII check.
- [ ] **Step 5: Commit** `feat: an incremental review and a re-check read only what no earlier review covers`.

---

### Task 7: Lines changed since a file was last read

**Files:**
- Create: `src/engine/context/increment.ts`, `src/engine/reconcile/mode.ts`
- Modify: `src/engine/types.ts`, `src/engine/context/build.ts`, `src/engine/context/section.ts`, `src/engine/review.ts`
- Test: `src/engine/context/increment.test.ts`, `src/engine/reconcile/mode.test.ts` (both new), `src/engine/context/section.test.ts` or `prompt.test.ts`, `src/engine/review.test.ts`

**Interfaces:**
- Consumes: `KeptScores.readAt` (Task 3); `patchFromContents`, `parsePatch`, `linesOf`, `Range`.
- Produces:

```ts
// src/engine/context/increment.ts
/** What of a file changed since a published review last read it: everything, or these new-side lines and the removed lines of these hunks. */
export interface Changed { all: boolean; right: Range[]; leftBlocks: string[] }
/** The new-side lines of `now` that `before` does not have, as ranges; null when the two cannot be compared. */
export function changedLines(before: string, now: string): Range[] | null;
/** Whether a placed finding sits on a line that changed. `blocks` are the file's hunks. */
export function isChanged(changed: Changed, blocks: Block[], side: Side, line: number): boolean;
/** The value of the header line: `all`, `none`, or such as `R4, R11-R12; removed lines of B2`. */
export function changedText(changed: Changed): string;
// src/engine/reconcile/mode.ts
export function reconcileMode(
  findings: Finding[], changedOf: (path: string) => Changed | null, blocksOf: (path: string) => Block[],
): { kept: Finding[]; unchanged: Finding[]; audit: AuditEntry[] };
```

  `FileContext` gains `changed?: Changed`. `buildFileContexts` also returns `content: (path: string, sha: string) => Promise<string | null>`, its own cached read. `ReviewResult` gains the optional `unchanged?: Finding[]` (majors on unchanged lines, listed in the body only) and `blockingOnUnchanged?: number`.

**Rules (5.2, 5.6 step 7, calls 7 to 10):**

1. **What changed in a file,** for a file whose plan is `model`, the first that applies:
   - it has no `kept`, or `kept.readAt` is null: `{ all: true }`. No published review has read it, in whatever mode this run is;
   - `kept.readAt.head` is the present head: nothing (`all` false, no line, no hunk). This is the file a re-check has already read;
   - the file is removed: no new-side line; `leftBlocks` as below. No content is read;
   - else `right` is `changedLines` of the file's content at `kept.readAt.head` and at the present head, each with `\r\n` made `\n`. The earlier content is read at the file's path, and at its `previousPath` when that answers null. When either content is null, or the two cannot be compared, `{ all: true }`.

   `leftBlocks` holds the ids of the file's hunks that have a removed line and whose hash is not in `kept.readAt.hashes`. A new hunk that only adds lines is not listed: its lines are in `right`.
2. `changedLines` uses `patchFromContents` and returns the new-side numbers of its added lines as ranges; null when that gives up.
3. `isChanged`: true when `all`; for `RIGHT`, when the line is inside one of `right`; for `LEFT`, when the line is among the old-side lines of one of `leftBlocks`.
4. **In `incremental` and `recheck`,** `changed` is set on every `model` file that is sent, on the object that is packed, before packing. Its header gets one more line after the whole-file line: `lines changed since this file was last reviewed: <changedText>`. In `full` mode no header changes. A read of the earlier content that rejects fails the review as any source error does: it is before any model call, and the job puts such a job back.
5. **Step 7,** after the duplicates of plan 6, in `incremental` and `recheck` only. For each placed finding on a file that has `changed` and that is not on a changed line: a blocker is kept; a major is taken out of the findings and listed in `unchanged`; a minor is dropped with `{ stage: 'reconcile', action: 'dropped', subject: '<path>:<line>', reason: 'unchanged_line' }`. A finding on a file without `changed`, and a finding that could not be placed, are not touched.
6. **The count.** In `full` mode, when the history has a last review: after the duplicates, `blockingOnUnchanged` is the number of placed blocker and major findings that are not on a changed line, with "changed" worked out by rule 1, all of it, for the files those findings sit on and only for those. Here a read that rejects does not fail the review, which is already paid for: the count is left absent, with `{ stage: 'reconcile', action: 'unchanged_count_failed', subject: <path>, reason: <the error's short code, else source_error> }`. In the other modes, and in a first review, the field is absent.

- [ ] **Step 1: Write the failing tests.**

```ts
// increment.test.ts
test('the lines a file gained or changed, by their new numbers', () => {
  assert.deepEqual(changedLines('a\nb\nc\n', 'a\nB\nc\nd\n'), [[2, 2], [4, 4]]);
  assert.deepEqual(changedLines('a\nb\n', 'a\nb\n'), []);
});
test('code that only moved down is not changed', () => { /* ten lines inserted at the top: only those ten */ });
test('two contents too different to compare are not compared', () => { /* over the edit limit -> null */ });
test('a finding is on a changed line when the file is new to the reviewer, the line changed, or its removed line is in a new hunk', () => { /* all; RIGHT inside and outside the ranges; LEFT in a hunk of leftBlocks and in another */ });
test('the header says what changed', () => {
  assert.deepEqual([{ all: true, right: [], leftBlocks: [] }, { all: false, right: [], leftBlocks: [] }, { all: false, right: [[4, 4], [11, 12]] as Range[], leftBlocks: ['B2'] }, { all: false, right: [], leftBlocks: ['B1', 'B3'] }].map(changedText),
    ['all', 'none', 'R4, R11-R12; removed lines of B2', 'removed lines of B1, B3']);
});
// mode.test.ts
test('on a line unchanged since the file was last read a blocker is kept, a major is listed and a minor is dropped', () => {
  const changedOf = () => ({ all: false, right: [[10, 12]] as Range[], leftBlocks: [] });
  const out = reconcileMode([f('blocker', 3), f('major', 4), f('minor', 5), f('major', 11), f('minor', 12)], changedOf, () => []);
  assert.deepEqual([out.kept.map((x) => [x.severity, x.line]), out.unchanged.map((x) => x.line), out.audit.map((a) => [a.subject, a.reason])],
    [[['blocker', 3], ['major', 11], ['minor', 12]], [4], [['src/a.ts:5', 'unchanged_line']]]);
});
test('a file that is new to the reviewer, and a file with nothing said about it, keep every finding', () => { /* all: true; changedOf answers null */ });
// section.test.ts or prompt.test.ts
test('a file that is sent in an incremental review says which lines changed, and a file without the field says nothing', () => { /* the line stands after the whole-file line; absent without `changed` */ });
// review.test.ts
test('an incremental review tells the model which lines changed, lists a major on an unchanged line and keeps one on a changed line', async () => {
  /* the file was read at the last review; its content then and now differ in line 4; the header holds 'lines changed since this file was last reviewed: R4';
     the model returns a major on line 4 and one on line 2: findings has the first, unchanged the second */
});
test('a re-check treats every line of a file read at this head as unchanged', async () => { /* header 'none'; a major anywhere goes to unchanged, a blocker stays */ });
test('a re-check of a file the last review listed as not reviewed measures from the review that did read it', async () => {
  /* Review Focus 8. History: readAt.head is h0, lastReview.head is h1 (the present head), the file is not covered. The content at h0 and now differ in line 4:
     the file is sent, the header says R4, and a major on line 4 is a finding, not listed as unchanged */
});
test('a file no published review has read is changed throughout', async () => { /* readAt null: header 'all'; a minor on it is kept */ });
test('the same block at other line numbers is not changed', async () => { /* Review Focus 10: ten lines added above between the two heads: the header names those ten lines only */ });
test('a file that cannot be read at the earlier head counts as changed throughout', async () => { /* content null at readAt.head and at the previous path: header 'all' */ });
test('a removed file read before has no changed line but the removed lines of a new hunk', async () => { /* no content is read for it; header 'removed lines of B2' */ });
test('a failed read of the earlier content fails an incremental review before any model call', async () => { /* getFileContent rejects Error('github_502') at the earlier head: status failed, stage context, code github_502, calls 0 */ });
test('a full review of a later head counts its blocking findings on unchanged lines and changes nothing else', async () => { /* blockingOnUnchanged 1; findings as returned; no header line */ });
test('a failed read while counting leaves the count out and the review whole', async () => { /* full mode, the read rejects after the model answered: status ok, findings kept, no blockingOnUnchanged, audit unchanged_count_failed */ });
test('a first review has no such count', async () => { /* a pin: the field is absent */ });
```

- [ ] **Step 2: Run them and see them fail.** The last one is a pin.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the suite, the type check, the lint and the ASCII check.
- [ ] **Step 5: Commit** `feat: a finding on a line unchanged since its file was last read is handled by its severity`.

---

### Task 8: What an incremental review and a re-check say

**Files:**
- Modify: `src/engine/render/body.ts`
- Test: `src/engine/render/body.test.ts`

**Rules (5.7):**

1. **The first line.** With `mode` read from the result (absent reads as `full`) and `since` its first 12 characters:
   - `full`: as today (nothing for an automatic review; `**Full review** requested by @<login>.` for a manual one);
   - `incremental`, automatic: ``**Incremental review** of the changes since `<since>`.``;
   - `incremental`, manual: ``**Incremental review** requested by @<login>, of the changes since `<since>`.`` (without the login: ``**Incremental review** requested, of the changes since `<since>`.``);
   - `recheck`: `**Re-check** requested by @<login>. The earlier threads were judged again; code that was reviewed before was not reviewed again.` (without the login: `**Re-check** requested. ...`). When the result's `threadsDue` is 0 or absent, the middle sentence is `No earlier thread was waiting for a verdict; code that was reviewed before was not reviewed again.` When threads were due and no verdict was kept, it is `No earlier thread could be judged; code that was reviewed before was not reviewed again.`
   When `since` is absent the words from "of the changes" on are left out, with the comma before them. `since` is written only when it is 7 to 64 characters of `0-9a-f`; otherwise it reads as absent. A failed review keeps the first line of its mode.
2. **`## On code unchanged since the last review`** is written when `unchanged` is not empty: the heading, an empty line, `These are on lines that have not changed since the reviewer last read their file. They are not posted as comments and do not hold a merge.`, an empty line, then each finding with its whole text, as the body-only form writes a finding. It is always the last element of the body's head, after `Findings`; with a finding that could not be placed it therefore stands before `Findings not placed on the diff` (call 23). A damaged entry of `unchanged` is skipped, never thrown on.
3. **`Overall`.** With no placed and no unplaced finding it opens with `No findings.` only when nothing is listed as already discussed and `unchanged` is empty; otherwise with `No new findings.`. With findings it opens with the counts, as today. When `unchanged` is not empty, the sentence `<n> major on code unchanged since the last review.` comes next, before the sentence about files not reviewed.
4. **A review with no model call** is written like any other: its overview is the sentence the engine set.
5. A result with none of the new fields renders as it did.

- [ ] **Step 1: Write the failing tests:** each first line with its exact text (the six, and the two of a re-check with no thread due), a `since` that is not a commit id, and a failed incremental review; the section with its place and the finding's whole text under its bullet, and a very long one that leaves `Overall` whole; `Overall` in its three openings and with the sentence about unchanged code; a zero-call review whose body holds the engine's sentence, `Human review`, `Coverage` and `Overall`; and that an old result renders as before (a pin).
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the suite, the type check, the lint and the ASCII check. Every body test that existed passes unchanged.
- [ ] **Step 5: Commit** `feat: an incremental review and a re-check say what they are, and list what sits on unchanged code`.

---

### Task 9: The job chooses the mode and keeps the scores

**Files:**
- Modify: `src/config/schema.ts`, `src/config/load.ts`, `config.example.yml`, `src/shell/review-job.ts`
- Test: `src/config/load.test.ts`, `src/shell/review-job.test.ts`, `src/shell/later-review.test.ts`; and the typed fixtures that build a `RepoSettings` by hand gain `newHead: null`: `src/shell/triggers.test.ts`, `src/shell/receive-jobs.test.ts`, `src/shell/receive.test.ts`, `src/eval/replay.test.ts`, `src/eval/backtest/run.test.ts`, the whole `RepoSettings` that `src/config/load.test.ts` compares, and any other the type check names

**Interfaces:**
- Consumes: everything Tasks 1 to 8 produce.
- Produces: `RepoSettings.newHead: 'full' | 'incremental' | null` (config key `repositories.defaults.newHead` and the same key in an override; null when written in neither); `REUSE_DAYS = 30` exported from the job.

**Rules.** Dry run is untouched: no history, no mode, no lookup, nothing stored for reuse. Out of dry run:

1. **The last review** is `lastReviewOf(runs)`: it is what `earlierOf` and `historyOf` are given. The check that ends a job as `already_reviewed` still looks at the newest published run of any mode.
2. **A manual job on a head and base that have their published review** is no longer refused: it goes on as a re-check. An automatic one is still dropped. A manual job is still refused when GitHub lists a review of the app's own on that head that the database does not know. On this path a stored review that was never published is taken for publication only when its id is above that published run's: an older row of the same head is a leftover of the review that is already posted, not a review that waits.
3. **The mode,** decided before the review, the first that applies:
   - no last review: `full`;
   - a manual job, and the last review has the live head and base: `recheck`;
   - the last review's `baseBranch` is null or is not the live base branch: `full`;
   - the repository's `newHead`, and `incremental` when it is null (call 12).
4. **The engine is given** `mode`, `history: historyOf({ runs, last, by })` with `by` `scorer` when the engine's dependencies hold a scorer and `model` otherwise, and, beside the dependencies it has today, `reusableScores`: it asks `reusableScores(db, job.ref, by, blocks, <REUSE_DAYS before the job's start>)` and turns each row into an entry (a category outside the list reads as `other`).
5. **The record.** A run is stored with the result's mode (the mode decided when the engine threw, `full` when the job failed before deciding) and the live base branch. Every place where the job writes `mode: 'full'` today follows this. After a run that ended `ok` is recorded, by whichever branch, `recordBlockScores(db, <its id>, job.ref, by, scoresToStore(result), <when it finished>)` is called once. It is a best effort (call 4), made once and outside the write that is tried three times: anything it throws is logged as `{ event: 'scores_store_failed', job, run, reason }` and changes nothing. A run that a later start publishes was stored already; nothing is stored for it again.
6. **Nothing new** (the result's `nothingToDo`). An automatic job records the run with an empty body, so that no later start takes it for a review waiting to be published, and finishes as `nothing_new`: nothing is published and no thread is touched. This branch stands before the one that ends a run with an empty body as `render_failed`. A manual job is published like any review.
7. **The log.** The `review` entry's `mode` is the run's, and it gains `blocking_on_unchanged` (the result's count, null when absent) and `nothing_new` (a boolean).
8. A recorded review that a later start publishes is published as it was recorded, whatever its mode.

- [ ] **Step 1: Write the failing tests.** The harness's fake engine now records the dependencies it was given beside its input, and answers the mode it was given unless a test says otherwise.

```ts
// load.test.ts
test('how a new head is reviewed can be set for all repositories or for one, and is not set otherwise', () => { /* null; defaults.newHead: full; an override: incremental */ });
test('another word for newHead is refused', () => { /* config error naming the key */ });
// review-job.test.ts (`published(over)` stores a published run as in plan 6, now with baseBranch 'main')
test('a push after a review is reviewed incrementally, with the history of the earlier runs', async () => {
  await published({ head: 'h0' });
  const h = await live({ own: [[{ id: '401', commit: 'h0' }]] });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([h.inputs[0]!.mode, h.inputs[0]!.history?.lastReview?.head, h.inputs[0]!.history?.by], ['incremental', 'h0', 'model']);
  assert.deepEqual([(await listRuns(db, REF)).at(-1)!.mode, (await listRuns(db, REF)).at(-1)!.baseBranch], ['incremental', 'main']);
});
test('a repository set to full is reviewed in full at every head, with its history', async () => { /* settings.newHead 'full' -> mode 'full', history.lastReview set */ });
test('a first review is a full review with an empty history', async () => { /* mode 'full'; history.files [] and lastReview null */ });
test('a pull request moved to another base branch is reviewed in full', async () => { /* published({ baseBranch: 'main' }); live base branch 'release' -> 'full' */ });
test('a review stored before base branches were kept is followed by one full review', async () => { /* published({ baseBranch: null }) -> 'full' */ });
test('a /review on a head that has its review is a re-check, not a refusal', async () => { /* published({ head: 'h1' }); manualJob: eyes, mode 'recheck', outcome published, no refusal sentence */ });
test('a /review on a head whose review was stored before this plan is a re-check too', async () => { /* Review Focus 9: a published run with baseBranch null and a result with none of the new fields */ });
test('a push on a head that has its review is still dropped', async () => { /* a pin: automatic: already_reviewed, no engine call */ });
test('a /review on a head with a review the database does not know is still refused', async () => { /* a pin */ });
test('a /review on a reviewed head does not post a leftover row of the review that is already there', async () => {
  /* an unpublished ok run of the same head and base with a lower id than the published one: the engine is called (a re-check) and that row is not published.
     One with a higher id, stored as an incremental review, is published as it was recorded, its first line too */
});
test('a review the engine threw on is stored with the mode that was decided', async () => { /* a push after a review, the fake throws: the failed run's mode is incremental */ });
test('a re-check is not the last review: the next push is planned from the review before it', async () => {
  /* published full at h0 with overview 'First.'; published recheck at h0 with overview 'Second.' and another score; a push to h1: history.lastReview.overview is 'First.',
     and history.shown is shownOf the re-check's result */
});
test('with a scorer in force the history and the stored scores are the scorer\'s', async () => { /* engineDeps holds a scorer: history.by 'scorer'; the rows in block_scores have scored_by 'scorer' */ });
test('with nothing new a push is finished without a review, and a command gets one', async () => {
  /* the fake answers okResult({ nothingToDo: true, mode: 'incremental' }). Automatic: job outcome nothing_new, a run recorded with an empty body, no publishReview, no thread read again,
     and a second start for the same head publishes nothing. Manual: published */
});
test('a review with no model call that is not nothing new is published', async () => { /* Review Focus 12: okResult({ mode: 'incremental', usage: zero, coverage with one file not reviewed }): outcome published */ });
test('the scores a run gave are stored for other pull requests, and a failure to store them changes nothing', async () => { /* block_scores holds the entry; with the insert failing: outcome published, log scores_store_failed, one run row and one attempt to store */ });
test('the engine can look up scores other pull requests stored in the last 30 days', async () => {
  /* a row stored 29 days ago under pull request 8, and one 31 days ago: calling the recorded dependency's reusableScores answers the first as an entry and not the second; a stored category outside the list reads as other */
});
test('in dry run nothing of this happens', async () => { /* a pin: no mode, no history, no reusableScores, no row in block_scores */ });
test('the review entry says the mode, the count and whether nothing was new', async () => { /* mode 'incremental', blocking_on_unchanged null, nothing_new false; a full later review with the count 2 */ });
// later-review.test.ts (the real engine under the real job, as plan 6 left it)
test('two reviews of one pull request: the second is incremental, asks for no score the first gave, and gives the unchanged file the same score', async () => {
  /* first review stored and published through the job; then a push that changes one of two files: the second model request names one file;
     the unchanged file's score in the second result equals the first's; block_scores holds the first review's scores once */
});
test('a push that changes nothing in the diff ends as nothing new, with no model call', async () => { /* Review Focus 12: the same files and patches at a new head: one model call in all, job outcome nothing_new */ });
```

- [ ] **Step 2: Run them and see them fail.** The pins hold before and after.
- [ ] **Step 3: Implement,** in this order: the config key; the mode; the history and the lookup; the record and the stored scores; nothing new.
- [ ] **Step 4: Run** the suite, the type check, the lint and the ASCII check.
- [ ] **Step 5: Commit** `feat: later heads are reviewed incrementally, a /review on a reviewed head re-checks, and scores are kept across reviews`.

---

### Task 10: The README and a real run

**Files:**
- Modify: `README.md`, `config.example.yml` (its comment for `newHead`, if Task 9 left it short)

**Rules:**

1. **README.** Each sentence states only what the code does, and names its cost where it has one:
   - **Reviews after the first** are incremental unless `newHead` says `full`: what is read (files whose diff changed, files no review has read yet, files that hold a thread due a verdict), what is not, and that a defect the first review missed in unchanged code is then not found later (5.2). In every mode the files no review has read come first, so a pull request too large for one review is covered over several.
   - **A finding on a line that has not changed** since a review last read its file: a blocker is posted, a major is listed in the body and not posted, a minor is dropped.
   - **`/review` on a head that has its review** is a re-check: the threads are judged again and files not yet read are read. It is still refused when GitHub shows a review of the app's own on that head that the service has no record of.
   - **A push after which a review would say what the newest one already says** (the same score for every file, the same parts for a person to read, the same files not reviewed, no thread waiting) gets no new review; a `/review` on it gets one.
   - **Scores are kept:** a block is scored once; while it stays in the diff its score does not change; a new or edited block cannot score below a block its file lost; a whole-file score never falls; another pull request of the repository reuses a score for 30 days; what the three notes in `Human review` mean; a hunk the model split is not reused by another pull request; the model's scores and a second scorer's are kept apart, so naming a scorer or dropping it scores every open pull request afresh once; a file that only moved is scored once and not shown to the model again.
   - **What reuse costs** (call 19), in plain words: a block is recognised by its changed lines alone, so lines that were scored where they were harmless keep that score when a later push, or another pull request within 30 days, puts the same lines somewhere else in the same file. And a new or edited block is held to the highest score its file lost only when it is scored: of several variants pushed together, a later push can keep the one that scored lowest.
   - **In dry run** none of this happens: every head is reviewed in full and scored afresh.
   - The settings table and `config.example.yml` name `newHead`.
   Every sentence that says each later review is a whole review, or that `/review` on a reviewed head is refused, is corrected wherever it stands.
2. **A real run under Docker,** made by the controller after the fix wave, on its code, as in plan 6: the previous release on a fresh database; this branch on that database (the ledger gains `0004_scores`; old runs read with a null base branch); `reusableScores`' statement and the score check on rows made by hand; a start out of dry run that goes on without GitHub; a log of ids, codes and counts only.

- [ ] **Step 1: Write the README.** For each sentence written or kept in the sections touched, name the code that makes it true in the report.
- [ ] **Step 2: Run** the suite, the type check, the lint and the ASCII check.
- [ ] **Step 3: Commit** `docs: the README says how later heads are reviewed and how scores are kept`.

---

## To verify with a real app

The scratch repository and the app of plan 6's trial are still there. Each of these needs the owner's go-ahead, and the ones that call a model spend money:

1. That the model sends no entry for a block marked `scored`, and no whole-file score for a file that takes none. This is the only place a model meets those headers. And how often it answers an edited file with a whole-file score alone.
2. Three reviews of one pull request in which a file does not change: its score is the same in all three, where plan 6's trial saw it move across the threshold.
3. A push that edits a scored block: the new block is not scored below it.
4. The same change opened as a second pull request: its blocks take the first one's scores.
5. An incremental review: only the changed file is sent, the header names the changed lines, the last review's overview is in the request, and a major the model raises on an unchanged line is listed and not posted.
6. A `/review` on a reviewed head: a re-check that judges the threads.
7. A push that merges the base branch and changes nothing in the diff: no review, the job ends as `nothing_new`; then a `/review` on that head.
8. A force-push that rebases the branch: the scores hold and the increment is only what changed.

## What was built

All ten tasks were built and reviewed, and corrected after a review of the whole branch; the rules above are the rules as built (calls 13 and 24 and Review Focus 17 to 19 came from that review). What was decided on the way, what the real run and a trial with a real app showed, and what was put off are in `2026-11-20-scores-that-hold-and-reading-less-notes.md`.

Of "To verify with a real app": items 2, 3, 6 and 7 were seen. Item 4 was seen for the one block that had a stored score. Item 1 was seen in part: the model sent a score for a block marked `scored` once, which was ignored, and sent no whole-file score where none is taken. Item 5 was seen without a finding on an unchanged line. Item 8 was seen for a rebase that changed no content.
