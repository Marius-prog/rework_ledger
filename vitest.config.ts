import { defineConfig } from "vitest/config";
export default defineConfig({ test: { env: { DATABASE_URL: "postgres://localhost:5432/rework_ledger_test", GITHUB_WEBHOOK_SECRET: "s3cret", ADMIN_PASSWORD: "pw", STRIPE_WEBHOOK_SECRET: "whsec_test", APP_URL: "http://localhost:3000" }, fileParallelism: false, globalSetup: ["test/setup.ts"] } });
