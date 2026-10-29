import type pg from "pg";
import { reworkByAgent, reworkByWeek } from "./stats.js";

const pct = (x: number) => `${Math.round(x * 100)}%`;
const bar = (x: number) => "█".repeat(Math.round(x * 20)).padEnd(20, "░");

/** Shareable markdown backfill report. Aggregates only: no PR titles, people, or code. */
export async function backfillReport(db: pg.Pool, repoId: number, days = 90, now = new Date()): Promise<string> {
  const since = new Date(now.getTime() - days * 86400_000);
  const repo = (await db.query("SELECT full_name FROM repos WHERE id=$1", [repoId])).rows[0];
  const tot = (await db.query(
    `SELECT count(*)::int prs, (count(*) FILTER (WHERE is_agent))::int agent,
       (count(*) FILTER (WHERE is_agent AND EXISTS (SELECT 1 FROM review_comments rc WHERE rc.repo_id=p.repo_id AND rc.pr_number=p.number
          AND rc.in_reply_to_id IS NULL AND rc.reviewer_login <> p.author_login AND rc.reviewer_login NOT LIKE '%[bot]' AND rc.reviewer_type IS DISTINCT FROM 'Bot')))::int human_reviewed,
       (SELECT count(*)::int FROM corrections WHERE repo_id=$1 AND created_at >= $2) corrections,
       (SELECT count(*)::int FROM rules ru WHERE repo_id=$1 AND status <> 'rejected' AND EXISTS (SELECT 1 FROM corrections c WHERE c.rule_id=ru.id)) rules,
       min(p.created_at) first_pr, max(p.created_at) last_pr
       FROM pull_requests p WHERE p.repo_id=$1 AND p.created_at >= $2`, [repoId, since])).rows[0];
  const agents = await reworkByAgent(db, since, null, repoId);
  const weeks = await reworkByWeek(db, repoId, since);
  const reworked = agents.reduce((a, x) => a + x.reworked, 0);

  return [
    `# Agent PR rework report: ${repo.full_name}`,
    tot.prs ? `Covers PRs created ${tot.first_pr.toISOString().slice(0, 10)} to ${tot.last_pr.toISOString().slice(0, 10)} (window requested: ${days} days). Generated ${now.toISOString().slice(0, 10)}.` : `No PRs in the last ${days} days.`, "",
    "## Summary",
    `- PRs scanned: ${tot.prs}, agent PRs: ${tot.agent} (${tot.prs ? pct(tot.agent / tot.prs) : "0%"})`,
    `- Agent PRs with a human review comment: ${tot.human_reviewed}`,
    `- Agent PRs that needed rework: ${reworked} (${tot.agent ? pct(reworked / tot.agent) : "0%"})`,
    `- Corrections captured (human comment paired with the commit that fixed it): ${tot.corrections}`,
    `- Candidate rules from repeated corrections: ${tot.rules}`, "",
    "## Rework rate by agent",
    "| Agent | PRs | Reworked | Rate |", "|---|---|---|---|",
    ...agents.map((a) => `| ${a.agent} | ${a.prs} | ${a.reworked} | ${pct(a.rate)} |`), "",
    "## Weekly rework rate",
    "```", ...weeks.map((w) => `${w.week}  ${bar(w.rate)} ${pct(w.rate).padStart(4)}  (${w.reworked}/${w.prs})`), "```", "",
    "## How to read this",
    "- Rework means at least one human review comment that was followed by a commit changing the same file, or a changes-requested review.",
    "- It is a lower bound. Fixes made in other files, squashed history, and feedback given in PR-level comments are not counted.",
    "- AI reviewers and dependency bots are excluded from both sides.",
  ].join("\n") + "\n";
}
