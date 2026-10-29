import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import { pool } from "./db/pool.js";
import { extractCorrections, syncPrCommits, type CommitReader } from "./extract.js";
import { backfillRepo, type GitHubReader } from "./backfill.js";

const split = (full: string) => { const [owner, repo] = full.split("/"); return { owner, repo }; };

export function readerFor(installationId: number): GitHubReader & CommitReader {
  const o = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: process.env.GITHUB_APP_ID!,
      privateKey: (process.env.GITHUB_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
      installationId,
    },
  });
  return {
    listPulls: (r) => o.paginate(o.pulls.list, { ...split(r), state: "all", sort: "created", direction: "desc", per_page: 100 }),
    getPull: async (r, n) => (await o.pulls.get({ ...split(r), pull_number: n })).data,
    listCommitMessages: async (r, n) => (await o.paginate(o.pulls.listCommits, { ...split(r), pull_number: n })).map((c) => c.commit.message),
    listPrCommits: async (r, n) => (await o.paginate(o.pulls.listCommits, { ...split(r), pull_number: n }))
      .map((c) => ({ sha: c.sha, message: c.commit.message, date: c.commit.committer?.date ?? c.commit.author?.date ?? new Date().toISOString() })),
    getCommitFiles: async (r, sha) => ((await o.repos.getCommit({ ...split(r), ref: sha })).data.files ?? [])
      .map((f) => ({ filename: f.filename, patch: f.patch })),
    listReviews: (r, n) => o.paginate(o.pulls.listReviews, { ...split(r), pull_number: n }),
    listReviewComments: (r, n) => o.paginate(o.pulls.listReviewComments, { ...split(r), pull_number: n }),
  };
}

export async function backfillInstallation(installationId: number, repos: { id: number; full_name: string }[]) {
  const gh = readerFor(installationId);
  for (const r of repos) await backfillRepo(gh, r);
}

export async function extractOnMerge(installationId: number, repo: { id: number; full_name: string }, prNumber: number) {
  const gh = readerFor(installationId);
  await syncPrCommits(gh, repo, prNumber);
  await extractCorrections(pool, repo.id, prNumber);
}
