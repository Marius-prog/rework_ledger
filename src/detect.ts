export interface DetectInput {
  authorLogin: string;
  authorType?: string;
  labels: string[];
  body?: string | null;
  commitMessages?: string[];
}
export interface Detection { isAgent: boolean; agentName: string | null; reason: string | null }

const AGENT_LABELS = new Set(["agent-authored", "ai-generated", "agent", "ai-agent"]);
const KNOWN_AGENTS: [RegExp, string][] = [
  [/copilot/i, "copilot"], [/codex/i, "codex"], [/claude/i, "claude-code"],
  [/devin/i, "devin"], [/kiro/i, "kiro"], [/cursor/i, "cursor"], [/jules/i, "jules"],
];
const TRAILER_RE = /^co-authored-by:\s*(.+?)\s*<[^>]*>/gim;

function nameFrom(text: string): string | null {
  for (const [re, name] of KNOWN_AGENTS) if (re.test(text)) return name;
  return null;
}

export function detectAgent(i: DetectInput): Detection {
  const login = i.authorLogin.toLowerCase();
  const isBot = i.authorType === "Bot" || login.endsWith("[bot]");
  // Only known coding agents count by login. Dependency and release bots (dependabot, dotnet-maestro) are automation, not agents.
  const botAgent = isBot ? nameFrom(login) : null;
  if (botAgent) return { isAgent: true, agentName: botAgent, reason: "bot_login" };
  const label = i.labels.find((l) => AGENT_LABELS.has(l.toLowerCase()));
  if (label) return { isAgent: true, agentName: nameFrom(i.labels.join(" ")) ?? "unknown", reason: "label" };
  const texts = [i.body ?? "", ...(i.commitMessages ?? [])];
  for (const t of texts) {
    for (const m of t.matchAll(TRAILER_RE)) {
      const name = nameFrom(m[1]);
      if (name) return { isAgent: true, agentName: name, reason: "co_authored_by" };
    }
  }
  return { isAgent: false, agentName: null, reason: null };
}
