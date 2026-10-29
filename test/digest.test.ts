import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { buildDigest, sendDigests } from "../src/digest.js";
import { claimWeekly, lastDue, weeklyJob } from "../src/jobs.js";
import { reworkByAgent, ruleHits } from "../src/stats.js";

const now = new Date("2025-10-27T09:00:00Z"); // a Monday
const day = (n: number) => new Date(now.getTime() - n * 86400_000).toISOString();

beforeEach(async () => {
  await pool.query("TRUNCATE installations, rules, corrections, reviews, job_runs CASCADE");
  await pool.query("INSERT INTO installations (id, account_login, digest_email, plan, subscription_status) VALUES (1,'acme','lead@acme.com','team','trialing')");
  await pool.query("INSERT INTO repos (id, installation_id, full_name) VALUES (1,1,'acme/api')");
  const pr = (n: number, agent: string | null, age: number) => pool.query(
    `INSERT INTO pull_requests (repo_id, number, author_login, title, state, head_ref, head_sha, is_agent, agent_name, created_at)
     VALUES (1,$1,'x','t','closed','b','s',$2,$3,$4)`, [n, agent !== null, agent, day(age)]);
  await pr(1, "claude-code", 1); await pr(2, "claude-code", 2); await pr(3, "codex", 3); await pr(4, "codex", 20); await pr(5, null, 1);
  await pool.query("INSERT INTO reviews (id, repo_id, pr_number, reviewer_login, state) VALUES (1,1,2,'bob','changes_requested')");
  await pool.query(`INSERT INTO rules (id, repo_id, title, body, status, decided_at) VALUES (1,1,'Use billing client','b','approved',$1)`, [day(2)]);
  const cor = (id: number, pr: number, age: number, rule: number | null, emb: number[]) => pool.query(
    `INSERT INTO corrections (repo_id, pr_number, comment_id, file, comment, before_hunk, after_hunk, fix_sha, created_at, rule_id, embedding)
     VALUES (1,$1,$2,'f','c','b','a','s',$3,$4,$5::real[])`, [pr, id, day(age), rule, emb]);
  await cor(1, 1, 6, 1, [1, 0]); await cor(2, 1, 6, 1, [0.9, 0.1]);   // source corrections for the rule (before approval)
  await cor(3, 3, 1, null, [0.95, 0.05]);                              // repeated after approval: a hit
  await cor(4, 3, 1, null, [0, 1]);                                     // unrelated
});
afterAll(() => pool.end());

describe("stats", () => {
  it("rework rate per agent counts corrections or changes-requested, only agent PRs in window", async () => {
    expect(await reworkByAgent(pool, new Date(now.getTime() - 7 * 86400_000), [1])).toEqual([
      { agent: "claude-code", prs: 2, reworked: 2, rate: 1 }, { agent: "codex", prs: 1, reworked: 1, rate: 1 }]);
    expect((await reworkByAgent(pool, new Date(now.getTime() - 30 * 86400_000), [1])).find((a) => a.agent === "codex")).toMatchObject({ prs: 2, reworked: 1, rate: 0.5 });
  });
  it("rule hits count only similar corrections made after approval", async () => {
    expect(await ruleHits(pool, new Date(now.getTime() - 7 * 86400_000), [1])).toEqual([{ title: "Use billing client", hits: 1 }]);
  });
});

describe("digest", () => {
  it("builds text with all three sections", async () => {
    const d = (await buildDigest(pool, 1, now))!;
    expect(d.text).toContain("claude-code: 100% (2 of 2 PRs)");
    expect(d.text).toContain("Use billing client: 2 corrections");
    expect(d.text).toContain("Use billing client: 1");
    expect(d.html).toContain("<li>");
  });
  it("returns null when there is nothing to report", async () => {
    await pool.query("INSERT INTO installations (id, account_login) VALUES (2,'empty')");
    expect(await buildDigest(pool, 2, now)).toBeNull();
  });
  it("sends only to installations with an email", async () => {
    await pool.query("INSERT INTO installations (id, account_login, plan, subscription_status) VALUES (3,'noemail','team','active')");
    const sent: any[] = [];
    expect(await sendDigests(pool, { send: async (m) => { sent.push(m); } }, now)).toBe(1);
    expect(sent[0].to).toBe("lead@acme.com");
  });
});

describe("weekly job", () => {
  it("computes the last Monday 08:00 UTC", () => {
    expect(lastDue(new Date("2025-10-27T09:00:00Z")).toISOString()).toBe("2025-10-27T08:00:00.000Z");
    expect(lastDue(new Date("2025-10-27T07:59:00Z")).toISOString()).toBe("2025-10-20T08:00:00.000Z");
    expect(lastDue(new Date("2025-10-30T12:00:00Z")).toISOString()).toBe("2025-10-27T08:00:00.000Z");
    expect(lastDue(new Date("2025-11-02T23:00:00Z")).toISOString()).toBe("2025-10-27T08:00:00.000Z");
  });
  it("first boot never fires, the next Monday fires once", async () => {
    expect(await claimWeekly(pool, "w", new Date("2025-10-29T12:00:00Z"))).toBe(false);
    expect(await claimWeekly(pool, "w", new Date("2025-11-03T08:05:00Z"))).toBe(true);
    expect(await claimWeekly(pool, "w", new Date("2025-11-03T08:15:00Z"))).toBe(false);
    expect(await claimWeekly(pool, "w", new Date("2025-11-05T08:15:00Z"))).toBe(false);
  });
  it("runs distillation and digest when due", async () => {
    await claimWeekly(pool, "weekly", new Date("2025-10-22T12:00:00Z"));
    const sent: any[] = [];
    const r = await weeklyJob(pool, { mailer: { send: async (m) => { sent.push(m); } } }, new Date("2025-10-27T08:05:00Z"));
    expect(r).toMatchObject({ ran: true, digests: 1 });
    expect((await weeklyJob(pool, { mailer: { send: async () => {} } }, new Date("2025-10-27T08:20:00Z"))).ran).toBe(false);
  });
});
