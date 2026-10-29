import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import { pool } from "./db/pool.js";
import { extractCorrections, syncPrCommits, type CommitReader } from "./extract.js";
import { runCheck, type ChecksClient } from "./checks.js";
import type { RepoWriter } from "./rulesPr.js";
import { backfillRepo, type GitHubReader } from "./backfill.js";

const split = (full: string) => { const [owner, repo] = full.split("/"); return { owner, repo }; };

export function octokitFor(installationId?: number): Octokit {
  if (process.env.GITHUB_TOKEN) return new Octokit({ auth: process.env.GITHUB_TOKEN });
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: process.env.GITHUB_APP_ID!,
      privateKey: (process.env.GITHUB_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
      installationId,
    },
  });
}

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

/** Writes via GITHUB_TOKEN when set (no app needed), else the app installation. */
export function writerFor(installationId?: number): RepoWriter {
  const o = octokitFor(installationId);
  return {
    async defaultBranch(repo) {
      const { data } = await o.repos.get(split(repo));
      const ref = await o.git.getRef({ ...split(repo), ref: `heads/${data.default_branch}` });
      return { name: data.default_branch, sha: ref.data.object.sha };
    },
    async getFile(repo, path, ref) {
      try {
        const { data } = await o.repos.getContent({ ...split(repo), path, ref });
        return Buffer.from((data as any).content, "base64").toString("utf8");
      } catch (e: any) { if (e.status === 404) return null; throw e; }
    },
    async createBranch(repo, name, sha) { await o.git.createRef({ ...split(repo), ref: `refs/heads/${name}`, sha }); },
    async putFile(repo, path, branch, content, message) {
      let sha: string | undefined;
      try { sha = ((await o.repos.getContent({ ...split(repo), path, ref: branch })).data as any).sha; } catch { /* new file */ }
      await o.repos.createOrUpdateFileContents({ ...split(repo), path, branch, message, sha, content: Buffer.from(content).toString("base64") });
    },
    async openPr(repo, head, base, title, body) {
      return (await o.pulls.create({ ...split(repo), head, base, title, body })).data.html_url;
    },
  };
}

/** Check runs require GitHub App auth. A personal token cannot create them. */
export function checksClientFor(installationId: number): ChecksClient {
  const o = octokitFor(installationId);
  return {
    listPrFiles: async (r, n) => (await o.paginate(o.pulls.listFiles, { ...split(r), pull_number: n })).map((f) => f.filename),
    async createCheckRun(r, p) {
      await o.checks.create({ ...split(r), name: p.name, head_sha: p.headSha, status: "completed", conclusion: p.conclusion,
        output: { title: p.title, summary: p.summary } });
    },
  };
}
export async function checkOnEvent(installationId: number, repo: { id: number; full_name: string }, prNumber: number) {
  await runCheck(pool, checksClientFor(installationId), repo, prNumber);
}
