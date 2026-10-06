-- ============================================================
--  FrontendRiders — Web Craft Event 01: Full Update Migration
--  Migration: 003_web_craft_event_01_full.sql
--  Adds: 6-hour window, 2 submissions per participant,
--        MAX-score leaderboard, per-category scoring columns,
--        UPCOMING/LIVE/ENDED state, evaluation error handling.
-- ============================================================

-- ── 1. Add end_time to events table ──────────────────────────
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS end_time timestamptz;

-- Set the official end time: 18 October 2026 at 4:00 PM IST
UPDATE public.events
SET
  end_time   = '2026-10-18T16:00:00+05:30'::timestamptz,
  -- Update rules to reflect 2 submissions and scoring breakdown
  rules      = '[
    "Hackathon runs from 10:00 AM to 4:00 PM IST on 18 October 2026 (6 hours).",
    "Each participant may submit up to 2 times during the event window.",
    "Your final competition score is the HIGHEST score from your two attempts.",
    "Submissions must be original work created during the event timeframe.",
    "Submit a valid, publicly accessible deployed website URL (HTTPS).",
    "Application must be responsive across mobile (375px), tablet (768px), and desktop (1440px).",
    "Scoring: Problem Requirements (40 pts) + Functionality (20 pts) + Responsive (15 pts) + Performance (10 pts) + Accessibility (10 pts) + UI/UX (5 pts) = 100 pts.",
    "The evaluation system analyzes your submission automatically within minutes."
  ]'::jsonb,
  updated_at = now()
WHERE id = 'web-craft-01';

-- ── 2. Add new columns to submissions ────────────────────────

-- Attempt number (1 or 2)
ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS attempt_number    int     DEFAULT 1;

-- Evaluation status: PENDING | EVALUATING | EVALUATED | FAILED
ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS eval_status       text    DEFAULT 'PENDING';

-- Error message when evaluation fails
ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS eval_error        text;

-- Whether this row is the participant's best (highest) submission
ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS is_best           boolean DEFAULT false;

-- Per-category scores for the new 100-pt rubric
ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS score_problem     numeric(5,2);  -- 40 pts max

ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS score_functional  numeric(5,2);  -- 20 pts max

ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS score_responsive  numeric(5,2);  -- 15 pts max

ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS score_performance numeric(5,2);  -- 10 pts max

ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS score_a11y        numeric(5,2);  -- 10 pts max

ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS score_uiux        numeric(5,2);  -- 5 pts max

-- ── 3. Re-create leaderboard views to use MAX score ──────────
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
  WHERE score IS NOT NULL AND eval_status = 'EVALUATED'
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
   WHERE s2.user_id = best.user_id AND s2.score IS NOT NULL)::int AS projects_count,
  (SELECT COUNT(*) FROM public.submissions s3
   WHERE s3.user_id = best.user_id AND (s3.hackathon_id = 1 OR s3.hackathon_id IS NULL))::int AS submission_count
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
  WHERE score IS NOT NULL AND eval_status = 'EVALUATED'
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
   WHERE s2.user_id = best.user_id AND s2.score IS NOT NULL
     AND s2.created_at >= now() - INTERVAL '30 days')::int AS projects_count,
  (SELECT COUNT(*) FROM public.submissions s3
   WHERE s3.user_id = best.user_id AND (s3.hackathon_id = 1 OR s3.hackathon_id IS NULL))::int AS submission_count
FROM best;

GRANT SELECT ON public.leaderboard       TO anon, authenticated;
GRANT SELECT ON public.leaderboard_month TO anon, authenticated;

-- ── 4. Updated get_event_state RPC ───────────────────────────
CREATE OR REPLACE FUNCTION public.get_event_state(p_event_id text DEFAULT 'web-craft-01')
RETURNS jsonb AS $$
DECLARE
  ev         RECORD;
  now_ts     timestamptz := now();
  ev_end     timestamptz;
  phase      text;
  can_reveal boolean;
BEGIN
  SELECT * INTO ev FROM public.events WHERE id = p_event_id LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'event_id', p_event_id, 'event_name', 'WEB CRAFT', 'event_number', 'EVENT 01',
      'title', 'Web Craft - Event 01', 'event_date', '18 October 2026',
      'server_time', now_ts,
      'release_time', '2026-10-18T10:00:00+05:30'::timestamptz,
      'end_time', '2026-10-18T16:00:00+05:30'::timestamptz,
      'is_forced_open', false, 'is_forced_closed', false,
      'phase', 'UPCOMING', 'is_live', false,
      'problem_statement_locked', true,
      'problem_statement_title', 'Problem Statement Locked',
      'problem_statement', NULL, 'max_submissions', 2,
      'rules', jsonb_build_array(
        'Hackathon runs from 10:00 AM to 4:00 PM IST on 18 October 2026.',
        'Each participant may submit up to 2 times.',
        'Your final score is the HIGHEST score from your attempts.',
        'Submit a valid HTTPS deployed website URL.',
        'Application must be responsive across all viewports.'
      )
    );
  END IF;

  ev_end := coalesce(ev.end_time, '2026-10-18T16:00:00+05:30'::timestamptz);

  IF coalesce(ev.is_forced_closed, false) THEN
    phase := 'ENDED';
  ELSIF coalesce(ev.is_forced_open, false) THEN
    phase := 'LIVE';
  ELSIF now_ts >= ev_end THEN
    phase := 'ENDED';
  ELSIF now_ts >= ev.release_time THEN
    phase := 'LIVE';
  ELSE
    phase := 'UPCOMING';
  END IF;

  can_reveal := (phase = 'LIVE' OR phase = 'ENDED');

  RETURN jsonb_build_object(
    'event_id', ev.id, 'event_name', ev.event_name, 'event_number', ev.event_number,
    'title', ev.title, 'event_date', ev.event_date,
    'server_time', now_ts, 'release_time', ev.release_time, 'end_time', ev_end,
    'is_forced_open', ev.is_forced_open, 'is_forced_closed', ev.is_forced_closed,
    'phase', phase, 'is_live', (phase = 'LIVE'),
    'problem_statement_locked', NOT can_reveal,
    'problem_statement_title', CASE
      WHEN can_reveal THEN coalesce(ev.problem_statement_title, 'Web Craft Event 01 Challenge')
      ELSE 'Problem Statement Locked' END,
    'problem_statement', CASE WHEN can_reveal THEN ev.problem_statement_markdown ELSE NULL END,
    'max_submissions', 2,
    'rules', ev.rules
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.get_event_state(text) TO anon, authenticated;

-- ── 5. Updated trigger: 2 attempts + end time ────────────────
CREATE OR REPLACE FUNCTION public.validate_web_craft_submission()
RETURNS trigger AS $$
DECLARE
  ev_release     timestamptz;
  ev_end         timestamptz;
  ev_forced_open   boolean;
  ev_forced_closed boolean;
  now_ts         timestamptz := now();
  existing_count int;
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

  IF coalesce(ev_forced_closed, false) THEN
    RAISE EXCEPTION 'Web Craft Event 01 has ended. Submissions are now closed.';
  END IF;

  IF NOT coalesce(ev_forced_open, false) AND now_ts >= ev_end THEN
    RAISE EXCEPTION 'Web Craft Event 01 ended at 4:00 PM IST. Submissions are closed.';
  END IF;

  IF NOT coalesce(ev_forced_open, false) AND now_ts < ev_release THEN
    RAISE EXCEPTION 'Submissions are LOCKED until 18 October 2026, 10:00 AM IST. Server time: %', now_ts;
  END IF;

  IF NEW.user_id IS NULL AND auth.uid() IS NOT NULL THEN
    NEW.user_id := auth.uid();
  END IF;

  IF NEW.user_id IS NOT NULL THEN
    SELECT COUNT(*) INTO existing_count
    FROM public.submissions
    WHERE user_id = NEW.user_id
      AND (hackathon_id = 1 OR hackathon_id IS NULL)
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

DROP TRIGGER IF EXISTS trg_validate_web_craft_submission ON public.submissions;
CREATE TRIGGER trg_validate_web_craft_submission
  BEFORE INSERT ON public.submissions
  FOR EACH ROW EXECUTE FUNCTION public.validate_web_craft_submission();

-- ── 6. Function: mark best submission after evaluation ────────
CREATE OR REPLACE FUNCTION public.update_best_submission(
  p_user_id      uuid,
  p_hackathon_id int DEFAULT 1
)
RETURNS void AS $$
DECLARE best_id uuid;
BEGIN
  SELECT id INTO best_id
  FROM public.submissions
  WHERE user_id = p_user_id
    AND (hackathon_id = p_hackathon_id OR hackathon_id IS NULL)
    AND score IS NOT NULL AND eval_status = 'EVALUATED'
  ORDER BY score DESC LIMIT 1;

  UPDATE public.submissions SET is_best = false
  WHERE user_id = p_user_id
    AND (hackathon_id = p_hackathon_id OR hackathon_id IS NULL);

  IF best_id IS NOT NULL THEN
    UPDATE public.submissions SET is_best = true WHERE id = best_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.update_best_submission(uuid, int) TO service_role;

-- ── 7. Updated submit RPC ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.submit_web_craft_project(
  p_project_name text,
  p_demo_url     text,
  p_repo_url     text DEFAULT NULL,
  p_tech_stack   text DEFAULT NULL
)
RETURNS jsonb AS $$
DECLARE
  v_user_id        uuid;
  ev_release       timestamptz;
  ev_end           timestamptz;
  ev_forced_open   boolean;
  ev_forced_closed boolean;
  now_ts           timestamptz := now();
  existing_count   int;
  v_attempt        int;
  v_row            RECORD;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to submit a project.';
  END IF;

  SELECT
    release_time,
    coalesce(end_time, '2026-10-18T16:00:00+05:30'::timestamptz),
    is_forced_open, is_forced_closed
  INTO ev_release, ev_end, ev_forced_open, ev_forced_closed
  FROM public.events WHERE id = 'web-craft-01' LIMIT 1;

  IF ev_release IS NULL THEN
    ev_release := '2026-10-18T10:00:00+05:30'::timestamptz;
    ev_end     := '2026-10-18T16:00:00+05:30'::timestamptz;
  END IF;

  IF coalesce(ev_forced_closed, false) THEN
    RAISE EXCEPTION 'Web Craft Event 01 has ended. Submissions are now closed.';
  END IF;

  IF NOT coalesce(ev_forced_open, false) AND now_ts >= ev_end THEN
    RAISE EXCEPTION 'Submissions closed at 4:00 PM IST.';
  END IF;

  IF NOT coalesce(ev_forced_open, false) AND now_ts < ev_release THEN
    RAISE EXCEPTION 'Submissions are LOCKED until 18 October 2026, 10:00 AM IST.';
  END IF;

  IF p_demo_url IS NULL OR length(trim(p_demo_url)) = 0
     OR NOT (p_demo_url ~* '^https?://[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(/.*)?$') THEN
    RAISE EXCEPTION 'Please enter a valid live demo URL (https://...)';
  END IF;

  SELECT COUNT(*) INTO existing_count
  FROM public.submissions
  WHERE user_id = v_user_id AND (hackathon_id = 1 OR hackathon_id IS NULL);

  IF existing_count >= 2 THEN
    RAISE EXCEPTION 'You have used both submission attempts (2/2). Maximum 2 submissions allowed.';
  END IF;

  v_attempt := existing_count + 1;

  INSERT INTO public.submissions (
    user_id, hackathon_id, project_name, demo_url, repo_url,
    tech_stack, attempt_number, eval_status, created_at
  ) VALUES (
    v_user_id, 1, trim(p_project_name), trim(p_demo_url),
    nullif(trim(coalesce(p_repo_url, '')), ''),
    nullif(trim(coalesce(p_tech_stack, '')), ''),
    v_attempt, 'PENDING', now_ts
  ) RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'success', true, 'submission_id', v_row.id,
    'user_id', v_row.user_id, 'project_name', v_row.project_name,
    'demo_url', v_row.demo_url, 'attempt_number', v_row.attempt_number,
    'eval_status', v_row.eval_status, 'created_at', v_row.created_at
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.submit_web_craft_project(text, text, text, text) TO authenticated;

-- ── 8. get_my_submissions: returns all attempts ───────────────
CREATE OR REPLACE FUNCTION public.get_my_submissions(p_hackathon_id int DEFAULT 1)
RETURNS jsonb AS $$
DECLARE
  v_user_id uuid;
  v_subs    jsonb;
  v_count   int;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'submission_count', 0, 'max_submissions', 2,
      'best_score', NULL, 'submissions', '[]'::jsonb
    );
  END IF;

  SELECT COUNT(*) INTO v_count
  FROM public.submissions
  WHERE user_id = v_user_id AND (hackathon_id = p_hackathon_id OR hackathon_id IS NULL);

  SELECT jsonb_agg(
    jsonb_build_object(
      'id', s.id, 'project_name', s.project_name, 'demo_url', s.demo_url,
      'repo_url', s.repo_url, 'tech_stack', s.tech_stack,
      'attempt_number', s.attempt_number, 'eval_status', s.eval_status,
      'eval_error', s.eval_error, 'is_best', s.is_best,
      'score', s.score, 'performance', s.performance,
      'accessibility', s.accessibility, 'best_practices', s.best_practices, 'seo', s.seo,
      'score_problem', s.score_problem, 'score_functional', s.score_functional,
      'score_responsive', s.score_responsive, 'score_performance', s.score_performance,
      'score_a11y', s.score_a11y, 'score_uiux', s.score_uiux,
      'evaluated_at', s.evaluated_at, 'created_at', s.created_at
    ) ORDER BY s.attempt_number ASC
  ) INTO v_subs
  FROM public.submissions s
  WHERE s.user_id = v_user_id AND (s.hackathon_id = p_hackathon_id OR s.hackathon_id IS NULL);

  RETURN jsonb_build_object(
    'submission_count', v_count,
    'max_submissions', 2,
    'best_score', (
      SELECT MAX(score) FROM public.submissions
      WHERE user_id = v_user_id
        AND (hackathon_id = p_hackathon_id OR hackathon_id IS NULL)
        AND score IS NOT NULL AND eval_status = 'EVALUATED'
    ),
    'submissions', coalesce(v_subs, '[]'::jsonb)
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.get_my_submissions(int) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_submission(p_hackathon_id int DEFAULT 1)
RETURNS jsonb AS $$
  SELECT public.get_my_submissions(p_hackathon_id);
$$ LANGUAGE sql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.get_my_submission(int) TO authenticated;

-- ── 9. Updated organizer submissions view ────────────────────
CREATE OR REPLACE FUNCTION public.organizer_get_submissions(
  p_event_id      text DEFAULT 'web-craft-01',
  p_organizer_key text DEFAULT 'webcraft2026admin'
)
RETURNS jsonb AS $$
DECLARE
  ev   RECORD;
  subs jsonb;
BEGIN
  SELECT * INTO ev FROM public.events WHERE id = p_event_id LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event not found.'; END IF;
  IF p_organizer_key <> ev.organizer_key AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Unauthorized.';
  END IF;

  SELECT jsonb_agg(
    jsonb_build_object(
      'id', s.id, 'user_id', s.user_id,
      'participant_email', coalesce(
        (SELECT split_part(u.email, '@', 1) || '@...' FROM auth.users u WHERE u.id = s.user_id LIMIT 1),
        'Participant'
      ),
      'project_name', s.project_name, 'demo_url', s.demo_url,
      'attempt_number', coalesce(s.attempt_number, 1),
      'eval_status', coalesce(s.eval_status, 'PENDING'),
      'eval_error', s.eval_error, 'is_best', coalesce(s.is_best, false),
      'score', s.score,
      'score_problem', s.score_problem, 'score_functional', s.score_functional,
      'score_responsive', s.score_responsive, 'score_performance', s.score_performance,
      'score_a11y', s.score_a11y, 'score_uiux', s.score_uiux,
      'performance', s.performance, 'accessibility', s.accessibility,
      'best_practices', s.best_practices, 'seo', s.seo,
      'evaluated_at', s.evaluated_at, 'created_at', s.created_at
    ) ORDER BY s.created_at DESC
  ) INTO subs
  FROM public.submissions s
  WHERE s.hackathon_id = 1 OR s.hackathon_id IS NULL;

  RETURN coalesce(subs, '[]'::jsonb);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.organizer_get_submissions(text, text) TO anon, authenticated;

-- ── 10. Indexes ───────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_submissions_user_hackathon
  ON public.submissions (user_id, hackathon_id);

CREATE INDEX IF NOT EXISTS idx_submissions_is_best
  ON public.submissions (user_id, is_best);

CREATE INDEX IF NOT EXISTS idx_submissions_eval_status
  ON public.submissions (eval_status);
