import "dotenv/config";
import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { aiFromEnv } from "./ai.js";
import { pool } from "./db/pool.js";
import { resendMailer } from "./digest.js";
import { weeklyJob } from "./jobs.js";
const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
console.log(`listening on :${port}`);

const mailer = process.env.RESEND_API_KEY ? resendMailer(process.env.RESEND_API_KEY, process.env.DIGEST_FROM ?? "Rework Ledger <digest@example.com>") : undefined;
const ai = process.env.OPENAI_API_KEY ? aiFromEnv() : undefined;
setInterval(() => {
  weeklyJob(pool, { ai, mailer }).then((r) => r.ran && console.log("weekly job", r)).catch((e) => console.error("weekly job failed", e));
}, 10 * 60_000);
