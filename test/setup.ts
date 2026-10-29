import { readFileSync } from "node:fs";
import pg from "pg";
export default async function () {
  const c = new pg.Client({ connectionString: "postgres://localhost:5432/rework_ledger_test" });
  await c.connect();
  await c.query(readFileSync("src/db/schema.sql", "utf8"));
  await c.end();
}
