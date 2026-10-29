CREATE TABLE IF NOT EXISTS waitlist (
  id serial PRIMARY KEY,
  email text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS installations (
  id bigint PRIMARY KEY,
  account_login text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS repos (
  id bigint PRIMARY KEY,
  installation_id bigint NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  full_name text NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id text PRIMARY KEY,
  event text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pull_requests (
  repo_id bigint NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  number int NOT NULL,
  author_login text NOT NULL,
  title text NOT NULL,
  state text NOT NULL,
  merged boolean NOT NULL DEFAULT false,
  head_ref text NOT NULL,
  head_sha text NOT NULL,
  additions int NOT NULL DEFAULT 0,
  deletions int NOT NULL DEFAULT 0,
  labels text[] NOT NULL DEFAULT '{}',
  is_agent boolean NOT NULL DEFAULT false,
  agent_name text,
  detection_reason text,
  created_at timestamptz NOT NULL,
  merged_at timestamptz,
  PRIMARY KEY (repo_id, number)
);

CREATE TABLE IF NOT EXISTS reviews (
  id bigint PRIMARY KEY,
  repo_id bigint NOT NULL,
  pr_number int NOT NULL,
  reviewer_login text NOT NULL,
  state text NOT NULL,
  submitted_at timestamptz
);

CREATE TABLE IF NOT EXISTS review_comments (
  id bigint PRIMARY KEY,
  repo_id bigint NOT NULL,
  pr_number int NOT NULL,
  reviewer_login text NOT NULL,
  in_reply_to_id bigint,
  path text,
  diff_hunk text,
  body text NOT NULL,
  commit_sha text,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS commits (
  repo_id bigint NOT NULL,
  sha text NOT NULL,
  ref text NOT NULL,
  author_login text,
  message text NOT NULL,
  committed_at timestamptz NOT NULL,
  PRIMARY KEY (repo_id, sha)
);

ALTER TABLE review_comments ADD COLUMN IF NOT EXISTS line int;

CREATE TABLE IF NOT EXISTS pr_commits (
  repo_id bigint NOT NULL,
  pr_number int NOT NULL,
  sha text NOT NULL,
  message text NOT NULL,
  committed_at timestamptz NOT NULL,
  PRIMARY KEY (repo_id, pr_number, sha)
);

CREATE TABLE IF NOT EXISTS commit_files (
  repo_id bigint NOT NULL,
  sha text NOT NULL,
  path text NOT NULL,
  patch text NOT NULL,
  PRIMARY KEY (repo_id, sha, path)
);

CREATE TABLE IF NOT EXISTS corrections (
  id serial PRIMARY KEY,
  repo_id bigint NOT NULL,
  pr_number int NOT NULL,
  comment_id bigint NOT NULL UNIQUE,
  agent_name text,
  file text NOT NULL,
  comment text NOT NULL,
  before_hunk text NOT NULL,
  after_hunk text NOT NULL,
  fix_sha text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS rules (
  id serial PRIMARY KEY,
  repo_id bigint NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','approved','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  exported_pr_url text
);
ALTER TABLE corrections ADD COLUMN IF NOT EXISTS embedding real[];
ALTER TABLE corrections ADD COLUMN IF NOT EXISTS rule_id int REFERENCES rules(id) ON DELETE SET NULL;
