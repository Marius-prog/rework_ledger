import type pg from "pg";

/** One JSON object per correction. Snippets were redacted when the correction was stored. */
export async function evalCasesJsonl(db: pg.Pool, repoId: number): Promise<string> {
  const rows = (await db.query(
    `SELECT c.id, c.pr_number, c.agent_name, c.file, c.comment, c.before_hunk, c.after_hunk, c.created_at,
            p.title task, ru.title rule, rp.full_name repo
       FROM corrections c JOIN repos rp ON rp.id=c.repo_id
       LEFT JOIN pull_requests p ON p.repo_id=c.repo_id AND p.number=c.pr_number
       LEFT JOIN rules ru ON ru.id=c.rule_id
      WHERE c.repo_id=$1 ORDER BY c.id`, [repoId])).rows;
  return rows.map((r) => JSON.stringify({
    id: r.id, repo: r.repo, pr: r.pr_number, agent: r.agent_name, file: r.file,
    task: r.task, review_comment: r.comment, bad_diff: r.before_hunk, corrected_diff: r.after_hunk,
    rule: r.rule, created_at: r.created_at,
  })).join("\n") + (rows.length ? "\n" : "");
}
