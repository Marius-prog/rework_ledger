import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { extractCorrections, syncPrCommits, type CommitReader } from "../src/extract.js";
import { pickHunk } from "../src/hunks.js";
import { redact } from "../src/redact.js";
import { storePullRequest, storeReviewComment, upsertInstallation, upsertRepo } from "../src/store.js";
import { comments, commits, files, pr, repo } from "./fixtures/agent-pr.js";

const reader: CommitReader = { listPrCommits: async () => commits, getCommitFiles: async (_r, sha) => files[sha] ?? [] };

beforeEach(async () => {
  await pool.query("TRUNCATE installations, reviews, review_comments, commits, pr_commits, commit_files, corrections CASCADE");
  await upsertInstallation(pool, 1, "acme"); await upsertRepo(pool, 1, 1, repo.full_name);
  await storePullRequest(pool, repo.id, pr, commits.map((c) => c.message));
  for (const c of comments) await storeReviewComment(pool, repo.id, pr.number, c);
  await syncPrCommits(reader, repo, pr.number);
});
afterAll(() => pool.end());

describe("extractCorrections", () => {
  it("pairs only the addressed reviewer thread with the fix hunk, redacted", async () => {
    expect(await extractCorrections(pool, repo.id, pr.number)).toBe(1);
    const c = (await pool.query("SELECT * FROM corrections")).rows[0];
    expect(c.comment_id).toBe("101");
    expect(c.fix_sha).toBe("f2");
    expect(c.agent_name).toBe("claude-code");
    expect(c.file).toBe("services/billing.ts");
    expect(c.comment).toContain("Use the billing client");
    expect(c.comment).toContain("Also add a test.");        // reviewer reply kept
    expect(c.comment).not.toContain("Will do.");            // agent reply dropped
    expect(c.comment).not.toContain("bob@acme.com");
    expect(c.before_hunk).not.toContain("sk_live_");
    expect(c.after_hunk).toContain("billing.charge");
    expect(c.after_hunk).not.toContain("sk_live_");
    expect(c.after_hunk.startsWith("@@ -10,8")).toBe(true); // picks the hunk covering line 11, not the import hunk
  });

  it("deletes raw commit patches once extraction has run", async () => {
    expect((await pool.query("SELECT count(*)::int c FROM commit_files")).rows[0].c).toBeGreaterThan(0);
    await extractCorrections(pool, repo.id, pr.number);
    expect((await pool.query("SELECT count(*)::int c FROM commit_files")).rows[0].c).toBe(0);
  });

  it("redacts secrets in raw review hunks and comments at ingest", async () => {
    await storeReviewComment(pool, repo.id, pr.number, { id: 777, user: { login: "bob", type: "User" }, path: "a.ts",
      diff_hunk: '@@\n+const k = "sk_live_abcdefghijklmnop1234";', body: "token: ghp_abcdefghijklmnopqrstuvwx", created_at: "2025-10-10T12:00:00Z" });
    const row = (await pool.query("SELECT diff_hunk, body FROM review_comments WHERE id=777")).rows[0];
    expect(row.diff_hunk).not.toContain("sk_live_");
    expect(row.body).not.toContain("ghp_");
  });

  it("re-extraction after patches were deleted re-fetches and does not duplicate", async () => {
    await extractCorrections(pool, repo.id, pr.number);
    await syncPrCommits(reader, repo, pr.number);
    expect(await extractCorrections(pool, repo.id, pr.number)).toBe(0);
    expect((await pool.query("SELECT count(*)::int c FROM corrections")).rows[0].c).toBe(1);
  });

  it("ignores AI reviewer comments", async () => {
    await pool.query("UPDATE review_comments SET reviewer_login='Copilot', reviewer_type='Bot' WHERE id=101");
    expect(await extractCorrections(pool, repo.id, pr.number)).toBe(0);
  });

  it("is idempotent", async () => {
    await extractCorrections(pool, repo.id, pr.number);
    expect(await extractCorrections(pool, repo.id, pr.number)).toBe(0);
    expect((await pool.query("SELECT count(*)::int c FROM corrections")).rows[0].c).toBe(1);
  });

  it("skips human PRs", async () => {
    await pool.query("UPDATE pull_requests SET is_agent=false");
    expect(await extractCorrections(pool, repo.id, pr.number)).toBe(0);
  });
});

describe("redact", () => {
  it.each([
    ["AKIAABCDEFGHIJKLMNOP", "AWS"], ["ghp_abcdefghijklmnopqrstuvwx", "GITHUB"],
    ["password = 'hunter2hunter2'", "REDACTED"], ["postgres://u:p@h/db", "REDACTED"],
    ["Authorization: Bearer abcdefghijklmnopqrstu", "REDACTED"],
  ])("%s", (input) => expect(redact(input)).toContain("[REDACTED"));
  it("leaves normal code alone", () => expect(redact("const total = a + b;")).toBe("const total = a + b;"));
  it("truncates long snippets", () => expect(redact("x".repeat(5000))).toMatch(/\[TRUNCATED\]$/));
});

describe("pickHunk", () => {
  const patch = "@@ -1,2 +1,3 @@\n a\n@@ -50,2 +51,2 @@\n b";
  it("chooses by old-side line", () => expect(pickHunk(patch, 51)?.oldStart).toBe(50));
  it("falls back to nearest", () => expect(pickHunk(patch, 3)?.oldStart).toBe(1));
  it("first hunk when line unknown", () => expect(pickHunk(patch, null)?.oldStart).toBe(1));
});
