import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type pg from "pg";
import { pool } from "./db/pool.js";

export interface GitHubOAuth {
  authorizeUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<string>;
  getUser(token: string): Promise<{ id: number; login: string }>;
  listInstallations(token: string): Promise<number[]>;
}

export function githubOAuth(clientId: string, clientSecret: string): GitHubOAuth {
  const gh = async (url: string, token: string) => {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "rework-ledger" } });
    if (!res.ok) throw new Error(`${url} ${res.status}`);
    return res.json() as Promise<any>;
  };
  return {
    authorizeUrl: (state, redirectUri) =>
      `https://github.com/login/oauth/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state })}`,
    async exchangeCode(code, redirectUri) {
      const res = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST", headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
      });
      const j: any = await res.json();
      if (!j.access_token) throw new Error(`oauth exchange failed: ${j.error ?? res.status}`);
      return j.access_token;
    },
    getUser: async (t) => { const u = await gh("https://api.github.com/user", t); return { id: u.id, login: u.login }; },
    listInstallations: async (t) => (await gh("https://api.github.com/user/installations?per_page=100", t)).installations.map((i: any) => i.id),
  };
}

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const SESSION_DAYS = 30;
export const appUrl = () => process.env.APP_URL ?? "http://localhost:3000";

export async function createSession(db: pg.Pool, userId: number): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await db.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1,$2,$3)",
    [hash(token), userId, new Date(Date.now() + SESSION_DAYS * 86400_000)]);
  return token;
}

export async function sessionUser(db: pg.Pool, token: string | undefined): Promise<{ id: number; login: string; installationIds: number[] } | null> {
  if (!token) return null;
  const u = (await db.query(
    "SELECT u.id, u.login FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at > now()", [hash(token)])).rows[0];
  if (!u) return null;
  const ids = (await db.query("SELECT installation_id FROM user_installations WHERE user_id=$1", [u.id])).rows.map((r) => Number(r.installation_id));
  return { ...u, installationIds: ids };
}

export function authRoutes(oauth: GitHubOAuth | null) {
  const a = new Hono();
  const cookieOpts = { httpOnly: true, sameSite: "Lax" as const, path: "/", secure: process.env.NODE_ENV === "production" };

  a.get("/login", (c) => {
    if (!oauth) return c.text("GitHub sign-in is not configured", 503);
    const state = randomBytes(16).toString("hex");
    setCookie(c, "rl_state", state, { ...cookieOpts, maxAge: 600 });
    return c.redirect(oauth.authorizeUrl(state, `${appUrl()}/auth/callback`));
  });

  a.get("/auth/callback", async (c) => {
    if (!oauth) return c.text("GitHub sign-in is not configured", 503);
    const state = c.req.query("state"), code = c.req.query("code");
    const expected = getCookie(c, "rl_state");
    deleteCookie(c, "rl_state", { path: "/" });
    if (!code || !state || !expected || state !== expected) return c.text("invalid state", 400);
    const token = await oauth.exchangeCode(code, `${appUrl()}/auth/callback`);
    const gh = await oauth.getUser(token);
    const user = (await pool.query(
      `INSERT INTO users (github_id, login) VALUES ($1,$2) ON CONFLICT (github_id) DO UPDATE SET login=$2 RETURNING id`, [gh.id, gh.login])).rows[0];
    await pool.query("DELETE FROM user_installations WHERE user_id=$1", [user.id]);
    for (const iid of await oauth.listInstallations(token)) {
      await pool.query("INSERT INTO user_installations (user_id, installation_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [user.id, iid]);
    }
    setCookie(c, "rl_session", await createSession(pool, user.id), { ...cookieOpts, maxAge: SESSION_DAYS * 86400 });
    return c.redirect("/app");
  });

  a.post("/logout", async (c) => {
    const t = getCookie(c, "rl_session");
    if (t) await pool.query("DELETE FROM sessions WHERE token_hash=$1", [hash(t)]);
    deleteCookie(c, "rl_session", { path: "/" });
    return c.redirect("/");
  });
  return a;
}
