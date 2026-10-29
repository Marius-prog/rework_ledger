import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { pool } from "./db/pool.js";
import { aiFromEnv, type Ai } from "./ai.js";
import { appUrl, sessionUser } from "./auth.js";
import { hasFeature, PLANS, stripeBilling, TRIAL_DAYS, type Billing, type Feature, type Plan } from "./billing.js";
import { distillRepo } from "./distill.js";
import { evalCasesJsonl } from "./evals.js";
import { openRulesPr, type RepoWriter } from "./rulesPr.js";
import { writerFor } from "./githubClient.js";
import { loadPolicy } from "./checks.js";
import { reworkByAgent, ruleHits, topRepeated } from "./stats.js";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export interface DashboardDeps { ai: () => Ai; writer: (installationId?: number) => RepoWriter; billing: () => Billing }
const defaults: DashboardDeps = {
  ai: aiFromEnv, writer: writerFor,
  billing: () => stripeBilling(process.env.STRIPE_SECRET_KEY ?? (() => { throw new Error("STRIPE_SECRET_KEY is not set"); })()),
};

/** ids = null means operator (sees every installation and bypasses plan gates). */
type Vars = { Variables: { ids: number[] | null; login: string } };

const page = (login: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Rework Ledger</title>
<style>body{font:15px/1.5 system-ui;max-width:880px;margin:32px auto;padding:0 16px}
.rule{border:1px solid #ddd;border-radius:6px;padding:10px 14px;margin:8px 0}.s-approved{border-color:#0a6}.s-rejected{opacity:.55}
form{display:inline}button{font:inherit;padding:4px 10px}small{color:#666}.bar{display:flex;justify-content:space-between}</style></head><body>
<div class="bar"><h1>Rework Ledger</h1><form method="post" action="/logout"><small>${esc(login)}</small> <button>Sign out</button></form></div>${body}</body></html>`;

function basicOk(header: string | undefined): boolean {
  const password = process.env.ADMIN_PASSWORD;
  if (!password || !header?.startsWith("Basic ")) return false;
  const given = Buffer.from(header.slice(6), "base64").toString();
  const want = `admin:${password}`;
  return given.length === want.length && timingSafeEqual(Buffer.from(given), Buffer.from(want));
}

export function dashboard(deps: DashboardDeps = defaults) {
  const d = new Hono<Vars>();

  d.use("*", async (c, next) => {
    if (basicOk(c.req.header("authorization"))) { c.set("ids", null); c.set("login", "operator"); return next(); }
    const user = await sessionUser(pool, getCookie(c, "rl_session"));
    if (!user) return c.req.method === "GET" ? c.redirect("/login") : c.text("sign in required", 401);
    c.set("ids", user.installationIds); c.set("login", user.login);
    return next();
  });

  const ownsInstallation = async (c: Context<Vars>, id: number) => {
    const ids = c.get("ids");
    return ids === null || ids.includes(id);
  };
  /** Returns the repo row if the caller may act on it. */
  const repoFor = async (c: Context<Vars>, repoId: number) => {
    const r = (await pool.query("SELECT r.id, r.full_name, r.installation_id, i.plan, i.subscription_status FROM repos r JOIN installations i ON i.id=r.installation_id WHERE r.id=$1", [repoId])).rows[0];
    return r && (await ownsInstallation(c, Number(r.installation_id))) ? r : null;
  };
  const gate = (c: Context<Vars>, row: { plan: string | null; subscription_status: string | null }, feature: Feature) =>
    c.get("ids") === null || hasFeature(row.plan, row.subscription_status, feature)
      ? null : c.text(`402: ${feature} needs the Team plan or higher with an active trial or subscription.`, 402);

  d.get("/", async (c) => {
    const ids = c.get("ids");
    const insts = (await pool.query(
      "SELECT * FROM installations WHERE $1::bigint[] IS NULL OR id = ANY($1) ORDER BY account_login", [ids])).rows;
    const repos = (await pool.query(
      `SELECT r.id, r.full_name, r.installation_id, i.plan, i.subscription_status,
         (SELECT count(*)::int FROM corrections WHERE repo_id=r.id) corrections
       FROM repos r JOIN installations i ON i.id=r.installation_id WHERE $1::bigint[] IS NULL OR r.installation_id = ANY($1) ORDER BY r.full_name`, [ids])).rows;
    const since = new Date(Date.now() - 30 * 86400_000);
    const [agents, top, hits] = await Promise.all([reworkByAgent(pool, since, ids), topRepeated(pool, since, ids), ruleHits(pool, since, ids)]);
    const table = (head: string[], rows: string[][]) => rows.length
      ? `<table border="1" cellpadding="4" style="border-collapse:collapse"><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr>${rows.map((r) => `<tr>${r.map((x) => `<td>${esc(x)}</td>`).join("")}</tr>`).join("")}</table>` : "<p><small>No data yet.</small></p>";
    let html = `<h2>Last 30 days</h2><h3>Rework rate per agent</h3>${table(["Agent", "PRs", "Reworked", "Rate"],
      agents.map((a) => [a.agent, String(a.prs), String(a.reworked), `${Math.round(a.rate * 100)}%`]))}
<h3>Top repeated corrections</h3>${table(["Rule", "Status", "Corrections"], top.map((t) => [t.title, t.status, String(t.n)]))}
<h3>Rule hits (repeated after approval)</h3>${table(["Rule", "Hits"], hits.map((h) => [h.title, String(h.hits)]))}`;

    for (const i of insts) {
      html += `<h2>${esc(i.account_login)}</h2><p><small>Plan: ${esc(i.plan ?? "none")}, status: ${esc(i.subscription_status ?? "none")}${i.trial_ends_at ? `, trial ends ${new Date(i.trial_ends_at).toISOString().slice(0, 10)}` : ""}</small></p>`;
      if (i.stripe_customer_id) html += `<form method="post" action="/app/installations/${i.id}/portal"><button>Manage billing</button></form> `;
      if (!i.stripe_subscription_id || ["canceled", "incomplete_expired"].includes(i.subscription_status)) {
        for (const [k, p] of Object.entries(PLANS)) html += `<form method="post" action="/app/installations/${i.id}/checkout"><input type="hidden" name="plan" value="${k}"><button>${TRIAL_DAYS}-day trial: ${p.name} $${p.price}/mo</button></form> `;
      }
      html += `<form method="post" action="/app/installations/${i.id}/digest-email"><small>Digest email:</small>
<input type="email" name="email" value="${esc(i.digest_email ?? "")}" placeholder="lead@company.com"> <button>Save</button></form>`;
    }
    for (const r of repos) {
      const pol = await loadPolicy(pool, r.id);
      const rules = (await pool.query(
        `SELECT ru.*, (SELECT count(*)::int FROM corrections WHERE rule_id=ru.id) n FROM rules ru WHERE repo_id=$1 ORDER BY
           CASE status WHEN 'candidate' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, id`, [r.id])).rows;
      const pending = rules.filter((x) => x.status === "approved" && !x.exported_pr_url).length;
      html += `<h2>${esc(r.full_name)} <small>${r.corrections} corrections</small></h2>
<form method="post" action="/app/repos/${r.id}/distill"><button>Run distillation</button></form>
<a href="/app/repos/${r.id}/evals.jsonl">Download eval cases (JSONL)</a>
<form method="post" action="/app/repos/${r.id}/policy"><br><small>Check run policies:</small>
<label><input type="checkbox" name="tests" ${pol.testsEnabled ? "checked" : ""}> tests changed</label>
<label><input type="checkbox" name="size" ${pol.sizeEnabled ? "checked" : ""}> max diff <input type="number" name="max" min="1" value="${pol.maxDiffLines}" style="width:6em"></label>
<label><input type="checkbox" name="protected" ${pol.protectedEnabled ? "checked" : ""}> protected paths need human approval</label>
<textarea name="paths" rows="2" cols="40" placeholder="one glob per line, e.g. src/auth/**">${esc(pol.protectedPaths.join("\n"))}</textarea> <button>Save</button></form>
${pending ? `<form method="post" action="/app/repos/${r.id}/export"><button>Open AGENTS.md PR (${pending} approved)</button></form>` : ""}`;
      for (const ru of rules) {
        html += `<div class="rule s-${ru.status}"><b>${esc(ru.title)}</b> <small>${ru.status}, ${ru.n} corrections</small><br>${esc(ru.body)}`;
        if (ru.exported_pr_url) html += `<br><small><a href="${esc(ru.exported_pr_url)}">PR</a></small>`;
        if (ru.status === "candidate") html += `<br><form method="post" action="/app/rules/${ru.id}/approve"><button>Approve</button></form> <form method="post" action="/app/rules/${ru.id}/reject"><button>Reject</button></form>`;
        html += `</div>`;
      }
    }
    return c.html(page(c.get("login"), html || "<p>No installations yet. Install the GitHub App on a repo to begin.</p>"));
  });

  d.post("/rules/:id/:action{approve|reject}", async (c) => {
    const rule = (await pool.query("SELECT repo_id FROM rules WHERE id=$1", [Number(c.req.param("id"))])).rows[0];
    const repo = rule && await repoFor(c, Number(rule.repo_id));
    if (!repo) return c.text("not found", 404);
    const status = c.req.param("action") === "approve" ? "approved" : "rejected";
    await pool.query("UPDATE rules SET status=$2, decided_at=now() WHERE id=$1 AND status='candidate'", [Number(c.req.param("id")), status]);
    return c.redirect("/app");
  });

  d.post("/repos/:id/distill", async (c) => {
    const repo = await repoFor(c, Number(c.req.param("id")));
    if (!repo) return c.text("not found", 404);
    const denied = gate(c, repo, "distill"); if (denied) return denied;
    await distillRepo(pool, deps.ai(), repo.id);
    return c.redirect("/app");
  });

  d.post("/repos/:id/export", async (c) => {
    const repo = await repoFor(c, Number(c.req.param("id")));
    if (!repo) return c.text("not found", 404);
    const denied = gate(c, repo, "agents_pr"); if (denied) return denied;
    await openRulesPr(pool, deps.writer(Number(repo.installation_id)), repo.id, repo.full_name);
    return c.redirect("/app");
  });

  d.get("/repos/:id/evals.jsonl", async (c) => {
    const repo = await repoFor(c, Number(c.req.param("id")));
    if (!repo) return c.text("not found", 404);
    const denied = gate(c, repo, "eval_export"); if (denied) return denied;
    return c.body(await evalCasesJsonl(pool, repo.id), 200, {
      "content-type": "application/x-ndjson", "content-disposition": `attachment; filename="${repo.full_name.replace("/", "_")}-evals.jsonl"` });
  });

  d.post("/repos/:id/policy", async (c) => {
    const repo = await repoFor(c, Number(c.req.param("id")));
    if (!repo) return c.text("not found", 404);
    const denied = gate(c, repo, "checks"); if (denied) return denied;
    const f = await c.req.parseBody();
    const max = Math.max(1, Math.floor(Number(f.max)) || 800);
    const paths = String(f.paths ?? "").split("\n").map((x) => x.trim()).filter(Boolean);
    await pool.query(
      `INSERT INTO repo_policies (repo_id, tests_enabled, protected_enabled, protected_paths, size_enabled, max_diff_lines)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (repo_id) DO UPDATE SET tests_enabled=$2, protected_enabled=$3, protected_paths=$4, size_enabled=$5, max_diff_lines=$6`,
      [repo.id, "tests" in f, "protected" in f, paths, "size" in f, max]);
    return c.redirect("/app");
  });

  d.post("/installations/:id/digest-email", async (c) => {
    const id = Number(c.req.param("id"));
    if (!(await ownsInstallation(c, id))) return c.text("not found", 404);
    const email = String((await c.req.parseBody()).email ?? "").trim();
    await pool.query("UPDATE installations SET digest_email=$2 WHERE id=$1", [id, email || null]);
    return c.redirect("/app");
  });

  d.post("/installations/:id/checkout", async (c) => {
    const id = Number(c.req.param("id"));
    if (!(await ownsInstallation(c, id))) return c.text("not found", 404);
    const plan = String((await c.req.parseBody()).plan);
    if (!(plan in PLANS)) return c.text("unknown plan", 400);
    const inst = (await pool.query("SELECT stripe_customer_id FROM installations WHERE id=$1", [id])).rows[0];
    if (!inst) return c.text("not found", 404);
    const url = await deps.billing().createCheckout({ installationId: id, plan: plan as Plan, customerId: inst.stripe_customer_id,
      successUrl: `${appUrl()}/app`, cancelUrl: `${appUrl()}/app` });
    return c.redirect(url, 303);
  });

  d.post("/installations/:id/portal", async (c) => {
    const id = Number(c.req.param("id"));
    if (!(await ownsInstallation(c, id))) return c.text("not found", 404);
    const inst = (await pool.query("SELECT stripe_customer_id FROM installations WHERE id=$1", [id])).rows[0];
    if (!inst?.stripe_customer_id) return c.text("no billing account yet", 400);
    return c.redirect(await deps.billing().createPortal({ customerId: inst.stripe_customer_id, returnUrl: `${appUrl()}/app` }), 303);
  });
  return d;
}
