import { afterAll, beforeEach, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { backfillReport } from "../src/report.js";

const now = new Date("2025-10-29T00:00:00Z");
beforeEach(async () => {
  await pool.query("TRUNCATE installations, reviews, review_comments, corrections, rules CASCADE");
  await pool.query("INSERT INTO installations (id, account_login) VALUES (1,'acme')");
  await pool.query("INSERT INTO repos (id, installation_id, full_name) VALUES (1,1,'acme/api')");
  const pr = (n: number, agent: string | null, created: string) => pool.query(
    `INSERT INTO pull_requests (repo_id, number, author_login, title, state, head_ref, head_sha, is_agent, agent_name, created_at)
     VALUES (1,$1,'x','SECRET TITLE','closed','b','s',$2,$3,$4)`, [n, agent !== null, agent, created]);
  await pr(1, "codex", "2025-10-14T00:00:00Z"); await pr(2, "codex", "2025-10-15T00:00:00Z");
  await pr(3, "claude-code", "2025-10-22T00:00:00Z"); await pr(4, null, "2025-10-22T00:00:00Z");
  await pool.query("INSERT INTO reviews (id, repo_id, pr_number, reviewer_login, state) VALUES (1,1,1,'bob','changes_requested')");
  await pool.query(`INSERT INTO review_comments (id, repo_id, pr_number, reviewer_login, reviewer_type, body, created_at, path)
    VALUES (10,1,1,'bob','User','fix','2025-10-14T01:00:00Z','a.ts'), (11,1,3,'Copilot','Bot','ai','2025-10-22T01:00:00Z','a.ts')`);
  await pool.query(`INSERT INTO corrections (repo_id, pr_number, comment_id, file, comment, before_hunk, after_hunk, fix_sha, created_at)
    VALUES (1,3,11,'a.ts','c','b','a','s','2025-10-22T02:00:00Z')`);
});
afterAll(() => pool.end());

it("builds an aggregate-only report", async () => {
  const md = await backfillReport(pool, 1, 90, now);
  expect(md).toContain("# Agent PR rework report: acme/api");
  expect(md).toContain("Covers PRs created 2025-10-14 to 2025-10-22");
  expect(md).toContain("PRs scanned: 4, agent PRs: 3 (75%)");
  expect(md).toContain("Agent PRs with a human review comment: 1"); // the Copilot comment does not count
  expect(md).toContain("| codex | 2 | 1 | 50% |");
  expect(md).toContain("| claude-code | 1 | 1 | 100% |");
  expect(md).toMatch(/2025-10-13 .* 50% {2}\(1\/2\)/);
  expect(md).toMatch(/2025-10-20 .* 100% {2}\(1\/1\)/);
  expect(md).not.toContain("SECRET TITLE");
});
