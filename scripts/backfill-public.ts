// Read-only backfill of a public repo using GITHUB_TOKEN, no GitHub App needed. For tuning on real data.
import "dotenv/config";
import { pool } from "../src/db/pool.js";
import { backfillRepo } from "../src/backfill.js";
import { octokitFor, readerFor } from "../src/githubClient.js";
import { upsertInstallation, upsertRepo } from "../src/store.js";

const [full, days = "14", max = "100"] = process.argv.slice(2);
if (!full || !process.env.GITHUB_TOKEN) throw new Error("usage: GITHUB_TOKEN=... npm run backfill:public -- owner/repo [days] [maxPrs]");
const SANDBOX = -1; // local-only installation, never a real GitHub installation id
const [owner, repo] = full.split("/");
const { data } = await octokitFor().repos.get({ owner, repo });
await upsertInstallation(pool, SANDBOX, "sandbox");
await upsertRepo(pool, data.id, SANDBOX, data.full_name);
const n = await backfillRepo(readerFor(SANDBOX), { id: data.id, full_name: data.full_name }, Number(days), new Date(), Number(max));
const s = (await pool.query(
  `SELECT count(*)::int total, count(*) FILTER (WHERE is_agent)::int agent,
     (SELECT count(*)::int FROM review_comments WHERE repo_id=$1) comments,
     (SELECT count(*)::int FROM corrections WHERE repo_id=$1) corrections FROM pull_requests WHERE repo_id=$1`, [data.id])).rows[0];
console.log(`${data.full_name}: scanned ${n} PRs, ${s.agent}/${s.total} agent, ${s.comments} review comments, ${s.corrections} corrections`);
await pool.end();
