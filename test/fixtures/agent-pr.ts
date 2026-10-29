// A realistic agent PR: Claude opens it, bob reviews, a fix commit follows.
export const repo = { id: 1, full_name: "acme/api" };
export const pr = {
  number: 42, title: "Add invoice retry", state: "closed", user: { login: "claude[bot]", type: "Bot" }, body: "",
  labels: [], head: { ref: "agent/retry", sha: "f3" }, additions: 40, deletions: 3,
  created_at: "2025-10-10T09:00:00Z", merged_at: "2025-10-11T09:00:00Z",
};
const hunk1 = `@@ -10,6 +10,8 @@ export async function chargeInvoice(inv: Invoice) {
   const amount = inv.total;
+  const stripe = new Stripe("sk_live_abcdefghijklmnop1234");
+  const res = await stripe.charges.create({ amount });
   return res;`;
export const comments = [
  // C1: addressed by commit f2 touching the same file
  { id: 101, user: { login: "bob" }, path: "services/billing.ts", original_line: 11, diff_hunk: hunk1,
    body: "Never call raw Stripe in services/. Use the billing client. Ping me at bob@acme.com if unsure.", commit_id: "f1", created_at: "2025-10-10T12:00:00Z" },
  { id: 102, user: { login: "claude[bot]" }, in_reply_to_id: 101, path: "services/billing.ts", body: "Will do.", created_at: "2025-10-10T12:05:00Z" },
  { id: 103, user: { login: "bob" }, in_reply_to_id: 101, path: "services/billing.ts", body: "Also add a test.", created_at: "2025-10-10T12:10:00Z" },
  // C2: no later commit touches the file
  { id: 104, user: { login: "bob" }, path: "services/email.ts", original_line: 5, diff_hunk: "@@ -1,3 +1,4 @@\n+const x = 1;", body: "Rename x.", commit_id: "f1", created_at: "2025-10-10T12:20:00Z" },
  // C3: only the author talks (no reviewer correction)
  { id: 105, user: { login: "claude[bot]" }, path: "services/billing.ts", original_line: 3, diff_hunk: "@@ -1,3 +1,4 @@\n+// note", body: "Self note", commit_id: "f1", created_at: "2025-10-10T12:30:00Z" },
];
export const commits = [
  { sha: "f1", message: "feat: retry\n\nCo-authored-by: Claude <noreply@anthropic.com>", date: "2025-10-10T10:00:00Z" },
  { sha: "f2", message: "fix: use billing client", date: "2025-10-10T13:00:00Z" },
  { sha: "f3", message: "chore: unrelated", date: "2025-10-10T14:00:00Z" },
];
export const files: Record<string, { filename: string; patch?: string }[]> = {
  f1: [{ filename: "services/billing.ts", patch: hunk1 }, { filename: "services/email.ts", patch: "@@ -1,3 +1,4 @@\n+const x = 1;" }],
  f2: [{ filename: "services/billing.ts", patch:
`@@ -1,4 +1,5 @@
 import { Invoice } from "./types";
+import { billing } from "../clients/billing";
@@ -10,8 +11,6 @@ export async function chargeInvoice(inv: Invoice) {
   const amount = inv.total;
-  const stripe = new Stripe("sk_live_abcdefghijklmnop1234");
-  const res = await stripe.charges.create({ amount });
+  const res = await billing.charge(inv.id, amount);
   return res;` }],
  f3: [{ filename: "README.md", patch: "@@ -1 +1 @@\n-a\n+b" }],
};
