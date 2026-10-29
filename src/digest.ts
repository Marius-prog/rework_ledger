import type pg from "pg";
import { reworkByAgent, ruleHits, topRepeated } from "./stats.js";

export interface Mailer { send(m: { to: string; subject: string; text: string; html: string }): Promise<void> }

export function resendMailer(key: string, from: string): Mailer {
  return { async send(m) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to: m.to, subject: m.subject, text: m.text, html: m.html }),
    });
    if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
  } };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export async function buildDigest(db: pg.Pool, installationId: number, now = new Date()) {
  const since = new Date(now.getTime() - 7 * 86400_000);
  const [agents, top, hits] = await Promise.all([
    reworkByAgent(db, since, installationId), topRepeated(db, since, installationId), ruleHits(db, since, installationId)]);
  if (!agents.length && !top.length) return null;
  const lines = [
    "Rework rate by agent (PRs opened in the last 7 days)",
    ...(agents.length ? agents.map((a) => `- ${a.agent}: ${pct(a.rate)} (${a.reworked} of ${a.prs} PRs)`) : ["- no agent PRs"]),
    "", "Top repeated corrections",
    ...(top.length ? top.map((t) => `- ${t.title}: ${t.n} corrections (${t.status})`) : ["- none"]),
    "", "Rule hits (mistakes repeated after approval)",
    ...(hits.length ? hits.map((h) => `- ${h.title}: ${h.hits}`) : ["- no approved rules yet"]),
  ];
  const html = `<h2>Rework Ledger weekly digest</h2>` + lines.join("\n").split("\n\n").map((block) => {
    const [head, ...items] = block.split("\n");
    return `<h3>${esc(head)}</h3><ul>${items.map((i) => `<li>${esc(i.replace(/^- /, ""))}</li>`).join("")}</ul>`;
  }).join("");
  return { subject: "Rework Ledger: weekly agent rework digest", text: lines.join("\n"), html };
}

export async function sendDigests(db: pg.Pool, mailer: Mailer, now = new Date()): Promise<number> {
  let sent = 0;
  for (const i of (await db.query("SELECT id, digest_email FROM installations WHERE digest_email IS NOT NULL")).rows) {
    const d = await buildDigest(db, i.id, now);
    if (!d) continue;
    await mailer.send({ to: i.digest_email, ...d });
    sent++;
  }
  return sent;
}
