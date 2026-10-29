import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, afterAll } from "vitest";
import { app } from "../src/app.js";
import { pool } from "../src/db/pool.js";

let n = 0;
async function send(event: string, payload: object, opts: { sign?: boolean; delivery?: string } = {}) {
  const body = JSON.stringify(payload);
  const sig = "sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex");
  return app.request("/webhooks/github", {
    method: "POST", body,
    headers: { "x-github-event": event, "x-github-delivery": opts.delivery ?? `d${++n}-${Date.now()}`,
      "x-hub-signature-256": opts.sign === false ? "sha256=bad" : sig },
  });
}
const repository = { id: 1, full_name: "acme/api", owner: { login: "acme" } };
const installation = { id: 99 };
const pr = (over: any = {}) => ({
  number: 7, title: "Add billing", state: "open", user: { login: "claude[bot]", type: "Bot" }, body: "",
  labels: [], head: { ref: "agent/billing", sha: "abc" }, additions: 10, deletions: 2,
  created_at: "2025-10-01T00:00:00Z", merged_at: null, ...over });

beforeEach(async () => { await pool.query("TRUNCATE installations, webhook_deliveries, reviews, review_comments, commits CASCADE"); });
afterAll(() => pool.end());

describe("webhook", () => {
  it("rejects bad signature", async () => expect((await send("push", {}, { sign: false })).status).toBe(401));

  it("stores an agent PR, review, comment", async () => {
    expect((await send("pull_request", { action: "opened", installation, repository, pull_request: pr() })).status).toBe(200);
    await send("pull_request_review", { repository, pull_request: { number: 7 },
      review: { id: 1, user: { login: "bob" }, state: "CHANGES_REQUESTED", submitted_at: "2025-10-02T00:00:00Z" } });
    await send("pull_request_review_comment", { repository, pull_request: { number: 7 },
      comment: { id: 5, user: { login: "bob" }, path: "services/a.ts", diff_hunk: "@@", body: "use billing client", commit_id: "abc", created_at: "2025-10-02T00:00:00Z" } });
    const p = (await pool.query("SELECT is_agent, agent_name, detection_reason FROM pull_requests")).rows[0];
    expect(p).toEqual({ is_agent: true, agent_name: "claude-code", detection_reason: "bot_login" });
    expect((await pool.query("SELECT state FROM reviews")).rows[0].state).toBe("changes_requested");
    expect((await pool.query("SELECT body FROM review_comments")).rows[0].body).toBe("use billing client");
  });

  it("ignores duplicate deliveries", async () => {
    const payload = { action: "opened", installation, repository, pull_request: pr() };
    await send("pull_request", payload, { delivery: "same" });
    expect(await (await send("pull_request", payload, { delivery: "same" })).text()).toBe("duplicate");
  });

  it("push trailer marks an open human-authored PR as agent", async () => {
    await send("pull_request", { action: "opened", installation, repository, pull_request: pr({ user: { login: "alice", type: "User" } }) });
    expect((await pool.query("SELECT is_agent FROM pull_requests")).rows[0].is_agent).toBe(false);
    await send("push", { ref: "refs/heads/agent/billing", repository, commits: [
      { id: "c1", message: "wip\n\nCo-authored-by: Codex <codex@openai.com>", timestamp: "2025-10-01T01:00:00Z", author: { username: "alice" } }] });
    const p = (await pool.query("SELECT is_agent, agent_name FROM pull_requests")).rows[0];
    expect(p).toEqual({ is_agent: true, agent_name: "codex" });
    expect((await pool.query("SELECT count(*)::int c FROM commits")).rows[0].c).toBe(1);
  });

  it("a later human-looking PR update does not clear agent detection", async () => {
    await send("pull_request", { action: "opened", installation, repository, pull_request: pr() });
    await send("pull_request", { action: "edited", installation, repository, pull_request: pr({ user: { login: "claude[bot]", type: "Bot" }, title: "Renamed" }) });
    expect((await pool.query("SELECT is_agent, title FROM pull_requests")).rows[0]).toEqual({ is_agent: true, title: "Renamed" });
  });

  it("installation event stores repos and triggers backfill", async () => {
    let called: any;
    const { handleEvent } = await import("../src/webhook.js");
    await handleEvent("installation", { action: "created", installation: { id: 99, account: { login: "acme" } },
      repositories: [{ id: 1, full_name: "acme/api" }] }, async (id, repos) => { called = { id, repos }; });
    expect(called.id).toBe(99);
    expect((await pool.query("SELECT full_name FROM repos")).rows[0].full_name).toBe("acme/api");
  });
});
