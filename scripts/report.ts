import "dotenv/config";
import { pool } from "../src/db/pool.js";
import { backfillReport } from "../src/report.js";
const [full, days = "90"] = process.argv.slice(2);
if (!full) throw new Error("usage: npm run report -- owner/repo [days]");
const repo = (await pool.query("SELECT id FROM repos WHERE full_name=$1", [full])).rows[0];
if (!repo) throw new Error(`${full} not found. Run backfill first.`);
console.log(await backfillReport(pool, repo.id, Number(days)));
await pool.end();
