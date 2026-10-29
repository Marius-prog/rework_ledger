import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import { backfillRepo, type GitHubReader } from "./backfill.js";

const split = (full: string) => { const [owner, repo] = full.split("/"); return { owner, repo }; };

export function readerFor(installationId: number): GitHubReader {
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
    listReviews: (r, n) => o.paginate(o.pulls.listReviews, { ...split(r), pull_number: n }),
    listReviewComments: (r, n) => o.paginate(o.pulls.listReviewComments, { ...split(r), pull_number: n }),
  };
}

export async function backfillInstallation(installationId: number, repos: { id: number; full_name: string }[]) {
  const gh = readerFor(installationId);
  for (const r of repos) await backfillRepo(gh, r);
}
