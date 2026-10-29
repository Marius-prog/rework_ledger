import type pg from "pg";
import { detectAgent } from "./detect.js";

type Db = pg.Pool | pg.PoolClient;

export async function upsertInstallation(db: Db, id: number, login: string) {
  await db.query(
    "INSERT INTO installations (id, account_login) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET account_login=$2",
    [id, login]);
}
export async function upsertRepo(db: Db, id: number, installationId: number, fullName: string) {
  await db.query(
    "INSERT INTO repos (id, installation_id, full_name) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET full_name=$3",
    [id, installationId, fullName]);
}

export async function storePullRequest(db: Db, repoId: number, pr: any, commitMessages: string[] = []) {
  const labels: string[] = (pr.labels ?? []).map((l: any) => l.name);
  const d = detectAgent({
    authorLogin: pr.user.login, authorType: pr.user.type, labels, body: pr.body, commitMessages,
  });
  // keep an earlier agent detection (e.g. from commit trailers) if this payload alone does not match
  await db.query(
    `INSERT INTO pull_requests (repo_id, number, author_login, title, state, merged, head_ref, head_sha,
       additions, deletions, labels, is_agent, agent_name, detection_reason, created_at, merged_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (repo_id, number) DO UPDATE SET
       title=$4, state=$5, merged=$6, head_sha=$8, additions=$9, deletions=$10, labels=$11,
       is_agent = pull_requests.is_agent OR $12,
       agent_name = CASE WHEN $12 THEN $13 ELSE pull_requests.agent_name END,
       detection_reason = CASE WHEN $12 THEN $14 ELSE pull_requests.detection_reason END,
       merged_at=$16`,
    [repoId, pr.number, pr.user.login, pr.title, pr.state, !!pr.merged_at || !!pr.merged,
     pr.head.ref, pr.head.sha, pr.additions ?? 0, pr.deletions ?? 0, labels,
     d.isAgent, d.agentName, d.reason, pr.created_at, pr.merged_at ?? null]);
}

export async function storeReview(db: Db, repoId: number, prNumber: number, r: any) {
  await db.query(
    `INSERT INTO reviews (id, repo_id, pr_number, reviewer_login, state, submitted_at)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET state=$5, submitted_at=$6`,
    [r.id, repoId, prNumber, r.user.login, String(r.state).toLowerCase(), r.submitted_at ?? null]);
}

export async function storeReviewComment(db: Db, repoId: number, prNumber: number, c: any) {
  await db.query(
    `INSERT INTO review_comments (id, repo_id, pr_number, reviewer_login, in_reply_to_id, path, diff_hunk, body, commit_sha, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO UPDATE SET body=$8`,
    [c.id, repoId, prNumber, c.user.login, c.in_reply_to_id ?? null, c.path ?? null,
     c.diff_hunk ?? null, c.body, c.commit_id ?? null, c.created_at]);
}

export async function storePush(db: Db, repoId: number, payload: any) {
  const ref = String(payload.ref).replace(/^refs\/heads\//, "");
  for (const c of payload.commits ?? []) {
    await db.query(
      `INSERT INTO commits (repo_id, sha, ref, author_login, message, committed_at)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [repoId, c.id, ref, c.author?.username ?? null, c.message, c.timestamp]);
  }
  // commit trailers can reveal an agent PR that the PR payload alone did not
  const msgs = (payload.commits ?? []).map((c: any) => c.message as string);
  const d = detectAgent({ authorLogin: "", labels: [], commitMessages: msgs });
  if (d.isAgent) {
    await db.query(
      `UPDATE pull_requests SET is_agent=true, agent_name=$3, detection_reason=$4
       WHERE repo_id=$1 AND head_ref=$2 AND state='open' AND NOT is_agent`,
      [repoId, ref, d.agentName, d.reason]);
  }
}
