import type pg from "pg";
import type { Ai } from "./ai.js";
import { distillRepo } from "./distill.js";
import { sendDigests, type Mailer } from "./digest.js";

/** Most recent Monday 08:00 UTC at or before `now`. */
export function lastDue(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 8));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d > now ? new Date(d.getTime() - 7 * 86400_000) : d;
}

/** Atomic across instances. The first ever call records the current week as done, so a fresh deploy never sends mid-week. */
export async function claimWeekly(db: pg.Pool, name: string, now: Date): Promise<boolean> {
  const due = lastDue(now);
  await db.query("INSERT INTO job_runs (name, last_run) VALUES ($1,$2) ON CONFLICT DO NOTHING", [name, due]);
  return ((await db.query("UPDATE job_runs SET last_run=$2 WHERE name=$1 AND last_run < $3", [name, now, due])).rowCount ?? 0) === 1;
}

export async function weeklyJob(db: pg.Pool, deps: { ai?: Ai; mailer?: Mailer }, now = new Date()) {
  if (!(await claimWeekly(db, "weekly", now))) return { ran: false, rules: 0, digests: 0 };
  let rules = 0;
  if (deps.ai) for (const r of (await db.query("SELECT id FROM repos")).rows) rules += await distillRepo(db, deps.ai, r.id);
  const digests = deps.mailer ? await sendDigests(db, deps.mailer, now) : 0;
  return { ran: true, rules, digests };
}
