import "dotenv/config";
import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import { pool } from "../src/db/pool.js";
import { upsertInstallation, upsertRepo } from "../src/store.js";
import { backfillRepo } from "../src/backfill.js";
import { readerFor } from "../src/githubClient.js";

const installationId = Number(process.argv[2]);
const only = process.argv[3]; // optional "owner/repo"
if (!installationId) throw new Error("usage: npm run backfill -- <installationId> [owner/repo]");

const o = new Octokit({
  authStrategy: createAppAuth,
  auth: { appId: process.env.GITHUB_APP_ID!, privateKey: (process.env.GITHUB_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"), installationId },
});
const repos = (await o.paginate(o.apps.listReposAccessibleToInstallation, { per_page: 100 }))
  .filter((r) => !only || r.full_name === only);
await upsertInstallation(pool, installationId, repos[0]?.owner.login ?? "unknown");
const gh = readerFor(installationId);
for (const r of repos) {
  await upsertRepo(pool, r.id, installationId, r.full_name);
  const n = await backfillRepo(gh, { id: r.id, full_name: r.full_name });
  const s = (await pool.query(
    `SELECT count(*) FILTER (WHERE is_agent)::int agent, count(*)::int total,
            (SELECT count(*)::int FROM corrections WHERE repo_id=$1) corrections
       FROM pull_requests WHERE repo_id=$1`, [r.id])).rows[0];
  console.log(`${r.full_name}: processed ${n.processed}, skipped ${n.skipped}, failed ${n.failed}, ${s.agent}/${s.total} agent, ${s.corrections} corrections`);
}
await pool.end();
