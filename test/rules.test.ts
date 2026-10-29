import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ai } from "../src/ai.js";
import { renderAgentsMd, START } from "../src/agentsMd.js";
import { app } from "../src/app.js";
import { cluster } from "../src/cluster.js";
import { pool } from "../src/db/pool.js";
import { distillRepo, parseRule, proseWords } from "../src/distill.js";
import { openRulesPr, type RepoWriter } from "../src/rulesPr.js";

// Hashed bag-of-words embedding: similar wording gives similar vectors.
const embed = (t: string) => { const v = new Array(64).fill(0); for (const w of t.toLowerCase().match(/[a-z]+/g) ?? []) { let h = 0; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) % 64; v[h]++; } return v; };
let llmCalls: string[] = [];
const ai: Ai = {
  embedder: { embed: async (ts) => ts.map(embed) },
  llm: { complete: async (_s, u) => { llmCalls.push(u); return 'Sure:\n{"title":"Use billing client","rule":"Never call Stripe directly in services/. Use the billing client."}'; } },
};
const auth = { authorization: "Basic " + Buffer.from("admin:pw").toString("base64") };

async function seed() {
  await pool.query("TRUNCATE installations, rules, corrections CASCADE");
  await pool.query("INSERT INTO installations (id, account_login) VALUES (1,'acme')");
  await pool.query("INSERT INTO repos (id, installation_id, full_name) VALUES (1,1,'acme/api')");
  const rows = [
    ["services/billing.ts", "Never call raw Stripe in services. Use the billing client."],
    ["services/invoice.ts", "Do not call Stripe directly in services, use the billing client."],
    ["services/refund.ts", "Raw Stripe calls are banned in services. Use the billing client instead."],
    ["web/page.tsx", "Add a loading skeleton while the data fetch is pending."],
  ];
  for (const [i, [file, comment]] of rows.entries()) {
    await pool.query(`INSERT INTO corrections (repo_id, pr_number, comment_id, file, comment, before_hunk, after_hunk, fix_sha, created_at)
      VALUES (1, $4, $1, $2, $3, '@@ b', '@@ a', 'f', now())`, [i + 1, file, comment, i + 1]);
  }
}
beforeEach(async () => { llmCalls = []; await seed(); });
afterAll(() => pool.end());

describe("cluster", () => {
  it("groups similar vectors, leaves outliers alone", () => {
    expect(cluster([[1, 0], [0.99, 0.1], [0, 1]], 0.9)).toEqual([[0, 1], [2]]);
  });
});

describe("distillRepo", () => {
  it("creates one rule from the repeated correction, ignores the singleton, and is not repeated", async () => {
    expect(await distillRepo(pool, ai, 1)).toBe(1);
    const rule = (await pool.query("SELECT * FROM rules")).rows[0];
    expect(rule.status).toBe("candidate");
    expect((await pool.query("SELECT count(*)::int c FROM corrections WHERE rule_id=$1", [rule.id])).rows[0].c).toBe(3);
    expect(llmCalls).toHaveLength(1);
    expect(await distillRepo(pool, ai, 1)).toBe(0);
    expect(llmCalls).toHaveLength(1);
  });
  it("does not make a rule from similar comments on a single PR", async () => {
    await pool.query("UPDATE corrections SET pr_number=1");
    expect(await distillRepo(pool, ai, 1)).toBe(0);
    expect(llmCalls).toHaveLength(0);
  });
  it("ignores comments without reviewer prose", async () => {
    await pool.query("UPDATE corrections SET comment='```suggestion\nuse billingClient\n```' WHERE id IN (SELECT id FROM corrections ORDER BY id LIMIT 2)");
    expect(await distillRepo(pool, ai, 1)).toBe(0);
  });
  it("proseWords ignores code and suggestion blocks", () => {
    expect(proseWords("```suggestion\n else\n```")).toBe(0);
    expect(proseWords("Revert")).toBe(1);
    expect(proseWords("Use the billing client ```ts\nfoo()\n```")).toBe(4);
  });
  it("skips clusters the model declines", async () => {
    const declining: Ai = { ...ai, llm: { complete: async () => '{"title":null,"rule":null}' } };
    expect(await distillRepo(pool, declining, 1)).toBe(0);
  });
  it("parseRule rejects junk", () => { expect(parseRule("no json")).toBeNull(); expect(parseRule('{"title":"","rule":"x"}')).toBeNull(); });
});

describe("renderAgentsMd", () => {
  const rules = [{ title: "A", body: "Do a." }];
  it("creates a file", () => expect(renderAgentsMd(null, rules)).toContain("- **A.** Do a."));
  it("appends to an existing file and keeps its content", () => {
    const out = renderAgentsMd("# Mine\n\nKeep me.\n", rules);
    expect(out.startsWith("# Mine\n\nKeep me.")).toBe(true);
    expect(out).toContain(START);
  });
  it("replaces only the managed block on re-run", () => {
    const once = renderAgentsMd("# Mine\n", rules);
    const twice = renderAgentsMd(once, [...rules, { title: "B", body: "Do b." }]);
    expect(twice.match(new RegExp(START, "g"))).toHaveLength(1);
    expect(twice).toContain("Do b.");
    expect(twice.startsWith("# Mine")).toBe(true);
  });
});

describe("dashboard + PR", () => {
  const calls: any[] = [];
  const writer: RepoWriter = {
    defaultBranch: async () => ({ name: "main", sha: "base" }),
    getFile: async () => "# Existing\n",
    createBranch: async (...a) => { calls.push(["branch", ...a]); },
    putFile: async (_r, path, branch, content) => { calls.push(["put", path, branch, content]); },
    openPr: async (...a) => { calls.push(["pr", ...a]); return "https://github.com/acme/api/pull/9"; },
  };
  beforeEach(() => { calls.length = 0; });

  it("requires auth", async () => {
    const anon = await app.request("/app");
    expect(anon.status).toBe(302);
    expect(anon.headers.get("location")).toBe("/login");
    expect((await app.request("/app", { headers: auth })).status).toBe(200);
  });

  it("approve then PR: only approved rules, PR recorded once", async () => {
    await distillRepo(pool, ai, 1);
    await pool.query("INSERT INTO rules (repo_id, title, body) VALUES (1,'Rejected one','nope')");
    const id = (await pool.query("SELECT id FROM rules WHERE title='Use billing client'")).rows[0].id;
    const rej = (await pool.query("SELECT id FROM rules WHERE title='Rejected one'")).rows[0].id;
    await app.request(`/app/rules/${id}/approve`, { method: "POST", headers: auth });
    await app.request(`/app/rules/${rej}/reject`, { method: "POST", headers: auth });
    expect(await (await app.request("/app", { headers: auth })).text()).toContain("Open AGENTS.md PR (1 approved)");

    const url = await openRulesPr(pool, writer, 1, "acme/api", new Date("2025-10-30T10:00:00Z"));
    expect(url).toBe("https://github.com/acme/api/pull/9");
    const put = calls.find((c) => c[0] === "put")!;
    expect(put[1]).toBe("AGENTS.md");
    expect(put[2]).toBe("rework-ledger/rules-20251030100000");
    expect(put[3]).toContain("# Existing");
    expect(put[3]).toContain("Use billing client");
    expect(put[3]).not.toContain("Rejected one");
    expect(await openRulesPr(pool, writer, 1, "acme/api")).toBeNull();
  });

  it("escapes rule text in HTML", async () => {
    await pool.query("INSERT INTO rules (repo_id, title, body) VALUES (1,'<script>x</script>','b')");
    const html = await (await app.request("/app", { headers: auth })).text();
    expect(html).not.toContain("<script>x");
    expect(html).toContain("&lt;script&gt;");
  });
});
