/**
 * evaluate-project — Supabase Edge Function
 *
 * Triggered by the frontend after a submission row is inserted.
 * Pipeline:
 *   1. Fetch submission row (demo_url, user_id, attempt_number).
 *   2. Check the site is reachable (HTTP HEAD).
 *   3. Call Google PageSpeed Insights v5 (mobile strategy).
 *   4. Map Lighthouse scores → new 100-pt rubric:
 *        Problem Requirements    40 pts  (requires the organizer to set criteria;
 *                                         approximated from overall PSI score until
 *                                         AI evaluation is integrated)
 *        Functionality           20 pts  (best-practices + accessibility proxy)
 *        Responsive Design       15 pts  (mobile LCP / layout stability proxy)
 *        Performance             10 pts  (Lighthouse performance score)
 *        Accessibility           10 pts  (Lighthouse accessibility score)
 *        UI/UX & Visual Quality   5 pts  (SEO + best-practices quality proxy)
 *
 *        Total = 100 pts
 *
 *   5. Write scores back to `submissions` row.
 *   6. Call update_best_submission() so is_best is always correct.
 *
 * Supabase Secrets required:
 *   PAGESPEED_API_KEY          — Google Cloud API key (optional; free tier without key)
 *   SUPABASE_URL               — auto-injected
 *   SUPABASE_SERVICE_ROLE_KEY  — auto-injected
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── CORS headers ─────────────────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

const round = (n: number) => Math.round(n * 100) / 100;

// ── Scoring rubric weights (must sum to 1.0) ─────────────────────────────────
// Maps from Lighthouse/PSI raw score (0-1) to rubric category
const MAX_POINTS = {
  problem:     40,
  functional:  20,
  responsive:  15,
  performance: 10,
  a11y:        10,
  uiux:         5,
} as const;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { submission_id } = await req.json() as { submission_id: string };
    if (!submission_id) {
      return json({ error: "submission_id is required" }, 400);
    }

    // ── Build Supabase admin client ──────────────────────────────────────────
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    // ── Fetch submission row ─────────────────────────────────────────────────
    const { data: submission, error: fetchErr } = await supabaseAdmin
      .from("submissions")
      .select("id, demo_url, user_id, attempt_number, hackathon_id")
      .eq("id", submission_id)
      .single();

    if (fetchErr || !submission) {
      return json({ error: fetchErr?.message ?? "Submission not found" }, 404);
    }

    const { demo_url, user_id, hackathon_id } = submission;

    if (!demo_url) {
      await supabaseAdmin.from("submissions").update({
        eval_status: "FAILED",
        eval_error:  "Submission has no demo_url",
      }).eq("id", submission_id);
      return json({ error: "Submission has no demo_url" }, 422);
    }

    // ── Mark as EVALUATING ───────────────────────────────────────────────────
    await supabaseAdmin.from("submissions").update({
      eval_status: "EVALUATING",
    }).eq("id", submission_id);

    // ── Reachability check ───────────────────────────────────────────────────
    let isReachable = false;
    try {
      const probe = await fetch(demo_url, {
        method: "HEAD",
        signal: AbortSignal.timeout(10_000),
      });
      isReachable = probe.ok || probe.status < 500;
    } catch (reachErr) {
      console.warn("[evaluate-project] Reachability check failed:", reachErr);
    }

    if (!isReachable) {
      await supabaseAdmin.from("submissions").update({
        eval_status: "FAILED",
        eval_error:  `Site at ${demo_url} is not reachable or returned a server error. Evaluation skipped.`,
      }).eq("id", submission_id);
      return json({
        error: `Site not reachable: ${demo_url}`,
        note:  "Submission attempt is preserved. Contact the organizer if you believe this is an error.",
      }, 200);
    }

    // ── Call Google PageSpeed Insights v5 (mobile) ───────────────────────────
    const apiKey = Deno.env.get("PAGESPEED_API_KEY") ?? "";
    const categories = ["performance", "accessibility", "best-practices", "seo"];
    const catParams = categories.map(c => `category=${c}`).join("&");
    const keyParam = apiKey ? `&key=${apiKey}` : "";
    const psiUrl =
      `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(demo_url)}&strategy=mobile&${catParams}${keyParam}`;

    const psiRes = await fetch(psiUrl, { signal: AbortSignal.timeout(60_000) });
    if (!psiRes.ok) {
      const body = await psiRes.text();
      await supabaseAdmin.from("submissions").update({
        eval_status: "FAILED",
        eval_error:  `PageSpeed API error ${psiRes.status}: ${body.slice(0, 500)}`,
      }).eq("id", submission_id);
      return json({
        error: `PageSpeed API error ${psiRes.status}`,
        note:  "Evaluation failed due to PSI API error. Submission preserved.",
      }, 200);
    }

    const psiData = await psiRes.json();
    const cats = psiData?.lighthouseResult?.categories;

    if (!cats) {
      await supabaseAdmin.from("submissions").update({
        eval_status: "FAILED",
        eval_error:  "No Lighthouse categories in PageSpeed response.",
      }).eq("id", submission_id);
      return json({ error: "No Lighthouse data returned." }, 200);
    }

    // ── Extract raw PSI scores (0–1) → 0–100 ────────────────────────────────
    const psiPerf    = round((cats["performance"]?.score    ?? 0) * 100);
    const psiA11y    = round((cats["accessibility"]?.score  ?? 0) * 100);
    const psiBP      = round((cats["best-practices"]?.score ?? 0) * 100);
    const psiSeo     = round((cats["seo"]?.score            ?? 0) * 100);

    // Weighted composite for backward-compat `score` field (legacy PSI weight)
    const legacyWeightedScore = round(
      psiPerf * 0.35 +
      psiA11y * 0.30 +
      psiBP   * 0.20 +
      psiSeo  * 0.15,
    );

    // ── Map to new 100-pt rubric ─────────────────────────────────────────────
    //
    // Problem Requirements (40 pts):
    //   True requirement checking needs the organizer's problem statement.
    //   Approximation: use overall PSI composite as a quality proxy scaled to 40 pts.
    //   When a dedicated AI evaluation layer is added, this can be replaced.
    const problemProxy = legacyWeightedScore / 100;   // 0..1
    const scoreP  = round(problemProxy * MAX_POINTS.problem);

    // Functionality & Interaction (20 pts):
    //   Best Practices + Accessibility average → proxy for working functionality
    const funcProxy = ((psiBP + psiA11y) / 2) / 100;
    const scoreF  = round(funcProxy * MAX_POINTS.functional);

    // Responsive Design (15 pts):
    //   PSI mobile performance encapsulates LCP, CLS, layout shift → good responsive proxy
    const respProxy = psiPerf / 100;
    const scoreR  = round(respProxy * MAX_POINTS.responsive);

    // Performance (10 pts):
    //   Directly from Lighthouse performance (mobile)
    const scorePerf = round((psiPerf / 100) * MAX_POINTS.performance);

    // Accessibility (10 pts):
    //   Directly from Lighthouse accessibility
    const scoreA  = round((psiA11y / 100) * MAX_POINTS.a11y);

    // UI/UX & Visual Quality (5 pts):
    //   SEO score correlates with clean markup, structured content, readability
    const scoreU  = round((psiSeo / 100) * MAX_POINTS.uiux);

    // Total
    const totalScore = Math.min(100, Math.round(
      scoreP + scoreF + scoreR + scorePerf + scoreA + scoreU
    ));

    // ── Write scores back ────────────────────────────────────────────────────
    const { error: updateErr } = await supabaseAdmin
      .from("submissions")
      .update({
        // New rubric columns
        score_problem:     scoreP,
        score_functional:  scoreF,
        score_responsive:  scoreR,
        score_performance: scorePerf,
        score_a11y:        scoreA,
        score_uiux:        scoreU,
        // Primary score (used by leaderboard)
        score:             totalScore,
        // Legacy Lighthouse columns (kept for backward compatibility)
        performance:       psiPerf,
        accessibility:     psiA11y,
        best_practices:    psiBP,
        seo:               psiSeo,
        // Status
        eval_status:       "EVALUATED",
        eval_error:        null,
        evaluated_at:      new Date().toISOString(),
      })
      .eq("id", submission_id);

    if (updateErr) {
      return json({ error: updateErr.message }, 500);
    }

    // ── Update is_best flag (server-side) ────────────────────────────────────
    if (user_id) {
      const hid = hackathon_id ?? 1;
      await supabaseAdmin.rpc("update_best_submission", {
        p_user_id:      user_id,
        p_hackathon_id: hid,
      }).catch(e => console.warn("[evaluate-project] update_best_submission:", e));
    }

    // ── Return results ───────────────────────────────────────────────────────
    return json({
      submission_id,
      score:             totalScore,
      score_problem:     scoreP,
      score_functional:  scoreF,
      score_responsive:  scoreR,
      score_performance: scorePerf,
      score_a11y:        scoreA,
      score_uiux:        scoreU,
      // legacy
      performance:       psiPerf,
      accessibility:     psiA11y,
      best_practices:    psiBP,
      seo:               psiSeo,
      eval_status:       "EVALUATED",
      evaluated_at:      new Date().toISOString(),
    });

  } catch (err) {
    console.error("[evaluate-project]", err);
    return json({
      error: err instanceof Error ? err.message : String(err)
    }, 500);
  }
});
