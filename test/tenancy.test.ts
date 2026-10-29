import { Hono } from "hono";
import Stripe from "stripe";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { authRoutes, createSession, type GitHubOAuth } from "../src/auth.js";
import { hasFeature, type Billing } from "../src/billing.js";
import { dashboard } from "../src/dashboard.js";
import { pool } from "../src/db/pool.js";

const checkouts: any[] = [];
const billing: Billing = {
  createCheckout: async (p) => { checkouts.push(p); return "https://checkout.stripe.test/s1"; },
  createPortal: async () => "https://billing.stripe.test/p1",
};
const dash = new Hono().route("/app", dashboard({ ai: () => { throw new Error("no ai"); }, writer: () => { throw new Error("no writer"); }, billing: () => billing }));
const oauth: GitHubOAuth = {
  authorizeUrl: (state, redirect) => `https://github.test/authorize?state=${state}&redirect_uri=${redirect}`,
  exchangeCode: async (code) => (code === "good" ? "tok" : (() => { throw new Error("bad code"); })()),
  getUser: async () => ({ id: 777, login: "alice" }),
  listInstallations: async () => [1],
};
const auth = new Hono().route("/", authRoutes(oauth));

async function login(userId: number, installations: number[]) {
  await pool.query("DELETE FROM user_installations WHERE user_id=$1", [userId]);
  for (const i of installations) await pool.query("INSERT INTO user_installations VALUES ($1,$2)", [userId, i]);
  return { cookie: `rl_session=${await createSession(pool, userId)}` };
}

beforeEach(async () => {
  checkouts.length = 0;
  await pool.query("TRUNCATE installations, rules, corrections, reviews, users, repo_policies CASCADE");
  await pool.query(`INSERT INTO installations (id, account_login, plan, subscription_status, stripe_customer_id) VALUES
    (1,'acme','team','trialing','cus_1'), (2,'globex',NULL,NULL,NULL), (3,'initech','starter','active',NULL)`);
  await pool.query("INSERT INTO repos (id, installation_id, full_name) VALUES (10,1,'acme/api'),(20,2,'globex/web'),(30,3,'initech/app')");
  await pool.query("INSERT INTO users (id, github_id, login) VALUES (1,111,'bob'),(2,222,'carol')");
  await pool.query("SELECT setval('users_id_seq', 100)");
  await pool.query(`INSERT INTO pull_requests (repo_id, number, author_login, title, state, head_ref, head_sha, is_agent, agent_name, created_at)
    VALUES (10,1,'x','Add invoice retry','closed','b','s',true,'codex',now()), (20,1,'x','globex pr','closed','b','s',true,'codex',now())`);
  await pool.query("INSERT INTO rules (id, repo_id, title, body) VALUES (1,10,'Acme rule','b'),(2,20,'Globex secret rule','b')");
  await pool.query(`INSERT INTO corrections (repo_id, pr_number, comment_id, agent_name, file, comment, before_hunk, after_hunk, fix_sha, created_at, rule_id)
    VALUES (10,1,1,'codex','a.ts','use client','@@ bad','@@ good','f',now(),1), (20,1,2,'codex','g.ts','secret','@@ b','@@ a','f',now(),2)`);
});
afterAll(() => pool.end());

describe("plan features", () => {
  it("gates by plan and status", () => {
    expect(hasFeature("team", "trialing", "checks")).toBe(true);
    expect(hasFeature("business", "active", "eval_export")).toBe(true);
    expect(hasFeature("starter", "active", "checks")).toBe(false);
    expect(hasFeature("team", "canceled", "checks")).toBe(false);
    expect(hasFeature(null, null, "checks")).toBe(false);
  });
});

describe("GitHub OAuth", () => {
  it("rejects a callback without matching state", async () => {
    expect((await auth.request("/auth/callback?code=good&state=x")).status).toBe(400);
    expect((await auth.request("/auth/callback?code=good&state=x", { headers: { cookie: "rl_state=y" } })).status).toBe(400);
  });
  it("login redirect sets state, callback creates user, memberships and a session", async () => {
    const res = await auth.request("/login");
    const state = /rl_state=([a-f0-9]+)/.exec(res.headers.get("set-cookie")!)![1];
    expect(res.headers.get("location")).toContain(`state=${state}`);
    const cb = await auth.request(`/auth/callback?code=good&state=${state}`, { headers: { cookie: `rl_state=${state}` } });
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/app");
    const session = /rl_session=([a-f0-9]+)/.exec(cb.headers.get("set-cookie")!)![1];
    expect((await pool.query("SELECT login FROM users WHERE github_id=777")).rows[0].login).toBe("alice");
    expect((await pool.query("SELECT installation_id FROM user_installations ui JOIN users u ON u.id=ui.user_id WHERE u.github_id=777")).rows.map((r) => Number(r.installation_id))).toEqual([1]);
    const page = await dash.request("/app", { headers: { cookie: `rl_session=${session}` } });
    expect(page.status).toBe(200);
  });
  it("the real app returns 503 for sign-in when OAuth is not configured", async () => {
    expect((await app.request("/login")).status).toBe(503);
  });
});

describe("tenant isolation", () => {
  it("a user sees only their installations' data", async () => {
    const html = await (await dash.request("/app", { headers: await login(1, [1]) })).text();
    expect(html).toContain("acme/api");
    expect(html).toContain("Acme rule");
    expect(html).not.toContain("globex");
    expect(html).not.toContain("Globex secret rule");
  });
  it("a user cannot act on another tenant's rules, repos, evals, policies or billing", async () => {
    const h = await login(1, [1]);
    for (const [method, path] of [["POST", "/app/rules/2/approve"], ["POST", "/app/repos/20/distill"], ["GET", "/app/repos/20/evals.jsonl"],
      ["POST", "/app/repos/20/policy"], ["POST", "/app/repos/20/export"], ["POST", "/app/installations/2/checkout"], ["POST", "/app/installations/2/digest-email"]]) {
      expect((await dash.request(path, { method, headers: h, body: method === "POST" ? new URLSearchParams({ plan: "team" }) : undefined })).status, path).toBe(404);
    }
    expect((await pool.query("SELECT status FROM rules WHERE id=2")).rows[0].status).toBe("candidate");
    expect(checkouts).toHaveLength(0);
  });
  it("anonymous POSTs get 401 and a bad session gets nothing", async () => {
    expect((await dash.request("/app/rules/1/approve", { method: "POST" })).status).toBe(401);
    expect((await dash.request("/app", { headers: { cookie: "rl_session=nope" } })).status).toBe(302);
  });
});

describe("plan gating and eval export", () => {
  it("Team trial can export eval cases as JSONL with task, bad and corrected diff", async () => {
    const res = await dash.request("/app/repos/10/evals.jsonl", { headers: await login(1, [1]) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ repo: "acme/api", pr: 1, task: "Add invoice retry", bad_diff: "@@ bad", corrected_diff: "@@ good", review_comment: "use client", rule: "Acme rule" });
  });
  it("no plan or Starter gets 402 on Team features", async () => {
    expect((await dash.request("/app/repos/20/evals.jsonl", { headers: await login(2, [2]) })).status).toBe(402);
    const h = await login(2, [3]);
    expect((await dash.request("/app/repos/30/evals.jsonl", { headers: h })).status).toBe(402);
    expect((await dash.request("/app/repos/30/policy", { method: "POST", headers: h, body: new URLSearchParams({ max: "10" }) })).status).toBe(402);
    expect((await dash.request("/app/repos/30/distill", { method: "POST", headers: h })).status).toBe(402);
  });
  it("the operator bypasses plan gates", async () => {
    const op = { authorization: "Basic " + Buffer.from("admin:pw").toString("base64") };
    expect((await dash.request("/app/repos/20/evals.jsonl", { headers: op })).status).toBe(200);
  });
});

describe("billing", () => {
  it("checkout starts for the chosen plan and rejects unknown plans", async () => {
    const h = await login(1, [1]);
    const res = await dash.request("/app/installations/1/checkout", { method: "POST", headers: h, body: new URLSearchParams({ plan: "team" }) });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://checkout.stripe.test/s1");
    expect(checkouts[0]).toMatchObject({ installationId: 1, plan: "team", customerId: "cus_1" });
    expect((await dash.request("/app/installations/1/checkout", { method: "POST", headers: h, body: new URLSearchParams({ plan: "free" }) })).status).toBe(400);
    expect((await dash.request("/app/installations/1/portal", { method: "POST", headers: h })).headers.get("location")).toBe("https://billing.stripe.test/p1");
  });

  const stripe = new Stripe("sk_test_x");
  const send = (type: string, object: any, created = 1_800_000_000) => {
    const payload = JSON.stringify({ id: `evt_${Math.random()}`, object: "event", type, created, data: { object } });
    return app.request("/webhooks/stripe", { method: "POST", body: payload,
      headers: { "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_test" }) } });
  };
  const sub = (over: any = {}) => ({ id: "sub_1", object: "subscription", status: "trialing", customer: "cus_9", trial_end: 1_801_000_000,
    metadata: { installation_id: "2" }, items: { data: [{ price: { lookup_key: "rework_ledger_team" } }] }, ...over });

  it("rejects bad signatures", async () => {
    const res = await app.request("/webhooks/stripe", { method: "POST", body: "{}", headers: { "stripe-signature": "t=1,v1=bad" } });
    expect(res.status).toBe(400);
  });
  it("trial start, upgrade, and cancel update the installation; stale events are ignored", async () => {
    await send("checkout.session.completed", { client_reference_id: "2", customer: "cus_9", subscription: "sub_1", metadata: { plan: "team" } }, 1_800_000_000);
    expect((await pool.query("SELECT plan, subscription_status, stripe_customer_id FROM installations WHERE id=2")).rows[0])
      .toEqual({ plan: "team", subscription_status: "trialing", stripe_customer_id: "cus_9" });

    await send("customer.subscription.updated", sub({ status: "active", items: { data: [{ price: { lookup_key: "rework_ledger_business" } }] } }), 1_800_000_100);
    expect((await pool.query("SELECT plan, subscription_status FROM installations WHERE id=2")).rows[0]).toEqual({ plan: "business", subscription_status: "active" });

    await send("customer.subscription.updated", sub({ status: "trialing" }), 1_800_000_050); // older, ignored
    expect((await pool.query("SELECT subscription_status FROM installations WHERE id=2")).rows[0].subscription_status).toBe("active");

    await send("customer.subscription.deleted", sub(), 1_800_000_200);
    expect((await pool.query("SELECT subscription_status FROM installations WHERE id=2")).rows[0].subscription_status).toBe("canceled");
    const h = await login(2, [2]);
    expect((await dash.request("/app/repos/20/evals.jsonl", { headers: h })).status).toBe(402);
  });
  it("a paid Team subscription unlocks Team features end to end", async () => {
    await send("customer.subscription.created", sub({ status: "trialing" }));
    expect((await dash.request("/app/repos/20/evals.jsonl", { headers: await login(2, [2]) })).status).toBe(200);
  });
});
