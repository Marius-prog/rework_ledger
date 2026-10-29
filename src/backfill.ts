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

export async function backfillRepo(
  gh: GitHubReader, repo: { id: number; full_name: string }, days = 90, now = new Date(), maxPrs = Infinity) {
  const cutoff = new Date(now.getTime() - days * 86400_000);
  let processed = 0;
  for (const listed of await gh.listPulls(repo.full_name, cutoff)) {
    if (processed >= maxPrs) break;
    if (new Date(listed.created_at) < cutoff) continue;
    const msgs = await gh.listCommitMessages(repo.full_name, listed.number);
    const labels = (listed.labels ?? []).map((l: any) => l.name);
    const agent = detectAgent({ authorLogin: listed.user.login, authorType: listed.user.type, labels, body: listed.body, commitMessages: msgs }).isAgent;
    if (!agent) {
      // Human PRs only count toward totals. Skip reviews, comments and diffs to save API calls.
      await storePullRequest(pool, repo.id, listed, msgs);
      processed++;
      continue;
    }
    const pr = await gh.getPull(repo.full_name, listed.number); // includes additions/deletions
    await storePullRequest(pool, repo.id, pr, msgs);
    for (const r of await gh.listReviews(repo.full_name, pr.number)) await storeReview(pool, repo.id, pr.number, r);
    for (const c of await gh.listReviewComments(repo.full_name, pr.number)) await storeReviewComment(pool, repo.id, pr.number, c);
    if (gh.listPrCommits && gh.getCommitFiles) {
      await syncPrCommits(gh as CommitReader, repo, pr.number);
      await extractCorrections(pool, repo.id, pr.number);
    }
    processed++;
  }
  return processed;
}
