import { readFileSync } from "node:fs";
import { pool } from "./pool.js";
await pool.query(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
console.log("migrated");
await pool.end();
