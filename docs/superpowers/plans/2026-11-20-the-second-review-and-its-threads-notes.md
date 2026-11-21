# Notes: The Second Review and Its Threads plan

These notes record what happened while `2026-11-20-the-second-review-and-its-threads.md` was built: the decisions taken where the plan was silent or wrong, what the reviews found, what the real run showed, and what was put off. Where the plan and these notes differ, the notes say what was built.

## Status

- Before the build, the plan was reviewed by a stronger model than the one that wrote it. It found one critical and four important defects and 27 minor ones. Every critical and important one, and nineteen of the minor ones, were applied to the plan before its first commit (decisions 1 to 9).
- Tasks 1 to 8 were built on the branch `stage-4d`, one implementer and one independent reviewer for each. Tasks 3 and 7, which decide what is written into people's threads and how the job spends money, were built by a stronger model; Tasks 2, 3, 4, 6, 7 and 8 were reviewed by one. Task 5 was built before Tasks 3 and 4, since it needs only what Tasks 1 and 2 provide.
- Two tasks needed a fix round, each re-reviewed: Task 2 (two points) and Task 8 (nine sentences of the README). Task 1 was sent back once before its review, for evidence (decision 10).
- Then a review of the whole branch by the strongest model: no critical defect, three important ones and nine minor ones. One fix wave of ten items followed (decisions 15 to 20), and one re-review of that wave by the same model. It found every item addressed and nothing critical or important, and left eight minor points. No second wave followed: each point was ruled on (decision 21) and is under "Put off".
- At the end: 1,355 tests pass, the type check and the lint are clean, source and tests are ASCII.
- The real run under Docker was made in two halves: the previous release before the fix wave, this branch after it, on the code of the wave. What it showed is below.
- When the branch was built, nothing had been checked against a real GitHub App or a real model call. After the merge it was: see "Verified with a real app" at the end, which also says what is still not verified.

## Decisions taken while building

Each entry says what was decided, why, and what it costs if it is wrong.

**From the review of the plan, before the first task**

1. The model's reason in a thread reply is written as one line: every run of white space made one space, at most 600 characters, through the same function as the review body's one-line texts. As first planned it went through the function that lets a code fence open, on the same line as the service's own word. The reviewer ran the real code: a reason that opened with a fence was posted with a live team mention, live HTML and a hidden comment shaped like the service's marker. A marker now counts only as a comment's last line. Cost: a reason longer than 600 characters is cut, and a reason can hold no code block.
2. Comment and review ids are read from `fullDatabaseId` only. The 32-bit `databaseId` no longer holds them. This is from knowledge of GitHub's schema, not from a test. Cost if wrong: every thread read fails and no later head of any pull request is reviewed. It is the first thing to verify with a real app.
3. The model is shown a thread's last verdict, and the rules name the one exception to "do not report what a thread already raised": a thread marked fixed whose defect is back. Without it a regression at a thread the app had confirmed and resolved was neither judged nor reported.
4. The query that lists threads is tried once more after a network failure or a server error, like every other read. The three writes are still sent once. One failed read after a publication would otherwise lose all of that review's replies.
5. A thread that is not due a verdict is shown without its replies, and a file's threads are cut last: the paired test goes first, then the full file, then the threads. Design 5.3 ranks the full files above the threads. A thread that is cut cannot be judged; a file without its full text can still be reviewed. Cost: text that anyone who may comment writes can push a file's full text out of a call, within the caps (about 22,000 tokens for a thread that is judged).
6. A `fixed` or `answered` verdict with no reason is not kept. Cost: a thread the model cleared without a sentence stays open until the next review.
7. Every call of a review in which a thread is shown is sent the larger tool, not only the calls that show one, so the calls of one review share their tool definition. A verdict from a call that did not show the thread is dropped.
8. The writes into threads are made one second apart. A burst can be refused, and a refused write is not tried again.
9. Left as the plan's known limits: a review adopted late is recorded with its own body and as posted with its inline comments; `canResolve` reads what the app asks for, not what an installation accepted; no alert is raised when a thread list is always refused; a thread whose file left the diff stays due, and `Overall` counts it as one that could not be judged.

**During the tasks**

10. Task 1's implementer wrote the adapter before its tests. The code was not thrown away and rebuilt. It was sent back to break each rule once and name the test that catches the break: 41 breaks, one gap found and closed with a test. The task's reviewer then made seven of those breaks itself on a copy; each failed in the named test. Cost if wrong: a test of the adapter passes for the wrong reason.
11. Task 5 moved the read-back's matching into a function of its own, "without change", and one thing changed: a stored result that is malformed now matches nothing and logs `readback` with `stored: 0`, where it used to throw and log `readback_failed`. Left as built: the service writes that result itself.
12. Task 3's review asked about a thread whose opening run is not among the pull request's runs: its opening head is then unknown and the "fixed on the same head" check cannot fire. Ruled unreachable: a stored comment's run is a run of the same pull request and no run is ever deleted. The review of the whole branch agreed.
13. The commit messages of eight local commits were rewritten before anything was pushed. The build's shared rules had told every implementer to sign with the controller's model; the repository's history names the model that wrote each commit. Only the messages changed; the trees were compared and are identical.
14. The real run was moved from Task 8 to after the fix wave, so that this branch's half exercises the final code. Plan 5's run was made before its last fixes and its notes had to say so.

**In the fix wave after the review of the whole branch**

15. "The app resolved it" no longer rests on a name. The adapter can only compare the login of the account that resolved a thread with the app's, and design 8.4 says the bot is never known by a login. A thread now counts as resolved by the app only when one of its comments is the app's own and ends with a marker. The follow-up resolves only after its confirmation landed, so every rightful case passes. Cost: none known. If GitHub never names the app as the one who resolved, this is never true either way.
16. A verdict is not written into a thread that changed after it was judged. Each kept verdict records how many replies the thread had then; when someone other than the app wrote after that, nothing is written and the thread is judged again at the next review. The reviewer showed by a run that a person's "this is a bug", written while the model was being asked, was answered with `Answered.` and the thread resolved for good. Cost: such a thread waits for the next review although the record says it cleared. Comments are counted by position, so a comment deleted in between can hide a later one.
17. **The rule "it quotes the same code as that thread" (5.6, step 6) was narrowed. The owner kept it as built on 2026-11-20, and the design now states it.** It now decides only for a thread whose line is no longer in the diff. A thread that still has a line is matched by position alone: within 3 lines, on the same side, of the same class. The reviewer showed by a run that a new blocker 360 lines from a thread was dropped as already discussed, and linked to the wrong thread, because both quoted a line that held only a closing brace. Cost: a finding that repeats an earlier thread on code GitHub still tracks, but sits more than 3 lines from where that thread now is, or is of the other class, is posted again.
18. Smaller points of the same review, each fixed: a stored verdict that is none of the three writes nothing (it was written as `Answered.`); a reason made only of characters nobody can see is no reason; when a file's threads have to be shed, its full file and its paired test come back if they then fit; the "Open again." sentence no longer says "fixed" about a thread that was answered; a thread that is listed twice is handed on once.
19. Three tests that cross the tasks were added, among them one that runs the real engine under the real job on a database, with a stored first review, a thread with a person's reply, and a model stub: the review is posted with its `Already discussed` section and the verdict is written into the thread.
20. The README was corrected in seven places: which findings are listed as already discussed; that only the newest published review decides whether a head is reviewed again; which threads are not shown; what thread text costs; the paging cap on the app's own reviews; that nothing is written into a thread someone wrote in since; and what "settled" means after decision 15.

**After the re-review of the wave**

21. Nothing more was changed. The eight minor points the re-review left were ruled on one by one and are listed under "Put off". One of them is a hole in decision 17 itself: for a thread whose line is no longer in the diff, the quote still decides alone, so a far-away blocker that quotes a short common line can still be dropped there. It was put to the owner with decision 17: the rule stays as built, with no minimum length for the quote, and the hole is a known limit. Section 5.6, step 6 of the design was then rewritten to the rule as built. Decisions 15 and 16 are still departures from the design's wording (8.4 and 9) and are recorded here only.

## What the reviews found that the plan had wrong

- The model's reason went out through the wrong function (decision 1). The plan's own test passed while the property it named did not hold.
- The thread query read ids through a 32-bit field (decision 2).
- The rules given to the model forbade reporting a regression at a thread it had marked fixed (decision 3).
- The plan sent the thread query once, like a write, and understated what one failed read loses (decision 4).
- Threads were never cut, so nine long threads on a file took it out of every later review (decision 5).
- The plan asked for the account that resolved a thread to be known by its login (decision 15).
- The plan wrote a verdict into whatever the thread had become by then (decision 16).
- The design's quote rule, built as written, hid a new blocker (decision 17).
- The plan's wording for the README, "Every push is reviewed", was looser than the code: pushes inside the quiet period share one review.

## Text in the plan that these decisions made stale

- Task 3: the duplicate rule's `same_quote` (decision 17); a kept verdict has one more field, `replies` (decision 16); the reason is cleaned of control characters before it is made one line (decision 18).
- Task 2: rule 6, when the threads are shed (decision 18).
- Task 4: the "Open again." sentence (decision 18).
- Task 5: rule 6, `settled` (decision 15), and one thread for each id (decision 18).
- Task 6: the table has one more row before the others, for a thread that changed, and the return has `changed` (decision 16); a verdict that is none of the three plans nothing (decision 18).
- Task 7: the `thread_followup` log entry has `changed`.
- Task 8: the README is as built, not as the task lists it; its Step 3, the real run, was made by the controller after the fix wave (decision 14).
- Every commit id the build's own records named before decision 13 is gone; the ids in the repository's history are the ones that count.

## What the real run showed

Under its own Compose project on the builder's machine, on a network with no way out, with throwaway secrets, cleaned up afterwards. Nothing could reach GitHub or a model, so no job got past its first read.

- The previous release was built from `main` and started in dry run on a fresh database. It took one `opened` sample (`202 accepted`) and left three migrations in the ledger, one waiting job and one failed dry run.
- This branch, at the head of the fix wave, started on that database with `dryRun: false`. The ledger still held the same three migrations: this plan has none.
- It logged `recovery`, `listening`, a `model_check` whose result was `unknown`, and a `start_step_failed` for `app_check` with `github_network`. It kept running and took up the job the previous release had left: failed at `prepare` with `github_network`, put back.
- With a published run inserted by hand for the pull request, a `synchronize` sample for another head was answered `202 accepted` and took the waiting job's place, due after the quiet period. After it the job failed at `prepare` with `github_network` and was put back; it was not dropped, and no row was marked published.
- The statement behind `adoptableRun`, run by hand on rows made by hand, returned the newer of two unpublished finished runs of a head, and nothing for a dry run, a published run, a failed run, a run with an empty body and an unknown head.
- The whole log was 9 lines of ids, codes and counts. None held the database password, the webhook secret, a key, an address or a title. The app stopped with exit code 0.

What the run could not show: any of this plan's own steps in the job. Offline, a job fails at its first read of the pull request, before it looks at earlier reviews or threads.

## Put off

**To plan 7 (reading less, and scores that hold)**

- The `incremental` and `recheck` modes, scores across reviews with their tables, coverage carried between runs, the counter of blocking findings on unchanged lines, inline notes, the app manifest. Until then every later head gets a whole review, and a `/review` on a head that is already reviewed is refused.

**To the gate's plan (stage 5)**

- The `thread_verdicts` table. Verdicts are in each run's stored result.
- Neither the marker nor the app's authorship proves that a comment's text is the app's: someone with write access can edit the app's comments, and anyone can write the marker's text. The gate must check the author and should ask GitHub whether a comment was edited.
- A dropped finding records whether its thread was resolved and settled at that moment (6.4 will ask).

**For the owner**

- A thread that a person resolved with a click and no reply, and that is then judged open, has its confirmation rewritten to "Open again." and stays resolved, so the finding sits in a collapsed thread. Nothing asks the app to unresolve.
- Links, images and references in the model's reason stay live in a thread reply, as everywhere else in a review. What is new is who can steer that text: anyone who may comment in the thread.
- The README's "Why" still says the bot approves a pull request; automatic approval is not built, as its Status table says.

**Known limits, left as they are**

- The follow-up of the threads can be lost (a stop between the publication and the replies; the second read of the threads failing). Those threads wait for the next review of a new head or base, which may not come.
- A thread whose line is no longer in the diff is matched by its quote alone, however short the quote (decisions 17 and 21; kept by the owner). From memory of GitHub, not verified, a gone line is the usual state of a thread once the code under it changed.
- A verdict is still written into a thread in which a comment was edited or deleted after it was judged: the check of decision 16 sees only a comment that was added.
- A thread that the follow-up leaves untouched because it changed is still counted as cleared in the `Overall` of the review that was just posted.
- A head that returns after another was reviewed (a force-push back; a base changed and changed back) is reviewed, paid and posted again: only the newest published review is compared.
- A review of the app's own that the database does not know and has no recorded run for does not stop a review. Its threads are not the service's by record, so the same findings can be posted again.
- A run adopted late never has its verdicts written into the threads; the next review judges those threads again.
- A pull request whose threads, or whose list of the app's own reviews, cannot be read (GitHub refuses the query, or a paging cap is reached) gets no later review: each of its jobs ends `attempts_exhausted`, with no alert.
- After an operator adds `contents` write and before the installation's owner accepts it, each resolve is refused and logged, with no alert. The permissions are read once, at start.
- Without `contents` write, and likewise if GitHub does not name the app as the one who resolved, a cleared thread is judged again at each later review and its reply rewritten.
- A thread on a file the pull request added and later renamed is not shown.
- A wrong `answered` verdict is final once the app has resolved the thread: the thread is settled, and a finding raised again within 3 lines of it is listed as already discussed. That is the design's rule.

**Small things the reviews left**

- Two helpers are declared in both the thread adapter and the writer. A comment whose body or time is not text reads as empty instead of failing. No test of a non-digit installation for the thread list.
- The verdict's shape in the larger tool refuses extra keys in its schema and drops them in parsing.
- `verdictOf` falls back to an older run when a newer one holds the thread with an invalid verdict. No test pins that an unpublished run is skipped by the repair.
- `hasMarker` accepts a last line that GitHub would show as code. `openAgainReply` does not check the commit it is given.
- No test of a failed edit that should have been followed by a resolve.
- In the job: `adopted_late` is logged even when the mark answered that the run was already published; a repair that stored only part of the missed comments leaves the rest out; `lastPublishedRun` is no longer called; three branches have no test (`repair_failed`, the job put back after a database read fails before the review, the order in which unknown reviews are adopted).
- A stored reply count that is not a number skips the check of decision 16. One test of the duplicate rule no longer pins the order in which threads are tried. Deleting a line separator can join two words of a reason, and a few blank characters outside the list of control characters still pass as a reason.
- README: one list item under "Running it" says a job is dropped as already reviewed "at that head and base" without saying that only the newest published review counts; the section "Leaving dry run" states the rule exactly.
- README: "not judged" is shown only when some thread was not judged; "rewritten each time" holds only when the model gives a verdict for the thread.

## Not verified

Nothing here has met a real GitHub App, and no model was called by the service. Each of these needs an app on a scratch repository and the owner's go-ahead:

- Everything in the plan's "To verify with a real app": first of all that GitHub accepts the thread query as written and what `fullDatabaseId` answers; that those ids are the ones the REST comment list gives; how GraphQL writes the app's own account; whether `resolvedBy` names the app, and whether another account can carry the app's slug as its login; that a reply made by the mutation is published at once and is not counted as a review with a body; that the app may edit its own reply and that resolving needs `contents` write and nothing else; the error a refused mutation answers; that writes one second apart are not refused; that the link to a thread opens it; that a hidden comment line at the end of a reply is kept and not shown; and one whole second review, which also needs a model key and is the only place a model meets the thread rules.
- How GitHub renders a reply: reasoned from CommonMark's rules, not seen.
- The real run reached neither GitHub nor a model, so it shows none of this plan's own steps.
- CI on Linux has not run for this branch.

## Verified with a real app

On 2026-11-20, after the merge, the merged code was tried against a real GitHub App on a private scratch repository, with a real model. The service ran on the builder's machine from an image of `main`. The app had no webhook, so each event was posted to the service by hand: signed with the trial's own secret and built from the objects GitHub's API gives for the pull request. One small pull request with deliberate defects was reviewed four times; each review cost well under a cent.

**Seen to work**

- The app's token, the app's own record and an installation token. The check at start named exactly what was missing: at first `contents` write, for resolving; later every event subscription (see below).
- **The thread query is accepted as written.** The ids read from `fullDatabaseId` are the ones the REST comment list gives, and they are beyond the 32-bit range, so decision 2 was needed. Path, side, line and review ids are right. A thread whose line a push changed comes back with no line.
- GraphQL writes the app's account without `[bot]` and with the type `Bot`; REST writes it with `[bot]`. The account that resolved a thread is named too: typed as a user, with the login that ends in `[bot]`, so the adapter's comparison holds.
- The first review: posted as a comment review pinned to the head commit, with its inline comments; the comments read back and stored; the review listed as the app's own afterwards.
- `/review`: GitHub reported an organisation member as a member. On a head that had its review the command was refused with the confused reaction and the one sentence; on a new head it took the waiting push job's place, ran at once and got its eyes. `issues` write was enough for both.
- The second review, after a reply by a person in one thread and a push that fixed another: both threads judged, one `fixed` and one `answered`; the review pinned to the new commit; `Overall` counted the threads; the replies written with the marker.
- A reply made by the mutation is published at once and is not counted as a review of the app's. The app may edit its own reply: at the next review each earlier reply was rewritten, so a thread holds one reply of the app's, not a stack.
- **Rendering, read from GitHub's own HTML of a reply** whose reason held a user mention, a team mention, a tag, a character reference and a forged marker: nothing was linked or rendered, the forged marker was shown as text, and the service's own marker line was not shown.
- Resolving: refused with an error of type `FORBIDDEN` while the app had `contents` read; after the permission was changed and accepted, the next review's follow-up rewrote three replies and resolved three threads, one second apart, with no write refused.
- Cached tokens were reported from the third review on.

**Seen, and worth knowing**

- **The scores moved between reviews of a file that had not changed, to either side of the threshold:** one review said a person was needed, the next that none was, the next that one was again. This is what the next plan's "a block is scored once" is for.
- Editing the app's permissions while its webhook was switched off removed all its event subscriptions. The check at start reported each one.
- An app with no webhook answers 404 to the list of its deliveries; the redelivery step logs that and raises its alert.

**Still not verified**

- GitHub's own webhook deliveries, and redelivery: no event came from GitHub.
- `Already discussed`: the model did not raise an old finding again. The fallback when GitHub refuses the inline comments. A thread that someone writes in between its judging and the follow-up. A new permission that the installation has not accepted yet.
- A fence line right after a list item's open fence, a zero-width space inside inline code, a link named like one of the service's tags, a write on a renamed repository (plan 5's list).
- More than one call in a review, the scorer's contract, and anything at the size of a real pull request.
