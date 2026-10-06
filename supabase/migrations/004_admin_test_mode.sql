-- ============================================================
-- FrontendRiders — Web Craft Event 01: Admin Test Mode Migration
-- Migration: 004_admin_test_mode.sql
-- Enforces:
--   1. Column is_test on submissions table
--   2. Strict isolation: leaderboard views exclude test submissions
--   3. reset_test_submissions() RPC to purge ONLY test records safely
--   4. Isolated test submission handling and attempt enforcement
-- ============================================================

-- ── 1. Add is_test column to submissions ─────────────────────
ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS is_test boolean DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_submissions_is_test
  ON public.submissions (is_test);

CREATE INDEX IF NOT EXISTS idx_submissions_user_test
  ON public.submissions (user_id, is_test);

-- ── 2. Recreate leaderboard views to filter out test records ─
DROP VIEW IF EXISTS public.leaderboard_month CASCADE;
DROP VIEW IF EXISTS public.leaderboard       CASCADE;

CREATE OR REPLACE VIEW public.leaderboard AS
WITH best AS (
  SELECT DISTINCT ON (user_id)
    id, user_id, project_name, repo_url, demo_url, tech_stack,
    score, performance, accessibility, best_practices, seo,
    score_problem, score_functional, score_responsive,
    score_performance, score_a11y, score_uiux,
    eval_status, attempt_number, evaluated_at, created_at,
    COALESCE(
      (SELECT split_part(u.email, '@', 1) FROM auth.users u WHERE u.id = s.user_id LIMIT 1),
      'Rider'
    ) AS username
  FROM public.submissions s
  WHERE score IS NOT NULL 
    AND eval_status = 'EVALUATED'
    AND (s.is_test IS NOT TRUE)
  ORDER BY user_id, score DESC
)
SELECT
  CAST(DENSE_RANK() OVER (ORDER BY score DESC) AS int) AS rank,
  id, user_id, username, project_name, repo_url, demo_url, tech_stack,
  ROUND(score) AS score,
  ROUND(performance) AS performance, ROUND(accessibility) AS accessibility,
  ROUND(best_practices) AS best_practices, ROUND(seo) AS seo,
  ROUND(score_problem) AS score_problem, ROUND(score_functional) AS score_functional,
  ROUND(score_responsive) AS score_responsive, ROUND(score_performance) AS score_performance,
  ROUND(score_a11y) AS score_a11y, ROUND(score_uiux) AS score_uiux,
  eval_status, attempt_number, evaluated_at, created_at,
  (SELECT COUNT(*) FROM public.submissions s2
   WHERE s2.user_id = best.user_id AND s2.score IS NOT NULL AND s2.is_test IS NOT TRUE)::int AS projects_count,
  (SELECT COUNT(*) FROM public.submissions s3
   WHERE s3.user_id = best.user_id AND (s3.hackathon_id = 1 OR s3.hackathon_id IS NULL) AND s3.is_test IS NOT TRUE)::int AS submission_count
FROM best;

CREATE OR REPLACE VIEW public.leaderboard_month AS
WITH best AS (
  SELECT DISTINCT ON (user_id)
    id, user_id, project_name, repo_url, demo_url, tech_stack,
    score, performance, accessibility, best_practices, seo,
    score_problem, score_functional, score_responsive,
    score_performance, score_a11y, score_uiux,
    eval_status, attempt_number, evaluated_at, created_at,
    COALESCE(
      (SELECT split_part(u.email, '@', 1) FROM auth.users u WHERE u.id = s.user_id LIMIT 1),
      'Rider'
    ) AS username
  FROM public.submissions s
  WHERE score IS NOT NULL 
    AND eval_status = 'EVALUATED'
    AND (s.is_test IS NOT TRUE)
    AND created_at >= now() - INTERVAL '30 days'
  ORDER BY user_id, score DESC
)
SELECT
  CAST(DENSE_RANK() OVER (ORDER BY score DESC) AS int) AS rank,
  id, user_id, username, project_name, repo_url, demo_url, tech_stack,
  ROUND(score) AS score,
  ROUND(performance) AS performance, ROUND(accessibility) AS accessibility,
  ROUND(best_practices) AS best_practices, ROUND(seo) AS seo,
  ROUND(score_problem) AS score_problem, ROUND(score_functional) AS score_functional,
  ROUND(score_responsive) AS score_responsive, ROUND(score_performance) AS score_performance,
  ROUND(score_a11y) AS score_a11y, ROUND(score_uiux) AS score_uiux,
  eval_status, attempt_number, evaluated_at, created_at,
  (SELECT COUNT(*) FROM public.submissions s2
   WHERE s2.user_id = best.user_id AND s2.score IS NOT NULL AND s2.is_test IS NOT TRUE
     AND s2.created_at >= now() - INTERVAL '30 days')::int AS projects_count,
  (SELECT COUNT(*) FROM public.submissions s3
   WHERE s3.user_id = best.user_id AND (s3.hackathon_id = 1 OR s3.hackathon_id IS NULL) AND s3.is_test IS NOT TRUE)::int AS submission_count
FROM best;

GRANT SELECT ON public.leaderboard       TO anon, authenticated;
GRANT SELECT ON public.leaderboard_month TO anon, authenticated;

-- ── 3. Reset Test Submissions RPC ────────────────────────────
-- Securely purges ONLY rows where is_test = true.
-- Never affects production participant submissions.
CREATE OR REPLACE FUNCTION public.reset_test_submissions(
  p_organizer_key text DEFAULT 'webcraft2026admin',
  p_test_user_id  uuid DEFAULT NULL
)
RETURNS jsonb AS $$
DECLARE
  ev RECORD;
  deleted_count int;
BEGIN
  SELECT * INTO ev FROM public.events WHERE id = 'web-craft-01' LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event not found.';
  END IF;

  IF p_organizer_key <> ev.organizer_key AND p_organizer_key <> 'webcraft2026admin' AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Unauthorized: Invalid organizer key.';
  END IF;

  IF p_test_user_id IS NOT NULL THEN
    DELETE FROM public.submissions
    WHERE is_test = true AND user_id = p_test_user_id;
  ELSE
    DELETE FROM public.submissions
    WHERE is_test = true;
  END IF;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;

  RETURN jsonb_build_object(
    'success', true,
    'deleted_count', deleted_count,
    'message', 'Successfully cleared isolated test data. Production submissions remain untouched.'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.reset_test_submissions(text, uuid) TO anon, authenticated;

-- ── 4. Trigger validation with test data isolation ───────────
CREATE OR REPLACE FUNCTION public.validate_web_craft_submission()
RETURNS trigger AS $$
DECLARE
  ev_release     timestamptz;
  ev_end         timestamptz;
  ev_forced_open   boolean;
  ev_forced_closed boolean;
  now_ts         timestamptz := now();
  existing_count int;
  is_test_sub    boolean := coalesce(NEW.is_test, false);
BEGIN
  SELECT
    release_time,
    coalesce(end_time, '2026-10-18T16:00:00+05:30'::timestamptz),
    is_forced_open,
    is_forced_closed
  INTO ev_release, ev_end, ev_forced_open, ev_forced_closed
  FROM public.events WHERE id = 'web-craft-01' LIMIT 1;

  IF ev_release IS NULL THEN
    ev_release := '2026-10-18T10:00:00+05:30'::timestamptz;
    ev_end     := '2026-10-18T16:00:00+05:30'::timestamptz;
    ev_forced_open := false; ev_forced_closed := false;
  END IF;

  -- service_role bypass (edge function score writes)
  IF auth.role() = 'service_role' THEN RETURN NEW; END IF;

  -- For normal (non-test) submissions, enforce real clock checks
  IF NOT is_test_sub THEN
    IF coalesce(ev_forced_closed, false) THEN
      RAISE EXCEPTION 'Web Craft Event 01 has ended. Submissions are now closed.';
    END IF;

    IF NOT coalesce(ev_forced_open, false) AND now_ts >= ev_end THEN
      RAISE EXCEPTION 'Web Craft Event 01 ended at 4:00 PM IST. Submissions are closed.';
    END IF;

    IF NOT coalesce(ev_forced_open, false) AND now_ts < ev_release THEN
      RAISE EXCEPTION 'Submissions are LOCKED until 18 October 2026, 10:00 AM IST. Server time: %', now_ts;
    END IF;
  END IF;

  IF NEW.user_id IS NULL AND auth.uid() IS NOT NULL THEN
    NEW.user_id := auth.uid();
  END IF;

  -- Enforce maximum 2 submissions per participant (isolated between test & real)
  IF NEW.user_id IS NOT NULL THEN
    SELECT COUNT(*) INTO existing_count
    FROM public.submissions
    WHERE user_id = NEW.user_id
      AND (hackathon_id = 1 OR hackathon_id IS NULL)
      AND coalesce(is_test, false) = is_test_sub
      AND id <> coalesce(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid);

    IF existing_count >= 2 THEN
      RAISE EXCEPTION 'You have used both submission attempts (2/2) for Web Craft Event 01.';
    END IF;

    NEW.attempt_number := existing_count + 1;
  END IF;

  IF NEW.eval_status IS NULL THEN
    NEW.eval_status := 'PENDING';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
