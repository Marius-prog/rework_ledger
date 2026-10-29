import { describe, expect, it } from "vitest";
import { detectAgent } from "../src/detect.js";

const base = { authorLogin: "alice", labels: [] as string[] };
describe("detectAgent", () => {
  it("bot login", () => expect(detectAgent({ ...base, authorLogin: "copilot-swe-agent[bot]", authorType: "Bot" }))
    .toEqual({ isAgent: true, agentName: "copilot", reason: "bot_login" }));
  it("ignores automation bots that are not coding agents", () => {
    for (const login of ["dotnet-maestro[bot]", "dotnet-release-bot[bot]", "renovate[bot]"])
      expect(detectAgent({ ...base, authorLogin: login, authorType: "Bot" }).isAgent, login).toBe(false);
  });
  it("ignores dependabot", () => expect(detectAgent({ ...base, authorLogin: "dependabot[bot]", authorType: "Bot" }).isAgent).toBe(false));
  it("label", () => expect(detectAgent({ ...base, labels: ["agent-authored"] }).reason).toBe("label"));
  it("co-authored-by in commit", () => expect(detectAgent({ ...base, commitMessages: ["fix\n\nCo-authored-by: Claude <noreply@anthropic.com>"] }))
    .toEqual({ isAgent: true, agentName: "claude-code", reason: "co_authored_by" }));
  it("co-authored-by human is not an agent", () => expect(detectAgent({ ...base, commitMessages: ["x\n\nCo-authored-by: Bob <bob@x.com>"] }).isAgent).toBe(false));
  it("plain human PR", () => expect(detectAgent(base).isAgent).toBe(false));
});
