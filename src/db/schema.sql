CREATE TABLE IF NOT EXISTS waitlist (
  id serial PRIMARY KEY,
  email text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
