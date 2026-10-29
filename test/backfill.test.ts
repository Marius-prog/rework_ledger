import { afterAll, beforeEach, describe, expect, it } from "vitest";
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

beforeEach(async () => { await pool.query("TRUNCATE installations, reviews, review_comments, commits, pr_commits, commit_files, corrections CASCADE"); await upsertInstallation(pool, 1, "acme"); await upsertRepo(pool, 1, 1, "acme/api"); });
afterAll(() => pool.end());

it("backfills only the last 90 days and detects agents via commit trailers", async () => {
  const n = await backfillRepo(gh, { id: 1, full_name: "acme/api" }, 90, now);
  expect(n).toEqual({ processed: 2, skipped: 0, failed: 0 });
  const rows = (await pool.query("SELECT number, is_agent, agent_name FROM pull_requests ORDER BY number")).rows;
  expect(rows).toEqual([{ number: 2, is_agent: true, agent_name: "claude-code" }, { number: 3, is_agent: true, agent_name: "codex" }]);
  expect((await pool.query("SELECT count(*)::int c FROM review_comments")).rows[0].c).toBe(1);
});

import { comments, commits, files, pr as fixturePr } from "./fixtures/agent-pr.js";
it("backfill extracts corrections end to end for an agent PR", async () => {
  const reader: GitHubReader = {
    listPulls: async () => [fixturePr], getPull: async () => fixturePr,
    listCommitMessages: async () => commits.map((c) => c.message),
    listReviews: async () => [], listReviewComments: async () => comments,
    listPrCommits: async () => commits, getCommitFiles: async (_r, sha) => files[sha] ?? [],
  };
  await backfillRepo(reader, { id: 1, full_name: "acme/api" }, 90, new Date("2025-10-30T00:00:00Z"));
  const rows = (await pool.query("SELECT comment_id, fix_sha FROM corrections")).rows;
  expect(rows).toEqual([{ comment_id: "101", fix_sha: "f2" }]);
});

describe("backfill robustness", () => {
  const prs = (n: number) => Array.from({ length: n }, (_, i) => mk(i + 1, "2025-10-20T00:00:00Z", "codex[bot]", "Bot"));
  const counting = (list: any[], over: Partial<GitHubReader> = {}) => {
    const calls = { getPull: 0, files: 0, inflight: 0, maxInflight: 0 };
    const reader: GitHubReader = {
      listPulls: async () => list,
      getPull: async (_r, n) => { calls.getPull++; calls.inflight++; calls.maxInflight = Math.max(calls.maxInflight, calls.inflight);
        await new Promise((r) => setTimeout(r, 15)); calls.inflight--; return list.find((p) => p.number === n); },
      listCommitMessages: async () => [], listReviews: async () => [], listReviewComments: async () => [],
      listPrCommits: async () => [{ sha: "c1", message: "m", date: "2025-10-21T00:00:00Z" }],
      getCommitFiles: async () => { calls.files++; return [{ filename: "a.ts", patch: "@@ -1 +1 @@\n-a\n+b" }]; },
      ...over,
    };
    return { reader, calls };
  };
  const repo = { id: 1, full_name: "acme/api" };

  it("respects the concurrency cap", async () => {
    const { reader, calls } = counting(prs(12));
    await backfillRepo(reader, repo, 90, now, { concurrency: 3 });
    expect(calls.maxInflight).toBe(3);
  });

  it("resumes: closed PRs done before are skipped, open ones are redone", async () => {
    const list = [...prs(3), { ...mk(4, "2025-10-20T00:00:00Z", "codex[bot]", "Bot"), state: "open" }];
    const first = counting(list);
    expect(await backfillRepo(first.reader, repo, 90, now)).toEqual({ processed: 4, skipped: 0, failed: 0 });
    await pool.query("UPDATE pull_requests SET state='open' WHERE number=4");
    const second = counting(list.map((p) => ({ ...p, state: p.number === 4 ? "open" : "closed" })));
    expect(await backfillRepo(second.reader, repo, 90, now)).toEqual({ processed: 1, skipped: 3, failed: 0 });
    expect(second.calls.getPull).toBe(1);
  });

  it("isolates failures and retries the failed PR on the next run", async () => {
    let fail = true;
    const { reader } = counting(prs(4), { listReviews: async (_r, n) => { if (n === 2 && fail) throw new Error("boom"); return []; } });
    const quiet = console.error; console.error = () => {};
    const first = await backfillRepo(reader, repo, 90, now);
    console.error = quiet;
    expect(first).toEqual({ processed: 3, skipped: 0, failed: 1 });
    fail = false;
    expect(await backfillRepo(reader, repo, 90, now)).toEqual({ processed: 1, skipped: 3, failed: 0 });
  });

  it("fetches commit diffs only for PRs with human comments, and only for commits after the first comment", async () => {
    const withComment = counting(prs(1), { listReviewComments: async () => [
      { id: 900, user: { login: "bob", type: "User" }, path: "a.ts", diff_hunk: "@@", body: "fix", created_at: "2025-10-20T12:00:00Z" }],
      listPrCommits: async () => [
        { sha: "early", message: "m", date: "2025-10-20T06:00:00Z" }, { sha: "late", message: "m", date: "2025-10-21T00:00:00Z" }] });
    await backfillRepo(withComment.reader, repo, 90, now);
    expect(withComment.calls.files).toBe(1);

    await pool.query("TRUNCATE installations, reviews, review_comments, commits, pr_commits, commit_files, corrections CASCADE");
    await upsertInstallation(pool, 1, "acme"); await upsertRepo(pool, 1, 1, "acme/api");
    const none = counting(prs(2));
    await backfillRepo(none.reader, repo, 90, now);
    expect(none.calls.files).toBe(0);
  });
});
