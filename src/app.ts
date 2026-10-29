import { Hono } from "hono";
import { pool } from "./db/pool.js";
import { landing } from "./landing.js";

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
