import { afterAll, beforeEach, expect, it } from "vitest";
import { backfillRepo, type GitHubReader } from "../src/backfill.js";
import { pool } from "../src/db/pool.js";
import { upsertInstallation, upsertRepo } from "../src/store.js";

const now = new Date("2025-10-30T00:00:00Z");
const mk = (number: number, created_at: string, login = "alice", type = "User") => ({
  number, title: `pr${number}`, state: "closed", user: { login, type }, body: "", labels: [],
  head: { ref: `b${number}`, sha: "s" }, additions: 5, deletions: 1, created_at, merged_at: created_at });

const gh: GitHubReader = {
  listPulls: async () => [mk(3, "2025-10-20T00:00:00Z", "codex[bot]", "Bot"), mk(2, "2025-09-01T00:00:00Z"), mk(1, "2025-06-01T00:00:00Z")],
  getPull: async (_r, n) => ({ 3: mk(3, "2025-10-20T00:00:00Z", "codex[bot]", "Bot"), 2: mk(2, "2025-09-01T00:00:00Z") } as any)[n],
  listCommitMessages: async (_r, n) => n === 2 ? ["x\n\nCo-authored-by: Claude <c@a.com>"] : [],
  listReviews: async () => [{ id: 10, user: { login: "bob" }, state: "APPROVED", submitted_at: "2025-10-21T00:00:00Z" }],
  listReviewComments: async (_r, n) => n === 3 ? [{ id: 20 + n, user: { login: "bob" }, body: "fix", path: "a.ts", diff_hunk: "@@", created_at: "2025-10-21T00:00:00Z" }] : [],
};

beforeEach(async () => { await pool.query("TRUNCATE installations, reviews, review_comments, commits CASCADE"); await upsertInstallation(pool, 1, "acme"); await upsertRepo(pool, 1, 1, "acme/api"); });
afterAll(() => pool.end());

it("backfills only the last 90 days and detects agents via commit trailers", async () => {
  const n = await backfillRepo(gh, { id: 1, full_name: "acme/api" }, 90, now);
  expect(n).toBe(2);
  const rows = (await pool.query("SELECT number, is_agent, agent_name FROM pull_requests ORDER BY number")).rows;
  expect(rows).toEqual([{ number: 2, is_agent: true, agent_name: "claude-code" }, { number: 3, is_agent: true, agent_name: "codex" }]);
  expect((await pool.query("SELECT count(*)::int c FROM review_comments")).rows[0].c).toBe(1);
});
