# Visto AI: design

Status: approved by the owner on 2026-11-16, after the owner's first read and a review against the predecessor's production record. First draft: 2026-11-13.
Name: Visto AI, written `visto-ai` in identifiers (section 11.4).

## 1. Why this exists

Code used to be written by people and reviewed by people. Now AI writes much of it, and people hand the review to AI as well. Nobody is left deciding which changes still need a person.

This project reviews every pull request and answers two questions:

1. **What is wrong with this change?** Findings a reviewer can demonstrate, each with a concrete failure scenario.
2. **Which parts of the change need a human reviewer, and why?** Every changed block of code gets a score from 0% to 100%. Blocks at or above a threshold are listed for a person, with the lines to read. If nothing reaches it, and the team has switched this on, the bot approves the pull request.

The aim is to reduce what people must review, and to be able to show the numbers that justify it.

It also replaces a predecessor: a reviewer that ran in production for about six months on top of a general agent gateway. That gateway was used for one model call with a few tools, and it caused nearly every outage. The lessons from running it are written into this document as requirements.

## 2. Goals, non-goals, anti-goals

### Goals

- **G1. Evidence-backed review.** A review for each new head of a pull request, with inline findings tagged `[blocker]`, `[major]` or `[minor]`. No style comments.
- **G2. A human-review score per changed block of code.** With a reason for each block that needs a person, and one verdict for the pull request.
- **G3. Optional automatic approval.** Per repository, off by default.
- **G4. Continuous learning.** What people do on pull requests is stored and retrieved into later reviews. The model itself is never fine-tuned.
- **G5. Measurement before trust.** Findings and scores can both be replayed offline against history, with no side effects.
- **G6. Self-hosted.** `docker compose up` on one machine. The adopter connects their own GitHub App.
- **G7. Optional merge gate.** A required check that blocks a merge while a major or blocker finding is unanswered.

### Non-goals for the first version

- GitLab. Only the boundary that will make it possible (section 10).
- A hosted service, or an app owned by this project.
- Running without a database.
- Code search for the model, and the repository snapshot cache it needs. The predecessor measured code search together with callers-of-changed-symbols context: about three times the cost and no gain in accuracy.
- A tool that reads one file at the reviewed commit. This is a different thing from code search: it needs no cache, because the engine's source already serves file contents at a commit, and it is not what the predecessor measured. Without it the model cannot check code outside the files it is given, so a finding that depends on such code is never major (section 5.5). It stays out until an eval run shows it earns its cost.
- A second-pass finding verifier, repository-wide context packs (callers, schema), a recall-first contract, and extra "lens" passes. The predecessor built and measured all four and dropped them. They return only with new evidence from the eval.
- Embedding search. It is the first experiment after lookups are measured (section 7.4).
- Built-in ticket, wiki or chat integrations. They attach as extensions (section 11.3).
- Porting the predecessor's dashboard.

### Anti-goals

These would make the project a failure even if it works.

- An approval that the pull request's author could talk the bot into on that pull request, unless the deployment chose to allow it (D18). Lessons learned from replies are a slower path, with guards of its own (section 6.2).
- An approval that outlives the commit it was given for. The app cannot guarantee this alone, so it approves only where the git service's own rule backs it (section 6.4).
- A dependency that fails silently for days.
- Unrelated or derailed model output published as a review.
- A single review of an oversized pull request spending the day's budget.
- A test that reaches a real git service, database, chat tool or model.
- Internal data from any deployment committed to this repository.

## 3. Decisions

"Owner" decisions were made by the project owner. "Design call" entries are proposed by this document and are open to change at approval. O14 to O18, and the entries marked "Owner" among D1 to D20, were settled when the owner read the first draft. So was scoring by block instead of by file (O8), which D21 and D22 work out. O19, D22 as it now reads, and the last sentence of O18, D4 and D12 were settled after a review of this document against the predecessor's production record. O20 and O21 came after that.

| # | Decision | Whose |
|---|---|---|
| O1 | Fresh codebase. Engine, webhook receiver, queue, publisher and UI live in this one repository. | Owner |
| O2 | Open source under Apache-2.0. The repository stayed private until the owner confirmed sign-off, and has been public since 2026-11-16. | Owner |
| O3 | Built for broad adoption. Runs through Docker with the database included; no external database is required. | Owner |
| O4 | Whoever runs it creates their own app and connects it. The project owns no app and runs no hosted service. | Owner |
| O5 | GitHub first, GitLab later. | Owner |
| O6 | TypeScript on Node. | Owner |
| O7 | The merge gate is in the core and off by default. Its rules are inherited unchanged (section 9). | Owner |
| O8 | A change is scored for need of human review block by block, not file by file. Below the threshold, the bot may approve. | Owner |
| O9 | Automatic approval is a per-repository switch, off by default. | Owner |
| O10 | The score is proven against past human reviews where a repository has history. In a new repository the model decides alone. | Owner |
| O11 | Learning is continuous: every pull request feeds later reviews, by retrieval, not fine-tuning. | Owner |
| O12 | A small new UI, built last. | Owner |
| O13 | Two reference projects, Mira and PR-Agent, are sources of ideas, not bases. | Owner |
| O14 | The name is Visto AI. | Owner |
| O15 | A review cut short by the limits sends the pull request to human review. | Owner |
| O16 | Thumbs up and down on a review keep being collected from chat. | Owner |
| O17 | No separate HTTP endpoint for requesting a review. A review is requested through the app. | Owner |
| O18 | On a gated pull request, a reply that resolves a major or blocker thread lets the merge go ahead, so a wrong finding cannot hold it. This is a setting, on by default. The reply may come from any person, with or without access to the repository. | Owner |
| O19 | Build order: the score is measured early, and the first deployment leaves the predecessor before memory, automatic approval and the UI are built (section 18). | Owner |
| O20 | The model is reached through OpenRouter, and the project is built and tested against it first. Any other OpenAI-compatible endpoint may be configured (section 5.4). | Owner |
| O21 | There is no spend limit per pull request. The cost guards are the batch limit per review and the daily limit (section 12). | Owner |
| D1 | One Postgres, the plain official image. Retrieval starts with lookups. The pgvector extension is added only if the embedding experiment earns it (section 7.4). | Design call |
| D2 | Two containers (app, database), not one image with the database inside. | Design call |
| D3 | The model gets the diff and full files inline. Its only tools are optional MCP servers and the final submit call. | Design call |
| D4 | Whether a new head gets a full or an incremental review is a setting. Unset, a gated pull request gets a full review and any other an incremental one. In a full review of a later head, a finding on unchanged code gates like any other. | Owner |
| D5 | A pull request too large for the review limits (section 12) is cut at a stated, deterministic point. Unreviewed files go to a human and block automatic approval. | Design call |
| D6 | The model returns structured data and the service renders the review text. There is no model call to merge summaries. | Design call |
| D7 | The score is a percentage from 0% to 100%. The default threshold is 70%. Where the rubric's bands sit on that scale is a design call. | Owner |
| D8 | Learned records may raise a score. Nothing learned lowers one. | Design call |
| D9 | With automatic approval on, a share of approvable pull requests is still sent to a human. The share is a setting, 5% by default. | Owner |
| D10 | Switches that loosen protection live in the deployment config. The file inside a reviewed repository can only tighten. | Design call |
| D11 | Company-specific integrations are extension modules named in the deployment config. | Design call |
| D12 | The bot withdraws its approval the moment a new commit arrives. The review of the new head may approve again. The bot approves only where the base branch dismisses stale approvals. | Owner |
| D13 | One app process. Scheduled work runs inside it. One instance per deployment. | Design call |
| D14 | Every accepted webhook is stored before it is acknowledged. | Design call |
| D15 | All commands require the commenter to be an owner, member or collaborator of the repository. | Design call |
| D16 | Resolving threads is optional and depends on the permission the adopter grants. | Design call |
| D17 | Scores are judged on a file's whole change in the pull request. A block is scored once, and while it stays in the diff, pushing again cannot lower its score. | Design call |
| D18 | For automatic approval, whether the author's own reply can clear a blocking thread is a setting. That it cannot by default is a design call. | Owner |
| D19 | One history importer feeds both the score backtest and a new deployment's memory. | Design call |
| D20 | Every review is pinned to the commit it read. Nothing unpinned is ever posted. | Design call |
| D21 | The scored block is a hunk of the diff, as git cuts it. The model may split a long one, or score a file as a whole. | Design call |
| D22 | Inline notes on flagged blocks are off unless a repository switches them on. When on, at most 50 are posted per review. | Owner |
| D23 | A reply counts towards a lesson, or towards closing a thread under the strict approval rule, only when its writer has access to the repository. | Design call |
| D24 | A pull request from a fork is never approved automatically. | Design call |
| D25 | A deployment may name a second scorer that scores the blocks in place of the review model. It is off unless the deployment config names it. The review model is then not asked for block scores. Nothing else changes: floors, rules, the verdict and the gate work the same. | Owner |

## 4. System overview

```
GitHub ──webhook──▶ receive ──▶ store ──▶ queue ──▶ review job
                                                      │
              ┌───────────────────────────────────────┘
              ▼
   ┌────────────────────── engine (no writes) ──────────────────────┐
   │ plan ▶ context ▶ memory lookup ▶ model ▶ reconcile ▶ score     │
   └─────────────────────────────────┬──────────────────────────────┘
                                     ▼
                  publish ▶ threads ▶ gate ▶ approve ▶ record

human activity on pull requests ──▶ store ──▶ learn ──▶ memory
```

Two containers:

- **app**: one Node process. It receives webhooks, runs the queue and its workers, runs scheduled work (learning, clean-up, redelivery) and serves the UI.
- **db**: Postgres.

The code is one package with these parts. Each has one job and talks to the others through typed interfaces.

| Part | Job | May write to |
|---|---|---|
| `engine` | Pull request in, structured review out | Nothing |
| `forge/github` | Everything that talks to GitHub | GitHub |
| `shell` | HTTP, queue, jobs, commands, publishing | Database, and GitHub through `forge` |
| `gate` | The merge-gate rule and its check | GitHub (through `forge`), database |
| `memory` | Store, learn and retrieve records | Database |
| `history` | Import a repository's past pull requests and human reviews | Local files, or the database when asked |
| `eval` | Replay and scoring commands | Local files only |
| `config` | Load and validate configuration | Nothing |
| `db` | Migrations and queries | Database |
| `ui` | The three screens | Database (kill switch only) |

The engine never writes to GitHub or the database. That is what lets the eval call it directly.

## 5. Engine

### 5.1 Interface

One entry point: `review(input, deps)`.

- **Input**: the pull request reference, base and head commits, the trigger, the effective configuration for the repository, an "as of" time used by memory lookups, and the pull request's earlier state. The caller reads the earlier state and hands it in: the head of the last published review, that review's overview and acceptance rows, the scores stored by earlier runs, the scores stored in the last 30 days for the same blocks on other pull requests of the repository (section 6.2), and which files are covered so far. In a replay it is empty or built from the case.
- **Dependencies**, all passed in: a read-only source (pull request data, file list with patches, file contents at a commit, review threads), a read-only memory, a model client, extension context providers, an MCP client factory, a clock and a logger.
- **Result**: the mode used, findings (placed and unplaced), verdicts on earlier threads, scores per block and per file, the pull request verdict, an overview, acceptance rows if any, coverage (files reviewed and files not, with reasons), usage (calls, tokens, cached tokens, cost), a status per dependency, and an audit list.

Every stage returns its output plus audit entries naming what it dropped and why.

### 5.2 Plan

| Mode | When | What happens |
|---|---|---|
| `full` | No earlier published review on the pull request, or the earlier head can no longer be read, or the base branch has changed since that review. Also a new head, where the repository's setting says so (D4) | Review the whole diff, and judge the bot's earlier threads if there are any |
| `incremental` | An earlier published review exists at a different head, where the repository's setting says so (D4) | Review what changed since that head, and judge the bot's earlier threads |
| `recheck` | A manual trigger on a head that already has a published review against the same base branch | Judge the bot's earlier threads, and read any file that is not yet covered. With neither to do, publish a short note without calling the model |

Rules carried over from the predecessor:

- The "last reviewed head" is the head of the last review **with a body** published by the app. Thread replies and bare approvals create bodiless review records and must not count.
- An automatic trigger on an already reviewed head is skipped as an empty diff. The one exception is a pull request retargeted to another base branch: its diff is different, so it gets a `full` review.
- A draft is skipped unless a person asked for the review.

**Threads a run judges.** Every major or blocker thread of the bot's that is not settled, whether it is resolved or not. A thread is **settled** when it is resolved in a way the rule in force accepts without a further verdict. For the gate that is the second half of its rule: the app resolved it, or a person replied in it (section 9). Where automatic approval is on under the strict rule, it is the second half of that rule (section 6.4). Judging resolved threads is a change from the predecessor, which judged only unresolved ones. Without it, an author who fixed the code and resolved the thread themselves could never have the fix verified, and on a later head the gate would have nothing left to clear that thread with.

**What a run reads.** In this order of priority, all within the batch limit (section 12):

1. Files holding a thread the run must judge, even when they have not changed. Without the file in front of it, the model's verdict on the thread is not kept (section 5.6, step 5).
2. Files that are not covered. A file is **covered** when a published run on this pull request has read it with the diff it has now, and every block of it has a score, its own or its file's (section 6.2). A file never read, a file whose diff changed after it was read, and a file with a block the model skipped are all uncovered. A file the service scores without the model (section 6.2) is covered without being read. In `incremental` mode these files are the run's main work, because a file whose diff changed is no longer covered.
3. In `full` mode, every other file of the pull request.

Files not yet covered come before files being read again, so an oversized pull request (section 12) is covered a few batches at a time in every mode.

Every file a run reads gets the same context (section 5.3).

**New heads: full or incremental (D4, owner).** One setting per repository chooses how a new head is reviewed: `full` or `incremental`. When it is not set, a gated pull request (section 9) gets `full` and any other gets `incremental`. Where a check blocks the merge on the bot's findings, the bot should have read the whole change at the head it passes.

Each choice has a known cost:

- **`incremental`** reads only what changed. A defect the first review missed in unchanged code is not found later.
- **`full`** reads everything again, so a later round can raise a finding on code the author has not touched since the last review. The predecessor did this on every manual trigger, and "new majors every round" was its engineers' main complaint. Expect it here too. On the predecessor, about half of the blocking findings raised in later rounds sat on a file that had not changed since an earlier review. The duplicate rule in reconcile (section 5.6, step 6) would have removed about one in seven of those later-round findings. That a gated pull request is reviewed only when asked does not help, because that was true of the predecessor as well. Later-round findings were right as often as first-round ones, so dropping them has a cost too. The owner's decision is to keep this behaviour, and to read the counter below before changing it.

Every `full` review of a later head records how many of its major and blocker findings sit on lines unchanged since the earlier head. That count shows what `full` costs in practice. What `incremental` misses shows in the eval's late-recall metrics.

**How the increment is computed.** A file is in the increment when the hash of its diff in the pull request differs from the one stored at the earlier head. The hash covers the changed lines and not their line numbers, so a rebase that only moves code leaves it alone. The git service's compare view is not used: it is unreliable after a squash or a force-push. A file in the increment is shown as its whole diff in the pull request, with the lines that changed since the earlier head marked. Those lines are found by comparing the file's content at the two heads. A finding on an unmarked line is handled by reconcile (section 5.6, step 7). The score is judged on the whole diff (section 6.2).

Because the model always sees the pull request's own diff against its base, anchors on both sides stay valid in every mode. Code that arrived through a merge of the base branch is not part of that diff and cannot take an inline comment.

### 5.3 Context and budget

The model receives everything inline. There are no chunk files and no read tool.

For each file under review:

- **The diff**, with every commentable line carrying an anchor: `R142    |+code` is the new side, line 142; `L98     |-code` is the old side, line 98. Lines that cannot take a comment have no anchor. Each block of the diff (section 6.2) opens with a header carrying its id, such as `B3`, and saying whether the block already has a score. The file's own header says whether the file may be given a whole-file score in this run. When GitHub omits a text file's patch, usually for size, the diff is computed from the file's two contents.
- **The full file at the head**, numbered. A file over 1,200 lines is shown as excerpts: each changed range widened by 150 lines. Removed files and low-priority files (generated, vendored, lock files, images) get no full-file context.
- **The paired test file**, when one is found by naming convention.

For the pull request:

- Title, description and branch names.
- The bot's earlier threads with replies and state, and in incremental mode the previous review's overview and acceptance rows.
- Memory blocks (section 7.4).
- Extension context, such as a ticket's acceptance criteria.

Files are ordered by a priority heuristic ported from the predecessor: size of change, raised for source directories and for paths that suggest services, models, authorization, payments, migrations, routes or API definitions, and lowered for documentation, generated output, fixtures and binary assets. The predecessor matched substrings; the port matches path segments.

There is one explicit budget per model call, with a fixed priority: contract and output format, then diff, then full files, then threads, then memory, then extension context, then room for tool results. Whatever is cut is named in the audit list. When the files do not fit one call they are packed into batches in priority order, and batches run two at a time. A file is never split between batches.

All text supplied by the pull request, the repository, a ticket or a tool is data. It is wrapped in markers with a random token generated per call, and invisible and bidirectional control characters are stripped. The contract tells the model that such text never changes its rules.

### 5.4 Model call

- **Endpoint (O20).** OpenRouter first: the project is built and tested against its chat completions endpoint, `https://openrouter.ai/api/v1/chat/completions`, with the key sent as a bearer token. Any other OpenAI-compatible chat completions endpoint with tool calling may be configured in its place. Base URL, key (by reference), model and request extras come from configuration. Nothing in the engine is specific to one provider beyond what this section lists.
- **Effort.** Elevated when the pull request has more than 15 files, more than 500 added lines, or targets a primary branch. Otherwise the default. Each level is a fragment of the request body, set in configuration and merged into the request as written, because endpoints disagree on the field. OpenRouter takes `reasoning: { "effort": "high" }`. The fragment is logged as sent.
- **Request extras.** Configuration may add fields to the request body and headers to the request. For OpenRouter this carries its `provider` preferences: which upstream providers may serve the model, `require_parameters` so that only providers that honour the forced tool call are used, and `data_collection: "deny"` for a team that will not send code to a provider that keeps it. A deployment that needs comparable eval runs pins the upstream provider here.
- **Usage and cost.** Token counts, cached tokens and cost are read from every response and recorded. OpenRouter returns the cost of each call in `usage.cost` and cached tokens in `usage.prompt_tokens_details.cached_tokens`, with no request flag. For an endpoint that reports no cost, it is computed from the token counts and prices set in configuration.
- **Tools.** `submit_review`, which ends the call, plus the tools of any configured MCP server. Nothing else, and no shell.
- **Loop.** With no MCP server configured this is a single request. With one, the engine runs a short loop with a hard cap on turns and on tool calls, enforced in code. On reaching a cap, on a prose answer, or on a tool error, the engine forces `submit_review` over the existing transcript instead of discarding the work.
- **MCP lifecycle.** Clients are opened per review and closed in a `finally` block with their own timeout. Tool results are truncated to a budget and wrapped as untrusted data. A documentation server typically indexes the default branch, so the contract forbids using it as the only evidence for a finding.
- **Prompt layout for caching.** Stable content first: the contract, then the tool definitions, then a per-repository block, then the pull request. The transcript is append-only. Nothing varying is ever inserted before earlier content. Whether this layout is cached depends on the model family. Some cache a repeated prefix on their own. Others need a marker: where the endpoint accepts one at the top of the request, as OpenRouter does for some families, the deployment sets it through the request extras. Markers on single blocks are not sent in the first version, so a model that needs those is reviewed without caching.
- **Retries.** Invalid output gets one retry, with the validation reason appended. A timeout on a batch of several files splits the batch in two and retries once. A provider error moves to the next model in the configured fallback list. The model that answered is read from the response and recorded.
- **What counts as a provider error.** Any status outside 2xx. Also a 200 response that carries an `error` object, has no choices, or ends a choice with `finish_reason: "error"`: OpenRouter reports failures of the upstream model this way. Two errors are not retried on another model, because the next model would fail the same way: a rejected key (401) and a key with no credit left (402). On either, reviews pause, gated checks say why, and an alert fires. A rate limit (429) is retried after the delay the response names.

The contract is one file in git. A test asserts its key rules, so a careless edit fails the build.

### 5.5 What the model returns

`submit_review` takes structured arguments:

- `overview`: what the change does, naming files.
- `findings[]`: `path`, `side`, `line`, `severity`, `body`, `quote` (the code on that line, copied verbatim), and `beyond_diff` for concerns about code the pull request did not change.
- `thread_verdicts[]`: `thread_id`, `verdict` (`fixed`, `answered` or `open`), `reply`.
- `acceptance[]`: only when acceptance criteria were supplied. `item`, `status` (`met`, `not_met`, `not_verified`), `note`.
- `files[]`: one entry per file in the batch. `path`, `change_summary`, an optional whole-file `score` with `category` and `reason`, and `blocks[]`, with one entry for each block the diff shows as not yet scored (section 6.2). Each block has its id and either a `score` (a whole number from 0 to 100) with `category` and `reason`, or `parts[]`, each with the anchors of its first and last line, a `score`, `category` and `reason`. A `reason` is required only for a score of 40% or more. Below that the category is enough: output is the expensive part of a call, and very long structured answers are the ones that fail to parse. With a second scorer named, the model is asked for no `blocks` (section 6.7).

The rules for findings are the predecessor's evidence contract, ported: the pull request introduces or exposes the defect; it is anchored on a changed line; it states a specific input or state and the wrong outcome; its evidence is something the model was given; certainty is a separate bar from severity, so a failure path the model could not verify is never major or blocker. Zero findings is a correct result.

The certainty rule has a known cost. The model sees only the files it is given, so a finding that depends on code elsewhere, such as a guard in a caller, cannot be verified and is never major. Defects that cross files were the predecessor's blind spot, and they remain one here (see the non-goals).

### 5.6 Reconcile

Deterministic, in this order. Each step adds audit entries.

1. **Schema.** Arguments must match the schema. A finding without a severity is invalid.
2. **Paths.** A finding or score for a file that is not in the pull request is dropped. So is a score for a block the batch did not contain.
3. **Grounding.** The overview or a finding must refer to a file of this pull request. This is the last defence against derailed output.
4. **Placement.** A finding on a commentable line is kept. One within 3 lines of such a line, on the same side, is moved onto it with a note after the severity tag. Anything further becomes "not placed on the diff": it is listed in the review body and does not block a merge. A `beyond_diff` item is not placed at all. It is a note about code the pull request did not change: it is listed under `Beyond the diff`, never gates, and never blocks automatic approval.
5. **Thread verdicts.** A verdict is kept only for a thread that exists, was opened by the app, is major or blocker, is one this run was due to judge (section 5.2), and whose file was in the batch that judged it. Three more checks follow:
   - An `answered` verdict needs a reply in the thread from an account other than the app. With none there is nothing to accept, and the verdict is dropped.
   - A `fixed` verdict is dropped when the pull request's head is still the one the thread was opened on. Nothing can have been fixed.
   - A `fixed` verdict on a thread whose own file has not changed since the thread was opened is kept, and recorded as a fix the service could not tie to the thread. The fix may be in another file.

   A dropped verdict leaves the thread as it was.
6. **Duplicates of earlier threads.** A finding is dropped as a duplicate of one of the bot's earlier threads on the same file in two cases. Either it sits within 3 lines of that thread, on the same side, and is of the same class, blocking (major or blocker) or minor. Or the thread's line is no longer in the diff and the finding quotes the same code as that thread: only then does the quote say where the thread was. A thread that still has a line is matched by its position alone. (Owner, when this step was built: as first written the quote decided for every thread, and a new blocker far from a thread was dropped because both quoted a line that held only a closing brace. No minimum length is set for the quote, so a short common line can still match a thread whose line is gone.) The thread may be open or resolved. Two limits keep the rule from hiding a new defect. A major next to an old minor thread is not a duplicate. And a thread whose latest verdict is `fixed`, from this run (step 5) or an earlier one, is never a reason to drop: a finding there is a regression or a new defect, and it is posted. Human-review notes (section 6.3) are not findings and are ignored here. A dropped major or blocker is listed in the body as "already discussed" with a link to the thread. When that thread was already closed for automatic approval, the dropped finding blocks the approval (section 6.4). The predecessor had no such rule and raised again findings an engineer had already answered.
7. **Mode.** In `incremental` and `recheck` modes, a new finding on a line that has not changed since the earlier head is handled by its severity. In `recheck` mode the head is the same, so that is every line of a file read before.
   - A blocker is kept and posted like any other finding. A change elsewhere can make an old line wrong, and a blocker is too costly to drop.
   - A major is not posted inline. It is listed in the body under `On code unchanged since the last review`, it does not gate, and it blocks automatic approval (section 6.4).
   - A minor is dropped.

   A file that no published run has read before is new to the reviewer in every mode. All its changed lines count as changed since the earlier head, and its findings are kept as usual.
8. **Scores.** Section 6.

**What a kept verdict does.**

| Verdict | Meaning | Merge gate (section 9) | Approval, strict rule (section 6.4) | Approval, same as the gate |
|---|---|---|---|---|
| `fixed`, and the thread's file changed since the thread was opened | The current code fixes it | Clears | Closed | Closed |
| `fixed`, and the thread's file did not change | The model says the fix is in another file | Clears | Not closed | Closed |
| `answered` | A reply in the thread shows the code is right | Clears | Not closed | Closed |
| `open`, or no verdict kept | The finding stands | Blocks | Blocks | Blocks |

Where the strict rule leaves a thread not closed, the merge is not held. The bot does not approve, and a person does.

### 5.7 Rendering

The service writes the review body from the structured result. The model does not write markdown headings, so there is nothing to reject for missing sections.

Sections, each present only when it has content: a one-line prefix for incremental, recheck or manually requested runs; `Summary`; `Human review`; `Acceptance criteria`; `Findings`; `Findings not placed on the diff`; `On code unchanged since the last review`; `Already discussed`; `Beyond the diff`; `Coverage`; `Overall`.

`Overall` is computed from the findings and the score. When batches ran, overviews are joined, findings are concatenated, and acceptance rows are merged by rule: an item is met when a batch shows it met and none shows it not met.

Bodies longer than GitHub's limit are trimmed from the middle so the tail (unplaced findings and the verdict) survives.

## 6. The score

### 6.1 What is scored

The score is a percentage from 0% to 100% (D7). It measures how much a change needs a person's judgement. It does not measure how likely the change is to contain a bug, and it is not a probability. Findings cover bugs.

| Score | Meaning | Examples |
|---|---|---|
| 0% to 19% | No judgement involved | Generated files, formatting, documentation text |
| 20% to 39% | Mechanical | A rename, new tests that mirror existing behaviour |
| 40% to 69% | A behaviour change that is local and follows an existing pattern | A bug fix inside one function, a new field passed through existing layers |
| 70% to 89% | A decision | A changed business rule, data model, public contract, permission check, calculation of money or time, or a structure that crosses modules. A dependency added or moved to another version. A test removed, skipped or weakened. A lint, type or CI check switched off |
| 90% to 100% | A decision that is costly to get wrong | Authentication, tenant isolation, an irreversible data migration, billing, security configuration |

The model returns a whole number. It first picks the band from what the code change does, then a position inside the band. What the description or a code comment claims about the change is not evidence.

Two kinds of change look mechanical and are not:

- **Dependencies.** A new dependency, or a different version of one, changes code that will run and that the reviewer cannot read. It is a decision, in the manifest and in the lock file alike. A lock file is scored by what it changes, not by being a lock file.
- **Weakened safeguards.** Removing, skipping or loosening a test or an assertion, and switching off a lint rule, a type check or a CI step, are decisions. An author that deletes a failing test has not made a test change.

Every score comes with a `category`: one value from a fixed list held in the contract. The first list is `generated`, `formatting`, `documentation`, `test`, `weakened_test`, `disabled_check`, `dependency`, `rename`, `refactor`, `fix`, `feature`, `business_rule`, `data_model`, `public_contract`, `permission`, `calculation`, `structure`, `authentication`, `tenant_isolation`, `migration`, `billing`, `security_configuration` and `other`. A value outside the list is stored as `other`.

**Design call: where the bands sit.** The owner set the scale and the 70% threshold. This document places 70% at the start of the "decision" band, which matches the owner's description of what needs a person: business rules and architectural decisions. The consequence is that a local behaviour change that follows an existing pattern is below the default threshold, so the bot can approve it. The backtest reports the numbers at 40% as well, so a team can see what the stricter line would catch and what it would cost.

### 6.2 Blocks, and the final score of a file

**Blocks (D21).** The scored unit is a block: one hunk of a file's diff in the pull request, which is a run of neighbouring changed lines with three lines of context, as git cuts it. The service numbers the blocks and the model returns a score for each one that has none yet. Because the blocks come from the diff and not from the model, the service can check that none was skipped.

The model may do two things beyond giving one score per block:

- **Split a long block.** A new file is a single block. So a block with more than 30 changed lines may be returned as parts. Each part names its first and last line by their anchors and covers the lines between them in the order the diff shows them, so a part may hold both removed and added lines. Once split, each part is a block in its own right, with its own hash, score, entry and note. Changed lines left out of every part form a block with no score.
- **Score a file as a whole.** Where every block of a file is the same kind of change, as in a lock file, one score covers all of them. And where the decision lies in how several blocks fit together, the model gives the file a score of its own, which the file keeps whatever its blocks score. Blocks the model did not score one by one then have no score of their own: the file's score stands for them, and the file is listed as a whole.

A block with no score counts as 100% in that run, unless its file was scored as a whole. That 100% is a placeholder and not a score. It is not stored and not carried to later runs, and the file counts as uncovered, so the next run reads it again (section 5.2).

The contract tells the model to score blocks, and to score a whole file only in those two cases or when the service asks for it (a moved file, below). The service cannot check that. The Focus number (section 6.6) shows it: a model that scores whole files leaves the person as much to read as before.

**The final score of a file** is the highest of:

- **Its blocks' scores, and its whole-file score if it has one.**
- **Built-in floors.** Changes to the reviewer's own file in the repository, to code-owner definitions and to CI workflow definitions score 100%. Changing them changes the safeguards.
- **Team floors.** Paths the team declares as always needing a person score 100%. They are read from the repository's default branch, never from the pull request.
- **Unknown.** A file the review did not cover, and a file the model returned nothing for, count as 100%. This is a placeholder in the same way.

For a renamed or moved file, both kinds of floor are checked against the old path and the new one. Moving a file out of a protected path is itself a change to what is protected.

Two kinds of file are scored by rule, without the model:

- A rename that keeps the file in its directory, with no content change, scores 30%.
- A raster image or a font scores 10%.

A move to another directory with no content change is not scored by rule. The model scores it as a whole file from its two paths, because a move can change a public URL where a framework routes by file path, and can change what other code is able to reach.

Any other file whose diff cannot be produced, such as an unrecognised binary or a text file too large to fit the budget, scores 100%. Path alone never earns a low score: a large file under a "vendored" or "generated" directory is still read by the model or sent to a human. The backtest will show how often this rule blocks an approval, and any exception is added only on that evidence.

No learned record lowers a score (D8). Learned records are shown to the model as reasons a block may need a person (section 7.4). Records that would argue the opposite are not shown to it at all.

D8 covers scores only. A lesson (section 7.2) works on findings: it can stop the bot raising a finding it would otherwise raise, and one major fewer can be what lets an approval through. Nothing in the score guards that path. What guards it are the rules on lessons themselves (section 7.3) and the kill switch on each one.

**Scores across reviews of one pull request (D17).**

- Scores are stored per block, with a hash of the block's changed lines, and per file, with a hash of its diff. Both hashes ignore line numbers, so a block that only moved down the file is the same block. Two blocks of one file with the same changed lines share one stored score.
- **A block is scored once.** A block whose hash already has a stored score for the same path is not scored again. The diff shows it as scored, the model is not asked for it, and the stored score, category and reason stand. While a file's diff is unchanged, nothing in it is scored again: not its blocks, and not the file as a whole, whether or not it already has a whole-file score. Scoring again would make a score the highest of several answers from a model that does not answer the same way twice. A pull request with many rounds would then drift towards needing a human for no reason in its code. Scoring once also costs less output.
- A file whose diff has changed is shown again as its **whole** diff against the base, never as the latest delta alone. Its new and edited blocks are scored. The model may also give the file a whole-file score, or raise the one it has, because the decision can lie in how the new blocks fit the old ones. A block with no score of its own, because the file's score stood for it, is shown as scored for as long as the file keeps that score.
- "Earlier" below means every completed run on this pull request, published or not, back to its first. Placeholders and dry runs (section 11.1) are not earlier scores.
- While a block stays in the diff, pushing again cannot lower its score:
  - A block that left the diff and came back unchanged takes its stored score again.
  - A block that is new or edited cannot score below the highest score an earlier run gave to a block of the same file that is not in the diff now. The service does not try to work out which earlier block an edited one came from, so it assumes the worst case. A long block that was split keeps its parts while its lines are unchanged.
  - A whole-file score never falls. It is kept per path for the life of the pull request.
- A block that is gone from the diff stops counting, and so does a file that leaves the pull request's diff entirely. A file's final score can therefore fall, but only because the block that carried it is gone.

Without these rules an author could push trivial commits until the model happened to score a block low. The worst-case rule has a cost: when a risky block is truly removed and another block of the same file changes in the same push, that other block inherits the high score for the rest of the pull request. Its entry says where the score came from. History is kept by path. For a file the diff shows as renamed, the history kept under its old path is used as well, so a rename gives no fresh roll. One gap is accepted: a file renamed twice within one pull request loses the history kept under the middle name.

**Across pull requests.** A stored score is reused for 30 days by any other pull request of the same repository that carries a block with the same path and hash. Closing a pull request and opening the same change again therefore gives its blocks no second roll. The score reused is the one the model gave, not one raised by the worst-case rule, which belongs to the pull request it arose in. A second gap is accepted here: an author who edits a block, even by one character, gets a fresh score for it in a new pull request. Inside one pull request the worst-case rule covers that. Across pull requests nothing does. The noise measurement (section 6.6) shows how much a fresh roll is worth.

The verdict always covers every file in the pull request at the current head.

### 6.3 The verdict

A pull request **needs a human** when any block, or any file as a whole, is at or above the repository's threshold. That is the same as saying some file's final score is. The default threshold is 70%, the start of the "decision" band, so by default a pull request is approvable when nothing in it makes a decision. A team that wants every behaviour change seen by a person sets the threshold to 40%. The threshold is set in the deployment config, as a default and per repository.

The review body always carries a `Human review` section. It lists the blocks at or above the threshold, grouped by file and highest first, each with a link to its lines, its score, its category and its reason. A file flagged as a whole (by a floor, by a whole-file score, or because the review did not cover it) is listed as a file, with the source of its score. With nothing at or above the threshold, the section is one line saying so. This is published whether or not automatic approval is on. A repository with a threshold below 40% sees the blocks between its threshold and 39% listed with their category only, because no reason is asked for below 40% (section 5.5).

**Inline notes (D22).** Inline notes are off unless a repository switches them on in the deployment config. The `Human review` section is always published and links every flagged block, so nothing is hidden with notes off. They are off by default because the predecessor's record is that a louder reviewer is read less. With notes on, each block at or above the threshold also gets a short inline note, carrying its line range, the score, the category and the reason, so a person reading the diff lands on it. The note is anchored on the block's first commentable changed line, the same way a finding is. A note is not a finding: it has no severity tag, it never gates, and no later review judges it. A block that already has a note is not given another. At most 50 notes are posted per review, highest scores first, and the remaining blocks appear in the body only. Notes are ordinary review threads. In a repository that requires every conversation to be resolved before a merge, someone has to resolve each one.

The app does not make a person review anything. It withholds its own approval and lists what to read. Where the repository requires an approving review, the pull request then waits for a person. The setup guide recommends that rule for every repository with automatic approval on: without it, the bot's approval decides nothing.

A person who reads only the flagged blocks and then approves is relying on the bot for the rest of that pull request. That is the same reliance automatic approval asks for, and the numbers in section 6.6 measure it.

### 6.4 Automatic approval

The app submits its review as an approval only when all of these hold:

1. The deployment config switches automatic approval on for the repository.
2. Every file in the pull request is covered at this head (section 5.2), by this run or an earlier one.
3. Nothing is at or above the threshold: no block, and no file as a whole.
4. This review has no major or blocker finding, placed on the diff or not. No major or blocker thread of the bot's is still open under the rule below. And no run on this pull request, this one included, reported a major or blocker that ended with no thread a later review could clear. That covers a finding that could not be placed, one whose inline comment was rejected, a major listed in the body because it sat on unchanged code (section 5.6, step 7), and one dropped as a duplicate of a thread that was already closed (step 6). Such a finding blocks automatic approval for the rest of the pull request.
5. The pull request is open, is not a draft, and its head is still the head that was reviewed.
6. The pull request was not drawn for the audit sample (section 6.5).
7. The pull request's branch is in the repository itself (D24). A pull request from a fork is never approved automatically, because pushing to a fork takes no access to the repository.
8. The base branch dismisses stale approvals, and the app can read that it does (D12). This is the git service's own rule that removes an approval when new commits are pushed. It is checked when a review is about to approve. Where the rule is off, or the app cannot read the branch's rules, the bot reviews as usual, does not approve, and says why in the review.

Otherwise the review is a comment, as in the predecessor.

**Blocking threads and approval (D18).** The gate (section 9) lets a thread clear when the bot accepts the author's reply, or when a person replies and the thread is resolved, and that person may be the author. That is right for a gate, which exists to make sure findings are answered. Whether it is enough for an approval that replaces a human reviewer is a setting, per repository, in the deployment config:

- **Strict, the default.** A major or blocker thread counts as closed in two cases only. First, the newest published review on the current head verified the fix in changed code: it kept a `fixed` verdict, and the thread's file changed since the thread was opened (section 5.6). Second, the thread is resolved, and either the app resolved it after such a verdict or a person **other than the author**, with access to the repository, replied in it. Access means owner, member or collaborator, the same check as for commands (D15, D23). On a public repository anyone can reply in a thread, and a stranger's reply closes nothing.
- **Same as the gate.** A thread counts as closed exactly when the gate's rule, as set for the repository, would clear it (section 9). The bot accepting a reply is enough. So is any person's reply once the thread is resolved, the author's included, unless clearing by reply is switched off.

The setting exists for wrong findings. Under the strict rule a wrong finding never blocks the merge. It costs one person's look: the bot does not approve, and a person reviews the pull request as they would one above the threshold. The relaxed rule saves that look. Its price is that the author, who may be an AI agent, can argue the bot out of a correct finding with no person involved.

Approval is decided only when a review runs. An author who has answered a thread comments `/review` to have it judged again. The rule is evaluated whether or not the gate check is on.

**Withdrawal (D12).** An approval belongs to one head. When a new commit arrives, or the pull request is retargeted to another base branch, the app dismisses its own approval at once, before the new review is queued. The review of the new head decides afresh, and approves again when every condition above holds. If the dismissal fails the app raises an alert, and where the gate is on it fails the check.

The app's own withdrawal is not a guarantee. It depends on the push webhook reaching a running app. While the app is down or restarting, or a delivery is late, the approval stands on the new head, and the pull request can be merged in that window. Redelivery at start-up (section 8.2) shortens the window and does not close it. Only the git service's own rule that dismisses stale approvals closes it. That is why the bot approves only where the rule is on (condition 8). The setup guide says how to enable it. When a pull request is merged at a head the bot did not approve while its approval still stood, the app records it and raises an alert.

Where a repository requires code-owner review, GitHub still waits for a person on owned paths, because an app cannot be a code owner.

### 6.5 Keeping the evidence honest

Once the bot approves a kind of change, no person looks at it, so nothing would ever record that it needed one. Two outside signals break that loop:

- **Audit sample (D9).** A share of approvable pull requests is sent to a human anyway and labelled as an audit. The share is set in the deployment config, as a default and per repository, and is 5% unless changed. At 0% the audit is off, and reverts are the only outside signal left. Selection is a hash of the pull request's identity, keyed with the deployment's audit key (section 11.1). Pushing again does not re-roll it, and an author cannot work out beforehand whether a pull request will be drawn. Opening a new pull request for the same change does give a new draw. That gap is accepted.
- **Reverts.** When a pull request is reverted, its files are recorded as having needed more attention. A revert is recognised nightly: a merged pull request whose description or commit messages carry the git service's standard revert reference to an earlier pull request or to its merge commit. Reverts enter none of the three numbers in section 6.6. The UI shows them as their own count, with how many of the reverted pull requests the bot had approved.

### 6.6 Measuring the score

Three numbers, reported at the start of each band (20%, 40%, 70% and 90%) and at the repository's own threshold:

- **Safety:** of the blocks that needed a human, the share the score would have left to the bot. Lower is better.
- **Benefit:** the share of pull requests in which nothing reaches the threshold.
- **Focus:** in pull requests that do need a human, the share of changed lines that sit inside flagged blocks or flagged files. Lower means less for the person to read.

Safety is also reported per file, using each file's final score. Both views come from one run, so they show what scoring by block adds over scoring by file.

A block **needed a human** when a person who is not the author left an inline comment on one of its lines, context lines included, that is not a reply inside one of the bot's finding threads. A reply inside a human-review note does count, for the block the note is on. A file needed a human when one of its blocks did, or when such a comment was left on the file as a whole. The stricter form, used for the headline number, also requires that the block's lines, or for a file its diff, changed in a later commit of the same pull request. Both are stored.

Any account that is not a bot and not the author counts here, with or without access to the repository. A human signal can only raise a score (D8), so a stranger can make the bot more careful and never less. The rules that can loosen something count only people with access (D23).

**Matching a comment to a block.** A person's inline comment is stored with its path, side, line and the commit it was made on (section 7.1). It is matched by line to the blocks of the run that scored that commit. When no run scored that commit, the comment counts for its file only. A block with no score of its own is measured with its file's score.

This label is a floor. A block that needed a person but was waved through looks safe in the data. The audit sample and reverts are there to catch part of what it misses. Labels per block are also fewer than labels per file, so the block numbers need more history before they mean much. Every number is shown with the count behind it.

**Backtest.** For a repository with history, a command builds cases from merged pull requests (the head a person first reviewed, plus the labels), replays the engine on them, and reports the three numbers with counts. Memory lookups use the case's own date as "as of", so a case never learns from its own outcome or from later ones. Block labels come from comments made on the replayed head, and comments made on other commits count for the file only. The stricter label checks whether each block's hash is still in the diff at the last head before the merge.

**Noise.** The model does not score the same code the same way twice. Every backtest on a new case file, and after every change of model or contract, is run twice. It reports, for each threshold, the share of blocks and the share of pull requests whose two scores fall on opposite sides of it. A difference in Safety or Benefit smaller than that band means nothing.

**Live.** After install, every score and every later human action is stored, and the UI shows the three numbers per repository over a rolling window, with the counts behind them. Benefit and Focus use each pull request's last run before it was merged or closed. A new repository starts with no numbers; they build up from the first pull requests a person reviews.

Whether the numbers justify switching approval on is the team's decision. The tool shows them and does not decide.

### 6.7 A second scorer (optional)

By default the review model scores the blocks in the same call that looks for bugs (section 5.5). A deployment may name a second scorer in its config (section 11.1). When it does, the block scores come from that scorer and the review model is not asked for block scores (D25). It exists so that the two ways of scoring can be compared on a repository's own history before either is relied on.

The first scorer supported is a decision model reached through its provider's decisions endpoint: a model that answers yes/no questions about a text with a probability and writes no text of its own.

- **What it reads.** For each file the review model read that has blocks, the pull request header and that file's section of the review prompt, as the review model received it: the diff cut into blocks, and the full file and the paired test unless they were cut to fit the input limit (section 5.3). A file the review model did not read is not sent and needs a person, as before.
- **Files without blocks.** A file moved to another directory with no content change has no block to ask about, and the questions are about code. The review model's whole-file score is kept for it (section 6.2); that one score is on the bands of section 6.1. For every other file the scorer answers for each block, so the review model's whole-file scores are not used.
- **What the review model is asked.** With a scorer named, the review model gets `contract/review-contract-scorer.md` in place of the review contract. It is the same text up to the section on blocks, and after that it asks for no block scores and for a whole-file score only on a moved file. The model still returns one sentence per file on what changed. If it scores a block anyway, that score is not used. Without a scorer the review contract is the one it always was.
- **What it is asked.** For each block, thirteen yes/no questions, each about one thing that can be checked on its own. Nine raise the score: a calculation of money, time or counts; a business rule; something other code calls; server-side access; the database schema; security; an irreversible change to stored data; a dependency; a weakened test or check. Four lower it: the block changes only what the user sees; it holds only declarations; it is only a rename, a move, formatting or generated output; it is test code.
- **How the answers become a score.** Three of the raising answers are soft (calculation, business rule, something other code calls) and six are hard (the rest). The highest soft answer is multiplied by one minus the highest lowering answer. A hard answer is never lowered. The score is the higher of the two, as a whole percentage. Test code stops lowering once the block weakens a test.
- **Category and reason.** Both come from the answer that set the score: a fixed sentence with the probability, and a category from the list in section 6.1 when the score is 50% or more. Below that the category is `test` for test code and `other` otherwise. The scorer writes no text, so nothing it returns is printed.
- **Failure.** A file the scorer cannot answer for, and a block it leaves out, count as not scored (100%). A review does not fail because the scorer failed: the findings stand. Every file the scorer failed on, and every file it was not asked about after a failure that stops the rest (a refused key, no credit), is recorded in the audit list. The backtest counts them per pull request and in total: each one is scored 100%, so a run with many of them would otherwise look safer than the scorer is.
- **The scale.** These scores are probabilities turned into percentages. They are not placed on the bands of section 6.1, and the default threshold was not chosen for them. A config that names a scorer must therefore write its threshold, and is refused otherwise; the example config ships with the default threshold commented out, so that writing it is a choice. The threshold is chosen from a backtest run with the scorer on (section 6.6).
- **What it costs.** One more provider, and more calls per review. The reviewed code is sent to that provider as well. The review model is not asked for block scores, so its answer should carry none that go unused. The tool definition it is sent is the same with and without a scorer. The scorer's cost is counted only when its provider reports a cost with each answer.

## 7. Memory

### 7.1 What is captured

From the first webhook, for every pull request, whether or not the bot has reviewed it:

- Reviews by people, with their state (approved, changes requested, commented) even when the body is empty.
- Inline comments by people, with path, side, line, the commit they were made on and the comment they reply to.
- General comments by people.
- Thread resolutions.
- Merges, closes and reverts.

Every review and comment is stored with its author's association with the repository, as the git service reports it at that moment: owner, member, collaborator or none.

The predecessor stored human activity only after its own first review, kept review state only inside a raw payload, and dropped approvals without a body. The score needs all three.

### 7.2 Records

A record is one learned item, scoped to a repository:

| Kind | Made from | Used for |
|---|---|---|
| `lesson` | A reply, by someone with access to the repository, that correctly showed a finding was wrong | Findings |
| `human_signal` | A block that needed a human (section 6.6), with its file's path and directory and a short excerpt of what the person wrote. When the bot had scored that block, also its category and reason | Score |
| `revert` | A reverted pull request's files | Score |

Every record has a source reference, a status (`active` or `disabled`), a creation time and an expiry. Lessons expire after 90 days, as in the predecessor. Signals and reverts expire after 180 days.

### 7.3 Learning

- **When a pull request closes:** its human signals are derived. This needs no model call.
- **When a person comments inside a block the bot scored below the threshold:** the miss is recorded immediately.
- **Nightly:** replies to the bot's findings are judged by a model call into `confirmed_fix`, `valid_pushback`, `invalid_pushback`, `question` or `noise`. A valid pushback may become a lesson. Reverts are detected and expired records are retired.

Guardrails on lessons, inherited, because lessons edit the reviewer's own prompt:

- The reply must come from an owner, member or collaborator of the repository, the same check as for commands (D15, D23). On a public repository anyone can reply in a bot thread. A stranger's reply is stored and judged, and never becomes a lesson.
- The judge must quote the reply verbatim. A quote that is not in the reply discards the lesson.
- A lesson must be a general rule: a length range, and no pull request numbers.
- A lesson that restates an active one is dropped.
- At most 10 new lessons per run.
- Every judged reply is marked, whatever the outcome, so the queue moves forward. A reply the judge keeps omitting is retired after 3 attempts.

Every record has a kill switch in the UI, and learning can be turned off in configuration.

The learning job reports when it last ran and how many records it added. If it has not run for 36 hours an alert fires. The predecessor's version of this loop was deployed and did nothing for weeks before anyone noticed.

### 7.4 Retrieval

Retrieval is deterministic lookups in Postgres. Every lookup takes an "as of" time.

- **Repository block.** Stable for a day, so it sits in the cached part of the prompt. It lists the directories and categories where people most often had to step in, with counts.
- **Pull request block.** For each changed file: records on the same path, newest first, otherwise records from the nearest directory that has any. Lessons are chosen by shared directory or file type with the changed files first, then by recency.

Each block has a fixed size. What is cut is named in the audit list. The predecessor injected lessons newest-first within a size limit, so most of a large repository's lessons never reached the reviewer.

**Embeddings.** Lookups cannot match a brand-new file in a new directory. Similarity search over change summaries is the first experiment once memory is built and both evals have been re-run with it (stage 8 of the build order), judged on the safety number. Adopting it means moving to a Postgres image that includes the pgvector extension. That is the same database, and it adds no service.

The engine sees memory through one read-only interface: given the changed files and an "as of" time, return the two blocks. Production backs it with the database. The eval backs it with records built from a local history file, so a backtest never touches a database.

### 7.5 History import (D19)

A repository with history should not start empty. One importer reads a repository's merged pull requests over a chosen window, through read-only access, and collects for each: its files, the head a person first reviewed, the diff at that head and at the last head before the merge, and the human activity of section 7.1.

It has two outputs:

- **A local history file**, which is both the case file for the score backtest and the source of "as of" memory during it.
- **On request, rows in the database**: the human activity and the human signals derived from it. This seeds a new deployment's memory.

Imported signals have no category or reason, because the bot never scored those blocks. They carry path, directory and the excerpt.

## 8. Service shell

This is the predecessor's behaviour, ported, with the fixes marked.

### 8.1 Receiving

Order on every webhook: verify the signature, parse, reject a delivery id already seen, **store it**, acknowledge, then act.

*Fix (D14):* the predecessor acknowledged commands before storing them, so a crash in that window lost the command. Here lookups a command needs happen inside its job.

| Event | Action |
|---|---|
| Pull request opened, reopened, ready for review | Queue a review |
| Pull request new commits | Withdraw any approval, then queue a review after a 180-second quiet period. A newer push replaces a pending one |
| Pull request retargeted to another base branch | Withdraw any approval, queue a `full` review |
| Pull request closed | Derive learning records |
| Comment `/review` | Queue a manual review |
| Comment `/done` | Gate command (section 9) |
| Comment `/ai-review-skip <reason>` | Gate command (section 9) |
| Re-run requested on the app's check | Queue a manual review |
| Review, inline comment or general comment by a person | Store as human activity |
| Thread resolved or reopened, or a reply in a thread | Store. Re-evaluate the gate if the pull request is gated |

Filters on automatic reviews: drafts, ignored authors (configuration, default the dependency bot), a base-branch filter (configuration, default all), and gated pull requests, which are reviewed only on request.

A repository is reviewed when the app is installed on it. There is no separate allowlist.

There is no separate HTTP endpoint for requesting a review (O17). A tool that wants one posts a `/review` comment from an account with access to the repository or, on a gated pull request, re-runs the app's check.

Commands are read from the first line of a comment that the app itself did not write. *Fix (D15):* all of them require the commenter to be an owner, member or collaborator. The predecessor let anyone trigger `/review`, which on a public repository lets a stranger spend the budget.

Acknowledgement: an eyes reaction when a command is accepted. On refusal or failure, a confused reaction and a reply that starts with a mention and carries a short code. Failure text never includes stack traces or host paths.

### 8.2 Queue

- Stored in Postgres. Pending, delayed and running jobs all survive a restart.
- Fixed concurrency, and never two jobs for the same pull request at once.
- Before a job runs, the pull request's live head is read. An automatic job for a head that has moved is dropped. *Fix:* the predecessor took this from an in-memory map that only pushes updated.
- A job is started at most 3 times.
- **Shutdown** drains: no new jobs start, webhooks are still accepted and stored, and running reviews get a bounded time to finish. A job cut short stays marked as running.
- **Start-up** recovers before listening: interrupted jobs are re-run unless their review was already published, delayed jobs are re-armed, and old or closed ones are dropped.
- Once listening, the app asks GitHub to redeliver webhook deliveries that failed while it was down, using a heartbeat row to know how far back to look.

### 8.3 Publishing

- One review per run, always pinned to the commit it read (D20). The head is read before and after the pull request's file list. If it moved in between, an automatic job stops, because the new head's own trigger will review it, and a manual job starts over once.
- A server error is retried once.
- A rejection because an inline comment is off the diff is retried first without the human-review notes, which then appear in the body only. If that is rejected too, it is retried as body-only, with the dropped comments listed in the body.
- If GitHub rejects the commit itself, the publish fails. An unpinned review is never posted in its place.
- After publishing, the app's inline comments are read back from the pull request's comment list and stored with their ids, paths and lines. The per-review list omits lines.

### 8.4 Threads

- Threads are read with their comments, authors, resolution state and current line. Paging has a cap, and reaching it is an error, not a truncated list.
- **The bot is identified by the app's own account**, by account type and app identity. Never by a list of logins.
- **A person**, wherever this document counts a person's reply or comment, is an account that is not a bot, by account type. A reply from another bot, such as a coding agent's own account, is not a person's reply: by itself it clears no gate thread, closes nothing for approval and makes no lesson. The reviewer may still accept what such a reply says when it judges the thread (`answered`).
- When a verdict clears a thread, the app replies with the confirmation and a hidden marker carrying the review id and the head commit. If the app's own reply is already last in the thread, it is edited, not stacked.
- Thread ids in verdicts are checked against the threads actually read before anything is posted.
- **Resolving (D16).** Resolving a thread needs write access to repository contents, which many teams will not grant a reviewer. With it, the app resolves the thread after replying. Without it, the reply and marker are enough for the gate. At start-up the app reads its granted permissions and the events it is subscribed to. It logs exactly which features are off because of what is missing, and raises an alert for each. The predecessor failed to resolve threads silently hundreds of times, and its `/review` command once did nothing because one event was not subscribed.

### 8.5 Recording

- One row per run, append-only: its mode, head, outcome, failure stage, cost, and when published the review id and whether it was an approval.
- Nothing is overwritten, so a failed re-run cannot hide a published review. The predecessor kept one row per head and needed guards against exactly that.
- "The last published review" used for planning (section 5.2) is the newest published run that is not a `recheck`.

## 9. Merge gate

Off by default, switched on per repository in the deployment config. These rules were decided for the predecessor and are inherited unchanged:

- A pull request is **gated** when its repository has the gate on and its base branch is in the gate's list of branches.
- A required **check run**, named `AI Review` by default, posted by the app.
- On a gated pull request no review runs on push. The check is posted as queued with the title "Waiting for /done". A review runs on `/done`, `/review`, or a re-run of the check, and the check shows in progress while it runs.
- A major or blocker thread clears only when the newest published review on the current head verified it, or it is resolved **and** either the app resolved it or a person replied. A resolve with no reply does not clear it. "Verified" means that review kept a `fixed` or `answered` verdict for the thread (section 5.6).
- Findings that could not be placed on the diff do not gate.
- `/done` runs the review unless the check is already green on this head. It also reads the required CI checks named in configuration and says so when everything is already green.
- `/ai-review-skip <reason>` is limited to one team named in configuration. A failed membership lookup is reported as "could not verify", never as "not a member". The skip and its reason are stored.
- It fails closed. If the gate cannot be evaluated, the check fails with a short code and tells the author to comment `/done`.
- Two operating modes. `shadow`, for rollout, computes and posts the check exactly as the gate would, on reviews, thread events and `/done` alike, and changes nothing else. Reviews stay automatic on push, and D4's default treats the pull request as not gated. `bypass`, for an outage, turns every check green.

*Changes from the predecessor:* a skip is stored in the database, not held in memory and in the check's title. Check updates for one commit are serialised inside the single app process (D13).

**Wrong findings (O18).** A finding can be wrong, and a wrong major must not hold a merge. The thread rule above covers it. A person replies in the thread saying why, the thread is resolved, and the check is evaluated again at once, without a new review. The person may be the author. A resolve with no reply still does not count. The finding stays visible on the pull request, and the reply is judged that night and may become a lesson (section 7.3).

The gate does not check the replier's access to the repository, unlike lessons and the strict approval rule (D23). On a public repository, the author of a pull request from a fork can therefore turn the check green alone. The owner chose to leave that as it is: the merge itself still takes someone with write access.

Clearing a thread this way is a setting in the gate block, on by default. With it off, a thread clears only when a review verified it. The ways past a wrong finding are then a `/review`, in which the bot may accept the reply, and the team's `/ai-review-skip`.

**Files the review did not cover (O15).** The predecessor had no such case. Here the pull request goes to human review: the files are listed for a person and the bot does not approve. The check is decided on the files that were reviewed, and its title says how many were not. It does not fail for that reason alone, because a person's review could not turn a failed check green.

## 10. Git-service boundary

Only `forge/github` imports GitHub's API, payload shapes or identifiers. A lint rule enforces it. Everything else uses the project's own types: a pull request reference that includes the service name, normalised events, threads and review drafts. Tables carry the service name in every repository identity.

No general plug-in interface for git services is designed now. It will be extracted when GitLab is built, from two real implementations.

GitHub access is direct HTTP with installation tokens. The `gh` command-line tool is not used. Tokens are minted per installation, read from each webhook, and cached until shortly before expiry.

**What GitLab will need to answer.** Its closest match to a required check is a paid-tier feature, and its free "all threads must be resolved" rule allows the silent resolve the gate forbids. Gate parity on GitLab is not promised.

### App permissions

| Permission | Level | Needed for |
|---|---|---|
| Pull requests | Write | Reviews, replies, approval, dismissal |
| Contents | Read | File contents, the repository's reviewer file |
| Contents | Write (optional) | Resolving threads |
| Checks | Write | The gate's check run |
| Commit statuses | Read | Reading required CI checks for `/done` |
| Issues | Write | Reactions and replies to commands |
| Organization members | Read | The skip-team check |
| Branch rules (the exact permission is to be verified, section 20) | Read (optional) | Reading whether the base branch dismisses stale approvals. Needed only for automatic approval |
| Metadata | Read | Required by GitHub |

Events: pull request, issue comment, pull request review, pull request review comment, pull request review thread, check run.

The repository ships this list and an app manifest file that GitHub can create the app from.

## 11. Configuration

All configuration is typed and validated at start-up. An unknown key, a bad value or a half-configured feature stops the app before it listens. No behaviour is decided by an environment variable. Environment variables carry secrets only, and the config refers to them by name.

### 11.1 Deployment config

One file, owned by whoever runs the deployment and kept in their own git repository. It holds:

- The app's identity (id, key and webhook secret, by reference).
- The model: endpoint and key (by reference), model, the request fragment for each effort level, fallbacks, request extras (body fields and headers), and prices per token for an endpoint that reports no cost.
- The second scorer (section 6.7), optional: endpoint and key (by reference), model and time limit.
- Limits and cost guards (section 12).
- Repository defaults and per-repository overrides: primary branches, ignored authors, base filter, how a new head is reviewed (D4), the gate block, and the score block (threshold, automatic approval, audit share, the thread rule for approval, and inline notes).
- MCP servers and extension modules.
- The alert webhook.
- Learning, on or off.
- Who may open the UI: named accounts or one team.
- The audit key, by reference: the secret that keys the audit draw (section 6.5).
- Dry run, for the whole deployment. Reviews are computed and recorded, nothing is written to the git service (no review, reply, note, check, approval or dismissal) and no notifier is called. Capture and learning run as normal. A dry run never counts as an earlier run: not as the last published review, not for scores and not for coverage.

### 11.2 The file in a reviewed repository

A team may commit one file, `.visto-ai.yml` at the root of its repository, listing paths that always need a human. It is read from the repository's default branch.

**Design call D10.** This file can only tighten. Anything that loosens protection (the gate off, clearing a gate thread by reply, approval on, a higher threshold, a smaller audit share, the relaxed thread rule for approval) is set in the deployment config, which a pull request cannot change.

### 11.3 Extensions

The deployment config may name extension modules. A module can provide:

- **Context providers:** given the pull request's metadata, return a labelled block of text, optionally acceptance criteria, and a status. Ticket and wiki lookups are built this way.
- **Notifiers:** called after a review is published, and for alerts. A chat message to the author is built this way.
- **Feedback routes (O16):** a notifier may collect a thumbs up or down on the review it announced, with an optional reason. The module registers HTTP routes under a prefix reserved for it. The app hands it each request untouched, so the module can verify its chat tool's signature. The module reports an answer to the core through one function: the review run, the person's git login, up or down, and the reason.

A module that fails to load stops start-up. Each provider's status is recorded on every review. Provider output is untrusted data with its own size limit.

Feedback is stored per review run, one answer per person, the latest winning. It is a measure of the reviewer: the UI shows the share of thumbs up per repository and the reasons given. It creates no memory record, because a verdict on a whole review does not say which finding or score was wrong. Feedback routes are public like every other route: a request that fails the module's check is rejected with no detail, and request size is capped.

The first deployment's ticket, wiki and chat integrations are extensions kept in its private repository, together with data such as the map from git logins to chat users. None of that is in this repository.

### 11.4 Names

The project is Visto AI (O14). Identifiers use `visto-ai`: the image, the hidden marker in thread replies, and the file a team commits (section 11.2). The database schema is `visto_ai`. The gate's check keeps its own configurable name (section 9).

## 12. Limits and cost guards

Initial values, to be tuned with the eval:

| Guard | Initial value | When reached |
|---|---|---|
| Input per model call | 200,000 tokens | Files move to the next batch |
| Batches per review | 6 | Remaining files are not reviewed (D5) |
| Spend per day | 50 USD | Reviews pause, gated checks say why, an alert fires |
| Queue concurrency | 2 | Jobs wait |
| MCP tool calls per review | 8 | The engine forces the submit call |
| Human-review notes per review | 50 | Further blocks are listed in the review body only |
| Reuse of a block's score by other pull requests | 30 days | The block is scored again |

**These are starting values for a small team.** The input limit starts high on purpose. Files in different batches cannot see each other. The predecessor's reviews peaked at a median a little under half of this limit, and about one in ten went above it. The eval decides where the limit ends up. The daily spend limit and the concurrency must be set for the deployment's own volume. Concurrency has to be at least the reviews requested in the busiest hour, times the minutes one review takes, divided by 60. The predecessor outgrew both of the values in this table.

**What "oversized" means (D5).** There is no limit on files or lines. A pull request is oversized when its files, packed in priority order with their context, need more batches than the limit allows: with the values above, more than 6 calls of 200,000 input tokens each. Both values are settings, and the input limit must fit the configured model with room for its answer. As a rough guide, that is somewhere between 100 and 200 ordinary source files with their full contents. This is an estimate and has not been measured.

When that happens, files are reviewed in priority order until the limit. The rest are named in a `Coverage` section written by the service and score 100%. The pull request goes to human review, and is not approved automatically while any file is uncovered (O15). This replaces the predecessor's rule that size is never a reason to review less, under which one very large pull request could spend most of a day's budget.

A failed batch does not waste the others. Completed batches are kept while the failed one is retried. If it fails again, its files are treated as not reviewed and the rest is published.

Coverage carries between runs. The next run on the pull request, in any mode, also takes the files that are not covered (section 5.2), in priority order, within the same limits. A very large pull request is therefore covered over several runs. One run costs at most the batch limit. There is no limit on what one pull request may spend in a day (O21), so repeated manual reviews of a very large pull request are held only by the daily limit.

Memory use per review is bounded by the call budget times the concurrency. No review holds state in a long-lived session.

## 13. Data model

The schema is designed fresh. Identity everywhere is the git service, the repository and the pull request number.

| Table | Holds |
|---|---|
| `schema_migrations` | Applied migrations. Migrations are ordered and each runs once |
| `deliveries` | Webhook delivery ids, for duplicate rejection |
| `jobs`, `heartbeat` | The queue and the liveness mark |
| `pull_requests` | Author, state, merge and revert facts |
| `review_runs` | One per run, append-only: mode, head, status, review id, whether approved and when dismissed, body, usage, dependency statuses, coverage, count of blocking findings on unchanged lines, count of blocking findings left without a thread |
| `review_comments` | The app's published inline comments: findings, with their severity and quoted code, and human-review notes, with their block's hash |
| `file_scores` | Per run and file: hash of the file's diff, final score, floor source, whole-file score if any, change summary |
| `block_scores` | Per run, file and block: hash of the block's changed lines, line range, score, what it carried from earlier heads, category, reason, parts if split |
| `human_activity` | Section 7.1, with each author's association with the repository |
| `thread_verdicts` | Per run and thread: the review's verdict (`fixed`, `answered` or `open`) and, for `fixed`, whether the thread's file had changed |
| `reply_verdicts` | The nightly judge's classification of each reply |
| `memory_records` | Section 7.2 |
| `gate_evaluations`, `gate_overrides` | Gate history and skips |
| `review_feedback` | Thumbs up or down per run and person, with the reason (section 11.3) |

Finished jobs are deleted after 14 days. Nothing else is pruned in the first version.

A deployment that ran the predecessor brings its history across with a one-off migration script kept in its private repository. Its open pull requests need a decision of their own. Threads the predecessor verified carry the predecessor's hidden marker, which this app does not read, so on a gated pull request they block again until the next review. That deployment's migration either converts the markers or its plan tells engineers to expect it.

## 14. Observability

- **One structured log line per review** with stage, outcome, failure stage and a short failure code.
- **A status per dependency on every review:** the model, each extension, each MCP server, memory.
- **Usage per review:** calls, tokens, cached tokens, cost.
- **Model connection check.** At start-up, and then on a timer, the app checks that its key reaches the model endpoint. For OpenRouter that is the key endpoint (`GET /api/v1/key`), which also returns the key's limit and what is left of it. The result is the model's dependency status. A failure raises an alert and does not stop start-up: webhooks are still stored, and reviews wait.
- **Health.** The public health route returns liveness only. Queue state, recent reviews and configuration are served only behind the UI's sign-in. Assume every route is reachable from the internet.
- **Alerts**, posted as JSON to one configured webhook and shown in the UI:
  - the publish rate falls;
  - a dependency's status changes;
  - cached tokens stay at zero across reviews that made more than one request in sequence. A single-request review at low volume misses the cache legitimately and is not counted;
  - the learning job is stale;
  - spend reaches 80% of the daily limit;
  - a dismissal fails;
  - a pull request is merged while a stale approval of the bot's still stood (section 6.4);
  - a permission or an event that a configured feature needs is missing (section 8.4).
- Health and alerts read live data, never a file written earlier.

## 15. Evaluation

Two commands. The findings replay arrives with stage 2 of the build order and the score backtest with stage 3. Memory joins both in stage 8. Neither can write: the eval builds its source in a read-only mode in which any write call throws.

### 15.1 Findings replay

Ported from the predecessor. A case is a pull request at a head where engineers already judged the bot's comments. The engine is replayed at that head with earlier threads hidden, and its inline findings are matched to the labels by path, side and line within 3.

Metrics keep their names: `valid_recall`, `valid_blocking_kept`, `invalid_repeat_rate`, `invalid_blocking_rate`, `first_recall`, `late_recall`, plus volume, cost and duration. A compare command refuses to compare runs of different case files.

What this eval can and cannot show:

- **It shows "not worse".** Labels are comments an earlier reviewer made. A valid finding that nobody raised before has no label and scores nothing.
- **It is noisy.** The same code run twice differs. Every new case file and every model change starts with two baseline runs, and their difference is the noise band.
- **New findings need a person.** The command writes out a sample of unmatched major and blocker findings for hand labelling.
- **A small case file shows only large effects.** The case file inherited from the predecessor has a few dozen cases, and on it the main metrics move by a few points between identical runs. A larger file is built before the replay is used to settle a close call.

**When scoring joins the call.** Scoring shares the model call with findings and adds a long structured answer to it. When scoring is added (stage 3 of the build order), and whenever the scoring part of the contract changes, the findings replay is run again on the same case file. If a findings metric leaves the noise band for the worse, scoring moves to a model call of its own.

Documentation tools are off during replay. Replayed pull requests are merged, so an index of the default branch already contains their fixes.

### 15.2 Score backtest

Section 6.6.

### 15.3 Case files

Case files hold code from the repositories they were built from. They are never committed here. The harness is public and the cases are private.

## 16. Testing

- **Every boundary is stubbed.** The test runner blocks all outbound network and clears credential variables before any test loads. A test that tries to reach a real service fails immediately. This rule exists because a predecessor test once posted a real review on a real pull request.
- **Database tests** run against an in-process Postgres created per test, never a configured connection.
- **Ported modules bring their tests.** The shell's edge cases live in the predecessor's tests, and they are ported with the code.
- **The contract has a test** asserting its key rules.
- **The model client is tested against OpenRouter's response shapes,** as synthetic fixtures: a forced tool call, an error inside a 200 response, a rejected key, a key out of credit, and a rate limit.
- **CI runs in a Linux container.** Some failure modes do not appear on macOS.
- **Fixtures are synthetic.** No real repository names, pull request numbers, logins or code.

## 17. Deployment

- A Compose file with two services: the app image and the official Postgres image, with one volume.
- TLS and the public hostname are the adopter's, in front of the app.
- One app instance per deployment. Locks for check updates and per-pull-request exclusivity are in-process, so a second instance would break them. The app takes a database lock at start-up and refuses to run beside another instance.
- Setup, in order: create the app from the manifest, set the secrets, write the deployment config, start, install the app on repositories.

## 18. Build order

Each stage ends with something that can be measured or shown.

**What "ported" means.** The builder has read access to the predecessor's source, held privately. It is JavaScript, with a test file beside each module. Wherever this document says ported or inherited, the builder reads the predecessor's module and its tests and carries over the behaviour and the test cases, cleaned of anything internal. The predecessor's baseline numbers come from its saved eval runs on the same case file, supplied by the owner.

1. **Skeleton.** Repository layout, typed configuration, the contract file and its test, the network-blocking test harness, CI.
2. **Engine: findings.** Context, model call, reconcile, rendering, and the findings replay. Compared with the predecessor on a frozen case file before anything else is trusted.
3. **Engine: score.** The rubric, blocks, floors, the verdict, the history importer writing local files, and the score backtest. The findings replay is run again with scoring in the call (section 15.1).
4. **Shell.** Receiving, queue, capture of human activity (section 7.1), publishing (findings and human-review notes), threads, commands. A dry-run mode computes and records a review but publishes nothing.
5. **Gate.**
6. **Extensions and MCP tools,** including feedback routes.
7. **Shadow at the first deployment, then cut-over.** Tracked in that deployment's private repository. From here the first deployment runs on this project: findings, the gate, and the score shown in every review, with automatic approval off and no learned records yet. Capture is already storing the human activity that memory and the live numbers need.
8. **Memory.** Records, learning, retrieval, and the importer's database output. Both evals are re-run with memory "as of" each case. Until the UI exists, a record can be disabled only in the database. A deployment may leave learning off in configuration until stage 10.
9. **Automatic approval and withdrawal.**
10. **UI.** Three screens: score numbers per repository, learned records with their kill switch, recent reviews with failures, feedback and dependency health. Sign-in is through the same app, and access is limited to the accounts or the one team named in the deployment config. With neither named, the UI is off.

Stages 2 and 3 need a case file, read access to the repositories it came from and an OpenRouter key. The owner supplies those. The replay in stage 2 is the first real use of the OpenRouter connection, so it is also where that connection is proven (section 20, item 4).

## 19. Keeping the repository clean

- No history from the predecessor. Files are copied in deliberately.
- Nothing internal to any deployment: no logins or people, no hostnames, no repository names, no review history, no eval cases, no learned records, no incident notes.
- Ported code was not released until the owner confirmed sign-off (O2).
- Before release, the repository is scanned against a term list that is itself kept privately.
- No secrets in the repository or in prompts.

## 20. To verify before relying on

Each of these comes from documentation or third-party reports, not from a test.

1. An app's approving review counts toward a repository's required approvals.
2. An app can dismiss its own approval on a protected branch. The docs suggest it may need to be on the dismissal allowlist.
3. The app manifest flow accepts the permission set in section 10.
4. Through OpenRouter, with the chosen model: a forced tool call is honoured, the `reasoning` fragment is accepted, cost and cached tokens come back on every response, one credit of reported cost is one US dollar, and the response names the upstream provider that served the call. OpenRouter's documentation states the first three and not the last two.
5. The in-process Postgres used for tests behaves like the real one for the queries the queue uses.
6. A `/review` comment posted by a tool's own account carries a repository association that the command check (D15) accepts. A comment posted by another app probably does not.
7. The association the git service reports for a commenter (owner, member, collaborator) is right for a member of an organisation whose membership is private. If it is not, D15 and D23 need a lookup of the commenter's permission on the repository instead.
8. Which permission lets an app read a branch's protection rules, in both of GitHub's forms (rulesets and classic branch protection), and whether the answer says that stale approvals are dismissed (section 6.4).
9. One review can carry 50 inline notes on top of its findings.
10. The decisions endpoint the second scorer uses (section 6.7) is marked alpha by its provider: its path, request and response may change.
11. That a decision model's answer to one question does not depend on which other questions travel in the same request. The question set was reduced after it was first tried.
12. That the review model's findings are the same under the contract it gets when a scorer is named (section 6.7) as under the review contract. The findings rules are the same text in both; the replay eval run with a scorer named is what shows it.

Items 1 to 3 and 6 to 9 need a scratch repository and the owner's go-ahead. Items 4 and 12 need an OpenRouter key and the owner's go-ahead, because they spend money.

## 21. Open points for the owner

The five points of the first draft are settled: the name (O14), coverage (O15), chat feedback (O16), the trigger endpoint (O17) and the defaults (D7, D9).

The five points raised by the review against the predecessor's production record are settled too, each as this document recommended: the build order (O19), later rounds on a gated pull request (D4), approval only where stale approvals are dismissed (D12), inline notes off unless switched on (D22), and no access check on a reply that clears a gate thread (O18).

Still open:

1. **How O15 was read.** "Goes to human review" is implemented as: the bot does not approve, the files are listed for a person, and the gate's check does not fail for that reason alone (section 9). In a repository that does not require an approving review, nothing makes the human look happen. The alternative is a check that stays red until a person other than the author approves.
2. **Where 70% sits** (section 6.1). As placed, a local behaviour change that follows an existing pattern is approvable by default.
3. **Copyright holder.** The licence notice needs a name. Sign-off is settled (O2).

## 22. Left to the builder

- Library choices (HTTP server, schema validation, diff, test runner, Postgres client).
- File and module names inside each part.
- Exact prompt wording, within the contract's rules.
- Exact shapes of the internal types.
- UI layout.
