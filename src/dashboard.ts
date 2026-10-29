import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { pool } from "./db/pool.js";
import { aiFromEnv, type Ai } from "./ai.js";
import { distillRepo } from "./distill.js";
import { openRulesPr, type RepoWriter } from "./rulesPr.js";
import { writerFor } from "./githubClient.js";
import { loadPolicy } from "./checks.js";
import { reworkByAgent, ruleHits, topRepeated } from "./stats.js";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export interface DashboardDeps { ai: () => Ai; writer: (installationId?: number) => RepoWriter }
const defaults: DashboardDeps = { ai: aiFromEnv, writer: writerFor };

const page = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Rework Ledger</title>
<style>body{font:15px/1.5 system-ui;max-width:880px;margin:32px auto;padding:0 16px}
.rule{border:1px solid #ddd;border-radius:6px;padding:10px 14px;margin:8px 0}.s-approved{border-color:#0a6}.s-rejected{opacity:.55}
form{display:inline}button{font:inherit;padding:4px 10px}small{color:#666}</style></head><body>
<h1>Rework Ledger</h1>${body}</body></html>`;

export function dashboard(deps: DashboardDeps = defaults) {
  const d = new Hono();
  d.use("*", async (c, next) => {
    const password = process.env.ADMIN_PASSWORD;
    if (!password) return c.text("ADMIN_PASSWORD is not set", 503);
    return basicAuth({ username: "admin", password })(c, next);
  });

  d.get("/", async (c) => {
    const repos = (await pool.query(
      `SELECT r.id, r.full_name, r.installation_id,
         (SELECT count(*)::int FROM corrections WHERE repo_id=r.id) corrections
       FROM repos r ORDER BY r.full_name`)).rows;
    const since = new Date(Date.now() - 30 * 86400_000);
    const [agents, top, hits] = await Promise.all([reworkByAgent(pool, since), topRepeated(pool, since), ruleHits(pool, since)]);
    const table = (head: string[], rows: string[][]) => rows.length
      ? `<table border="1" cellpadding="4" style="border-collapse:collapse"><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</table>` : "<p><small>No data yet.</small></p>";
    let html = `<h2>Last 30 days</h2><h3>Rework rate per agent</h3>${table(["Agent", "PRs", "Reworked", "Rate"],
      agents.map((a) => [a.agent, String(a.prs), String(a.reworked), `${Math.round(a.rate * 100)}%`]))}
<h3>Top repeated corrections</h3>${table(["Rule", "Status", "Corrections"], top.map((t) => [t.title, t.status, String(t.n)]))}
<h3>Rule hits (repeated after approval)</h3>${table(["Rule", "Hits"], hits.map((h) => [h.title, String(h.hits)]))}`;
    for (const i of (await pool.query("SELECT id, account_login, digest_email FROM installations ORDER BY account_login")).rows) {
      html += `<form method="post" action="/app/installations/${i.id}/digest-email"><small>${esc(i.account_login)} digest email:</small>
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
<form method="post" action="/app/repos/${r.id}/policy"><small>Check run policies:</small>
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
    return c.html(page(html || "<p>No repos yet.</p>"));
  });

  d.post("/rules/:id/:action{approve|reject}", async (c) => {
    const status = c.req.param("action") === "approve" ? "approved" : "rejected";
    await pool.query("UPDATE rules SET status=$2, decided_at=now() WHERE id=$1 AND status='candidate'", [Number(c.req.param("id")), status]);
    return c.redirect("/app");
  });

  d.post("/repos/:id/policy", async (c) => {
    const f = await c.req.parseBody();
    const max = Math.max(1, Math.floor(Number(f.max)) || 800);
    const paths = String(f.paths ?? "").split("\n").map((x) => x.trim()).filter(Boolean);
    await pool.query(
      `INSERT INTO repo_policies (repo_id, tests_enabled, protected_enabled, protected_paths, size_enabled, max_diff_lines)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (repo_id) DO UPDATE SET tests_enabled=$2, protected_enabled=$3, protected_paths=$4, size_enabled=$5, max_diff_lines=$6`,
      [Number(c.req.param("id")), "tests" in f, "protected" in f, paths, "size" in f, max]);
    return c.redirect("/app");
  });

  d.post("/installations/:id/digest-email", async (c) => {
    const email = String((await c.req.parseBody()).email ?? "").trim();
    await pool.query("UPDATE installations SET digest_email=$2 WHERE id=$1", [Number(c.req.param("id")), email || null]);
    return c.redirect("/app");
  });

  d.post("/repos/:id/distill", async (c) => {
    await distillRepo(pool, deps.ai(), Number(c.req.param("id")));
    return c.redirect("/app");
  });

  d.post("/repos/:id/export", async (c) => {
    const repo = (await pool.query("SELECT id, full_name, installation_id FROM repos WHERE id=$1", [Number(c.req.param("id"))])).rows[0];
    if (!repo) return c.text("not found", 404);
    await openRulesPr(pool, deps.writer(Number(repo.installation_id)), repo.id, repo.full_name);
    return c.redirect("/app");
  });
  return d;
}
