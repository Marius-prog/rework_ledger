import type pg from "pg";
import { renderAgentsMd } from "./agentsMd.js";

export interface RepoWriter {
  defaultBranch(repo: string): Promise<{ name: string; sha: string }>;
  getFile(repo: string, path: string, ref: string): Promise<string | null>;
  createBranch(repo: string, name: string, fromSha: string): Promise<void>;
  putFile(repo: string, path: string, branch: string, content: string, message: string): Promise<void>;
  openPr(repo: string, head: string, base: string, title: string, body: string): Promise<string>;
}

/** Regenerates the managed AGENTS.md block from all approved rules and opens a PR. Returns the PR URL or null if nothing new. */
export async function openRulesPr(db: pg.Pool, writer: RepoWriter, repoId: number, fullName: string, now = new Date()): Promise<string | null> {
  const approved = (await db.query("SELECT id, title, body, exported_pr_url FROM rules WHERE repo_id=$1 AND status='approved' ORDER BY id", [repoId])).rows;
  const pending = approved.filter((r) => !r.exported_pr_url);
  if (!pending.length) return null;
  const base = await writer.defaultBranch(fullName);
  const branch = `rework-ledger/rules-${now.toISOString().replace(/[-:T]/g, "").slice(0, 14)}`;
  const current = await writer.getFile(fullName, "AGENTS.md", base.name);
  await writer.createBranch(fullName, branch, base.sha);
  await writer.putFile(fullName, "AGENTS.md", branch, renderAgentsMd(current, approved), `Add ${pending.length} review rule(s) from Rework Ledger`);
  const url = await writer.openPr(fullName, branch, base.name, `Rework Ledger: ${pending.length} new agent rule(s)`,
    `Approved by a lead in Rework Ledger.\n\n${pending.map((r) => `- **${r.title}.** ${r.body}`).join("\n")}`);
  await db.query("UPDATE rules SET exported_pr_url=$2 WHERE id = ANY($1::int[])", [pending.map((r) => r.id), url]);
  return url;
}
