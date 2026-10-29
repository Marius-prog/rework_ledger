# Rework Ledger: design partner onboarding

Free 90-day backfill report on your agent-written PRs. You approve a read-only GitHub App, and we send you a one-page report.

## What you do (about 10 minutes)

1. **Pick 1 or 2 repos** where coding agents open many PRs and humans review them.
2. **Install the app** from `<INSTALL_URL>`. Choose only those repos.
3. **Sign in** at `<APP_URL>` with GitHub. You see your repos and the dashboard.
4. **Wait for the backfill.** It reads the last 90 days of PRs, usually minutes to under an hour per repo.
5. **Get your report.** We send a markdown report: agent share of PRs, rework rate per agent, a weekly chart, captured corrections, candidate rules.

## Permissions

Requested at install:
- **Read** metadata, contents, pull requests.
- **Write** checks. Used only once you turn on policy checks.

Not requested at install: write access to contents and pull requests. Opening an `AGENTS.md` pull request needs both. We ask for that as a separate permission upgrade, and you can decline it and still use everything else.

## What we store

- **PR metadata:** author login, title, labels, branch, size, state.
- **Review data:** review comment text, the diff hunk each comment was left on, review states.
- **Commits:** messages. Per-file patches are fetched only for commits made after a human review comment on an agent PR, and they are deleted as soon as correction extraction finishes.
- **Corrections:** a human comment paired with the commit that fixed it.

Secrets, tokens, emails, and database URLs are redacted from review comments, review hunks, and corrections before they are stored, and each is capped at 4,000 characters. Redaction is pattern based and will miss some secrets. Commit messages are stored as received.

We do not read or store your full source tree, issues, or repos you did not select.

## Who processes your data

- **Hosting and database:** Fly.io and Neon.
- **Rule drafting:** OpenAI (or Anthropic). Only redacted correction text and fix hunks are sent, and only for paid-plan features.
- **Billing and email:** Stripe and Resend. They receive account and billing data, not code.

## Removing your data

- **Remove a repo from the install.** All stored data for that repo is deleted.
- **Uninstall the app.** All stored data for the installation is deleted.

Deleted data covers PRs, reviews, comments, commits, patches, corrections, rules, and policies.

## What the report does and does not tell you

- Rework means a human review comment followed by a commit changing the same file, or a changes-requested review.
- It is a lower bound. Fixes made in other files, squashed history, and feedback in PR-level comments are not counted.
- AI reviewers and dependency bots are excluded.
