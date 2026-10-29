import { detectAgent } from "./detect.js";
import { pool } from "./db/pool.js";
import { extractCorrections, syncPrCommits, type CommitReader } from "./extract.js";
import { storePullRequest, storeReview, storeReviewComment } from "./store.js";

export interface GitHubReader extends Partial<CommitReader> {
  listPulls(repo: string, since: Date): Promise<any[]>; // all states, newest first, stops at `since`
  getPull(repo: string, n: number): Promise<any>; // includes additions/deletions
  listCommitMessages(repo: string, n: number): Promise<string[]>;
  listReviews(repo: string, n: number): Promise<any[]>;
  listReviewComments(repo: string, n: number): Promise<any[]>;
}

export interface BackfillOptions { maxPrs?: number; concurrency?: number; onProgress?: (done: number, total: number) => void }
export interface BackfillResult { processed: number; skipped: number; failed: number }

async function mapPool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

/** Resumable: closed PRs that were fully processed before are skipped. A PR that errors is counted and the rest continue. */
export async function backfillRepo(
  gh: GitHubReader, repo: { id: number; full_name: string }, days = 90, now = new Date(), opts: BackfillOptions = {}): Promise<BackfillResult> {
  const { maxPrs = Infinity, concurrency = 6, onProgress } = opts;
  const cutoff = new Date(now.getTime() - days * 86400_000);
  const listed = (await gh.listPulls(repo.full_name, cutoff)).filter((p) => new Date(p.created_at) >= cutoff).slice(0, maxPrs);
  const done = new Set((await pool.query(
    "SELECT number FROM pull_requests WHERE repo_id=$1 AND backfilled_at IS NOT NULL AND state='closed'", [repo.id])).rows.map((r) => r.number));
  const todo = listed.filter((p) => !(p.state === "closed" && done.has(p.number)));
  const result = { processed: 0, skipped: listed.length - todo.length, failed: 0 };

  await mapPool(todo, concurrency, async (item) => {
    try {
      await backfillPr(gh, repo, item);
      result.processed++;
    } catch (e) {
      result.failed++;
      console.error(`backfill ${repo.full_name}#${item.number} failed:`, (e as Error).message);
    }
    onProgress?.(result.processed + result.failed, todo.length);
  });
  return result;
}

async function backfillPr(gh: GitHubReader, repo: { id: number; full_name: string }, listed: any) {
  const msgs = await gh.listCommitMessages(repo.full_name, listed.number);
  const labels = (listed.labels ?? []).map((l: any) => l.name);
  const agent = detectAgent({ authorLogin: listed.user.login, authorType: listed.user.type, labels, body: listed.body, commitMessages: msgs }).isAgent;
  if (!agent) {
    // Human PRs only count toward totals. Skip reviews, comments and diffs to save API calls.
    await storePullRequest(pool, repo.id, listed, msgs);
  } else {
    const pr = await gh.getPull(repo.full_name, listed.number); // includes additions/deletions
    await storePullRequest(pool, repo.id, pr, msgs);
    for (const r of await gh.listReviews(repo.full_name, pr.number)) await storeReview(pool, repo.id, pr.number, r);
    for (const c of await gh.listReviewComments(repo.full_name, pr.number)) await storeReviewComment(pool, repo.id, pr.number, c);
    if (gh.listPrCommits && gh.getCommitFiles) {
      await syncPrCommits(gh as CommitReader, repo, pr.number);
      await extractCorrections(pool, repo.id, pr.number);
    }
  }
  await pool.query("UPDATE pull_requests SET backfilled_at=now() WHERE repo_id=$1 AND number=$2", [repo.id, listed.number]);
}
