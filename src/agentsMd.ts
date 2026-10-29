export const START = "<!-- rework-ledger:start -->";
export const END = "<!-- rework-ledger:end -->";

export function renderAgentsMd(existing: string | null, rules: { title: string; body: string }[]): string {
  const block = [START, "## Review rules (managed by Rework Ledger)", "",
    ...rules.map((r) => `- **${r.title}.** ${r.body}`), END].join("\n");
  if (existing === null) return `# AGENTS.md\n\n${block}\n`;
  const s = existing.indexOf(START), e = existing.indexOf(END);
  if (s >= 0 && e > s) return existing.slice(0, s) + block + existing.slice(e + END.length);
  return existing.replace(/\s*$/, "") + `\n\n${block}\n`;
}
