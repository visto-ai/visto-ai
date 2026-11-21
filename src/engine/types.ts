// src/engine/types.ts
import type { ChangedFile, PullRequestInfo, Side, Source } from '../forge/types.ts';
import type { FileScore, ScoreEntry, ScoreHistory, Verdict } from './score/types.ts';

export type Severity = 'blocker' | 'major' | 'minor';
export interface AuditEntry { stage: string; action: string; subject: string; reason: string }
export interface Usage { calls: number; inputTokens: number; outputTokens: number; cachedTokens: number; cost: number }

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface ToolDefinition { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export type Effort = 'default' | 'elevated';
export interface ModelRequest { messages: ChatMessage[]; tools: ToolDefinition[]; forcedTool: string; effort: Effort; timeoutMs: number }
export interface ModelResponse { toolName: string | null; toolArguments: string | null; text: string | null; model: string; provider: string | null; usage: Usage }
export interface ModelClient { complete(request: ModelRequest): Promise<ModelResponse> }

export interface Limits { inputTokensPerCall: number; batchesPerReview: number; modelTimeoutSeconds: number }
export interface RepoConfig { primaryBranches: string[]; scoreThreshold: number }

export interface EarlierReply { author: string; kind: 'person' | 'bot' | 'app'; body: string }
export interface EarlierThread {
  id: string;                         // the git service's id of the thread
  commentId: string;                  // its first comment
  path: string; side: Side; line: number | null;   // where it sits now
  severity: Severity; quote: string;  // of the finding that opened it
  body: string;                       // the first comment's text, as the git service has it
  openedAt: { head: string; diffHash: string | null };   // the head of the run that posted it, and the hash of its file's diff in that run
  resolved: boolean;
  settled: boolean;                   // resolved in a way that needs no further verdict
  lastVerdict: 'fixed' | 'answered' | 'open' | null;     // the newest verdict an earlier published run kept
  replies: EarlierReply[];            // oldest first
}
export interface EarlierState { head: string; threads: EarlierThread[] }   // head: of the last published review
export interface ThreadVerdict {
  threadId: string; commentId: string;
  verdict: 'fixed' | 'answered' | 'open';
  reply: string;              // the model's reason as one line: every run of white space made one space, trimmed, at most 600 characters; '' when it gave none
  fileChanged: boolean;       // for `fixed`: the thread's file has another diff than when the thread was opened
  replies?: number;           // how many replies the thread had when it was judged; absent on a verdict stored before this was recorded
}
export interface Discussed {
  path: string; side: Side; line: number; severity: 'blocker' | 'major'; body: string;
  commentId: string;                    // the first comment of the thread that already raised it
  resolved: boolean; settled: boolean;  // that thread, at the moment the finding was dropped
}

export interface ReviewInput {
  pullRequest: PullRequestInfo;
  trigger: 'automatic' | 'manual';
  repoConfig: RepoConfig;
  limits: Limits;
  asOf: Date;
  earlier: EarlierState | null; // what the last published review left on the pull request; null for a first review
  history?: ScoreHistory | null;   // the scores of the pull request's earlier runs; absent reads as none
  mode?: 'full' | 'incremental' | 'recheck';   // absent reads as 'full'
}
export interface ScoreRequest { text: string; blocks: string[] } // blocks: ids to score, in diff order; never empty
export interface ScoredItem { score: number; category: string; reason: string }
export interface ScoreAnswer {
  blocks: Record<string, ScoredItem>; // by block id; a block the scorer could not answer for is absent
  usage: Usage;
  failure: string | null;             // a short code when some request for this file failed; what was answered before it is kept
}
export interface Scorer { score(request: ScoreRequest): Promise<ScoreAnswer> }

export interface ReviewDeps {
  source: Source;
  model: ModelClient;
  contract: string;           // the rules the review model is given; with a scorer, the contract that asks for no block scores
  clock: () => Date;
  token: () => string;        // fresh random text for data markers, 16 hex characters
  log: (entry: Record<string, unknown>) => void;
  scorer?: Scorer;            // scores the blocks in place of the review model, when set
  /** The highest scores other pull requests of the repository stored for these blocks in the last 30 days. May reject. */
  reusableScores?: (blocks: Array<{ path: string; hash: string }>) => Promise<Array<{ path: string; hash: string; entry: ScoreEntry }>>;
}

export interface RawFinding { path: string; side: Side; line: number; severity: Severity; body: string; quote: string; beyond_diff: boolean }
export interface Finding { path: string; side: Side; line: number; severity: Severity; body: string; quote: string; requestedLine: number | null }
export type UnplacedReason = 'file_has_no_patch' | 'line_not_in_diff';
export interface UnplacedFinding { path: string; side: Side; line: number; severity: Severity; body: string; quote: string; reason: UnplacedReason }
export type NotReviewedReason = 'no_diff' | 'too_large' | 'over_batch_limit' | 'batch_failed';
export interface NotReviewed { path: string; reason: NotReviewedReason }

export interface ReviewResult {
  status: 'ok' | 'failed';
  failure: { stage: 'context' | 'model'; code: string } | null;
  mode: 'full' | 'incremental' | 'recheck';
  since?: string;             // the head of the last review this run reads on from; absent in a full review, or with no last review
  overview: string;
  findings: Finding[];
  unplaced: UnplacedFinding[];
  beyondDiff: RawFinding[];
  coverage: { reviewed: string[]; notReviewed: NotReviewed[] };
  usage: Usage;
  models: string[];           // models that answered, distinct, in first-seen order
  providers: string[];        // upstream providers that answered, distinct, in first-seen order
  dependencies: { model: 'ok' | 'error' };
  audit: AuditEntry[];
  scores: FileScore[];        // one per changed file; empty when the review failed
  verdict: Verdict;
  teamFileInvalid: string | null; // why the repository's .visto-ai.yml cannot be used; null when it can, or on a failed review
  // Each optional because a result stored before these existed has none: read as empty, or 0. The engine always sets them.
  threadVerdicts?: ThreadVerdict[];   // the verdicts this run kept
  threadsDue?: number;                // how many threads this run owed a verdict
  alreadyDiscussed?: Discussed[];     // major and blocker findings dropped as duplicates of an earlier thread
  nothingToDo?: boolean;              // true when an incremental review or a re-check read nothing and would tell a person what the newest published review tells
  unchanged?: Finding[];              // in an incremental review and a re-check: majors on lines unchanged since their file was last read, listed in the body only
  blockingOnUnchanged?: number;       // in a full review of a later head: its blocker and major findings on lines unchanged since their file was last read
}
export type { ChangedFile, PullRequestInfo, Side, Source };
export type {
  Anchor,
  Block,
  BlockScore,
  Category,
  FileLevelSource,
  FileScore,
  ScoreEntry,
  Span,
  Verdict,
} from './score/types.ts';
export { CATEGORIES } from './score/types.ts';
