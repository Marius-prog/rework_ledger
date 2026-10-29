import type pg from "pg";
import type { Ai } from "./ai.js";
import { cluster } from "./cluster.js";

const SYSTEM = `You write coding rules for AI coding agents from repeated human review corrections.
Given several corrections that share a theme, reply with ONLY JSON: {"title": string, "rule": string}.
"title" is at most 8 words. "rule" is one or two imperative sentences naming the concrete API, path or pattern.
If the corrections do not share one clear, specific rule, reply {"title": null, "rule": null}.`;

export function parseRule(text: string): { title: string; rule: string } | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (typeof j.title === "string" && typeof j.rule === "string" && j.title.trim() && j.rule.trim()) {
      return { title: j.title.trim(), rule: j.rule.trim() };
    }
  } catch { /* fall through */ }
  return null;
}

export interface DistillOptions { threshold?: number; minCluster?: number; maxExamples?: number }

/** Embed new corrections, cluster unassigned ones, and create candidate rules. Returns rules created. */
export async function distillRepo(db: pg.Pool, ai: Ai, repoId: number, opts: DistillOptions = {}): Promise<number> {
  const { threshold = 0.8, minCluster = 2, maxExamples = 8 } = opts;
  const text = (r: any) => `${r.file}\n${r.comment}`;

  const fresh = (await db.query("SELECT id, file, comment FROM corrections WHERE repo_id=$1 AND embedding IS NULL ORDER BY id", [repoId])).rows;
  for (let i = 0; i < fresh.length; i += 50) {
    const batch = fresh.slice(i, i + 50);
    const vecs = await ai.embedder.embed(batch.map(text));
    for (let j = 0; j < batch.length; j++) await db.query("UPDATE corrections SET embedding=$2::real[] WHERE id=$1", [batch[j].id, vecs[j]]);
  }

  const rows = (await db.query(
    "SELECT id, file, comment, before_hunk, after_hunk, embedding FROM corrections WHERE repo_id=$1 AND rule_id IS NULL ORDER BY id", [repoId])).rows;
  let created = 0;
  for (const members of cluster(rows.map((r) => r.embedding), threshold)) {
    if (members.length < minCluster) continue;
    const examples = members.slice(0, maxExamples).map((i, n) =>
      `Correction ${n + 1} (${rows[i].file}):\nReviewer: ${rows[i].comment}\nFix:\n${rows[i].after_hunk}`).join("\n\n");
    const parsed = parseRule(await ai.llm.complete(SYSTEM, examples));
    if (!parsed) continue;
    const rule = (await db.query("INSERT INTO rules (repo_id, title, body) VALUES ($1,$2,$3) RETURNING id", [repoId, parsed.title, parsed.rule])).rows[0];
    await db.query("UPDATE corrections SET rule_id=$1 WHERE id = ANY($2::int[])", [rule.id, members.map((i) => rows[i].id)]);
    created++;
  }
  return created;
}
