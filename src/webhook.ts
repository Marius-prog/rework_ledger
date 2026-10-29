import { createHmac, timingSafeEqual } from "node:crypto";
import { pool } from "./db/pool.js";
import { deleteInstallationData, deleteRepoData, storePullRequest, storePush, storeReview, storeReviewComment, upsertInstallation, upsertRepo } from "./store.js";

export function verifySignature(secret: string, body: string, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(header.slice(7), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export type Backfill = (installationId: number, repos: { id: number; full_name: string }[]) => Promise<void>;

export type OnMerged = (installationId: number, repo: { id: number; full_name: string }, prNumber: number) => Promise<void>;

export type OnCheck = (installationId: number, repo: { id: number; full_name: string }, prNumber: number) => Promise<void>;
export interface Hooks { backfill?: Backfill; onMerged?: OnMerged; onCheck?: OnCheck }

export async function handleEvent(event: string, p: any, hooks: Hooks = {}): Promise<string> {
  const { backfill, onMerged, onCheck } = hooks;
  switch (event) {
    case "installation":
    case "installation_repositories": {
      if (p.action === "deleted") {
        await deleteInstallationData(pool, p.installation.id);
        return "installation removed";
      }
      if (p.action === "removed") {
        await deleteRepoData(pool, (p.repositories_removed ?? []).map((r: any) => r.id));
        return `purged ${(p.repositories_removed ?? []).length} repos`;
      }
      await upsertInstallation(pool, p.installation.id, p.installation.account.login);
      const repos = p.repositories ?? p.repositories_added ?? [];
      for (const r of repos) await upsertRepo(pool, r.id, p.installation.id, r.full_name);
      if (backfill && repos.length) void backfill(p.installation.id, repos).catch((e) => console.error("backfill failed", e));
      return `installed ${repos.length} repos`;
    }
    case "pull_request":
      await upsertInstallation(pool, p.installation.id, p.repository.owner.login);
      await upsertRepo(pool, p.repository.id, p.installation.id, p.repository.full_name);
      await storePullRequest(pool, p.repository.id, p.pull_request);
      if (onMerged && p.action === "closed" && p.pull_request.merged_at) {
        void onMerged(p.installation.id, p.repository, p.pull_request.number).catch((e) => console.error("extract failed", e));
      }
      if (onCheck && ["opened", "synchronize", "reopened", "ready_for_review"].includes(p.action)) {
        void onCheck(p.installation.id, p.repository, p.pull_request.number).catch((e) => console.error("check failed", e));
      }
      return "pr stored";
    case "pull_request_review":
      await storeReview(pool, p.repository.id, p.pull_request.number, p.review);
      if (onCheck && p.installation && ["submitted", "dismissed"].includes(p.action)) {
        void onCheck(p.installation.id, p.repository, p.pull_request.number).catch((e) => console.error("check failed", e));
      }
      return "review stored";
    case "pull_request_review_comment":
      await storeReviewComment(pool, p.repository.id, p.pull_request.number, p.comment);
      return "comment stored";
    case "push":
      await storePush(pool, p.repository.id, p);
      return "push stored";
    default:
      return "ignored";
  }
}
