import { Hono } from "hono";
import { pool } from "./db/pool.js";
import { landing } from "./landing.js";
import { handleEvent, verifySignature, type Backfill } from "./webhook.js";
import { backfillInstallation } from "./githubClient.js";

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const app = new Hono();
app.get("/", (c) => c.html(landing()));
app.get("/healthz", (c) => c.text("ok"));
app.post("/waitlist", async (c) => {
  const form = await c.req.parseBody();
  const email = String(form.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return c.html(landing("Enter a valid email."), 400);
  await pool.query("INSERT INTO waitlist (email) VALUES ($1) ON CONFLICT DO NOTHING", [email]);
  return c.html(landing("You're on the list."));
});

const backfill: Backfill = backfillInstallation;

app.post("/webhooks/github", async (c) => {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return c.text("webhook secret not configured", 500);
  const raw = await c.req.text();
  if (!verifySignature(secret, raw, c.req.header("x-hub-signature-256"))) return c.text("bad signature", 401);
  const event = c.req.header("x-github-event") ?? "";
  const delivery = c.req.header("x-github-delivery") ?? "";
  const ins = await pool.query(
    "INSERT INTO webhook_deliveries (delivery_id, event) VALUES ($1,$2) ON CONFLICT DO NOTHING", [delivery, event]);
  if (!ins.rowCount) return c.text("duplicate");
  return c.text(await handleEvent(event, JSON.parse(raw), backfill));
});
