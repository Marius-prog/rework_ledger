export function landing(message = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rework Ledger</title>
<style>body{font:16px/1.5 system-ui;max-width:720px;margin:48px auto;padding:0 16px;color:#111}
h1{font-size:2rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:8px;text-align:left}
input,button{font:inherit;padding:8px}.msg{color:#0a6}</style></head><body>
<h1>Stop paying for the same agent PR fix every week</h1>
<p>Rework Ledger turns reviewer corrections on agent-written PRs into rules, eval cases and audit records.</p>
<ul><li>Captures corrections from review threads and fix commits</li>
<li>Distills them into rules and opens an AGENTS.md PR once you approve</li>
<li>Posts a policy check run on every agent PR</li>
<li>Tracks rework rate per agent and model</li></ul>
<table><tr><th>Plan</th><th>Price</th><th>Includes</th></tr>
<tr><td>Starter</td><td>$39/mo</td><td>2 repos, correction capture, weekly rework report</td></tr>
<tr><td>Team</td><td>$149/mo</td><td>15 repos, rule distillation, AGENTS.md PRs, policy checks, eval JSONL export</td></tr>
<tr><td>Business</td><td>$499/mo</td><td>Unlimited repos, audit export, per-model comparison, priority support</td></tr></table>
<p>14-day trial on all plans.</p>
<h2>Join the waitlist</h2>
<form method="post" action="/waitlist"><input type="email" name="email" placeholder="you@company.com" required> <button>Join</button></form>
<p class="msg">${message}</p></body></html>`;
}
