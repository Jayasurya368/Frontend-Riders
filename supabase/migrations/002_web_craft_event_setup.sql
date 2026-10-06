-- ============================================================
--  FrontendRiders — Web Craft Event 01 Database Setup Script
--  Migration: 002_web_craft_event_setup.sql
--  Enforces Server-Side Time Validation, Problem Statement
--  Release, Duplicate Prevention, and Organizer Controls.
-- ============================================================

-- ── 1. Create events configuration table ──────────────────────
CREATE TABLE IF NOT EXISTS public.events (
  id                          text PRIMARY KEY DEFAULT 'web-craft-01',
  event_name                  text NOT NULL DEFAULT 'WEB CRAFT',
  event_number                text NOT NULL DEFAULT 'EVENT 01',
  title                       text NOT NULL DEFAULT 'Web Craft – Event 01',
  event_date                  text NOT NULL DEFAULT '18 October 2026',
  release_time                timestamptz NOT NULL DEFAULT '2026-10-18T10:00:00+05:30',
  is_forced_open              boolean NOT NULL DEFAULT false,
  is_forced_closed            boolean NOT NULL DEFAULT false,
  problem_statement_title     text DEFAULT 'Problem Statement Locked',
  problem_statement_markdown  text DEFAULT NULL,
  rules                       jsonb DEFAULT '["Submissions must be original work created during the event timeframe.", "Submit a valid, publicly accessible deployed website URL (HTTPS).", "Application must be responsive across mobile, tablet, and desktop viewports.", "Automated Lighthouse evaluation tests Performance, Accessibility, Best Practices, and SEO.", "Only one submission per registered participant is permitted."]'::jsonb,
  organizer_email             text DEFAULT 'admin@frontendriders.dev',
  organizer_key               text DEFAULT 'webcraft2026admin',
  created_at                  timestamptz DEFAULT now() NOT NULL,
  updated_at                  timestamptz DEFAULT now() NOT NULL
);

-- Seed initial row for Web Craft Event 01
INSERT INTO public.events (
  id,
  event_name,
  event_number,
  title,
  event_date,
  release_time,
  is_forced_open,
  is_forced_closed,
  problem_statement_title,
  problem_statement_markdown
)
VALUES (
  'web-craft-01',
  'WEB CRAFT',
  'EVENT 01',
  'Web Craft – Event 01',
  '18 October 2026',
  '2026-10-18T10:00:00+05:30'::timestamptz,
  false,
  false,
  'Problem Statement Locked',
  NULL
)
ON CONFLICT (id) DO UPDATE SET
  release_time = '2026-10-18T10:00:00+05:30'::timestamptz,
  event_date = '18 October 2026',
  event_name = 'WEB CRAFT',
  event_number = 'EVENT 01';

-- Enable Row Level Security
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;

-- Drop previous policies if re-running
DROP POLICY IF EXISTS "Public read events" ON public.events;
DROP POLICY IF EXISTS "Auth update events" ON public.events;

-- Anyone can read the event configuration
CREATE POLICY "Public read events"
  ON public.events FOR SELECT
  USING (true);

-- Authenticated users or organizers can update event settings
CREATE POLICY "Auth update events"
  ON public.events FOR UPDATE
  USING (auth.role() = 'service_role' OR auth.uid() IS NOT NULL);

-- Enable Supabase Realtime on events table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.events;
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- Fallback if publication doesn't exist or already added
  NULL;
END;
$$;

-- ── 2. Trusted Server Time RPC ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_server_time()
RETURNS timestamptz AS $$
BEGIN
  RETURN now();
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.get_server_time() TO anon, authenticated;

-- ── 3. Secure Event State RPC ──────────────────────────────────
-- Only reveals problem_statement when server timestamp >= release_time
-- or when explicitly forced open by the organizer.
CREATE OR REPLACE FUNCTION public.get_event_state(p_event_id text DEFAULT 'web-craft-01')
RETURNS jsonb AS $$
DECLARE
  ev RECORD;
  now_ts timestamptz := now();
  is_live_status boolean;
  can_reveal boolean;
BEGIN
  SELECT * INTO ev FROM public.events WHERE id = p_event_id LIMIT 1;
  IF NOT FOUND THEN
    -- Fallback defaults matching official schedule
    RETURN jsonb_build_object(
      'event_id', p_event_id,
      'event_name', 'WEB CRAFT',
      'event_number', 'EVENT 01',
      'title', 'Web Craft – Event 01',
      'event_date', '18 October 2026',
      'server_time', now_ts,
      'release_time', '2026-10-18T10:00:00+05:30'::timestamptz,
      'is_forced_open', false,
      'is_forced_closed', false,
      'is_live', false,
      'problem_statement_locked', true,
      'problem_statement_title', 'Problem Statement Locked',
      'problem_statement', NULL,
      'rules', jsonb_build_array(
        'Submissions must be original work created during the event timeframe.',
        'Submit a valid, publicly accessible deployed website URL (HTTPS).',
        'Application must be responsive across mobile, tablet, and desktop viewports.',
        'Automated Lighthouse evaluation tests Performance, Accessibility, Best Practices, and SEO.',
        'Only one submission per registered participant is permitted.'
      )
    );
  END IF;

  is_live_status := (now_ts >= ev.release_time OR coalesce(ev.is_forced_open, false)) AND NOT coalesce(ev.is_forced_closed, false);
  can_reveal := is_live_status;

  RETURN jsonb_build_object(
    'event_id', ev.id,
    'event_name', ev.event_name,
    'event_number', ev.event_number,
    'title', ev.title,
    'event_date', ev.event_date,
    'server_time', now_ts,
    'release_time', ev.release_time,
    'is_forced_open', ev.is_forced_open,
    'is_forced_closed', ev.is_forced_closed,
    'is_live', is_live_status,
    'problem_statement_locked', NOT can_reveal,
    'problem_statement_title', CASE
      WHEN can_reveal THEN coalesce(ev.problem_statement_title, 'Web Craft Event 01 Challenge')
      ELSE 'Problem Statement Locked'
    END,
    'problem_statement', CASE
      WHEN can_reveal THEN ev.problem_statement_markdown
      ELSE NULL
    END,
    'rules', ev.rules
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.get_event_state(text) TO anon, authenticated;

-- ── 4. Server-Side Trigger: Enforce Release Time & Anti-Duplicate ───
CREATE OR REPLACE FUNCTION public.validate_web_craft_submission()
RETURNS trigger AS $$
DECLARE
  ev_release timestamptz;
  ev_forced_open boolean;
  ev_forced_closed boolean;
  now_ts timestamptz := now();
BEGIN
  -- Look up Web Craft Event 01 settings
  SELECT release_time, is_forced_open, is_forced_closed
  INTO ev_release, ev_forced_open, ev_forced_closed
  FROM public.events
  WHERE id = 'web-craft-01'
  LIMIT 1;

  IF ev_release IS NULL THEN
    ev_release := '2026-10-18T10:00:00+05:30'::timestamptz;
    ev_forced_open := false;
    ev_forced_closed := false;
  END IF;

  -- Allow service_role bypass for administrative operations
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Enforce release time check against trusted database clock
  IF coalesce(ev_forced_closed, false) = true THEN
    RAISE EXCEPTION 'Submissions for Web Craft Event 01 are closed.';
  END IF;

  IF NOT coalesce(ev_forced_open, false) AND now_ts < ev_release THEN
    RAISE EXCEPTION 'Submissions are LOCKED until 18 October 2026, 10:00 AM IST (Asia/Kolkata). Current server time: %', now_ts;
  END IF;

  -- Check authentication
  IF NEW.user_id IS NULL AND auth.uid() IS NOT NULL THEN
    NEW.user_id := auth.uid();
  END IF;

  -- Enforce duplicate submission restriction
  IF NEW.user_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.submissions
      WHERE user_id = NEW.user_id
        AND (hackathon_id = 1 OR hackathon_id IS NULL OR NEW.hackathon_id = 1)
        AND id <> coalesce(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
    ) THEN
      RAISE EXCEPTION 'You have already submitted a project for Web Craft Event 01. Duplicate submissions are not allowed.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_validate_web_craft_submission ON public.submissions;
CREATE TRIGGER trg_validate_web_craft_submission
  BEFORE INSERT ON public.submissions
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_web_craft_submission();

-- ── 5. Secure Submission RPC ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.submit_web_craft_project(
  p_project_name text,
  p_demo_url text,
  p_repo_url text DEFAULT NULL,
  p_tech_stack text DEFAULT NULL
)
RETURNS jsonb AS $$
DECLARE
  v_user_id uuid;
  v_submission_id uuid;
  ev_release timestamptz;
  ev_forced_open boolean;
  ev_forced_closed boolean;
  now_ts timestamptz := now();
  v_row RECORD;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to submit a project.';
  END IF;

  -- Verify release time
  SELECT release_time, is_forced_open, is_forced_closed
  INTO ev_release, ev_forced_open, ev_forced_closed
  FROM public.events
  WHERE id = 'web-craft-01'
  LIMIT 1;

  IF ev_release IS NULL THEN
    ev_release := '2026-10-18T10:00:00+05:30'::timestamptz;
  END IF;

  IF NOT coalesce(ev_forced_open, false) AND now_ts < ev_release THEN
    RAISE EXCEPTION 'Submissions are LOCKED until 18 October 2026, 10:00 AM IST.';
  END IF;

  -- Validate deployed demo URL
  IF p_demo_url IS NULL OR length(trim(p_demo_url)) = 0 OR NOT (p_demo_url ~* '^https?://[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(/.*)?$') THEN
    RAISE EXCEPTION 'Please enter a valid live demo URL starting with http:// or https://';
  END IF;

  -- Check duplicate
  IF EXISTS (
    SELECT 1 FROM public.submissions
    WHERE user_id = v_user_id AND (hackathon_id = 1 OR hackathon_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'You have already submitted a project for Web Craft Event 01.';
  END IF;

  -- Insert submission
  INSERT INTO public.submissions (
    user_id,
    hackathon_id,
    project_name,
    demo_url,
    repo_url,
    tech_stack,
    created_at
  )
  VALUES (
    v_user_id,
    1,
    trim(p_project_name),
    trim(p_demo_url),
    trim(coalesce(p_repo_url, '')),
    trim(coalesce(p_tech_stack, '')),
    now_ts
  )
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'success', true,
    'submission_id', v_row.id,
    'user_id', v_row.user_id,
    'project_name', v_row.project_name,
    'demo_url', v_row.demo_url,
    'repo_url', v_row.repo_url,
    'tech_stack', v_row.tech_stack,
    'created_at', v_row.created_at
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.submit_web_craft_project(text, text, text, text) TO authenticated;

-- ── 6. Participant Check Submission Status RPC ─────────────────
CREATE OR REPLACE FUNCTION public.get_my_submission(p_hackathon_id int DEFAULT 1)
RETURNS jsonb AS $$
DECLARE
  v_user_id uuid;
  v_sub RECORD;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('submitted', false, 'submission', NULL);
  END IF;

  SELECT * INTO v_sub
  FROM public.submissions
  WHERE user_id = v_user_id AND (hackathon_id = p_hackathon_id OR hackathon_id IS NULL)
  ORDER BY created_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('submitted', false, 'submission', NULL);
  END IF;

  RETURN jsonb_build_object(
    'submitted', true,
    'submission', jsonb_build_object(
      'id', v_sub.id,
      'project_name', v_sub.project_name,
      'demo_url', v_sub.demo_url,
      'repo_url', v_sub.repo_url,
      'tech_stack', v_sub.tech_stack,
      'score', v_sub.score,
      'performance', v_sub.performance,
      'accessibility', v_sub.accessibility,
      'best_practices', v_sub.best_practices,
      'seo', v_sub.seo,
      'evaluated_at', v_sub.evaluated_at,
      'created_at', v_sub.created_at
    )
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.get_my_submission(int) TO authenticated;

-- ── 7. Organizer Management RPC Functions ─────────────────────
CREATE OR REPLACE FUNCTION public.organizer_update_event(
  p_event_id text,
  p_organizer_key text,
  p_problem_statement_title text,
  p_problem_statement_markdown text,
  p_is_forced_open boolean DEFAULT NULL,
  p_is_forced_closed boolean DEFAULT NULL
)
RETURNS jsonb AS $$
DECLARE
  ev RECORD;
BEGIN
  SELECT * INTO ev FROM public.events WHERE id = p_event_id LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event not found.';
  END IF;

  -- Authenticate organizer key or admin session
  IF p_organizer_key <> ev.organizer_key AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Invalid organizer credentials.';
  END IF;

  UPDATE public.events
  SET
    problem_statement_title = coalesce(p_problem_statement_title, problem_statement_title),
    problem_statement_markdown = p_problem_statement_markdown,
    is_forced_open = coalesce(p_is_forced_open, is_forced_open),
    is_forced_closed = coalesce(p_is_forced_closed, is_forced_closed),
    updated_at = now()
  WHERE id = p_event_id;

  RETURN public.get_event_state(p_event_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.organizer_update_event(text, text, text, text, boolean, boolean) TO anon, authenticated;

-- Organizer: Fetch all submissions with participant email and timestamps
CREATE OR REPLACE FUNCTION public.organizer_get_submissions(
  p_event_id text DEFAULT 'web-craft-01',
  p_organizer_key text DEFAULT 'webcraft2026admin'
)
RETURNS jsonb AS $$
DECLARE
  ev RECORD;
  subs jsonb;
BEGIN
  SELECT * INTO ev FROM public.events WHERE id = p_event_id LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event not found.';
  END IF;

  IF p_organizer_key <> ev.organizer_key AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Unauthorized.';
  END IF;

  SELECT jsonb_agg(
    jsonb_build_object(
      'id', s.id,
      'user_id', s.user_id,
      'participant_email', coalesce(
        (SELECT split_part(u.email, '@', 1) || '@...' FROM auth.users u WHERE u.id = s.user_id LIMIT 1),
        'Participant'
      ),
      'project_name', s.project_name,
      'demo_url', s.demo_url,
      'repo_url', s.repo_url,
      'tech_stack', s.tech_stack,
      'score', s.score,
      'performance', s.performance,
      'accessibility', s.accessibility,
      'best_practices', s.best_practices,
      'seo', s.seo,
      'evaluated_at', s.evaluated_at,
      'created_at', s.created_at
    )
  ) INTO subs
  FROM public.submissions s
  WHERE s.hackathon_id = 1 OR s.hackathon_id IS NULL
  ORDER BY s.created_at DESC;

  RETURN coalesce(subs, '[]'::jsonb);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.organizer_get_submissions(text, text) TO anon, authenticated;
