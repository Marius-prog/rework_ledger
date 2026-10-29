import { afterAll, beforeEach, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { handleEvent } from "../src/webhook.js";

const TABLES = ["pull_requests", "reviews", "review_comments", "commits", "pr_commits", "commit_files", "corrections", "rules", "repo_policies", "repos"];
const count = async (t: string, repoIds: number[]) =>
  (await pool.query(`SELECT count(*)::int c FROM ${t} WHERE ${t === "repos" ? "id" : "repo_id"} = ANY($1)`, [repoIds])).rows[0].c;

beforeEach(async () => {
  await pool.query("TRUNCATE installations, reviews, review_comments, commits, pr_commits, commit_files, corrections, rules, repo_policies, user_installations CASCADE");
  for (const [inst, repo] of [[1, 10], [2, 20]]) {
    await pool.query("INSERT INTO installations (id, account_login) VALUES ($1,'x')", [inst]);
    await pool.query("INSERT INTO repos (id, installation_id, full_name) VALUES ($1,$2,'o/r')", [repo, inst]);
    await pool.query(`INSERT INTO pull_requests (repo_id, number, author_login, title, state, head_ref, head_sha, created_at) VALUES ($1,1,'a','t','open','b','s',now())`, [repo]);
    await pool.query("INSERT INTO reviews (id, repo_id, pr_number, reviewer_login, state) VALUES ($1,$2,1,'b','approved')", [repo, repo]);
    await pool.query("INSERT INTO review_comments (id, repo_id, pr_number, reviewer_login, body, created_at) VALUES ($1,$2,1,'b','c',now())", [repo, repo]);
    await pool.query("INSERT INTO commits (repo_id, sha, ref, message, committed_at) VALUES ($1,'s','b','m',now())", [repo]);
    await pool.query("INSERT INTO pr_commits (repo_id, pr_number, sha, message, committed_at) VALUES ($1,1,'s','m',now())", [repo]);
    await pool.query("INSERT INTO commit_files (repo_id, sha, path, patch) VALUES ($1,'s','a','p')", [repo]);
    await pool.query("INSERT INTO rules (id, repo_id, title, body) VALUES ($1,$2,'t','b')", [repo, repo]);
    await pool.query(`INSERT INTO corrections (repo_id, pr_number, comment_id, file, comment, before_hunk, after_hunk, fix_sha, created_at, rule_id)
      VALUES ($1::bigint,1,$1::bigint,'f','c','b','a','s',now(),$1::int)`, [repo]);
    await pool.query("INSERT INTO repo_policies (repo_id) VALUES ($1)", [repo]);
  }
});
afterAll(() => pool.end());

it("uninstall removes all stored data for that installation and leaves others intact", async () => {
  await handleEvent("installation", { action: "deleted", installation: { id: 1 } });
  for (const t of TABLES) {
    expect(await count(t, [10]), `${t} for removed installation`).toBe(0);
    expect(await count(t, [20]), `${t} for other installation`).toBe(1);
  }
  expect((await pool.query("SELECT id FROM installations")).rows.map((r) => Number(r.id))).toEqual([2]);
});

it("removing one repo from an install purges that repo only", async () => {
  await pool.query("INSERT INTO repos (id, installation_id, full_name) VALUES (11,1,'o/r2')");
  await pool.query("INSERT INTO rules (id, repo_id, title, body) VALUES (11,11,'t','b')");
  const out = await handleEvent("installation_repositories", { action: "removed", installation: { id: 1, account: { login: "x" } },
    repositories_added: [], repositories_removed: [{ id: 10, full_name: "o/r" }] });
  expect(out).toBe("purged 1 repos");
  for (const t of TABLES) expect(await count(t, [10]), `${t} for removed repo`).toBe(0);
  expect(await count("rules", [11])).toBe(1);   // sibling repo in the same installation kept
  expect(await count("rules", [20])).toBe(1);   // other installation kept
  expect(await count("repos", [11])).toBe(1);
});
