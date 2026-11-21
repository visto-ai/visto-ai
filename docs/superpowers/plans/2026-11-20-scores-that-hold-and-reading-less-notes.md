# Notes: Scores That Hold, and Reading Less plan

These notes record what happened while `2026-11-20-scores-that-hold-and-reading-less.md` was built: the decisions taken where the plan was silent or wrong, what the reviews found, what the real run showed, what a trial with a real app showed, and what was put off. The plan file was corrected as the build went, so it states the rules as built; where a task's test list in it still names an older rule, these notes say so.

## Status

- Before the build the plan was reviewed twice by a stronger model than the one that wrote it. The first review found seven critical defects, ten important and 27 minor: each critical one was a sequence of reviews in which a score fell, could be bought, or a file was never read again. The scoring core (Tasks 2 to 4 and 6 to 9) was written again from that review, not patched. The second review, of the rewrite, found no critical defect, five important and 19 minor; all five and fifteen of the minor ones were applied before the first commit.
- Tasks 1 to 10 were built on the branch `stage-4e`, one implementer and one independent reviewer for each. Tasks 2, 3, 4, 6, 7 and 9 were built by a stronger model and reviewed by one.
- Four tasks needed a fix round, each re-reviewed: Task 2 (a gap that came from the plan, decision 6), Task 7 (decisions 10 and 11), Task 8 (decision 12, and a damaged list that made the body throw) and Task 10 (three sentences of the README).
- Then a review of the whole branch by the strongest model. It ran the real engine under the real job through 1,500 reviews of made-up pull requests and found no score falling. It found two critical defects all the same, both ways to a lower score by how one pushes, three important and seven minor. One fix wave followed (decisions 13 to 16), and a re-review of it by the same model: everything addressed, but the second critical one only in part. A second, small fix followed, against the rule of one wave (decision 17), and a last re-check: ready, nothing critical or important left.
- At the end: 1,672 tests pass, the type check and the lint are clean, source and tests are ASCII.
- The real run under Docker was made on the final code. What it showed is below.
- The final code was tried against a real GitHub App with a real model: see "Verified with a real app".

## Decisions taken while building

Each is the builder's, taken without the owner, and listed so he can overrule it. The plan's numbered calls say the same of the ones that became rules.

1. **The plan was rewritten after its first review, and reviewed again.** The history a review is given changed shape: the highest entry for each hash; splits kept apart; who gave a score; for each file, the head at which a published review last read it. Cost: one more review before the build.
2. **A split hunk is not reused by another pull request** (call 5). Opening the same change again gives every long block the model split a fresh score.
3. **Reuse by path and changed lines is built as the design has it, with no guard** (call 19). The lookup answers the highest score in the window. Lines scored where they are harmless keep that score when they are put elsewhere in the file.
4. **A file a review should have read and could not counts as 100 whatever scores it keeps** (call 20). One failed model call makes a scored file 100 for that review.
5. **A hunk split by a review stored before this plan is asked again once** (call 18): its parts did not record where they sat.
6. **"Nothing new" is decided by comparing what two reviews show a person,** as one text: the threshold, every file's final score, every block and every file-level score at or above the threshold, and each file not reviewed with its reason (call 11). The plan first compared two numbers; the second plan review showed pushes that changed the list and not the numbers, and Task 2's review that the text missed whole-file lines and reasons.
7. **The last review's overview is shown to the model at the end of the header message,** as data, cut to 4,000 characters, in an incremental review and a re-check. It takes up to that much of each call's room.
8. **No third review of the plan.** Each correction of the second review was a rule changed in a sentence or two with its test.
9. **Readings the builders made where a rule left a choice,** each accepted because it errs towards asking again or towards a person: a split is taken from the newest run that qualifies; a stored entry that is damaged is skipped and is not "no entry"; a hunk whose stored split no longer fits is asked whole; the mode is decided as soon as the pull request's runs are listed, so a failure after that records the decided mode; a write that is tried again stores a run's scores for other pull requests only when that try recorded the run.
10. **Only a hunk with a removed line is named for its removed lines** (Task 7). The plan listed every new hunk, so the model was told of removed lines in a hunk that only adds.
11. **A finding also counts as on a changed line when the line the model named changed** (Task 7's review). Placement can move a finding up to three lines onto a hunk's edge; judged by the placed line alone, a major on changed code could be listed in the body and never posted.
12. **`On code unchanged since the last review` is written before `Findings not placed on the diff`** (call 23); the design lists it after. Among the sections that are kept whole when a long body is cut, an uncapped list could push `Overall` out of the posted review.
13. **A file takes no new whole-file score only while its diff is the one a published review of this pull request read under its present path** (call 13; the whole-branch review's first critical finding and its first important one). The plan had "while every block has a score", so a pull request whose blocks all came from another pull request could never get the whole-file score the first one had, and a reviewed file moved with the same change was never read where it now stood. Cost: such a file is read once more.
14. **A file the pull request adds answers to the history of any other path that held one of its blocks** (call 24; the second critical finding). GitHub shows a new file that a later push renames as added, with no earlier name, so its scores started afresh with no floor. The rule holds a new file moved or copied with its content unchanged, also when it was scored as a whole only. It does not hold a new file renamed and edited in the same push: a new file is one block, so any edit gives a fresh score.
15. **A split's parts are stored in line order.** In the model's own order they never fitted again, and the file was asked, and paid for, at every review.
16. **A score taken from another pull request is kept and shown without its reason.** The reason was written about another pull request, a fork's too, and would have appeared in this one's review.
17. **A second fix after the fix wave.** The re-review showed the rename rule missing the commonest case, a new file the model scored as a whole only. One condition closed it; leaving it open would have made the README's sentence false.

## What the reviews found that the plan had wrong

- **First plan review.** An edited block answered with a whole-file score went under the floor. A part that became a hunk of its own lost its score. A score found on another pull request escaped the floor. Two blocks with the same lines had no rule for which score stood. A moved file was scored afresh in every review. A whole-file score ended up standing for blocks nobody had scored. A hunk split in a first review lost its parts in the second, and its file was read again for ever.
- **Second plan review.** "Nothing new" compared two numbers. A file with a character stripped from a changed line could never be covered and was sent in every review. A covered file that found no room in a full review counted as 100. A moved file was asked again whenever it was sent, and the highest answer stayed. Two old results, one that scored a hunk whole and one that split it, left the hunk below its highest part.
- **Task reviews.** What two reviews show a person missed the whole-file lines and the reason a file was not reviewed (Task 2). A finding was judged by the line it was placed on (Task 7). A long list of unchanged findings could push `Overall` out of the body, and a damaged one made the body throw (Task 8).
- **Whole-branch review.** Decisions 13 to 16. It also found three sentences of the README that were not true, among them that nothing had been tried against a real app.

## Text in the plan that is stale

- Task 3's test list still names `a renamed file with the same change is covered by the review that read it under its old name`. Decision 13 reversed it: such a file is not covered, and is read once where it now stands.
- Task 6's interface comments and Task 3's `KeptScores` comments describe `settled` and `covered` as two things. For a file with blocks they are one (decision 13).

## What the real run showed

One run under Docker on the final code, against a real Postgres, in a network with no way out, with a key made for the run. The previous release came first, on a fresh database; this branch followed on that database.

- The previous release applied its three migrations. This branch added the fourth, and nothing else, on that database. A run the previous release had stored reads with no base branch, and its history and what it showed a person are read from its stored result.
- The lookup for scores other pull requests stored, on rows made by hand: the highest of two pull requests was answered; the asking pull request's own row was left out; the second scorer's row was kept apart; a row older than 30 days was left out; 1,201 blocks asked in several statements were all answered. A score of 150 was refused by the database.
- From inside the network the service answered its health check and could not reach the outside.
- A signed push for a pull request that already had a published review was accepted and its job queued for the quiet period; a push with a wrong signature was refused. The job's first try failed at its first read of GitHub and was put back, with the run recorded as failed and nothing spent.
- The log was nine lines, each one JSON object. None held the webhook secret, the private key, the model key, the database password, a score's reason or a review's overview.
- Everything the run made was removed: no container, volume, network or image left.

## Verified with a real app

On 2026-11-21 the final code was tried against a real GitHub App on a small private scratch repository, with a real model, as the trial after the last plan was. The service ran on the builder's machine. The app has no webhook, so each event was posted to the service by hand, signed with the trial's own secret and built from the objects GitHub's API gives. The database was the one that trial had left: one pull request with four reviews stored by the previous release, in which the same two files had been scored differently each time. Seven jobs ran; three called the model.

**Seen to work**

- The migration ran on that database, and the four older reviews were read.
- **A `/review` on the head that had its review** was a re-check with no model call, posted. Its scores came from the older results: each file stood at the highest whole-file score any of the four reviews had given it, each block at the highest score its lines had been given, marked as kept from an earlier review. The scores that had moved to either side of the threshold no longer moved.
- **A push that edited one file.** The first review after one stored by the previous release is a full one, since no base branch was stored. The model answered the edited file with a whole-file score alone, higher than the kept one, and that stood. The file that had not changed kept its scores.
- **A push that edited the other file** was an incremental review: one file was sent, the other was left out and kept its scores. **The model gave the edited block a lower score than the block it replaced; the block was held at the floor, and the review records what was given.** The model's lower whole-file score lost to the kept one. The review opened by saying it was incremental and since which commit.
- **A push that merged the base branch and changed nothing in the diff** ended as nothing new: no model call, nothing posted. A `/review` on that head then got a review with no model call, and a second `/review` a re-check.
- **A rebase of the branch, force-pushed, with the same content** ended as nothing new too.
- **The same change opened as a second pull request.** The one block the first pull request had a stored score for was taken from it, without being asked, at the score the model had given there (not the one the floor had raised it to), and its file could still be given a whole-file score. The other file had no stored block score and was scored afresh.

**Seen, and worth knowing**

- **The model sent a score for a block marked as already scored,** once. It was ignored and named in the audit, as built. It sent no whole-file score for a file that takes none.
- **The model answered most files with a whole-file score and no block score.** Nothing is stored for other pull requests from such an answer, so in the whole trial one block could be reused. With a model that answers so, reuse across pull requests rarely applies; what held the scores inside the pull request was the whole-file score that never falls, and the floor.
- The second pull request took a block at the score that was given in the first, which is lower than the score the first pull request holds it at. That is the design's rule for reuse.

**Still not verified**

- GitHub's own webhook deliveries and their redelivery.
- A finding on a line that has not changed (the model raised none there), a thread judged in an incremental review, a hunk the model splits, a renamed or copied new file, a second scorer.
- What the model was sent: the service stores no request, so the headers that say `scored`, and the lines named as changed, were seen only in tests.
- How GitHub renders the new first lines and sections: they were posted, and their HTML was not read.
- Anything at the size of a real pull request.

## Put off

- **Inline notes on the blocks listed for a person (D22) and the app manifest:** the next plan, before the gate.
- **For the owner to decide:**
  - whether the key for reuse should also cover the lines around a block (call 19);
  - the place of the section on unchanged code (call 23).
- **Ruled by the owner on 2026-11-21:** a new file is not held to the scores of files that left the diff in the same push (call 24). A new file renamed and edited in one push is therefore scored afresh, and so is the lower of two identical new files when the higher is deleted.
- **Known and left as they are:**
  - A file with an unsettled major or blocker thread is read at every push, changed or not (5.2). A thread on a file that left the diff makes every push post a review with no model call.
  - The increment compares a file's content at two heads. A line that enters the diff with its text unchanged (the base moved under it) counts as unchanged, and of two swapped lines one does; a major there is listed in the body and not posted. A moved file read once where it now stands is told that no line changed, so a major about the move is listed too; a blocker is posted.
  - A block raised to the floor from a whole-file answer is stored for other pull requests with that whole-file score as its own.
  - The floor counts scores that were themselves raised.
  - A kept part of a split hunk loses the context lines at its edges in its stored line ranges; only the backtest's labels read them.
  - Each further automatic start on a head that ended as nothing new records another empty run.
  - A write that is tried again after its first try landed stores no scores for other pull requests and logs that nothing was new as false.

## Not verified

- Two jobs of one pull request at once.
- The packer at real token sizes, and the lookup on a large table.
- Whether a model more often honours `scored` than the one in the trial did, and how often one lists a split's parts out of order.
