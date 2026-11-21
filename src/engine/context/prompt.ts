import type { ChatMessage, PullRequestInfo } from '../types.ts';
import { estimateTokens } from './batches.ts';
import type { Batch } from './batches.ts';
import { ANCHOR_LEGEND } from './diff.ts';
import { submitReviewTool, submitReviewWithThreadsTool } from '../model/submit-review.ts';
import { MEASURE_NUMBER, MEASURE_TOKEN, fileSection } from './section.ts';
import { THREAD_HEADING, THREAD_RULES, threadsPart } from './threads.ts';
import { cutText, inlineText, stripControl, wrapData } from './untrusted.ts';

// Room kept for the retry turn: the rejected answer (cut to 2,000 characters) and the rejection line.
export const RETRY_ALLOWANCE_TOKENS = 800;
// The longest last review overview a call is shown.
export const LAST_OVERVIEW_CHARS = 4000;

const LAST_OVERVIEW_LINE = 'The last review of this pull request summarized it as below. It describes an earlier state of the code and proves nothing about the code you are given.';

// Everything the pull request author wrote is untrusted: text printed outside a
// data wrapper goes through inlineText, text inside one is stripped first.
export function pullRequestHeader(pr: PullRequestInfo, fileCount: number, token: string, lastOverview?: string): string {
  return [
    `Repository: ${inlineText(pr.ref.owner)}/${inlineText(pr.ref.repo)}`,
    `Pull request: #${pr.ref.number}`,
    `Base branch: ${inlineText(pr.baseBranch)}`,
    `Head branch: ${inlineText(pr.headBranch)}`,
    `Author: ${inlineText(pr.author)}`,
    `Files in this review: ${fileCount}`,
    wrapData('title', stripControl(pr.title).text, token),
    wrapData('description', stripControl(pr.description).text, token),
    ...(lastOverview === undefined ? [] : [LAST_OVERVIEW_LINE, wrapData('last review overview', cutText(lastOverview, LAST_OVERVIEW_CHARS), token)]),
  ].join('\n');
}

// What stripping removes from the title and the description, for the audit.
export function headerStripCounts(pr: PullRequestInfo): { title: number; description: number } {
  return { title: stripControl(pr.title).removed, description: stripControl(pr.description).removed };
}

export function buildMessages(args: {
  contract: string;
  pr: PullRequestInfo;
  fileCount: number;
  firstFileNumber: number;
  batch: Batch;
  batchIndex: number;
  batchCount: number;
  token: string;
  lastOverview?: string;   // the last review's overview, in an incremental review or a re-check that has one
}): ChatMessage[] {
  const { contract, pr, fileCount, firstFileNumber, batch, batchIndex, batchCount, token, lastOverview } = args;
  const parts: string[] = [];
  if (batchCount > 1) {
    parts.push(`Batch ${batchIndex + 1} of ${batchCount}.`);
  }
  parts.push(ANCHOR_LEGEND);
  batch.files.forEach((c, i) => {
    parts.push(fileSection(c, firstFileNumber + i, fileCount, token));
  });
  const threads = threadsPart(
    batch.files.flatMap((c) => c.threads ?? []).sort((x, y) => Number(x.key.slice(1)) - Number(y.key.slice(1))), token,
  );
  if (threads !== '') parts.push(threads);
  return [
    { role: 'system', content: contract },
    { role: 'user', content: pullRequestHeader(pr, fileCount, token, lastOverview) },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

// Everything in a call except the file sections: the contract, the header, the
// batch line, the legend, the tool definition and the retry turn.
export function fixedTokens(contract: string, pr: PullRequestInfo, withThreads = false, lastOverview?: string): number {
  return (
    estimateTokens(contract) +
    estimateTokens(pullRequestHeader(pr, MEASURE_NUMBER, MEASURE_TOKEN, lastOverview)) +
    estimateTokens(`Batch ${MEASURE_NUMBER} of ${MEASURE_NUMBER}.\n\n`) +
    estimateTokens(`${ANCHOR_LEGEND}\n\n`) +
    estimateTokens(JSON.stringify(withThreads ? submitReviewWithThreadsTool : submitReviewTool)) +
    (withThreads ? estimateTokens(`${THREAD_HEADING}\n\n${THREAD_RULES}\n\n`) : 0) +
    RETRY_ALLOWANCE_TOKENS
  );
}
