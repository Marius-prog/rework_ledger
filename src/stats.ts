import type pg from "pg";
import { cosine } from "./cluster.js";

export interface AgentRework { agent: string; prs: number; reworked: number; rate: number }

/** An agent PR counts as reworked if it has at least one extracted correction or a changes-requested review. */
export async function reworkByAgent(db: pg.Pool, since: Date, installationIds: number[] | null = null): Promise<AgentRework[]> {
  const rows = (await db.query(
    `SELECT coalesce(p.agent_name,'unknown') agent, count(*)::int prs,
       (count(*) FILTER (WHERE EXISTS (SELECT 1 FROM corrections c WHERE c.repo_id=p.repo_id AND c.pr_number=p.number)
                            OR EXISTS (SELECT 1 FROM reviews v WHERE v.repo_id=p.repo_id AND v.pr_number=p.number AND v.state='changes_requested')))::int reworked
       FROM pull_requests p JOIN repos rp ON rp.id=p.repo_id
      WHERE p.is_agent AND p.created_at >= $1 AND ($2::bigint[] IS NULL OR rp.installation_id = ANY($2))
      GROUP BY 1 ORDER BY prs DESC, agent`, [since, installationIds])).rows;
  return rows.map((r) => ({ ...r, rate: r.prs ? r.reworked / r.prs : 0 }));
}

export async function topRepeated(db: pg.Pool, since: Date, installationIds: number[] | null = null, limit = 5) {
  return (await db.query(
    `SELECT ru.title, ru.status, count(*)::int n FROM rules ru
       JOIN corrections c ON c.rule_id=ru.id JOIN repos rp ON rp.id=ru.repo_id
      WHERE ru.status <> 'rejected' AND c.created_at >= $1 AND ($2::bigint[] IS NULL OR rp.installation_id = ANY($2))
      GROUP BY ru.id ORDER BY n DESC, ru.id LIMIT $3`, [since, installationIds, limit])).rows as { title: string; status: string; n: number }[];
}

/**
 * Hit = a correction made after the rule was approved that looks like the rule's source corrections
 * (the agent repeated the mistake despite the rule). Needs embeddings, which distillation creates.
 */
export async function ruleHits(db: pg.Pool, since: Date, installationIds: number[] | null = null, threshold = 0.8) {
  const rules = (await db.query(
    `SELECT ru.id, ru.repo_id, ru.title, ru.decided_at FROM rules ru JOIN repos rp ON rp.id=ru.repo_id
      WHERE ru.status='approved' AND ($1::bigint[] IS NULL OR rp.installation_id = ANY($1)) ORDER BY ru.id`, [installationIds])).rows;
  const out: { title: string; hits: number }[] = [];
  for (const r of rules) {
    const src = (await db.query("SELECT embedding FROM corrections WHERE rule_id=$1 AND embedding IS NOT NULL", [r.id])).rows.map((x) => x.embedding as number[]);
    if (!src.length) { out.push({ title: r.title, hits: 0 }); continue; }
    const centroid = src[0].map((_, d) => src.reduce((s, v) => s + v[d], 0) / src.length);
    const later = (await db.query(
      `SELECT embedding FROM corrections WHERE repo_id=$1 AND created_at > $2 AND created_at >= $3
         AND rule_id IS DISTINCT FROM $4 AND embedding IS NOT NULL`, [r.repo_id, r.decided_at, since, r.id])).rows;
    out.push({ title: r.title, hits: later.filter((x) => cosine(x.embedding, centroid) >= threshold).length });
  }
  return out.sort((a, b) => b.hits - a.hits);
}
