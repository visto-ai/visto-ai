<img src="assets/icon.svg" width="96" alt="Visto AI icon">

# Visto AI

An open-source, self-hosted AI reviewer for pull requests. It looks for defects it can demonstrate, and it scores which parts of a change still need a human reviewer.

> **Status: early development.** The review engine and an offline evaluation tool are built. The service receives GitHub's webhooks, reads each pull request and runs the review. In dry run it records what it would have posted and posts nothing; out of dry run it posts a review when a pull request is opened and again when its head or base moves, unless the review would say nothing the newest one does not already say, and follows up the threads of its own earlier reviews. The first review, `/review`, a later review with its threads, an incremental review, a re-check, a push that tells nothing new and scores kept across reviews were each tried once against a real GitHub App, on a small private repository. See [Status](#status).

## Why

Code used to be written by people and reviewed by people. Now AI writes much of it, and people hand the review to AI as well. Nobody is left deciding which changes still need a person.

Visto AI reviews a pull request and answers two questions:

1. **What is wrong with this change?** Findings the reviewer can demonstrate, each with a concrete failure scenario. No style comments.
2. **Which parts of the change need a human reviewer, and why?** Every changed block of code gets a score from 0% to 100%. Blocks at or above a threshold (70% by default) are listed for a person, with the lines to read. If nothing reaches the threshold, and the team has switched this on, the bot approves the pull request.

The aim is to reduce what people must review, and to be able to show the numbers that justify it.

## The score

The score measures how much a change needs a person's judgement. It does not measure how likely the change is to contain a bug: findings cover bugs.

| Score | Meaning | Examples |
|---|---|---|
| 0% to 19% | No judgement involved | Generated files, formatting, documentation text |
| 20% to 39% | Mechanical | A rename, new tests that mirror existing behaviour |
| 40% to 69% | A local behaviour change that follows an existing pattern | A bug fix inside one function |
| 70% to 89% | A decision | A changed business rule, data model, public contract or permission check. A new dependency. A weakened test |
| 90% to 100% | A decision that is costly to get wrong | Authentication, tenant isolation, an irreversible data migration, billing |

The scored unit is a block: one hunk of the diff. A file with ten changes, of which one is a decision, sends a person to that one change and not to the whole file.

## What it is designed to do

- **Evidence-backed findings**, tagged `[blocker]`, `[major]` or `[minor]`.
- **A human-review score** for every changed block, with a reason for each block that needs a person.
- **Optional automatic approval**, per repository, off by default.
- **Optional merge gate**: a required check that blocks a merge while a major or blocker finding is unanswered.
- **Learning by retrieval**: what people do on pull requests is stored and retrieved into later reviews. The model is never fine-tuned.
- **Self-hosted**: `docker compose up` on one machine, with the app and Postgres. You create your own GitHub App and connect it. The project runs no hosted service.
- **Your choice of model**: built and tested against [OpenRouter](https://openrouter.ai) first. Any OpenAI-compatible endpoint can be configured.
- **Measured before trusted**: findings and scores can be replayed offline against past pull requests, with no side effects.

The full design, with every decision and its reason, is in [docs/superpowers/specs/2026-11-13-visto-ai-design.md](docs/superpowers/specs/2026-11-13-visto-ai-design.md).

## Status

| Part | State |
|---|---|
| Skeleton: typed configuration, the review contract, a test harness that blocks the network, CI | Built |
| Engine: findings | Built. Compared with the predecessor on a frozen case set |
| Offline replay of past pull requests | Built and run |
| Engine: the score | Built. Measured only where its owner has run the backtest |
| Service: receiving webhooks and recording what people do on pull requests | Built |
| Service: a queue of review jobs, run in dry run and recorded | Built |
| Service: publishing a review, and `/review` | Built. Tried once against a real GitHub App |
| Service: reviewing a pull request again when its head or base moves, unless the review would say nothing the newest one does not already say, and following up the threads of its own earlier reviews | Built. Tried once against a real GitHub App |
| Service: incremental reviews of later heads, `/review` as a re-check, and scores kept across reviews | Built. Tried once against a real GitHub App |
| Service: inline notes on the blocks listed for a person, and the GitHub App manifest | Not built |
| Merge gate | Planned |
| Extensions and MCP tools | Planned |
| Memory | Planned |
| Automatic approval | Planned |
| UI | Planned |

What exists today is a library, a command-line tool, and a service that you can run with Docker. The service receives, queues, reviews and records. In dry run it posts nothing; out of dry run it posts a review when a pull request is opened and again when its head or base moves, unless the review would say nothing the newest one does not already say, and writes into the threads of its own earlier reviews. It does not decide whether a pull request may merge, and it does not approve one: the score is only listed for a person.

## How the engine works

The engine is one function, `review(input, deps)`. It reads a pull request and returns a structured review. It writes nowhere: not to GitHub, not to a database. That is what lets the evaluation call it directly.

1. **Read.** The pull request, its changed files and their contents come through a read-only source. The GitHub source only ever sends `GET` requests.
2. **Build context.** The model gets the diff with an anchor on every line (`R142    |+code`), the full contents of changed files where they fit, and the test file that belongs to a changed file. A large pull request is split into batches, up to a limit; what does not fit is reported as not reviewed, unless an earlier review already covers that file.
3. **Mark untrusted text.** Everything that comes from the pull request is wrapped in data markers with a random token. The contract tells the model that text inside the markers is data, never instructions.
4. **Ask the model.** The model must answer through one forced tool call, `submit_review`, so the answer is structured data and not prose. The rules it follows are in [contract/review-contract.md](contract/review-contract.md).
5. **Check the answer.** An answer that names no changed file is sent back once, and then rejected. A finding on a file that is not in the pull request is dropped. A finding on a line that cannot take a comment is moved to the nearest line that can, within three lines, or listed separately.
6. **Render.** The service builds the review text from the structured result. The layout, the severity tags and the lists are the service's. The model supplies the overview, the text of each finding, and a score for each changed block, which the service checks before it counts: a score that is not a whole number from 0 to 100 leaves its block counted as 100.

## Development

Requires Node 26 or later. TypeScript files run directly; there is no build step.

```bash
npm ci
npm test
npm run typecheck
npm run lint
```

Tests never reach the network. The test setup blocks sockets and `fetch`, and clears credential variables, so a test that tries to reach GitHub or a model fails.

## Run the service

The service receives GitHub's signed webhooks and records each delivery's id and what it says about people and the pull request (the payload itself is not kept). When a pull request is opened, reopened, made ready for review, pushed to or given a new base branch, it queues a review. A push is reviewed after 180 quiet seconds, so several pushes in a row give one review (see [Leaving dry run](#leaving-dry-run) for what a later review does and [Scores kept across reviews](#scores-kept-across-reviews) for how scores are kept). The review runs the engine on the pull request as GitHub has it then. In dry run (`dryRun: true` in the config) it is recorded in the database and **nothing is posted to GitHub**. Out of dry run (`dryRun: false`) it is also posted, and the threads of the app's earlier reviews are followed up, as described below. The merge gate is not built.

To run it you need a GitHub App (its id, its private key and its webhook secret), a model key and a Postgres.

What the app needs for a dry run, from what the service calls: read access to pull requests and to contents (and to metadata, which GitHub always asks for), and the events `pull_request`, `issue_comment`, `pull_request_review`, `pull_request_review_comment` and `pull_request_review_thread`. In dry run it reads pull requests and the files of the repository and writes nothing. With too little access every read is refused, and every job ends `attempts_exhausted` (or `not_found`, if GitHub answers the pull request itself with 404).

```bash
cp env.example .env                       # then write your own passwords, secret and keys
cp config.example.yml config.local.yml    # then switch on the app and database blocks (dryRun is true in the example)
docker compose up -d --build --wait
```

To try it with invented webhooks, load `.env` and send a sample (it posts only to this machine):

```bash
set -a && . ./.env && set +a
npm run dev:send-webhook -- --url http://localhost:8080/webhooks/github --secret-env WEBHOOK_SECRET --kind review
```

The kinds are `pull_request`, `review` and `comment`. For the `comment` kind, `--body <text>` sets the comment's text, so `--body /review` sends a command; the other kinds refuse it. For the `pull_request` kind, `--action opened|synchronize` (default `opened`) and `--head <sha>` (default `abc123`) choose the action and the head commit, so two pushes can be sent with two heads. The other kinds refuse these options. Stop it with `docker compose down`.

### Leaving dry run

Set `dryRun: false` in the config. A config that does not write `dryRun` runs in dry run: the service posts only when the key says `false`. Nothing else changes: from then on the service writes to GitHub, so check the app's permissions first.

Nothing is posted at the switch itself. A review recorded in dry run is never posted; each open pull request gets its review at its next event (a push, a reopening, a `/review`). Jobs that were waiting run as before and now post, and after a stop the deliveries GitHub could not make (at most 200) are asked for again, so the pull requests they name are reviewed and posted.

- **Posting.** Each review is posted once, as a comment review pinned to the commit it was computed for, with its inline comments. When GitHub refuses the inline comments, the review is posted with their text in its body instead.
- **Asked first.** Before a review is computed, unless a recorded review is waiting to be published, the service asks GitHub which reviews of the app's own the pull request has, so a review it once posted is not paid for again. One on the live head that the database does not know ends the job as `already_reviewed`. One on another commit is recorded as posted when the database holds an unpublished review of that commit, and is otherwise logged as `unknown_review`.
- **Reviews after the first.** After its first review a pull request is reviewed again when its head moves (after the 180 quiet seconds; pushes inside them share one review), when its base moves, and on `/review`. A draft, an ignored author, a filtered base branch and the daily limit stop a review as they do the first. In dry run nothing is read from or written to threads, and none of what follows applies: every head is reviewed in full and its scores are given afresh. Out of dry run the review has one of three modes. The last review is the pull request's newest published review that is not a re-check. The first rule that applies decides:
  1. There is no last review, or its base branch is not the pull request's base branch now (or was not recorded, as in a run made before it was): a **full** review, as the first was.
  2. A `/review` on the head and base of the last review: a **re-check**.
  3. Otherwise the repository's `newHead` setting: `incremental` (when it is not written) or `full`. It can be set for all repositories and for one (see [Configuration](#configuration)).
  - *What a full later review does.* It reads every file again, as the first review did, except a moved file that already has its score, and pays for it in full. A file whose diff a published review already read, with every block already scored, is sent last. The model is told which hunks are scored, so it is not asked for them again.
  - *What an incremental review and a re-check read.* They read the files with a thread that is due a verdict, and the files whose present diff no published review has read where they now stand: new files, files whose diff changed, and files moved or renamed with the same change. They do not read a file whose diff a published review has read and whose blocks are all scored, unless a thread of it is due. A file that only moved, once it has its score, is not read in any mode. For each file read, the request names the lines that changed since a published review last read it, and carries the last review's overview. That costs input tokens.
  - *The order.* In every mode the files with a thread due come first, then the files no published review has read as they are now, then the rest. A pull request too large for one review is therefore covered over several. A file that finds no room and that no earlier review covers is listed under `Coverage` as not reviewed, and counts as 100. A file that an earlier review covers and that finds no room keeps its scores and is not listed.
  - *What this costs.* A defect that the first review missed in code that has not changed since is not found by a later incremental review or re-check: the file is not read again, or, if it is read for other reasons, a major on a line that has not changed is listed and not posted (below). Set `newHead: full` to read everything at every head, and pay for it.
  - *Which lines count as unchanged.* "A line that has not changed" is measured for each file, from the last published review that read that file, by comparing the file's content then and now. When the content then cannot be read, or the file is new to the history, every line counts as changed. A finding the model raised on a changed line, and that was moved to a neighbouring line to be placed, counts as on changed code. A line that enters the diff without its own text changing counts as unchanged, as when the base branch moves under it.
  - *A finding on an unchanged line.* A blocker is posted as usual. A major is listed in the body, in the section `On code unchanged since the last review`, which follows `Findings`, and is not posted as a comment. A minor is dropped. A full review posts them all, and only counts the blockers and majors among them in the log.
  - *How the review opens.* An incremental review opens with `**Incremental review** of the changes since` and the first 12 characters of the last review's head; a `/review` adds `requested by @<login>`. A re-check opens with `**Re-check** requested by @<login>.` and says whether earlier threads were judged again, none was waiting, or none could be judged. A full review opens with a line only when it was asked for with `/review`.
  - *A push that tells nothing new.* When an incremental review started by a push or a change of base would read no file, owes no thread a verdict, and would show a person exactly what the newest published review shows (the same score for every file, the same parts to read, the same files not reviewed), no review is posted and the job ends as `nothing_new`. The run is recorded without a body, and it stores no scores for other pull requests: every score in it was kept from an earlier run. A `/review` is never ended this way: it gets a review, in the mode a push on that head would get. A head whose push ended this way has no review of its own: the older review stays the newest one, so the next push is measured against it, and a `/review` on that head is not a re-check.
  - *Already reviewed.* A head and base whose review is the pull request's newest published one are not reviewed again by a push (`already_reviewed`). A head that returns after another was reviewed (a force-push back, or a base changed and changed back) is reviewed again, in the mode above, against the newest review, not the older one it matches. It is posted, unless the review would show exactly what the newest one shows: then a push's job ends as `nothing_new`, as above.
- **Earlier threads.** Before a later review is computed, the service reads the pull request's review threads from GitHub through its GraphQL endpoint. A thread is the service's own when its first comment is a finding it posted and the database holds. A thread is judged when its finding is a major or a blocker and the thread is not settled: settled means resolved, and either a person replied or the app resolved it (GitHub names the app as the one that resolved it, and the app's own reply with its hidden line stands in the thread). The model is shown each of the service's own threads that lies on a file it is shown: a judged thread with its replies (the last 30 only, each comment cut at 2,000 characters), the others without their replies. A thread is not shown on a file that moved without a change, nor when a file and its threads do not fit one call; in both cases it gets no verdict in that review. The threads' text is part of the call and is paid for: a judged thread can take about 22,000 tokens, and whoever may comment on the pull request writes that text. When a file and its threads do not fit one call, the file's test goes first, then its full contents, then its threads; when the threads go, the test and the full contents come back if they then fit. For each judged thread it may give one of three verdicts: `fixed`, `answered` or `open`. A verdict is kept only for a judged thread; `fixed` and `answered` need a reason; `answered` needs a reply in the thread by someone other than the app; and `fixed` is dropped when the review is of the head the thread was opened on.
  - *Written into the threads.* Once the review is published and its job is finished, a `fixed` or an `answered` verdict is written as a reply that opens with `Fixed.` or `Answered.` and ends with a hidden line that names the review and the commit. An `open` verdict is written as a reply opening with `Still open.`, and only when someone other than the app wrote last and the model gave a reason. When the app's own reply is last in the thread, a `fixed` or `answered` verdict rewrites it instead of adding another; an `open` verdict rewrites a confirmation to open with `Open again.`, and writes nothing after the app's own `Still open.` or when the thread has no reply. Nothing is written into a thread in which someone other than the app wrote after it was judged; it is judged again at the next review of a new head or base, or at a `/review`. Each write is made once, one second after the one before it; a write that fails is logged as `thread_write_failed` and not tried again, and changes nothing else. The threads are read again just before these writes; when that read fails, when recording the publication fails, or when the service stops after the review is posted and before the writes, none of them is made and nothing tries them again: the threads are judged again at the next review of a new head or base.
  - *Not posted again.* A blocker or a major finding that an earlier thread already raised is listed under `Already discussed`, with a link to the thread, and is not posted; a minor one is dropped without being listed. A finding was raised when an earlier thread on its file lies within 3 lines of it on the same side and is of the same class (blocker and major together, minor apart), or, for a thread whose line is no longer in the diff, when the thread quoted the same code. A minor thread never swallows a blocking finding, and a thread whose last verdict is `fixed` swallows nothing. When a thread was due a verdict, the `Overall` line counts the threads cleared, still open and not judged.
  - *A reply is judged later.* A reply someone writes in a thread is judged at the next review (of a new head or a new base, or a `/review`), not at once: nothing but a push, a change of base or a `/review` starts a review.
- **Resolving.** When the app has `contents` write, it resolves a thread whose verdict cleared it, after its reply landed. Without it the reply stands and the thread stays open, and the service logs `feature_off` with `resolving` at each start and raises an alert of that name. Without it a cleared thread stays open, so it is judged again at each later review and the app's reply is rewritten each time. The permissions are read once, at start: after changing them, restart the service. The service reads the permission the app asks for, not what an installation has accepted: until the owner accepts it, each resolve is refused and logged as `thread_write_failed` with `github_forbidden`.
- **`/review`.** A comment asks for a review when the first line of it that is not empty is `/review`, in any letter case, alone on the line or followed by a space and more text. Only an owner, a member or a collaborator of the repository is listened to. A command from anyone else is refused. When no run is recorded yet for the pull request's head (a review, or a failed try at one), the refusal gives that head its automatic job: the command may have stood in the way of a push's job. So such a comment can be what starts the review the head would have got at its next event. An accepted command gets an eyes reaction. A command the service refuses or whose review fails gets a confused reaction and one sentence with a short code: `not_allowed`, `closed` or `already_reviewed` when it is refused, `head_moved`, `review_failed`, `publish_rejected`, `render_failed` or `superseded` (another job for the pull request was waiting when this one was put back) when it failed. These ends are not answered: a command from someone without access that arrives while the pull request has a job waiting (it is not stored); a command that is replaced, while it waits, by a later `/review` from someone with access; one whose job was dropped because the pull request is gone (`not_found`) or no installation is known for it (`no_installation`); one whose job the service gave up on (it ran out of starts or grew too old); one whose job was cut by a restart, or met a database error before its review, while another job for the pull request was waiting; one whose pull request was closed while the review ran; and one the service could not record. An answer is written once: when GitHub refuses it, the log says `answer_failed` and it is not tried again. A command on the head and base of the last review is a re-check: the earlier threads are judged again, and files that no published review has read as they are now are read (see Reviews after the first for what that means, and what it does not read). A command on any other head gets the mode a push would give it, with the earlier threads. A command is refused with `already_reviewed` only for a head on which GitHub lists a review of the app's own that the database does not know. It is never ended as `nothing_new`. A draft, an ignored author and the base-branch filter do not stop it. A bot's command is ignored. In dry run a command from someone with access is reviewed and recorded like any other job (in full, whatever the head; but a head and base that already have a recorded review end it as `already_reviewed`), and nothing is written on the pull request.
- **What the app needs.** Beyond what dry run needs, the app needs `pull_requests` write and `issues` write, and, to resolve threads, `contents` write (optional: without it the app still replies). At start the service logs `feature_off` once for each thing a feature lacks and raises an alert of that name, and keeps running.
- **Mentions and HTML.** In text the model wrote, outside fenced code blocks, a zero-width space is put after the `@` of a mention, after a `<` that could start HTML (one before a letter, `/`, `!` or `?`), and after the `&` of a character reference, so none of them takes effect. This also holds inside inline code: copying such inline code copies the invisible character. Links are left as written, with these exceptions. In an address (text with `://` before it and no space between), an `@` that could start a mention is written `%40`; most sites read that as the same address. (An `@` right after a letter or digit, as in `user@example.test`, never starts a mention and is left alone; an address whose user part ends in another character stops working.) A link in angle brackets stays a link only when it starts with `http://` or `https://`, in lower case. A character reference inside an address still gets the invisible character, and so does an `@` in a link with no `://`, such as a relative path; such a link may stop working.
- **Tried once.** The first review, `/review`, a later review with its threads (reading them, replying, editing a reply and resolving), an incremental review, a re-check, a push that tells nothing new (a merge of the base branch, and a rebase), scores kept across reviews, and a score taken from another pull request were each tried once against a real GitHub App, on a small private repository, with each event sent to the service by hand. In that trial the model once sent a score for a block marked as already scored; the service ignored it, as it is built to. Not tried: GitHub's own webhook deliveries and their redelivery, the `Already discussed` section and the fallback when GitHub refuses the inline comments, a finding on a line that has not changed, a thread judged in an incremental review, a hunk the model splits, a renamed new file, a second scorer, and anything at the size of a real pull request.

### Scores kept across reviews

Out of dry run, a pull request's score is not given again at each head. The service reads the scores of the pull request's earlier runs (recorded out of dry run and ended ok, published or not, with no age limit) and, for other pull requests, the scores it has stored. In dry run none of this is read or stored: every head is reviewed in full and scored afresh.

- **A block is scored once.** A block is a hunk of a file, or a part of a hunk that the model split. It is recognised by its file's path (or the one it had before a rename) and the text of its changed lines. A file the pull request adds, with no history under its own path, also answers to every other path of the pull request that held one of its blocks, whether a score of its own or a whole-file score stood for it: GitHub shows a new file that a later push renames as added under its new name, with no earlier name, and a copy as added too. While a block stays in the diff, its score does not fall: the model is not asked for it again, and its hunk is marked `scored` in what the model is shown. When a block has more than one earlier score, the highest is kept.
- **A file is closed to a whole-file score only once it was read as it is.** A file whose blocks all have a score takes no new whole-file score while its diff is one a published review of this pull request read under the path it has now. Until then (its blocks' scores came from another pull request, a push changed its diff, or it was moved or renamed with the same change) it is sent, its hunks are marked `scored`, and the model may give it a whole-file score; the higher of that and the one it keeps counts. A file moved or renamed with the same change is therefore read once more where it now stands.
- **A new or edited block cannot score below a block its file lost.** The floor is the highest earlier score of a block of that file whose changed lines are no longer in the diff. A new or edited block scored below it is raised to it, and a whole-file score given in place of a block score is raised too. Only blocks scored in this review are held to it.
- **A whole-file score never falls.** When the review model gave a file a whole-file score in an earlier review, the file keeps at least that one. With a second scorer, a file that has blocks keeps none: only a file that moved does.
- **Another pull request of the repository reuses a score for 30 days.** A block with the same path and the same changed lines, scored on another pull request of the repository in the last 30 days, takes that score (the highest, if there are several), and the floor above applies to it. Scores are stored when a run is recorded, whether or not its review is then posted. A hunk that the model split into parts has no score of its own as a whole, so another pull request does not reuse it as one.
- **A file that only moved is scored once.** It keeps its whole-file score, and it is not shown to the model again.
- **A second scorer has its own history.** The scores of the review model and of a second scorer are kept apart. Naming a scorer, or dropping it, makes the next review of every open pull request score its blocks afresh, once.

In the `Human review` section, three notes can follow a block's line:

- `_(kept from an earlier review)_`: the score is the one an earlier review of this pull request gave to the same lines.
- `_(scored on another pull request)_`: the score was stored by another pull request of the repository. Its category is shown and its reason never is, at that review or at a later one: the reason was written about another pull request, and it is not taken with the score.
- `_(N% was given; a block this file lost had scored M%)_`: N was the score given before the floor raised it to M.

What this costs:

- A block is recognised by its changed lines alone. Lines scored where they were harmless keep that score when a later push, or another pull request within 30 days, puts the same lines somewhere else in the same file, or adds a new file made of exactly those lines. In an incremental review, a push that only does that is not read again at all, and ends as nothing new when what it would show a person is unchanged.
- A file the pull request adds keeps its scores when a later push moves, renames or copies it with its content unchanged, also when the model had scored it as a whole only. A new file is one block: any edit made in the same push as the rename gives it a fresh score, with no floor.
- A new or edited block is held to the highest score its file lost only when it is scored. An author can push the same change written several ways in one file and have each scored; a block that already has a score keeps it, and the rule that holds a block to the highest score its file lost applies only to a block that is new or edited, so the one that scored lowest can be the one kept.
- A whole-file score that was once high stays: fixing the file does not lower it.

### Reading what a review would have posted

Every attempt at a review, finished or failed, is a row of `visto_ai.review_runs`:

```bash
docker compose exec db psql -U postgres -d visto -c "select id, owner, repo, number, outcome, cost, body from visto_ai.review_runs order by id desc limit 5"
```

`body` is the text that would have been posted (or was posted, out of dry run), `outcome` how the run ended and `cost` what the model calls cost, as recorded (see the daily limit below).

### Running it

- Run one instance per database. A second one stops at once with `another_instance_running`, and the first keeps running.
- If the database restarts, the service notices that it has lost its lock, exits, and Compose starts it again.
- Connect to Postgres directly. The lock and the statement timeout do not work through a pooler in transaction mode.
- Stopping the service (`docker compose stop`) waits up to 10 minutes for the reviews that are running. The Compose file allows 660 seconds for it. A second signal ends it at once.
- Every review costs money. The cost of a run is what the model endpoint reports with each answer; OpenRouter, the default, reports it in US dollars. For an endpoint that reports no cost, it is computed from `model.prices`, in whatever currency those prices are written in. With neither, the cost is recorded as 0.
- The daily limit, `limits.spendPerDay` (50 when not written), is a number in the unit of those recorded costs. The service adds up the cost of the runs recorded since the start of the UTC day, so it can only see what is recorded: with an endpoint that reports no cost and no `prices`, it never stops anything, and it raises the alert `cost_unknown`. At 80% of the limit it raises `spend_80`, and at the limit `spend_limit`. Reviews then stop starting until the next UTC day; the ones already running finish. These three alerts are raised once per run of the service, so a restart can raise them again; `spend_80` and `spend_limit` are also raised once per UTC day. At most `limits.queueConcurrency` reviews run at once (2 when not written).
- When the model's key is refused or its account is out of credit, reviews pause for 5 minutes at a time and the service raises one alert, `model_error`, and `model_ok` when the key works again. The jobs wait, but not for ever: a job that has waited 24 hours is dropped as `too_old`. A review refused after it had already made model calls uses up one of the job's three starts. Alerts go to the log always, and to `alerts.webhook` when you wrote it.
- A job ends without a review when its three starts are used up (`attempts_exhausted`), when it is a day old (`too_old`), when no installation is known for the pull request (`no_installation`), when another job for the pull request was already waiting as it was put back (`superseded`), or when the pull request is, by the time the job runs, not one to review: gone (`not_found`), closed, a draft, by an ignored author (`ignored_author`), against a base branch outside the filter (`base_filtered`), given a new head (`stale_head`; the new head gets a job of its own), or already reviewed at that head and base (`already_reviewed`; a `/review` is not ended this way, except in dry run). Out of dry run, `nothing_new` ends a push's job, after the engine has run without a model call, when the review would tell a person what the newest published one already tells (see Reviews after the first). A review that fails is recorded and its job ends `failed`; nothing is posted for it. Out of dry run there are more. Before anything is paid: `already_reviewed` when GitHub lists a review of the app's own on the live head that the database does not know of. After the review was computed and recorded: `head_moved` when the head or the base changed meanwhile (the new head gets a job), `closed` when the pull request was closed meanwhile, `publish_rejected` when GitHub refused the review even without its inline comments, and `render_failed` when its text could not be written.
- When GitHub cannot be reached, or refuses a read (reading the threads is one), before any model call, the run is recorded as failed and the job is tried again a minute later, and then 15 minutes after that: three starts in all. A pull request whose threads cannot be read (GitHub refuses the query, or the list is too long to read) gets no later review: each of its jobs ends `attempts_exhausted`. The list of the pull request's reviews, which the service reads to find its own, has a cap too (10 pages of 100); a pull request past it gets no review after that, in the same way.
- Out of dry run, a review that could not be posted for any other reason (GitHub could not be reached, or answered with an error) stays recorded and its job is tried again the same way. The later start posts the recorded review without computing it again, while it is less than a day old.
- A restart of the database, like any restart of the service in the middle of a review, cuts the reviews that are running. They run again afterwards while they have starts left, and their model calls are paid for again. Out of dry run, a review already recorded when the restart came is posted afterwards without being computed again, provided its job has a start left and is less than a day old.

Setup notes:

- A database password that contains any of `@ : / # ?` must be percent-encoded in the database URL.
- If you change `server.port` in the config, change the port mapping and the health check in the Compose file too.

What to know before you expose it:

- The service holds a request's body in memory before it can check the signature: at most 25 MB for each of at most 20 requests at once. That is about 500 MB while bodies arrive, and about twice that at the moment a body is joined into one piece.
- A caller that sends slowly can hold one of the 20 places for up to about a minute. Twenty such callers, none of whom needs the secret, take every place, and real deliveries are answered `503 busy` meanwhile.
- The Compose file publishes port 8080 on every interface of the host. TLS, and any limit on connections or body size per caller, belong to the proxy in front. Firewall the port, or publish it only where the proxy can reach it.

## Configuration

[config.example.yml](config.example.yml) documents every key. Copy it to `config.local.yml`, which git ignores. A secret is never written in the file; the file names the environment variable that holds it.

One repository setting decides how a later head is reviewed: `repositories.defaults.newHead`, which `repositories.overrides` can set for one repository. `incremental` (what you get when it is not written) reads only what changed since the last review; `full` reads the whole pull request at every head, and costs what a first review costs. It changes nothing for a first review, for a head on a different base branch (always full), or for a `/review` on the head and base of the last review (always a re-check). See [Reviews after the first](#leaving-dry-run).

### A second scorer (optional)

By default the review model also scores the changed blocks. You can name a separate decision model to score them instead. It is off unless you write the `scorer` block. The scorer answers for blocks only: a file moved to another directory with no content change keeps the review model's score. Its scores have their own history: naming a scorer, or dropping it, scores every open pull request's blocks afresh once (see [Scores kept across reviews](#scores-kept-across-reviews)). [config.example.yml](config.example.yml) shows the keys, with a placeholder model name.

The adapter speaks the decisions endpoint of OpenRouter and was built against the Jev decision model.

- The reviewed code is then also sent to that provider.
- The review model is then not asked for block scores: it gets [contract/review-contract-scorer.md](contract/review-contract-scorer.md) in place of the review contract.
- The endpoint is marked alpha by its provider.
- The score threshold must be written, and you should choose it from a backtest.
- A file the scorer fails on goes to a person.
- The scorer's cost counts towards `--max-cost` only when its provider reports a cost with each answer.

`backtest` records which scorer was used, and `score-noise` refuses to compare two runs made with different scorers.

## Replay

The replay runs past pull requests through the engine and scores its findings against what human reviewers said on those pull requests. It reads from GitHub and calls the model. It posts nothing.

It makes paid model calls. It runs at most `--max-cases` cases (60 by default) and starts no new case once the cost reaches `--max-cost` (10 by default). The cost is the one the provider reports, as OpenRouter does, or else it is computed from the prices in your configuration. With neither, the cost counts as zero and `--max-cost` stops nothing.

```bash
export GITHUB_TOKEN=...        # a read-only token
export OPENROUTER_API_KEY=...  # or the variable your configuration names

npm run eval:replay -- --cases ../cases.jsonl --out ../runs/first --label first --config config.local.yml
npm run eval:compare -- ../runs/baseline/summary.json ../runs/first/summary.json
```

The case file and the output folder must be outside the project folder, so that private data cannot be committed by accident. A case file is JSON Lines: each line names a pull request at a fixed head and base, with the review comments people left, labelled by whether they were valid. This repository has no command that builds a case file yet.

## Backtest

The backtest replays the score on past pull requests and measures it against where people actually commented. Like the replay, it reads from GitHub, calls the model, makes paid calls bounded by `--max-cases` and `--max-cost`, and posts nothing. Its input is a history file written by `import-history`, and its files, like the history file, must be outside the project folder: they hold paths and model-written reasons.

```bash
npm run eval:import-history -- --repo owner/name --since 2026-01-01 --until 2026-04-01 --out ../history.jsonl
npm run eval:backtest -- --history ../history.jsonl --out ../runs/score-one --label score-one --config config.local.yml
npm run eval:score-noise -- ../runs/score-one ../runs/score-two
```

- **Safety**: of the blocks and files a person had to look at, the share the score would have left below the threshold; lower is better.
- **Benefit**: the share of pull requests in which nothing in the pull request reaches the threshold: no block and no file as a whole. A person need not be asked about those at all.
- **Focus**: in the pull requests that do go to a person, the share of changed lines flagged. Lower means the person reads less.

A block or file is labelled **loose** when a person who is not the author left an inline comment on it. It is labelled **strict** when, in addition, its lines (for a file, its diff) changed in a later commit before the merge; Safety is reported for both.

`score-noise` compares two runs of the same history file and prints how often a block, and a whole pull request, falls on a different side of each threshold between them.

## The file a team commits

A team may commit `.visto-ai.yml` at the root of its repository, listing paths that always need a human reviewer. It is read from the default branch and can only add protection.

```yaml
# .visto-ai.yml
human_review:
  - db/migrate/
  - "app/**/policy.rb"
```

- A trailing slash is ignored, and a pattern with no slash left matches at any depth: `migrations/` is the same as `migrations`, and covers `migrations/x.sql` and `services/api/migrations/x.sql`.
- A pattern with a slash anywhere but at its end is matched from the repository root. `db/migrate/` therefore covers `db/migrate/001.rb` and never `services/db/migrate/001.rb`.
- A leading slash also ties a pattern to the root: `/docs` matches only the top-level `docs`, while `docs` matches at any depth.
- A pattern that names a directory covers everything under it, dot-files included.
- The wildcards are `*` (any run of characters within one name), `?` (one character) and `**` (any number of directories): `app/**/policy.rb` covers `app/policy.rb` and `app/models/user/policy.rb`.
- `**` is special only as a whole path segment; inside a name, such as `a**b`, it is two `*`.
- Matching is case-sensitive.
- A renamed file is checked by its old path as well as its new one.
- Brackets are ordinary characters: `app/[id]/page.tsx` matches only that path.
- A pattern with a backslash, a brace, a `.` or `..` segment, or a leading `!` is refused, and makes the file unusable.

A file that cannot be used (invalid YAML, an unknown key, a refused pattern, content that is not text, or one that is too large) sends every pull request to a person, and the review says why the file cannot be used.

## Repository layout

| Path | What |
|---|---|
| `src/engine` | The review engine: context, model call, checks on the answer, rendering |
| `src/engine/scorer` | The optional decision-model scorer and its client |
| `src/engine/score` | Blocks, the rules that score without the model, and the floors from `.visto-ai.yml` |
| `src/forge` | The boundary to git services. `forge/github` holds the GitHub sources, the webhook reader and the writer that posts |
| `src/eval` | The `replay` and `compare` commands |
| `src/eval/history` | The `import-history` command and the history file it writes |
| `src/eval/backtest` | The `backtest` and `score-noise` commands: labels, the three numbers and the noise between runs |
| `src/db` | The Postgres client, migrations, the queue's statements and the recorded runs |
| `src/shell` | Receiving a webhook, the queue of review jobs, running a review, publishing it, following up its threads, the daily limit and the model's health |
| `src/service.ts`, `src/main.ts` | Starting and stopping the service |
| `src/config` | Loading and validating configuration |
| `contract` | The rules the model is given |
| `docs/superpowers` | The design and the implementation plans |

## Licence

[Apache-2.0](LICENSE).
