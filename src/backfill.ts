import { pool } from "./db/pool.js";
import { storePullRequest, storeReview, storeReviewComment } from "./store.js";

export interface GitHubReader {
  listPulls(repo: string): Promise<any[]>; // all states, newest first
  getPull(repo: string, n: number): Promise<any>; // includes additions/deletions
  listCommitMessages(repo: string, n: number): Promise<string[]>;
  listReviews(repo: string, n: number): Promise<any[]>;
  listReviewComments(repo: string, n: number): Promise<any[]>;
}

export async function backfillRepo(gh: GitHubReader, repo: { id: number; full_name: string }, days = 90, now = new Date()) {
  const cutoff = now.getTime() - days * 86400_000;
  let processed = 0;
  for (const listed of await gh.listPulls(repo.full_name)) {
    if (new Date(listed.created_at).getTime() < cutoff) continue;
    const pr = await gh.getPull(repo.full_name, listed.number);
    await storePullRequest(pool, repo.id, pr, await gh.listCommitMessages(repo.full_name, pr.number));
    for (const r of await gh.listReviews(repo.full_name, pr.number)) await storeReview(pool, repo.id, pr.number, r);
    for (const c of await gh.listReviewComments(repo.full_name, pr.number)) await storeReviewComment(pool, repo.id, pr.number, c);
    processed++;
  }
  return processed;
}
