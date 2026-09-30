-- ============================================================
--  FrontendRiders — Complete Database Setup Script
--  Run this in the Supabase SQL Editor (once, in order).
-- ============================================================

-- ── 1. submissions table ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.submissions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  hackathon_id    int,

  -- Project metadata
  project_name    text        NOT NULL,
  repo_url        text,
  demo_url        text        NOT NULL,
  tech_stack      text,                         -- comma-separated, e.g. "React, Tailwind"

  -- Lighthouse scores written by the edge function
  score           numeric(5,2),                 -- weighted average 0-100
  performance     numeric(5,2),
  accessibility   numeric(5,2),
  best_practices  numeric(5,2),
  seo             numeric(5,2),
  evaluated_at    timestamptz,

  -- Timestamps
  created_at      timestamptz DEFAULT now() NOT NULL
);

-- ── 2. Row-Level Security ───────────────────────────────────────────────────
ALTER TABLE public.submissions ENABLE ROW LEVEL SECURITY;

-- Anyone can read submissions (public leaderboard)
CREATE POLICY "Public read"
  ON public.submissions FOR SELECT
  USING (true);

-- Authenticated users can insert their own submission
CREATE POLICY "Auth insert"
  ON public.submissions FOR INSERT
  WITH CHECK (auth.uid() = user_id OR user_id IS NULL);

-- Only the owner or service role can update (edge function uses service role)
CREATE POLICY "Owner update"
  ON public.submissions FOR UPDATE
  USING (auth.uid() = user_id OR auth.role() = 'service_role');

-- ── 3. Enable Realtime on submissions ──────────────────────────────────────
-- This lets the frontend subscribe to UPDATE events so the leaderboard
-- refreshes automatically the moment the edge function writes scores back.
ALTER PUBLICATION supabase_realtime ADD TABLE public.submissions;

-- ── 4. leaderboard view (all-time) ─────────────────────────────────────────
-- DROP first so CREATE OR REPLACE cannot hit error 42P16 on column renames.
DROP VIEW IF EXISTS public.leaderboard_month CASCADE;
DROP VIEW IF EXISTS public.leaderboard       CASCADE;
-- Uses DENSE_RANK so ties share the same rank number.
-- Only rows that have been evaluated (score IS NOT NULL) are included.
-- One row per user: their best-scoring project.
CREATE OR REPLACE VIEW public.leaderboard AS
WITH best AS (
  SELECT DISTINCT ON (user_id)
    id,
    user_id,
    project_name,
    repo_url,
    demo_url,
    tech_stack,
    score,
    performance,
    accessibility,
    best_practices,
    seo,
    evaluated_at,
    created_at,
    -- Derive a display name: use email prefix stored in auth.users, fallback to 'Rider'
    COALESCE(
      (SELECT split_part(u.email, '@', 1) FROM auth.users u WHERE u.id = s.user_id LIMIT 1),
      'Rider'
    ) AS username
  FROM public.submissions s
  WHERE score IS NOT NULL
  ORDER BY user_id, score DESC
)
SELECT
  CAST(DENSE_RANK() OVER (ORDER BY score DESC) AS int) AS rank,
  id,
  user_id,
  username,
  project_name,
  repo_url,
  demo_url,
  tech_stack,
  ROUND(score)          AS score,
  ROUND(performance)    AS performance,
  ROUND(accessibility)  AS accessibility,
  ROUND(best_practices) AS best_practices,
  ROUND(seo)            AS seo,
  evaluated_at,
  created_at,
  -- How many projects this user has submitted (evaluated)
  (
    SELECT COUNT(*) FROM public.submissions s2
    WHERE s2.user_id = best.user_id AND s2.score IS NOT NULL
  )::int AS projects_count
FROM best;

-- ── 5. leaderboard_month view (rolling 30-day window) ──────────────────────
CREATE OR REPLACE VIEW public.leaderboard_month AS
WITH best AS (
  SELECT DISTINCT ON (user_id)
    id,
    user_id,
    project_name,
    repo_url,
    demo_url,
    tech_stack,
    score,
    performance,
    accessibility,
    best_practices,
    seo,
    evaluated_at,
    created_at,
    COALESCE(
      (SELECT split_part(u.email, '@', 1) FROM auth.users u WHERE u.id = s.user_id LIMIT 1),
      'Rider'
    ) AS username
  FROM public.submissions s
  WHERE score IS NOT NULL
    AND created_at >= now() - INTERVAL '30 days'
  ORDER BY user_id, score DESC
)
SELECT
  CAST(DENSE_RANK() OVER (ORDER BY score DESC) AS int) AS rank,
  id,
  user_id,
  username,
  project_name,
  repo_url,
  demo_url,
  tech_stack,
  ROUND(score)          AS score,
  ROUND(performance)    AS performance,
  ROUND(accessibility)  AS accessibility,
  ROUND(best_practices) AS best_practices,
  ROUND(seo)            AS seo,
  evaluated_at,
  created_at,
  (
    SELECT COUNT(*) FROM public.submissions s2
    WHERE s2.user_id = best.user_id AND s2.score IS NOT NULL
      AND s2.created_at >= now() - INTERVAL '30 days'
  )::int AS projects_count
FROM best;

-- ── 6. Useful index for performance ────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_submissions_user_score
  ON public.submissions (user_id, score DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_submissions_created_at
  ON public.submissions (created_at DESC);

-- ── 7. Grant SELECT on the views to the anon role (public leaderboard) ──────
GRANT SELECT ON public.leaderboard       TO anon;
GRANT SELECT ON public.leaderboard       TO authenticated;
GRANT SELECT ON public.leaderboard_month TO anon;
GRANT SELECT ON public.leaderboard_month TO authenticated;
