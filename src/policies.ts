export interface PolicyConfig {
  testsEnabled: boolean; protectedEnabled: boolean; protectedPaths: string[]; sizeEnabled: boolean; maxDiffLines: number;
}
export const DEFAULT_POLICY: PolicyConfig = { testsEnabled: true, protectedEnabled: true, protectedPaths: [], sizeEnabled: true, maxDiffLines: 800 };

export interface PolicyInput { files: string[]; additions: number; deletions: number; humanApprovals: string[] }
export interface PolicyResult { policy: "tests_changed" | "protected_paths" | "max_diff_size"; passed: boolean; detail: string }

/** `dir/` = everything under dir, `**` = any depth, `*` = within one segment, a pattern with no `/` also matches any basename. */
export function globToRegExp(glob: string): RegExp {
  const g = glob.endsWith("/") ? glob + "**" : glob;
  const src = g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
  return new RegExp(`^${src}$`);
}
export function matchesGlob(path: string, glob: string): boolean {
  if (globToRegExp(glob).test(path)) return true;
  return !glob.includes("/") && globToRegExp(glob).test(path.split("/").pop()!);
}

export function isTestFile(path: string): boolean {
  return /(^|\/)(tests?|__tests__|spec)\//i.test(path) || /\.(test|spec)\.[a-z]+$/i.test(path) || /(^|\/)test_[^/]+\.py$|_test\.(go|py|rs)$/i.test(path);
}

export function evaluatePolicies(input: PolicyInput, cfg: PolicyConfig): PolicyResult[] {
  const out: PolicyResult[] = [];
  if (cfg.testsEnabled) {
    const tests = input.files.filter(isTestFile);
    out.push({ policy: "tests_changed", passed: tests.length > 0,
      detail: tests.length ? `${tests.length} test file(s) changed` : "No test files changed" });
  }
  if (cfg.protectedEnabled && cfg.protectedPaths.length) {
    const hit = input.files.filter((f) => cfg.protectedPaths.some((g) => matchesGlob(f, g)));
    if (!hit.length) out.push({ policy: "protected_paths", passed: true, detail: "No protected paths touched" });
    else out.push({ policy: "protected_paths", passed: input.humanApprovals.length > 0,
      detail: input.humanApprovals.length ? `Protected paths touched (${hit.length}), approved by ${input.humanApprovals.join(", ")}`
        : `Protected paths touched (${hit.slice(0, 3).join(", ")}${hit.length > 3 ? ", ..." : ""}) and no human approval` });
  }
  if (cfg.sizeEnabled) {
    const size = input.additions + input.deletions;
    out.push({ policy: "max_diff_size", passed: size <= cfg.maxDiffLines, detail: `${size} changed lines (max ${cfg.maxDiffLines})` });
  }
  return out;
}

export function toCheckOutput(results: PolicyResult[], humanApprovals: string[]) {
  const failed = results.filter((r) => !r.passed);
  return {
    conclusion: failed.length ? ("failure" as const) : ("success" as const),
    title: failed.length ? `${failed.length} polic${failed.length > 1 ? "ies" : "y"} failed` : "All policies passed",
    summary: [...results.map((r) => `- ${r.passed ? "PASS" : "FAIL"} \`${r.policy}\`: ${r.detail}`),
      `- Human approval: ${humanApprovals.length ? humanApprovals.join(", ") : "none"}`].join("\n"),
  };
}
