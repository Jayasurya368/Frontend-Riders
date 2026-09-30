// config.js — Runtime environment configuration
// On Vercel, build.js writes the actual SUPABASE_URL and SUPABASE_ANON_KEY here.
// When running locally without a build step, this file provides empty defaults
// and the app falls back to local-only mode.
window.__ENV__ = window.__ENV__ || {
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: ''
};
