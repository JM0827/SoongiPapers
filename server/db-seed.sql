-- Seed data for Project-T1 PostgreSQL schema
-- Add service plans
INSERT INTO service_plans (name, description, max_jobs, max_characters, price_cents, is_active) VALUES
  ('Free', 'Free plan with limited usage', 5, 10000, 0, true),
  ('Trial', 'Trial plan for new users', 10, 50000, 0, true),
  ('Pro', 'Pro plan for regular users', 100, 1000000, 1999, true),
  ('Enterprise', 'Enterprise plan with custom limits', NULL, NULL, 9999, true)
ON CONFLICT (name) DO NOTHING;