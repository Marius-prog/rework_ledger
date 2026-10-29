import type pg from "pg";
import { DEFAULT_POLICY, evaluatePolicies, toCheckOutput, type PolicyConfig, type PolicyResult } from "./policies.js";

export interface ChecksClient {
  listPrFiles(repo: string, n: number): Promise<string[]>;
  createCheckRun(repo: string, p: { name: string; headSha: string; conclusion: "success" | "failure"; title: string; summary: string }): Promise<void>;
}

export async function loadPolicy(db: pg.Pool, repoId: number): Promise<PolicyConfig> {
  const r = (await db.query("SELECT * FROM repo_policies WHERE repo_id=$1", [repoId])).rows[0];
  return r ? { testsEnabled: r.tests_enabled, protectedEnabled: r.protected_enabled, protectedPaths: r.protected_paths,
    sizeEnabled: r.size_enabled, maxDiffLines: r.max_diff_lines } : DEFAULT_POLICY;
}

/** Latest review per human reviewer, kept only if it is an approval. The PR author and bots never count. */
export async function humanApprovals(db: pg.Pool, repoId: number, prNumber: number, author: string): Promise<string[]> {
  return (await db.query(
    `SELECT reviewer_login FROM (
       SELECT DISTINCT ON (reviewer_login) reviewer_login, state FROM reviews
        WHERE repo_id=$1 AND pr_number=$2 AND state IN ('approved','changes_requested','dismissed')
        ORDER BY reviewer_login, submitted_at DESC NULLS LAST, id DESC) x
      WHERE state='approved' AND reviewer_login NOT LIKE '%[bot]' AND reviewer_login <> $3 ORDER BY 1`,
    [repoId, prNumber, author])).rows.map((r) => r.reviewer_login);
}

/** Evaluates policies for an agent PR and posts the check run. Returns null for non-agent or unknown PRs. */
export async function runCheck(db: pg.Pool, client: ChecksClient, repo: { id: number; full_name: string }, prNumber: number): Promise<PolicyResult[] | null> {
  const pr = (await db.query("SELECT * FROM pull_requests WHERE repo_id=$1 AND number=$2 AND is_agent", [repo.id, prNumber])).rows[0];
  if (!pr) return null;
  const approvals = await humanApprovals(db, repo.id, prNumber, pr.author_login);
  const results = evaluatePolicies(
    { files: await client.listPrFiles(repo.full_name, prNumber), additions: pr.additions, deletions: pr.deletions, humanApprovals: approvals },
    await loadPolicy(db, repo.id));
  await client.createCheckRun(repo.full_name, { name: "Rework Ledger", headSha: pr.head_sha, ...toCheckOutput(results, approvals) });
  return results;
}
