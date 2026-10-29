import type pg from "pg";
import { pool } from "./db/pool.js";
import { pickHunk } from "./hunks.js";
import { redact } from "./redact.js";

export interface CommitReader {
  listPrCommits(repo: string, n: number): Promise<{ sha: string; message: string; date: string }[]>;
  getCommitFiles(repo: string, sha: string): Promise<{ filename: string; patch?: string }[]>;
}

/** Fetch and store a PR's commits and per-file patches. */
export async function syncPrCommits(gh: CommitReader, repo: { id: number; full_name: string }, prNumber: number) {
  for (const c of await gh.listPrCommits(repo.full_name, prNumber)) {
    await pool.query(
      "INSERT INTO pr_commits (repo_id, pr_number, sha, message, committed_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
      [repo.id, prNumber, c.sha, c.message, c.date]);
    for (const f of await gh.getCommitFiles(repo.full_name, c.sha)) {
      if (!f.patch) continue;
      await pool.query(
        "INSERT INTO commit_files (repo_id, sha, path, patch) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [repo.id, c.sha, f.filename, f.patch]);
    }
  }
}

/**
 * A correction is a reviewer's top-level comment on an agent PR, paired with the first later
 * commit on that PR that changed the commented file. Threads with no such commit are skipped.
 */
export async function extractCorrections(db: pg.Pool, repoId: number, prNumber: number): Promise<number> {
  const pr = (await db.query(
    "SELECT author_login, agent_name FROM pull_requests WHERE repo_id=$1 AND number=$2 AND is_agent", [repoId, prNumber])).rows[0];
  if (!pr) return 0;
  const roots = (await db.query(
    `SELECT * FROM review_comments WHERE repo_id=$1 AND pr_number=$2 AND in_reply_to_id IS NULL
       AND path IS NOT NULL AND reviewer_login <> $3 ORDER BY created_at`, [repoId, prNumber, pr.author_login])).rows;
  let stored = 0;
  for (const root of roots) {
    const fix = (await db.query(
      `SELECT c.sha, f.patch FROM pr_commits c JOIN commit_files f ON f.repo_id=c.repo_id AND f.sha=c.sha AND f.path=$4
        WHERE c.repo_id=$1 AND c.pr_number=$2 AND c.committed_at > $3 ORDER BY c.committed_at LIMIT 1`,
      [repoId, prNumber, root.created_at, root.path])).rows[0];
    if (!fix) continue;
    const after = pickHunk(fix.patch, root.line);
    if (!after || !root.diff_hunk) continue;
    const replies = (await db.query(
      "SELECT body FROM review_comments WHERE in_reply_to_id=$1 AND reviewer_login <> $2 ORDER BY created_at",
      [root.id, pr.author_login])).rows.map((r) => r.body);
    const res = await db.query(
      `INSERT INTO corrections (repo_id, pr_number, comment_id, agent_name, file, comment, before_hunk, after_hunk, fix_sha, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (comment_id) DO NOTHING`,
      [repoId, prNumber, root.id, pr.agent_name, root.path, redact([root.body, ...replies].join("\n\n")),
       redact(root.diff_hunk), redact(after.text), fix.sha, root.created_at]);
    stored += res.rowCount ?? 0;
  }
  return stored;
}
