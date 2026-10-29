import "dotenv/config";
import { aiFromEnv } from "../src/ai.js";
import { pool } from "../src/db/pool.js";
import { distillRepo } from "../src/distill.js";
const ai = aiFromEnv();
for (const r of (await pool.query("SELECT id, full_name FROM repos")).rows) {
  console.log(`${r.full_name}: ${await distillRepo(pool, ai, r.id)} new candidate rules`);
}
await pool.end();
