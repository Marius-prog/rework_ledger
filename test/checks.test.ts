import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { runCheck, type ChecksClient } from "../src/checks.js";
import { pool } from "../src/db/pool.js";
import { evaluatePolicies, DEFAULT_POLICY, isTestFile, matchesGlob } from "../src/policies.js";
import { handleEvent } from "../src/webhook.js";

describe("policies", () => {
  const input = { files: ["src/a.ts", "src/auth/login.ts"], additions: 100, deletions: 50, humanApprovals: [] as string[] };
  const cfg = { ...DEFAULT_POLICY, protectedPaths: ["src/auth/**"] };
  const by = (r: ReturnType<typeof evaluatePolicies>) => Object.fromEntries(r.map((x) => [x.policy, x.passed]));

  it("fails tests, protected paths without approval, passes size", () =>
    expect(by(evaluatePolicies(input, cfg))).toEqual({ tests_changed: false, protected_paths: false, max_diff_size: true }));
  it("passes when tests changed and a human approved", () =>
    expect(by(evaluatePolicies({ ...input, files: [...input.files, "test/a.test.ts"], humanApprovals: ["bob"] }, cfg)))
      .toEqual({ tests_changed: true, protected_paths: true, max_diff_size: true }));
  it("fails oversized diffs", () => expect(by(evaluatePolicies({ ...input, additions: 900 }, cfg)).max_diff_size).toBe(false));
  it("skips disabled policies and protected policy with no globs", () => {
    expect(evaluatePolicies(input, { ...DEFAULT_POLICY, testsEnabled: false, sizeEnabled: false })).toEqual([]);
  });
  it("detects test files", () => {
    for (const f of ["test/a.ts", "src/__tests__/a.ts", "a.test.ts", "b.spec.js", "tests/x.py", "pkg/a_test.go", "test_a.py"]) expect(isTestFile(f), f).toBe(true);
    for (const f of ["src/latest.ts", "contest/a.ts", "README.md"]) expect(isTestFile(f), f).toBe(false);
  });
  it("matches globs", () => {
    expect(matchesGlob("src/auth/a/b.ts", "src/auth/**")).toBe(true);
    expect(matchesGlob("migrations/001.sql", "migrations/")).toBe(true);
    expect(matchesGlob("deep/pnpm.lock", "*.lock")).toBe(true);
    expect(matchesGlob("src/x.ts", "src/*.ts")).toBe(true);
    expect(matchesGlob("src/a/x.ts", "src/*.ts")).toBe(false);
    expect(matchesGlob("src/authz/x.ts", "src/auth/**")).toBe(false);
  });
});

describe("runCheck", () => {
  const posted: any[] = [];
  const client = (files: string[]): ChecksClient => ({ listPrFiles: async () => files, createCheckRun: async (_r, p) => { posted.push(p); } });
  const repo = { id: 1, full_name: "acme/api" };
  beforeEach(async () => {
    posted.length = 0;
    await pool.query("TRUNCATE installations, reviews, repo_policies CASCADE");
    await pool.query("INSERT INTO installations (id, account_login) VALUES (1,'acme')");
    await pool.query("INSERT INTO repos (id, installation_id, full_name) VALUES (1,1,'acme/api')");
    for (const [n, agent, login] of [[1, true, "claude[bot]"], [2, false, "alice"]] as const) {
      await pool.query(`INSERT INTO pull_requests (repo_id, number, author_login, title, state, head_ref, head_sha, additions, deletions, is_agent, agent_name, created_at)
        VALUES (1,$1,$2,'t','open','b','sha${n}',10,5,$3,$4,now())`, [n, login, agent, agent ? "claude-code" : null]);
    }
    await pool.query("INSERT INTO repo_policies (repo_id, protected_paths) VALUES (1, '{src/auth/**}')");
  });
  afterAll(() => pool.end());

  it("posts a failing record for an agent PR without approval", async () => {
    await runCheck(pool, client(["src/auth/x.ts"]), repo, 1);
    expect(posted[0]).toMatchObject({ name: "Rework Ledger", headSha: "sha1", conclusion: "failure" });
    expect(posted[0].summary).toContain("FAIL `protected_paths`");
    expect(posted[0].summary).toContain("Human approval: none");
  });
  it("passes once a human approves, and ignores bot approvals and the author", async () => {
    await pool.query(`INSERT INTO reviews (id, repo_id, pr_number, reviewer_login, state, submitted_at) VALUES
      (1,1,1,'ci[bot]','approved','2025-10-01'),(2,1,1,'claude[bot]','approved','2025-10-01')`);
    await runCheck(pool, client(["src/auth/x.ts", "test/x.test.ts"]), repo, 1);
    expect(posted[0].conclusion).toBe("failure");
    await pool.query("INSERT INTO reviews (id, repo_id, pr_number, reviewer_login, state, submitted_at) VALUES (3,1,1,'bob','approved','2025-10-02')");
    await runCheck(pool, client(["src/auth/x.ts", "test/x.test.ts"]), repo, 1);
    expect(posted[1].conclusion).toBe("success");
    expect(posted[1].summary).toContain("Human approval: bob");
  });
  it("a later changes-requested review revokes approval", async () => {
    await pool.query(`INSERT INTO reviews (id, repo_id, pr_number, reviewer_login, state, submitted_at) VALUES
      (1,1,1,'bob','approved','2025-10-01'),(2,1,1,'bob','changes_requested','2025-10-02')`);
    await runCheck(pool, client(["src/auth/x.ts", "test/x.test.ts"]), repo, 1);
    expect(posted[0].conclusion).toBe("failure");
  });
  it("skips human PRs and unknown PRs", async () => {
    expect(await runCheck(pool, client([]), repo, 2)).toBeNull();
    expect(await runCheck(pool, client([]), repo, 99)).toBeNull();
    expect(posted).toHaveLength(0);
  });
  it("webhook triggers checks on open and review, not on edits", async () => {
    const calls: number[] = [];
    const hooks = { onCheck: async (_i: number, _r: any, n: number) => { calls.push(n); } };
    const repository = { id: 1, full_name: "acme/api", owner: { login: "acme" } };
    const pull_request = { number: 1, title: "t", state: "open", user: { login: "claude[bot]", type: "Bot" }, body: "", labels: [], head: { ref: "b", sha: "s" }, created_at: "2025-10-01T00:00:00Z" };
    await handleEvent("pull_request", { action: "opened", installation: { id: 1 }, repository, pull_request }, hooks);
    await handleEvent("pull_request", { action: "edited", installation: { id: 1 }, repository, pull_request }, hooks);
    await handleEvent("pull_request_review", { action: "submitted", installation: { id: 1 }, repository, pull_request: { number: 1 },
      review: { id: 9, user: { login: "bob" }, state: "APPROVED", submitted_at: "2025-10-02T00:00:00Z" } }, hooks);
    expect(calls).toEqual([1, 1]);
  });
  it("policy form saves config", async () => {
    const auth = { authorization: "Basic " + Buffer.from("admin:pw").toString("base64"), "content-type": "application/x-www-form-urlencoded" };
    await app.request("/app/repos/1/policy", { method: "POST", headers: auth, body: "size=on&max=300&paths=src%2Fpay%2F**%0Amigrations%2F" });
    expect((await pool.query("SELECT * FROM repo_policies WHERE repo_id=1")).rows[0]).toMatchObject(
      { tests_enabled: false, protected_enabled: false, size_enabled: true, max_diff_lines: 300, protected_paths: ["src/pay/**", "migrations/"] });
  });
});
