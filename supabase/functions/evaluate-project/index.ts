/**
 * evaluate-project  — Supabase Edge Function
 *
 * Triggered by the frontend after it inserts a row into `submissions`.
 * 1. Reads the submission's demo_url from the database.
 * 2. Calls Google PageSpeed Insights v5 for Performance, Accessibility,
 *    Best-Practices, and SEO scores.
 * 3. Computes a weighted average score out of 100.
 * 4. Writes the scores back to the submissions row.
 *
 * Weights:
 *   Performance  35 %
 *   Accessibility 30 %
 *   Best Practices 20 %
 *   SEO            15 %
 *
 * Required Supabase Secrets (set via `supabase secrets set`):
 *   PAGESPEED_API_KEY  — Google Cloud API key with PageSpeed Insights enabled.
 *                        Leave empty to hit the free un-keyed endpoint (strict rate-limit).
 *   SUPABASE_URL       — injected automatically by the Supabase runtime.
 *   SUPABASE_SERVICE_ROLE_KEY — injected automatically; needed to bypass RLS for the write-back.
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Weights (must sum to 1.0) ────────────────────────────────────────────────
const WEIGHTS = {
  performance:    0.35,
  accessibility:  0.30,
  best_practices: 0.20,
  seo:            0.15,
} as const;

// ── CORS headers (allow the Vercel / Netlify frontend to call this) ──────────
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
};

// ── Helper: round to nearest integer ────────────────────────────────────────
const round = (n: number) => Math.round(n);

// ── PageSpeed category key → our DB column ───────────────────────────────────
const CATEGORY_MAP: Record<string, keyof typeof WEIGHTS> = {
  performance:    "performance",
  accessibility:  "accessibility",
  "best-practices": "best_practices",
  seo:            "seo",
};

serve(async (req) => {
  // Handle CORS pre-flight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  try {
    // ── 1. Parse request body ──────────────────────────────────────────────
    const { submission_id } = await req.json() as { submission_id: string };
    if (!submission_id) {
      return new Response(
        JSON.stringify({ error: "submission_id is required" }),
        { status: 400, headers: { ...CORS, "Content-Type": "application/json" } },
      );
    }

    // ── 2. Build Supabase admin client ────────────────────────────────────
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    // ── 3. Fetch the submission row ───────────────────────────────────────
    const { data: submission, error: fetchErr } = await supabaseAdmin
      .from("submissions")
      .select("id, demo_url")
      .eq("id", submission_id)
      .single();

    if (fetchErr || !submission) {
      return new Response(
        JSON.stringify({ error: fetchErr?.message ?? "Submission not found" }),
        { status: 404, headers: { ...CORS, "Content-Type": "application/json" } },
      );
    }

    const { demo_url } = submission;
    if (!demo_url) {
      return new Response(
        JSON.stringify({ error: "Submission has no demo_url" }),
        { status: 422, headers: { ...CORS, "Content-Type": "application/json" } },
      );
    }

    // ── 4. Call Google PageSpeed Insights v5 ─────────────────────────────
    const apiKey = Deno.env.get("PAGESPEED_API_KEY") ?? "";
    const categories = ["performance", "accessibility", "best-practices", "seo"];
    const catParams = categories.map(c => `category=${c}`).join("&");
    const keyParam = apiKey ? `&key=${apiKey}` : "";
    const psiUrl =
      `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(demo_url)}&strategy=mobile&${catParams}${keyParam}`;

    const psiRes = await fetch(psiUrl);
    if (!psiRes.ok) {
      const body = await psiRes.text();
      return new Response(
        JSON.stringify({ error: `PageSpeed API error ${psiRes.status}: ${body}` }),
        { status: 502, headers: { ...CORS, "Content-Type": "application/json" } },
      );
    }

    const psiData = await psiRes.json();
    const cats = psiData?.lighthouseResult?.categories;

    if (!cats) {
      return new Response(
        JSON.stringify({ error: "No Lighthouse categories in PageSpeed response", raw: psiData }),
        { status: 502, headers: { ...CORS, "Content-Type": "application/json" } },
      );
    }

    // ── 5. Extract raw scores (0-1) and convert to 0-100 ─────────────────
    const raw: Record<string, number> = {};

    for (const [psiKey, dbKey] of Object.entries(CATEGORY_MAP)) {
      const score = cats[psiKey]?.score;
      raw[dbKey] = score !== null && score !== undefined
        ? round(score * 100)
        : 0;
    }

    // ── 6. Compute weighted average ───────────────────────────────────────
    const weightedScore = round(
      raw.performance    * WEIGHTS.performance  +
      raw.accessibility  * WEIGHTS.accessibility +
      raw.best_practices * WEIGHTS.best_practices +
      raw.seo            * WEIGHTS.seo,
    );

    // ── 7. Write scores back to the submissions row ───────────────────────
    const { error: updateErr } = await supabaseAdmin
      .from("submissions")
      .update({
        score:          weightedScore,
        performance:    raw.performance,
        accessibility:  raw.accessibility,
        best_practices: raw.best_practices,
        seo:            raw.seo,
        evaluated_at:   new Date().toISOString(),
      })
      .eq("id", submission_id);

    if (updateErr) {
      return new Response(
        JSON.stringify({ error: updateErr.message }),
        { status: 500, headers: { ...CORS, "Content-Type": "application/json" } },
      );
    }

    // ── 8. Return the computed scores to the caller ───────────────────────
    return new Response(
      JSON.stringify({
        submission_id,
        score:          weightedScore,
        performance:    raw.performance,
        accessibility:  raw.accessibility,
        best_practices: raw.best_practices,
        seo:            raw.seo,
        evaluated_at:   new Date().toISOString(),
      }),
      { status: 200, headers: { ...CORS, "Content-Type": "application/json" } },
    );

  } catch (err) {
    console.error("[evaluate-project]", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }
});
