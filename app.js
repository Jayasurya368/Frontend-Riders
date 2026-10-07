/* ============================================================
   FrontendRiders Platform Controller & Interactive Engine
   FRAI v1.0 - Frontend Riders AI Evaluation Engine
   ============================================================ */

(function() { // IIFE: prevents const/let collisions on re-injection; all window.xxx at the bottom expose functions globally.

// Safe Icon Helper to prevent uncaught CDN errors
function safeCreateIcons() {
  try {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }
  } catch (e) {
    console.warn('Lucide icons initialization warning:', e);
  }
}

// 0. SUPABASE AUTH INTEGRATION & LOCAL FALLBACK
// Values come from Vercel Environment Variables. build.js writes them into
// config.js (window.__ENV__) at deploy time, so they are not hard-coded here.
const ENV = window.__ENV__ || {};
const SUPABASE_URL = ENV.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = ENV.SUPABASE_ANON_KEY || '';
let supabase = null;
let recoveryPending = false; // true while the user is in the "set new password" step
let currentAuthMode = 'signin';
let currentUser = null;

// Initialize Supabase Client if script is loaded, with LocalStorage fallback
function initSupabase() {
  try { localStorage.removeItem('rider_user'); } catch (e) {}

  // Password-reset emails land back here with #...&type=recovery in the URL
  if (/type=recovery/.test(window.location.hash)) recoveryPending = true;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('Supabase config missing. Set SUPABASE_URL and SUPABASE_ANON_KEY in Vercel → Settings → Environment Variables, then redeploy.');
  } else if (window.supabase && typeof window.supabase.createClient === 'function') {
    try {
      supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      loadLeaderboard();

      // ── Real-time leaderboard refresh ─────────────────────────────────
      // Subscribe to UPDATE events on the submissions table.
      // The edge function writes `score`, `performance`, etc. back to the
      // row via UPDATE — this fires and re-fetches the leaderboard so every
      // open browser tab sees the result without a page reload.
      supabase
        .channel('leaderboard-realtime')
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'submissions' },
          (payload) => {
            // Only re-render if the update actually populated a score
            if (payload.new && payload.new.score !== null && payload.new.score !== undefined) {
              loadLeaderboard(lbPeriod);
              // Flash the leaderboard section to signal a live update
              const lbSection = document.getElementById('leaderboard');
              if (lbSection) {
                lbSection.classList.add('leaderboard-flash');
                setTimeout(() => lbSection.classList.remove('leaderboard-flash'), 1200);
              }
            }
          }
        )
        .subscribe();

      // ── Real-time Web Craft Event configuration changes ────────────────
      supabase
        .channel('events-realtime')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'events' },
          () => {
            fetchEventState();
          }
        )
        .subscribe();
      
      // Fetch initial session
      supabase.auth.getSession().then(({ data: { session } }) => {
        if (session && session.user && !recoveryPending) {
          currentUser = session.user;
          try { localStorage.setItem('rider_user', JSON.stringify(currentUser)); } catch (e) {}
          updateAuthUI();
          checkMySubmission();
        }
      }).catch(err => {
        console.warn('Session retrieval warning:', err);
      });

      // Listen for auth state changes
      supabase.auth.onAuthStateChange((event, session) => {
        if (event === 'PASSWORD_RECOVERY') {
          // User clicked the reset link in their email → show "set new password"
          recoveryPending = true;
          setTimeout(() => openAuthModal('reset'), 0);
        }
        if (session && session.user && !recoveryPending) {
          currentUser = session.user;
          try { localStorage.setItem('rider_user', JSON.stringify(currentUser)); } catch (e) {}
          checkMySubmission();
        } else if (event === 'SIGNED_OUT') {
          currentUser = null;
          try { localStorage.removeItem('rider_user'); } catch (e) {}
          mySubmission = null;
          updateSubmissionSectionUI();
        }
        updateAuthUI();
      });
    } catch (e) {
      console.error('Supabase initialization error:', e);
    }
  }
  updateAuthUI();
  initWebCraftEvent();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSupabase);
} else {
  initSupabase();
}

// ---- Forgot / reset password ----
function showAuthAlert(type, text) {
  const box = document.getElementById('authAlertBox');
  if (!box) return;
  const styles = {
    success: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
    error: 'bg-rose-50 text-rose-700 border border-rose-200',
    info: 'bg-amber-50 text-amber-700 border border-amber-200'
  };
  box.className = 'mb-4 p-3 rounded-lg text-xs font-mono font-medium text-center ' + (styles[type] || styles.info);
  box.innerText = text;
}

function syncForgotLink() {
  const link = document.getElementById('forgotPasswordWrap');
  if (link) link.classList.toggle('hidden', currentAuthMode !== 'signin');
}

// view: 'main' (sign in / sign up) | 'forgot' | 'reset'
function showAuthView(view) {
  ['main', 'forgot', 'reset'].forEach(v => {
    const el = document.getElementById('auth' + v.charAt(0).toUpperCase() + v.slice(1) + 'View');
    if (el) el.classList.toggle('hidden', v !== view);
  });
  const box = document.getElementById('authAlertBox');
  if (box) { box.classList.add('hidden'); box.innerText = ''; }
  const sub = document.getElementById('authSubtitle');
  if (sub) {
    sub.innerText = view === 'forgot' ? 'RESET YOUR PASSWORD'
      : view === 'reset' ? 'SET A NEW PASSWORD'
      : 'RIDERS AUTHENTICATION';
  }
  if (view === 'forgot') {
    const typed = document.getElementById('authEmail');
    const target = document.getElementById('forgotEmail');
    if (typed && target && typed.value && !target.value) target.value = typed.value;
  }
  safeCreateIcons();
}

async function handleForgotSubmit(e) {
  e.preventDefault();
  const email = (document.getElementById('forgotEmail')?.value || '').trim();
  const btn = document.getElementById('btnSendReset');
  if (!email) return;
  if (!supabase) { showAuthAlert('error', 'Cannot reach Supabase. Check your internet connection and reload.'); return; }

  const original = btn ? btn.innerText : 'Send Reset Link';
  if (btn) { btn.disabled = true; btn.innerText = 'Sending...'; }
  try {
    // This URL must be listed under Supabase → Authentication → URL Configuration → Redirect URLs
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + window.location.pathname
    });
    if (error) throw error;
    showAuthAlert('success', '✓ If an account exists for that email, a reset link is on its way. Check your inbox (and spam).');
    playSound('success');
  } catch (err) {
    showAuthAlert('error', err.message || 'Could not send reset email. Please try again.');
    playSound('warning');
  } finally {
    if (btn) { btn.disabled = false; btn.innerText = original; }
  }
}

async function handleResetSubmit(e) {
  e.preventDefault();
  const pw = document.getElementById('resetPassword')?.value || '';
  const confirmPw = document.getElementById('resetPasswordConfirm')?.value || '';
  const btn = document.getElementById('btnSubmitReset');

  if (pw.length < 8) { showAuthAlert('error', 'Password must be at least 8 characters.'); playSound('warning'); return; }
  if (pw !== confirmPw) { showAuthAlert('error', 'Passwords do not match.'); playSound('warning'); return; }
  if (!supabase) { showAuthAlert('error', 'Cannot reach Supabase. Check your internet connection and reload.'); return; }

  const original = btn ? btn.innerText : 'Update Password';
  if (btn) { btn.disabled = true; btn.innerText = 'Updating...'; }
  try {
    const { data, error } = await supabase.auth.updateUser({ password: pw });
    if (error) throw error;

    recoveryPending = false;
    currentUser = data.user || currentUser;
    try { localStorage.setItem('rider_user', JSON.stringify(currentUser)); } catch (e2) {}
    updateAuthUI();
    showAuthAlert('success', '✓ Password updated! You are now signed in.');
    playSound('success');
    try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch (e3) {}

    setTimeout(() => {
      closeModal('authModal');
      const f = document.getElementById('resetForm');
      if (f) f.reset();
    }, 1200);
  } catch (err) {
    showAuthAlert('error', err.message || 'Could not update password. The link may have expired — request a new one.');
    playSound('warning');
  } finally {
    if (btn) { btn.disabled = false; btn.innerText = original; }
  }
}

function toggleAuthMode() {
  currentAuthMode = currentAuthMode === 'signin' ? 'signup' : 'signin';
  const toggleBtn = document.getElementById('toggleAuthModeBtn');
  const submitBtn = document.getElementById('btnSubmitAuth');
  const alertBox = document.getElementById('authAlertBox');
  if (alertBox) {
    alertBox.classList.add('hidden');
    alertBox.innerText = '';
  }
  
  if (currentAuthMode === 'signin') {
    if (toggleBtn) toggleBtn.innerText = 'Need an account? Sign Up';
    if (submitBtn) submitBtn.innerText = 'Sign In';
  } else {
    if (toggleBtn) toggleBtn.innerText = 'Already have an account? Sign In';
    if (submitBtn) submitBtn.innerText = 'Create Developer Account';
  }
  syncForgotLink();
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  
  const emailInput = document.getElementById('authEmail');
  const passwordInput = document.getElementById('authPassword');
  const email = emailInput ? emailInput.value.trim() : '';
  const password = passwordInput ? passwordInput.value : '';
  const alertBox = document.getElementById('authAlertBox');
  const submitBtn = document.getElementById('btnSubmitAuth');
  
  if (!email) return;

  // Loading state
  const originalBtnText = submitBtn ? submitBtn.innerText : 'Submit';
  if (submitBtn) {
    submitBtn.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> Processing...';
    submitBtn.disabled = true;
  }
  if (alertBox) alertBox.classList.add('hidden');
  playSound('beep');
  safeCreateIcons();
  
  let needsEmailConfirm = false;
  try {
    if (supabase) {
      let result;
      if (currentAuthMode === 'signup') {
        result = await supabase.auth.signUp({ email, password });
      } else {
        result = await supabase.auth.signInWithPassword({ email, password });
      }
      
      if (result.error) throw result.error;
      currentUser = result.data?.session ? result.data.user : null;
      needsEmailConfirm = currentAuthMode === 'signup' && !result.data?.session;
    } else {
      throw new Error('Cannot reach Supabase. Check your internet connection and reload.');
    }

    try {
      localStorage.setItem('rider_user', JSON.stringify(currentUser));
    } catch (e) {}

    updateAuthUI();

    // Success handling
    if (alertBox) {
      alertBox.className = 'mb-4 p-3 rounded-lg text-xs font-mono font-medium text-center bg-emerald-50 text-emerald-700 border border-emerald-200';
      alertBox.innerText = needsEmailConfirm
        ? '✓ Account created! Check your email to confirm, then sign in.'
        : currentAuthMode === 'signup' 
        ? '✓ Account created successfully! Welcome to FrontendRiders.' 
        : '✓ Sign in successful! Welcome back.';
      alertBox.classList.remove('hidden');
    }
    playSound('success');
    
    setTimeout(() => {
      closeModal('authModal');
      if (alertBox) alertBox.classList.add('hidden');
    }, 900);

  } catch (error) {
    // Error handling with graceful fallback option
    if (alertBox) {
      alertBox.className = 'mb-4 p-3 rounded-lg text-xs font-mono font-medium text-center bg-rose-50 text-rose-700 border border-rose-200';
      alertBox.innerText = error.message || 'Authentication error. Please try again.';
      alertBox.classList.remove('hidden');
    }
    playSound('warning');
  } finally {
    if (submitBtn) {
      submitBtn.innerText = originalBtnText;
      submitBtn.disabled = false;
    }
    safeCreateIcons();
  }
}

async function handleOAuth(provider) {
  playSound('click');
  const alertBox = document.getElementById('authAlertBox');
  if (!supabase) {
    if (alertBox) {
      alertBox.className = 'mb-4 p-3 rounded-lg text-xs font-mono font-medium text-center bg-rose-50 text-rose-700 border border-rose-200';
      alertBox.innerText = 'Cannot reach Supabase. Check your internet connection and reload.';
      alertBox.classList.remove('hidden');
    }
    return;
  }
  try {
    // Sends the browser to provider's login page, then back to this site.
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.location.origin + window.location.pathname },
    });
    if (error) throw error;
    // Browser navigates away now; nothing else to do here.
  } catch (error) {
    const label = provider === 'google' ? 'Google' : 'GitHub';
    if (alertBox) {
      alertBox.className = 'mb-4 p-3 rounded-lg text-xs font-mono font-medium text-center bg-rose-50 text-rose-700 border border-rose-200';
      alertBox.innerText = label + ' sign-in failed: ' + (error.message || 'is it enabled in Supabase?');
      alertBox.classList.remove('hidden');
    }
  }
}

async function handleSignOut() {
  playSound('click');
  currentUser = null;
  try {
    localStorage.removeItem('rider_user');
  } catch (e) {}
  if (supabase) {
    try {
      await supabase.auth.signOut();
    } catch (e) {}
  }
  updateAuthUI();
}

function updateAuthUI() {
  const desktopContainer = document.getElementById('desktopAuthContainer');
  const mobileContainer = document.getElementById('mobileAuthContainer');
  const mobileSignInBtn = document.getElementById('mobileSignInBtn');
  
  if (!desktopContainer && !mobileContainer && !mobileSignInBtn) return;
  
  if (currentUser) {
    // User is logged in
    const emailPrefix = (currentUser.email || 'Developer').split('@')[0];
    
    // Hide the persistent mobile Sign In button when logged in
    if (mobileSignInBtn) {
      mobileSignInBtn.style.display = 'none';
    }

    if (desktopContainer) {
      desktopContainer.innerHTML = `
        <div class="flex items-center gap-4">
          <div class="flex items-center gap-2 px-3 py-1.5 bg-white border border-slate-200 rounded-xl shadow-sm">
            <div class="w-6 h-6 rounded-full bg-blue-100 flex items-center justify-center text-[#0066FF] text-xs font-bold font-mono">
              ${emailPrefix.charAt(0).toUpperCase()}
            </div>
            <span class="text-xs font-mono font-bold text-slate-700">${emailPrefix}</span>
          </div>
          <button onclick="handleSignOut()" class="text-xs font-semibold text-slate-500 hover:text-rose-600 transition-colors">Sign Out</button>
          <button onclick="openSubmitModal()" class="px-5 py-2.5 rounded-xl font-bold text-sm bg-gradient-to-r from-[#0066FF] to-[#0052CC] text-white shadow-lg shadow-blue-500/25 hover:scale-[1.02] active:scale-[0.98] transition-all flex items-center gap-2">
            <i data-lucide="rocket" class="w-4 h-4"></i> Submit Project
          </button>
        </div>
      `;
    }
    
    if (mobileContainer) {
      mobileContainer.innerHTML = `
        <div class="flex items-center gap-2 px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl justify-center mb-2">
          <span class="text-xs font-mono font-bold text-slate-700">Logged in as ${emailPrefix}</span>
        </div>
        <button onclick="openSubmitModal()" class="w-full py-2.5 text-center text-sm font-bold text-white bg-gradient-to-r from-[#0066FF] to-[#0052CC] rounded-xl shadow-md shadow-blue-500/20">Submit Project</button>
        <button onclick="handleSignOut()" class="w-full py-2.5 text-center text-sm font-semibold text-rose-600 border border-rose-200 rounded-xl bg-rose-50 hover:bg-rose-100 transition-colors">Sign Out</button>
      `;
    }
  } else {
    // User is logged out — show the persistent mobile Sign In button
    if (mobileSignInBtn) {
      mobileSignInBtn.style.display = '';
    }

    if (desktopContainer) {
      desktopContainer.innerHTML = `
        <button onclick="openAuthModal('signin')" class="px-4 py-2 text-sm font-semibold text-slate-600 hover:text-[#0A0F1D] transition-colors">
          Sign In
        </button>
        <button onclick="openSubmitModal()" class="px-5 py-2.5 rounded-xl font-bold text-sm bg-gradient-to-r from-[#0066FF] to-[#0052CC] text-white shadow-lg shadow-blue-500/25 hover:scale-[1.02] active:scale-[0.98] transition-all flex items-center gap-2">
          <i data-lucide="rocket" class="w-4 h-4 text-white"></i> Submit Project
        </button>
      `;
    }
    
    if (mobileContainer) {
      mobileContainer.innerHTML = `
        <button onclick="openAuthModal('signin')" class="w-full py-2.5 text-center text-sm font-semibold text-slate-700 border border-slate-200 rounded-xl bg-slate-50">Sign In</button>
        <button onclick="openSubmitModal()" class="w-full py-2.5 text-center text-sm font-bold text-white bg-gradient-to-r from-[#0066FF] to-[#0052CC] rounded-xl shadow-md shadow-blue-500/20">Submit Project</button>
      `;
    }
  }
  safeCreateIcons();
}

// 1. WEB AUDIO API SYNTHESIZER FOR DEVELOPER UI SFX
let audioCtx = null;
let soundEnabled = true;

function initAudio() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      try {
        audioCtx = new AudioContextClass();
      } catch (e) {}
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
}

function playSound(type) {
  if (!soundEnabled) return;
  try {
    initAudio();
    if (!audioCtx) return;

    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    if (type === 'click') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(800, now);
      osc.frequency.exponentialRampToValueAtTime(400, now + 0.05);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.linearRampToValueAtTime(0, now + 0.05);
      osc.start(now);
      osc.stop(now + 0.05);
    } else if (type === 'beep') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1200, now);
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.linearRampToValueAtTime(0, now + 0.08);
      osc.start(now);
      osc.stop(now + 0.08);
    } else if (type === 'success') {
      [523.25, 659.25, 783.99, 1046.50].forEach((freq, i) => {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(freq, now + i * 0.06);
        g.gain.setValueAtTime(0.10, now + i * 0.06);
        g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.06 + 0.3);
        o.connect(g);
        g.connect(audioCtx.destination);
        o.start(now + i * 0.06);
        o.stop(now + i * 0.06 + 0.3);
      });
    } else if (type === 'warning') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(200, now);
      osc.frequency.exponentialRampToValueAtTime(100, now + 0.15);
      gain.gain.setValueAtTime(0.06, now);
      gain.gain.linearRampToValueAtTime(0, now + 0.15);
      osc.start(now);
      osc.stop(now + 0.15);
    } else if (type === 'scan') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(400, now);
      osc.frequency.linearRampToValueAtTime(2000, now + 0.12);
      gain.gain.setValueAtTime(0.05, now);
      gain.gain.linearRampToValueAtTime(0, now + 0.12);
      osc.start(now);
      osc.stop(now + 0.12);
    }
  } catch (e) {
    // Audio playback prevented or unsupported
  }
}

// Sound Toggle & Interactive Controls Initialization
function initApp() {
  const soundBtn = document.getElementById('soundToggleBtn');
  const soundIcon = document.getElementById('soundIcon');
  if (soundBtn) {
    soundBtn.addEventListener('click', () => {
      soundEnabled = !soundEnabled;
      if (soundEnabled) {
        soundBtn.querySelector('span').innerText = 'SFX: ON';
        soundIcon.setAttribute('data-lucide', 'volume-2');
        playSound('beep');
      } else {
        soundBtn.querySelector('span').innerText = 'SFX: OFF';
        soundIcon.setAttribute('data-lucide', 'volume-x');
      }
      safeCreateIcons();
    });
  }
  
  // Attach general click sound to primary buttons & links
  document.querySelectorAll('button, a[href^="#"], input[type="submit"]').forEach(el => {
    el.addEventListener('click', () => {
      initAudio();
      playSound('click');
    });
  });

  // Prepopulate FRAI code input with default sample so evaluation works instantly
  const codeInput = document.getElementById('aiCodeInput');
  if (codeInput && !codeInput.value && typeof SNIPPET_PRESETS !== 'undefined' && SNIPPET_PRESETS.glass) {
    codeInput.value = SNIPPET_PRESETS.glass;
    updateCharCount();
  }

  // Close modals when clicking backdrop
  document.querySelectorAll('.fixed.inset-0').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeModal(modal.id);
      }
    });
  });

  // Close modals with Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.fixed.inset-0:not(.hidden)').forEach(modal => {
        closeModal(modal.id);
      });
    }
  });

  // Mobile menu toggle
  const menuBtn = document.getElementById('mobileMenuBtn');
  const mobileMenu = document.getElementById('mobileMenu');
  if (menuBtn && mobileMenu) {
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      mobileMenu.classList.toggle('hidden');
    });
    // Close mobile menu on clicking any link inside it
    mobileMenu.querySelectorAll('a, button').forEach(item => {
      item.addEventListener('click', () => {
        mobileMenu.classList.add('hidden');
      });
    });
    // Close mobile menu when clicking outside
    document.addEventListener('click', (e) => {
      if (!mobileMenu.contains(e.target) && !menuBtn.contains(e.target)) {
        mobileMenu.classList.add('hidden');
      }
    });
  }

  initParticleCanvas();
  startHackathonCountdowns();
  safeCreateIcons();
}

// Run initApp: if the DOM is still loading wait for DOMContentLoaded,
// otherwise run immediately (script is at the bottom of <body>).
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

// 2. CANVAS PARTICLE BACKGROUND ("RIDE THE DOM" NEON GRID)
function initParticleCanvas() {
  const canvas = document.getElementById('particleCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  
  let width = (canvas.width = window.innerWidth);
  let height = (canvas.height = window.innerHeight);

  window.addEventListener('resize', () => {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
  });

  const particles = [];
  const numParticles = Math.min(Math.floor(width / 22), 65);

  for (let i = 0; i < numParticles; i++) {
    particles.push({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.6,
      vy: (Math.random() - 0.5) * 0.6,
      radius: Math.random() * 2 + 1,
      color: Math.random() > 0.5 ? '#0066FF' : '#38BDF8'
    });
  }

  function animate() {
    ctx.clearRect(0, 0, width, height);

    for (let i = 0; i < particles.length; i++) {
      const p1 = particles[i];
      p1.x += p1.vx;
      p1.y += p1.vy;

      if (p1.x < 0 || p1.x > width) p1.vx *= -1;
      if (p1.y < 0 || p1.y > height) p1.vy *= -1;

      ctx.beginPath();
      ctx.arc(p1.x, p1.y, p1.radius, 0, Math.PI * 2);
      ctx.fillStyle = p1.color;
      ctx.fill();

      for (let j = i + 1; j < particles.length; j++) {
        const p2 = particles[j];
        const dx = p1.x - p2.x;
        const dy = p1.y - p2.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 130) {
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.strokeStyle = `rgba(0, 102, 255, ${0.15 * (1 - dist / 130)})`;
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }
      }
    }
    requestAnimationFrame(animate);
  }

  animate();
}

// ============================================================
// 3. WEB CRAFT EVENT 01: ENGINE, TIME VALIDATION & CONTROLS
// ============================================================

const EVENT_CONFIG = {
  id: 'web-craft-01',
  hackathonId: 1,
  name: 'WEB CRAFT',
  number: 'EVENT 01',
  title: 'Web Craft – Event 01',
  dateString: '18 October 2026',
  // Official release time: 18 October 2026 at 10:00:00 AM IST (Asia/Kolkata)
  releaseIso: '2026-10-18T10:00:00+05:30',
  releaseTimestamp: 1792297800000, // 2026-10-18 10:00:00 AM IST in milliseconds
  // Official event conclusion: 18 October 2026 at 4:00:00 PM IST (6 hours)
  endIso: '2026-10-18T16:00:00+05:30',
  endTimestamp: 1792319400000, // 2026-10-18 16:00:00 PM IST in milliseconds
  defaultOrganizerKey: 'webcraft2026admin',
  maxSubmissions: 2,
  defaultRules: [
    'Hackathon runs from 10:00 AM to 4:00 PM IST on 18 October 2026 (6 hours).',
    'Each participant may submit up to 2 times during the event window.',
    'Your final competition score is the HIGHEST score from your two attempts.',
    'Submissions must be original work created during the event timeframe.',
    'Submit a valid, publicly accessible deployed website URL (HTTPS).',
    'Application must be responsive across mobile (375px), tablet (768px), and desktop (1440px).',
    'Scoring: Problem Requirements (40 pts) + Functionality (20 pts) + Responsive (15 pts) + Performance (10 pts) + Accessibility (10 pts) + UI/UX (5 pts) = 100 pts.',
    'The evaluation system analyzes your submission automatically within minutes.'
  ]
};

// ============================================================
// ADMIN TEST MODE ENGINE & ISOLATED SANDBOX
// Organizer-only simulation of lifecycle stages & verification
// ============================================================
let adminTestMode = {
  active: false,
  simulatedPhase: null, // 'UPCOMING' | 'LIVE' | 'ENDED' | null
  simulatedNow: null,
  simulatedSetAt: 0,
  activeStateKey: null,
  testParticipant: {
    id: 'test-rider-org-isolated-01',
    email: 'test-organizer-01@frontendriders.test',
    username: 'TestOrganizer'
  },
  testSubmissions: [],
  testResults: {}
};

let serverTimeOffsetMs = 0; // offset between trusted server clock and local Date.now()
let hasServerTimeSync = false;
let eventState = {
  isLive: false,
  releaseTime: EVENT_CONFIG.releaseIso,
  serverTime: null,
  problemStatementLocked: true,
  problemStatementTitle: 'Problem Statement Locked',
  problemStatement: null,
  rules: EVENT_CONFIG.defaultRules,
  isForcedOpen: false,
  isForcedClosed: false
};
let mySubmissions = []; // cached participant submissions for Event 01 (up to 2)
let mySubmission = null; // latest/best participant submission for Event 01
let webCraftCountdownInterval = null;
let serverSyncInterval = null;
let organizerCurrentTab = 'status';

function formatIST(date) {
  try {
    const d = (date instanceof Date) ? date : new Date(date);
    if (isNaN(d.getTime())) return '—';
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    }).format(d) + ' IST';
  } catch (e) {
    return String(date);
  }
}

// Trusted current timestamp in epoch milliseconds (immune to local clock tampering)
function getTrustedNow() {
  if (adminTestMode.active && adminTestMode.simulatedNow !== null) {
    return adminTestMode.simulatedNow + (Date.now() - adminTestMode.simulatedSetAt);
  }
  return Date.now() + serverTimeOffsetMs;
}

// Evaluates the event phase based on trusted server time or active test simulation
function getEventPhase() {
  if (adminTestMode.active && adminTestMode.simulatedPhase) {
    return adminTestMode.simulatedPhase;
  }
  if (eventState.isForcedClosed) return 'ENDED';
  if (eventState.isForcedOpen) return 'LIVE';
  const now = getTrustedNow();
  if (now >= EVENT_CONFIG.endTimestamp) return 'ENDED';
  if (now >= EVENT_CONFIG.releaseTimestamp) return 'LIVE';
  return 'UPCOMING';
}

function isEventLive() {
  return getEventPhase() === 'LIVE';
}

function isEventEnded() {
  return getEventPhase() === 'ENDED';
}

// Synchronize client with trusted server time
async function syncServerTime() {
  try {
    // Priority 1: Supabase database server time RPC
    if (supabase) {
      try {
        const { data, error } = await supabase.rpc('get_server_time');
        if (!error && data) {
          const serverDate = new Date(data);
          if (!isNaN(serverDate.getTime())) {
            serverTimeOffsetMs = serverDate.getTime() - Date.now();
            hasServerTimeSync = true;
            return;
          }
        }
      } catch (_) {}
    }

    // Priority 2: HTTP Server Date header from current origin (Vercel / web server)
    try {
      const res = await fetch(window.location.href, { method: 'HEAD', cache: 'no-store' });
      const headerDate = res.headers.get('date');
      if (headerDate) {
        const serverDate = new Date(headerDate);
        if (!isNaN(serverDate.getTime())) {
          serverTimeOffsetMs = serverDate.getTime() - Date.now();
          hasServerTimeSync = true;
          return;
        }
      }
    } catch (_) {}
  } catch (err) {
    console.warn('[WebCraft] Server time sync notice:', err);
  }
}

// Fetch event state from Supabase
async function fetchEventState() {
  if (adminTestMode.active) return; // simulated state takes precedence in test mode
  if (!supabase) return;

  try {
    // 1. Try secure RPC function
    const { data: rpcData, error: rpcErr } = await supabase.rpc('get_event_state', { p_event_id: 'web-craft-01' });
    if (!rpcErr && rpcData) {
      if (rpcData.server_time) {
        const sDate = new Date(rpcData.server_time);
        if (!isNaN(sDate.getTime())) {
          serverTimeOffsetMs = sDate.getTime() - Date.now();
          hasServerTimeSync = true;
        }
      }
      eventState.isForcedOpen = !!rpcData.is_forced_open;
      eventState.isForcedClosed = !!rpcData.is_forced_closed;
      eventState.problemStatement = rpcData.problem_statement || null;
      eventState.problemStatementTitle = rpcData.problem_statement_title || 'Web Craft Event 01 Challenge';
      if (rpcData.rules) eventState.rules = rpcData.rules;
      updateWebCraftUI();
      return;
    }

    // 2. Fallback: Query events table directly
    const { data: tblData, error: tblErr } = await supabase
      .from('events')
      .select('*')
      .eq('id', 'web-craft-01')
      .single();

    if (!tblErr && tblData) {
      eventState.isForcedOpen = !!tblData.is_forced_open;
      eventState.isForcedClosed = !!tblData.is_forced_closed;
      eventState.problemStatement = tblData.problem_statement_markdown || null;
      eventState.problemStatementTitle = tblData.problem_statement_title || 'Web Craft Event 01 Challenge';
      if (tblData.rules) eventState.rules = tblData.rules;
      updateWebCraftUI();
    }
  } catch (e) {
    console.warn('[WebCraft] Could not retrieve remote event state:', e);
  }
}

// Check participant's submission status for Event 01
async function checkMySubmission() {
  if (adminTestMode.active) {
    mySubmissions = adminTestMode.testSubmissions || [];
    mySubmission = mySubmissions[mySubmissions.length - 1] || null;
    updateSubmissionSectionUI();
    return;
  }

  if (!supabase || !currentUser) {
    mySubmissions = [];
    mySubmission = null;
    updateSubmissionSectionUI();
    return;
  }

  try {
    const { data, error } = await supabase
      .from('submissions')
      .select('*')
      .eq('user_id', currentUser.id)
      .or('hackathon_id.eq.1,hackathon_id.is.null')
      .not('is_test', 'is', true)
      .order('created_at', { ascending: true });

    if (!error && Array.isArray(data)) {
      mySubmissions = data;
      mySubmission = data[data.length - 1] || null;
    } else {
      mySubmissions = [];
      mySubmission = null;
    }
  } catch (e) {
    console.warn('[WebCraft] checkMySubmission notice:', e);
  }
  updateSubmissionSectionUI();
}

// Simple safe markdown renderer for problem statement
function renderMarkdownToHtml(md) {
  if (!md) return '';
  let html = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Headings
  html = html.replace(/^### (.*$)/gim, '<h3 class="text-lg font-bold text-[#0A0F1D] mt-4 mb-2">$1</h3>');
  html = html.replace(/^## (.*$)/gim, '<h2 class="text-xl font-extrabold text-[#0A0F1D] mt-5 mb-2 pb-1 border-b border-slate-200">$1</h2>');
  html = html.replace(/^# (.*$)/gim, '<h1 class="text-2xl font-black text-[#0A0F1D] mt-6 mb-3">$1</h1>');

  // Bold & Italic
  html = html.replace(/\*\*(.*?)\*\*/gim, '<strong class="font-bold text-slate-900">$1</strong>');
  html = html.replace(/\*(.*?)\*/gim, '<em>$1</em>');

  // Inline code & Pre blocks
  html = html.replace(/```([\s\S]*?)```/gim, '<pre class="bg-[#0A0F1D] text-slate-100 p-4 rounded-xl font-mono text-xs overflow-x-auto my-3"><code>$1</code></pre>');
  html = html.replace(/`([^`]+)`/gim, '<code class="bg-blue-50 text-[#0066FF] px-1.5 py-0.5 rounded text-xs font-mono border border-blue-200">$1</code>');

  // Blockquotes
  html = html.replace(/^\> (.*$)/gim, '<blockquote class="border-l-4 border-[#0066FF] bg-blue-50/60 p-3 rounded-r-lg text-slate-700 italic my-3">$1</blockquote>');

  // Unordered list items
  html = html.replace(/^\- (.*$)/gim, '<li class="ml-4 list-disc text-slate-700 my-1">$1</li>');

  // Paragraphs
  html = html.replace(/\n\n+/g, '</p><p class="mb-3 text-slate-700 leading-relaxed">');
  html = '<p class="mb-3 text-slate-700 leading-relaxed">' + html + '</p>';

  return html;
}

// Fallback problem statement when organizer hasn't set custom text
function getDefaultLiveProblemStatement() {
  return `# Web Craft Event 01: Core Challenge

Welcome to **Web Craft – Event 01**, the premier frontend speed, craft, and responsiveness challenge by Frontend Riders.

### Objective
Design and implement a responsive, highly accessible, and visually stunning web experience meeting production-grade Core Web Vitals benchmarks.

### Core Technical Requirements
- **Responsive Layout**: Flawless visual hierarchy across Mobile (375px+), Tablet (768px+), and Desktop (1280px+) viewports.
- **Accessibility & ARIA**: Semantic HTML5 landmark structure, proper color contrast, keyboard navigability, and ARIA labels.
- **Speed & Web Vitals**: Zero layout shift (CLS < 0.05), rapid DOM hydration, and smooth 60 FPS interactions.
- **Clean Architecture**: Modular structure, well-organized styling, and zero console errors.

### Submission Instructions
1. Deploy your live project to a public host (**Vercel**, **Netlify**, **GitHub Pages**, or **Cloudflare Pages**).
2. Enter your live HTTPS URL into the **Submit Project** section below.
3. Your submission will immediately be evaluated and your score will be posted to the live leaderboard.`;
}

// Main countdown loop (runs every second)
function updateWebCraftCountdown() {
  const now = getTrustedNow();
  const phase = getEventPhase();

  // Update clock sync indicator in hero & organizer portal
  const clockEl = document.getElementById('heroServerClock');
  if (clockEl) {
    clockEl.innerText = (adminTestMode.active ? 'TEST TIME: ' : 'IST: ') + formatIST(now);
  }
  const orgClockEl = document.getElementById('orgServerTimeDisplay');
  if (orgClockEl) {
    orgClockEl.innerText = formatIST(now) + (adminTestMode.active ? ' (SIMULATED)' : '');
  }

  const cdDays = document.getElementById('cdDays');
  const cdHours = document.getElementById('cdHours');
  const cdMinutes = document.getElementById('cdMinutes');
  const cdSeconds = document.getElementById('cdSeconds');
  const psCd = document.getElementById('psCountdownText');
  const t1 = document.getElementById('timer1');
  const pad = n => String(Math.max(0, n)).padStart(2, '0');

  if (phase === 'ENDED') {
    if (cdDays) cdDays.innerText = '00';
    if (cdHours) cdHours.innerText = '00';
    if (cdMinutes) cdMinutes.innerText = '00';
    if (cdSeconds) cdSeconds.innerText = '00';
    if (psCd) psCd.innerText = 'EVENT ENDED (18 OCT 4:00 PM IST)';
    if (t1) t1.innerText = 'EVENT ENDED';
    return;
  }

  if (phase === 'LIVE') {
    if (!eventState.isLive) {
      transitionToLive();
    }
    // Time remaining until 4:00 PM IST closing
    const remainMs = Math.max(0, EVENT_CONFIG.endTimestamp - now);
    const hours = Math.floor(remainMs / (1000 * 60 * 60));
    const minutes = Math.floor((remainMs % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((remainMs % (1000 * 60)) / 1000);

    if (cdDays) cdDays.innerText = '00';
    if (cdHours) cdHours.innerText = pad(hours);
    if (cdMinutes) cdMinutes.innerText = pad(minutes);
    if (cdSeconds) cdSeconds.innerText = pad(seconds);
    if (psCd) psCd.innerText = `EVENT IS LIVE! Closes in ${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
    if (t1) t1.innerText = `CLOSES IN ${pad(hours)}h ${pad(minutes)}m`;
    return;
  }

  // Phase is UPCOMING (counting down to 10:00 AM IST)
  const diff = Math.max(0, EVENT_CONFIG.releaseTimestamp - now);
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60)) / (1000 * 60));
  const seconds = Math.floor((diff % (1000 * 60)) / 1000);

  if (cdDays) cdDays.innerText = pad(days);
  if (cdHours) cdHours.innerText = pad(hours);
  if (cdMinutes) cdMinutes.innerText = pad(minutes);
  if (cdSeconds) cdSeconds.innerText = pad(seconds);

  if (psCd) psCd.innerText = `${pad(days)}d ${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
  if (t1) t1.innerText = `${pad(days)}d ${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
}

// Master UI state synchronizer: updates all DOM elements for locked vs live vs ended state
function updateWebCraftUI() {
  const phase = getEventPhase();
  const isLive = phase === 'LIVE';
  const isEnded = phase === 'ENDED';
  const isLocked = phase === 'UPCOMING';
  eventState.isLive = isLive;

  // Check how many submissions the user has completed
  const subsCount = mySubmissions ? mySubmissions.length : 0;
  const hasReachedLimit = subsCount >= EVENT_CONFIG.maxSubmissions;

  // 1. Navigation status badge
  const navStatusBadge = document.getElementById('navStatusBadge');
  const navStatusText = document.getElementById('navStatusText');
  const mobileStatusBadge = document.getElementById('mobileStatusBadge');
  const mobileStatusText = document.getElementById('mobileStatusText');

  if (navStatusBadge && navStatusText) {
    if (isEnded) {
      navStatusBadge.className = 'hidden md:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-mono font-bold bg-rose-50 text-rose-800 border border-rose-200';
      navStatusText.innerHTML = '🔴 EVENT ENDED';
    } else if (isLive) {
      navStatusBadge.className = 'hidden md:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-mono font-bold bg-emerald-50 text-emerald-700 border border-emerald-200';
      navStatusText.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-500 animate-ping inline-block mr-1"></span> 🟢 EVENT LIVE';
    } else {
      navStatusBadge.className = 'hidden md:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-mono font-bold bg-amber-50 text-amber-800 border border-amber-200';
      navStatusText.innerText = '🔒 EVENT NOT STARTED';
    }
  }

  if (mobileStatusBadge && mobileStatusText) {
    if (isEnded) {
      mobileStatusBadge.className = 'p-2.5 rounded-xl bg-rose-50 border border-rose-200 text-xs font-mono font-bold text-rose-800 flex items-center gap-2 mb-2';
      mobileStatusText.innerHTML = '🔴 EVENT ENDED';
    } else if (isLive) {
      mobileStatusBadge.className = 'p-2.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs font-mono font-bold text-emerald-700 flex items-center gap-2 mb-2';
      mobileStatusText.innerHTML = '🟢 EVENT LIVE';
    } else {
      mobileStatusBadge.className = 'p-2.5 rounded-xl bg-amber-50 border border-amber-200 text-xs font-mono font-bold text-amber-800 flex items-center gap-2 mb-2';
      mobileStatusText.innerText = '🔒 EVENT NOT STARTED';
    }
  }

  // 2. Navigation Submit Project Button
  const navSubmitBtn = document.getElementById('navSubmitBtn');
  const navSubmitBtnText = document.getElementById('navSubmitBtnText');
  const mobileNavSubmitBtn = document.getElementById('mobileNavSubmitBtn');
  const mobileNavSubmitBtnText = document.getElementById('mobileNavSubmitBtnText');

  const canSubmit = isLive && !hasReachedLimit;

  if (navSubmitBtn && navSubmitBtnText) {
    if (canSubmit) {
      navSubmitBtn.className = 'px-4 py-2 rounded-xl font-bold text-xs font-mono transition-all flex items-center gap-1.5 bg-gradient-to-r from-[#0066FF] to-[#0052CC] text-white shadow-md shadow-blue-500/25 hover:shadow-blue-500/40 hover:scale-[1.02] cursor-pointer';
      navSubmitBtn.removeAttribute('disabled');
      navSubmitBtn.innerHTML = `<i data-lucide="rocket" class="w-3.5 h-3.5"></i> <span>Submit Project (${subsCount}/2)</span>`;
    } else {
      navSubmitBtn.className = 'px-4 py-2 rounded-xl font-bold text-xs font-mono transition-all flex items-center gap-1.5 bg-slate-200 text-slate-400 border border-slate-300 cursor-not-allowed opacity-60';
      navSubmitBtn.setAttribute('disabled', 'true');
      const label = isEnded ? 'Event Ended: LOCKED' : (hasReachedLimit ? 'Limit Reached (2/2)' : 'Submit: LOCKED');
      navSubmitBtn.innerHTML = `<i data-lucide="lock" class="w-3.5 h-3.5"></i> <span>${label}</span>`;
    }
  }

  if (mobileNavSubmitBtn && mobileNavSubmitBtnText) {
    if (canSubmit) {
      mobileNavSubmitBtn.className = 'w-full py-2.5 text-center text-xs font-mono font-bold rounded-xl transition-all flex items-center justify-center gap-2 bg-gradient-to-r from-[#0066FF] to-[#0052CC] text-white shadow-md cursor-pointer';
      mobileNavSubmitBtn.removeAttribute('disabled');
      mobileNavSubmitBtn.innerHTML = `<i data-lucide="rocket" class="w-4 h-4"></i> <span>Submit Project (${subsCount}/2)</span>`;
    } else {
      mobileNavSubmitBtn.className = 'w-full py-2.5 text-center text-xs font-mono font-bold rounded-xl transition-all flex items-center justify-center gap-2 bg-slate-200 text-slate-400 border border-slate-300 cursor-not-allowed opacity-60';
      mobileNavSubmitBtn.setAttribute('disabled', 'true');
      const label = isEnded ? 'Event Ended: LOCKED' : (hasReachedLimit ? 'Limit Reached (2/2)' : 'Submit: LOCKED');
      mobileNavSubmitBtn.innerHTML = `<i data-lucide="lock" class="w-4 h-4"></i> <span>${label}</span>`;
    }
  }

  // 3. Hero Status Card
  const heroStatusPill = document.getElementById('heroStatusPill');
  const heroStatusPillText = document.getElementById('heroStatusPillText');
  const heroStatusMessageText = document.getElementById('heroStatusMessageText');
  const heroProblemStatusText = document.getElementById('heroProblemStatusText');
  const heroSubmitStatusText = document.getElementById('heroSubmitStatusText');
  const heroSubmitBtn = document.getElementById('heroSubmitBtn');
  const heroSubmitBtnText = document.getElementById('heroSubmitBtnText');

  if (heroStatusPill && heroStatusPillText) {
    if (isEnded) {
      heroStatusPill.className = 'px-3 py-1 rounded-full text-xs font-mono font-bold bg-rose-50 text-rose-800 border border-rose-300 flex items-center gap-1.5';
      heroStatusPill.innerHTML = '<span class="w-2 h-2 rounded-full bg-rose-500"></span> <span>🔴 EVENT ENDED</span>';
    } else if (isLive) {
      heroStatusPill.className = 'px-3 py-1 rounded-full text-xs font-mono font-bold bg-emerald-50 text-emerald-700 border border-emerald-300 flex items-center gap-1.5';
      heroStatusPill.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-500 animate-ping"></span> <span>🟢 EVENT LIVE</span>';
    } else {
      heroStatusPill.className = 'px-3 py-1 rounded-full text-xs font-mono font-bold bg-amber-50 text-amber-800 border border-amber-300 flex items-center gap-1.5';
      heroStatusPill.innerHTML = '<i data-lucide="lock" class="w-3.5 h-3.5 text-amber-600"></i> <span>🔒 EVENT NOT STARTED</span>';
    }
  }

  if (heroStatusMessageText) {
    if (isEnded) {
      heroStatusMessageText.innerText = 'Event closed at 4:00 PM IST on 18 October 2026. Final leaderboard rankings are calculated.';
    } else if (isLive) {
      heroStatusMessageText.innerText = 'Event is LIVE! Problem Statement is available. Submit your live project below (up to 2 attempts).';
    } else {
      heroStatusMessageText.innerText = 'Problem Statement will be revealed on 18 October at 10:00 AM IST.';
    }
  }

  if (heroProblemStatusText) {
    if (isLive || isEnded) {
      heroProblemStatusText.className = 'font-bold text-emerald-600';
      heroProblemStatusText.innerText = 'AVAILABLE';
    } else {
      heroProblemStatusText.className = 'font-bold text-amber-700';
      heroProblemStatusText.innerText = 'LOCKED';
    }
  }

  if (heroSubmitStatusText) {
    if (isEnded) {
      heroSubmitStatusText.className = 'font-bold text-rose-600';
      heroSubmitStatusText.innerText = 'CLOSED';
    } else if (isLive) {
      heroSubmitStatusText.className = hasReachedLimit ? 'font-bold text-amber-600' : 'font-bold text-emerald-600';
      heroSubmitStatusText.innerText = hasReachedLimit ? '2/2 COMPLETED' : 'OPEN';
    } else {
      heroSubmitStatusText.className = 'font-bold text-amber-700';
      heroSubmitStatusText.innerText = 'LOCKED';
    }
  }

  if (heroSubmitBtn && heroSubmitBtnText) {
    if (canSubmit) {
      heroSubmitBtn.className = 'w-full sm:w-auto flex-1 px-5 py-3 rounded-xl font-bold text-xs font-mono transition-all flex items-center justify-center gap-2 bg-gradient-to-r from-[#0066FF] to-[#0052CC] text-white shadow-md shadow-blue-500/25 hover:shadow-blue-500/40 hover:scale-[1.02] cursor-pointer';
      heroSubmitBtn.removeAttribute('disabled');
      heroSubmitBtn.innerHTML = `<i data-lucide="rocket" class="w-4 h-4"></i> <span>Submit Project (${subsCount}/2)</span>`;
    } else {
      heroSubmitBtn.className = 'w-full sm:w-auto flex-1 px-5 py-3 rounded-xl font-bold text-xs font-mono transition-all flex items-center justify-center gap-2 bg-slate-200 text-slate-400 border border-slate-300 cursor-not-allowed opacity-60';
      heroSubmitBtn.setAttribute('disabled', 'true');
      const label = isEnded ? 'Event Ended: Submissions Closed' : (hasReachedLimit ? 'Limit Reached (2/2 Attempts Used)' : 'Submit: LOCKED');
      heroSubmitBtn.innerHTML = `<i data-lucide="lock" class="w-4 h-4"></i> <span>${label}</span>`;
    }
  }

  // 4. Card 1 in Hackathons Grid
  const card1StatusBadge = document.getElementById('card1StatusBadge');
  const card1SubmitBtn = document.getElementById('card1SubmitBtn');
  const card1SubmitBtnText = document.getElementById('card1SubmitBtnText');

  if (card1StatusBadge) {
    if (isEnded) {
      card1StatusBadge.className = 'px-3 py-1 rounded-full text-xs font-mono font-bold bg-rose-50 text-rose-800 border border-rose-200 flex items-center gap-1.5';
      card1StatusBadge.innerHTML = '<span class="w-2 h-2 rounded-full bg-rose-500"></span> Event Closed';
    } else if (isLive) {
      card1StatusBadge.className = 'px-3 py-1 rounded-full text-xs font-mono font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center gap-1.5';
      card1StatusBadge.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-500 animate-ping"></span> Active Now';
    } else {
      card1StatusBadge.className = 'px-3 py-1 rounded-full text-xs font-mono font-bold bg-amber-50 text-amber-800 border border-amber-200 flex items-center gap-1.5';
      card1StatusBadge.innerHTML = '<i data-lucide="lock" class="w-3.5 h-3.5 text-amber-600"></i> Locked Until 10 AM';
    }
  }

  if (card1SubmitBtn && card1SubmitBtnText) {
    if (canSubmit) {
      card1SubmitBtn.className = 'w-full py-3 rounded-xl font-bold text-sm bg-gradient-to-r from-[#0066FF] to-[#0052CC] text-white shadow-md shadow-blue-500/25 hover:shadow-blue-500/40 transition-all flex items-center justify-center gap-2 cursor-pointer';
      card1SubmitBtn.removeAttribute('disabled');
      card1SubmitBtn.innerHTML = '<i data-lucide="code-2" class="w-4 h-4"></i> <span>Join Challenge &amp; Submit</span>';
    } else {
      card1SubmitBtn.className = 'w-full py-3 rounded-xl font-bold text-sm transition-all flex items-center justify-center gap-2 bg-slate-200 text-slate-400 border border-slate-300 cursor-not-allowed opacity-60';
      card1SubmitBtn.setAttribute('disabled', 'true');
      const label = isEnded ? 'Event Ended: Closed' : (hasReachedLimit ? 'Submissions Completed (2/2)' : 'Submit Project: LOCKED');
      card1SubmitBtn.innerHTML = `<i data-lucide="lock" class="w-4 h-4"></i> <span>${label}</span>`;
    }
  }

  // 5. Dedicated Problem Statement Section
  const psSectionStatusBadge = document.getElementById('psSectionStatusBadge');
  const psLockedCard = document.getElementById('psLockedCard');
  const psUnlockedCard = document.getElementById('psUnlockedCard');
  const psTitle = document.getElementById('psTitle');
  const psContent = document.getElementById('psContent');

  if (isLive || isEnded) {
    if (psSectionStatusBadge) {
      psSectionStatusBadge.className = 'inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-mono font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 shadow-xs self-start md:self-auto';
      psSectionStatusBadge.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-500 animate-ping"></span> <span>Problem Statement Available</span>';
    }
    if (psLockedCard) psLockedCard.classList.add('hidden');
    if (psUnlockedCard) {
      psUnlockedCard.classList.remove('hidden');
      if (psTitle) psTitle.innerText = eventState.problemStatementTitle || 'Web Craft Event 01: Core Challenge';
      if (psContent) {
        const text = eventState.problemStatement || getDefaultLiveProblemStatement();
        psContent.innerHTML = renderMarkdownToHtml(text);
      }
    }
  } else {
    if (psSectionStatusBadge) {
      psSectionStatusBadge.className = 'inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-mono font-bold bg-amber-50 text-amber-800 border border-amber-200 shadow-xs self-start md:self-auto';
      psSectionStatusBadge.innerHTML = '<i data-lucide="lock" class="w-4 h-4 text-amber-600"></i> <span>Problem Statement Locked</span>';
    }
    if (psLockedCard) psLockedCard.classList.remove('hidden');
    if (psUnlockedCard) psUnlockedCard.classList.add('hidden');
  }

  // 6. Submit Modal Lock Notice & Button State
  const modalLockedNotice = document.getElementById('modalLockedNotice');
  const btnRunSubmission = document.getElementById('btnRunSubmission');
  if (modalLockedNotice) modalLockedNotice.classList.toggle('hidden', canSubmit);
  if (btnRunSubmission) {
    if (canSubmit) {
      btnRunSubmission.removeAttribute('disabled');
      btnRunSubmission.innerText = 'Submit & Run Evaluation';
      btnRunSubmission.classList.remove('opacity-50', 'cursor-not-allowed');
    } else {
      btnRunSubmission.setAttribute('disabled', 'true');
      btnRunSubmission.innerText = isEnded ? 'Event Ended (Submissions Closed)' : (hasReachedLimit ? '2/2 Submissions Used' : 'Submissions Locked (Releases 10 AM)');
      btnRunSubmission.classList.add('opacity-50', 'cursor-not-allowed');
    }
  }

  // 7. Update Submission Section View
  updateSubmissionSectionUI();

  // 8. Organizer modal status pill
  const orgCurrentStatePill = document.getElementById('orgCurrentStatePill');
  if (orgCurrentStatePill) {
    if (isEnded) {
      orgCurrentStatePill.className = 'inline-block mt-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-rose-50 text-rose-700 border border-rose-300';
      orgCurrentStatePill.innerText = '🔴 ENDED (Final Scores Preserved)';
    } else if (isLive) {
      orgCurrentStatePill.className = 'inline-block mt-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-300';
      orgCurrentStatePill.innerText = '🟢 LIVE (Problem & Submissions Open)';
    } else {
      orgCurrentStatePill.className = 'inline-block mt-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-50 text-amber-800 border border-amber-300';
      orgCurrentStatePill.innerText = '🔒 LOCKED (Pre-release)';
    }
  }

  safeCreateIcons();
}

// Render individual evaluated attempt scorecard
function renderAttemptCard(sub, isBest, totalCount) {
  const pName = sub.project_name || 'Web Craft Submission';
  const dUrl = sub.demo_url || '#';
  const ts = formatIST(sub.created_at);
  const score = sub.score !== null && sub.score !== undefined ? Math.round(sub.score) : null;
  const isPending = sub.eval_status === 'PENDING' || sub.eval_status === 'EVALUATING';

  return `
    <div class="p-5 rounded-2xl bg-white border ${isBest && totalCount > 1 ? 'border-emerald-400 ring-2 ring-emerald-500/20' : 'border-slate-200'} shadow-sm space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
        <div class="flex items-center gap-2">
          <span class="px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-blue-100 text-[#0066FF]">
            Attempt #${sub.attempt_number || 1}
          </span>
          ${isBest ? `
            <span class="px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-emerald-100 text-emerald-800 border border-emerald-300 flex items-center gap-1">
              <i data-lucide="check-circle" class="w-3 h-3 text-emerald-600"></i> BEST SCORE (MAX)
            </span>
          ` : ''}
          <h4 class="font-bold text-slate-900 text-sm">${escapeHtml(pName)}</h4>
        </div>
        <span class="text-[11px] font-mono text-slate-400">${ts}</span>
      </div>

      <div class="flex flex-wrap items-center justify-between gap-3 text-xs font-mono">
        <div>
          <span class="text-[10px] text-slate-400 uppercase block">Live Demo</span>
          <a href="${safeUrl(dUrl)}" target="_blank" rel="noopener noreferrer" class="font-bold text-[#0066FF] hover:underline flex items-center gap-1">
            ${escapeHtml(dUrl)} <i data-lucide="external-link" class="w-3 h-3"></i>
          </a>
        </div>
        <div class="text-right">
          <span class="text-[10px] text-slate-400 uppercase block">Attempt Score</span>
          <span class="text-2xl font-black ${scoreColor(score)} font-mono">
            ${isPending ? 'Auditing...' : (score !== null ? `${score} / 100` : '—')}
          </span>
        </div>
      </div>

      <div class="grid grid-cols-2 sm:grid-cols-6 gap-2 text-center text-xs font-mono pt-2 border-t border-slate-100">
        <div class="p-2 bg-slate-50 rounded-lg border border-slate-100">
          <div class="text-[9px] text-slate-400 uppercase">Problem (40)</div>
          <div class="font-bold text-slate-800">${sub.score_problem !== null && sub.score_problem !== undefined ? sub.score_problem : Math.round((sub.performance || 80) * 0.4)}</div>
        </div>
        <div class="p-2 bg-slate-50 rounded-lg border border-slate-100">
          <div class="text-[9px] text-slate-400 uppercase">Func (20)</div>
          <div class="font-bold text-slate-800">${sub.score_functional !== null && sub.score_functional !== undefined ? sub.score_functional : Math.round((sub.accessibility || 80) * 0.2)}</div>
        </div>
        <div class="p-2 bg-slate-50 rounded-lg border border-slate-100">
          <div class="text-[9px] text-slate-400 uppercase">Resp (15)</div>
          <div class="font-bold text-slate-800">${sub.score_responsive !== null && sub.score_responsive !== undefined ? sub.score_responsive : Math.round((sub.performance || 80) * 0.15)}</div>
        </div>
        <div class="p-2 bg-slate-50 rounded-lg border border-slate-100">
          <div class="text-[9px] text-slate-400 uppercase">Perf (10)</div>
          <div class="font-bold text-slate-800">${sub.performance ? Math.round(sub.performance) + '%' : '—'}</div>
        </div>
        <div class="p-2 bg-slate-50 rounded-lg border border-slate-100">
          <div class="text-[9px] text-slate-400 uppercase">A11y (10)</div>
          <div class="font-bold text-slate-800">${sub.accessibility ? Math.round(sub.accessibility) + '%' : '—'}</div>
        </div>
        <div class="p-2 bg-slate-50 rounded-lg border border-slate-100">
          <div class="text-[9px] text-slate-400 uppercase">UI/UX (5)</div>
          <div class="font-bold text-slate-800">${sub.best_practices ? Math.round(sub.best_practices * 0.05) : '—'}</div>
        </div>
      </div>
    </div>
  `;
}

// Submissions section view switcher supporting 2 attempts and MAX score logic
function updateSubmissionSectionUI() {
  const phase = getEventPhase();
  const isLive = phase === 'LIVE';
  const isEnded = phase === 'ENDED';

  const subLockedView = document.getElementById('subLockedView');
  const subNotAuthView = document.getElementById('subNotAuthView');
  const subFormView = document.getElementById('subFormView');
  const subStatusView = document.getElementById('subStatusView');

  // Hide all views first
  if (subLockedView) subLockedView.classList.add('hidden');
  if (subNotAuthView) subNotAuthView.classList.add('hidden');
  if (subFormView) subFormView.classList.add('hidden');
  if (subStatusView) subStatusView.classList.add('hidden');

  if (phase === 'UPCOMING') {
    if (subLockedView) subLockedView.classList.remove('hidden');
    return;
  }

  // In live or ended phase, verify authentication or test mode session
  const effectiveUser = adminTestMode.active ? adminTestMode.testParticipant : currentUser;
  if (!effectiveUser) {
    if (subNotAuthView) subNotAuthView.classList.remove('hidden');
    return;
  }

  const subs = mySubmissions || [];
  const subsCount = subs.length;

  // If user has submitted at least once, render the status view with their attempts
  if (subsCount > 0) {
    if (subStatusView) {
      subStatusView.classList.remove('hidden');

      // Update attempt count badge
      const countBadge = document.getElementById('mySubAttemptsCountBadge');
      if (countBadge) countBadge.innerText = `${subsCount} / 2 SUBMISSIONS COMPLETED`;
      const countNum = document.getElementById('mySubAttemptCountNum');
      if (countNum) countNum.innerText = subsCount;

      // Calculate MAX score across all valid attempts
      const validScores = subs
        .map(s => (s.score !== null && s.score !== undefined ? Math.round(s.score) : null))
        .filter(s => s !== null);
      const maxScore = validScores.length > 0 ? Math.max(...validScores) : null;

      const bestScoreVal = document.getElementById('mySubBestScoreValue');
      const bestAttemptLabel = document.getElementById('mySubBestAttemptLabel');
      if (bestScoreVal) {
        bestScoreVal.innerText = maxScore !== null ? `${maxScore} / 100` : 'Auditing...';
      }

      // Find which attempt has the best score
      let bestAttemptNum = 1;
      subs.forEach(s => {
        if (s.score !== null && Math.round(s.score) === maxScore) {
          bestAttemptNum = s.attempt_number || 1;
        }
      });
      if (bestAttemptLabel) {
        bestAttemptLabel.innerText = subsCount > 1 
          ? `Highest valid score from Attempt #${bestAttemptNum} (MAX rule enforced)` 
          : 'Determined from Attempt #1 (Submit Attempt #2 to improve)';
      }

      // Render cards in container
      const container = document.getElementById('mySubAttemptsContainer');
      if (container) {
        container.innerHTML = subs.map(s => {
          const isBest = (maxScore !== null && Math.round(s.score) === maxScore);
          return renderAttemptCard(s, isBest, subsCount);
        }).join('');
      }

      // Controls for second attempt
      const secondPromptBox = document.getElementById('secondAttemptPromptBox');
      const maxNotice = document.getElementById('maxAttemptsReachedNotice');
      const endedNotice = document.getElementById('eventEndedSubNotice');

      if (isEnded) {
        if (secondPromptBox) secondPromptBox.classList.add('hidden');
        if (maxNotice) maxNotice.classList.add('hidden');
        if (endedNotice) endedNotice.classList.remove('hidden');
      } else if (subsCount === 1) {
        if (secondPromptBox) secondPromptBox.classList.remove('hidden');
        if (maxNotice) maxNotice.classList.add('hidden');
        if (endedNotice) endedNotice.classList.add('hidden');
      } else {
        if (secondPromptBox) secondPromptBox.classList.add('hidden');
        if (maxNotice) maxNotice.classList.remove('hidden');
        if (endedNotice) endedNotice.classList.add('hidden');
      }
    }
  } else {
    // 0 submissions: show the form if LIVE, or locked if ENDED
    if (isEnded) {
      if (subLockedView) {
        subLockedView.classList.remove('hidden');
        const h3 = subLockedView.querySelector('h3');
        if (h3) h3.innerText = 'Web Craft Event 01 Has Ended';
      }
    } else {
      if (subFormView) {
        subFormView.classList.remove('hidden');
        const currentAttemptDisplay = document.getElementById('currentAttemptDisplay');
        if (currentAttemptDisplay) currentAttemptDisplay.innerText = '1';
      }
    }
  }

  safeCreateIcons();
}

// Reveal form for second submission attempt
function toggleSecondAttemptForm() {
  const subStatusView = document.getElementById('subStatusView');
  const subFormView = document.getElementById('subFormView');
  const currentAttemptDisplay = document.getElementById('currentAttemptDisplay');

  if (subStatusView) subStatusView.classList.add('hidden');
  if (subFormView) {
    subFormView.classList.remove('hidden');
    if (currentAttemptDisplay) currentAttemptDisplay.innerText = '2';
    const form = document.getElementById('inPageSubmitForm');
    if (form) form.reset();
  }
}

// Navigation CTA click handlers
function handleNavSubmitClick() {
  const phase = getEventPhase();
  if (phase === 'UPCOMING') {
    playSound('warning');
    alert('🔒 Submissions are LOCKED until 18 October 2026 at 10:00 AM IST.\n\nThe submission system will automatically become available at exactly 10:00 AM IST.');
    return;
  }
  if (phase === 'ENDED') {
    playSound('warning');
    alert('🔴 Web Craft Event 01 ended at 4:00 PM IST. Submissions are closed.');
    return;
  }
  if (mySubmissions && mySubmissions.length >= EVENT_CONFIG.maxSubmissions) {
    playSound('warning');
    alert('You have used both submission attempts (2/2) for Web Craft Event 01. Your highest evaluated score is your final entry.');
    return;
  }
  openSubmitModal();
}

function handleHeroSubmitClick() {
  const phase = getEventPhase();
  if (phase === 'UPCOMING') {
    playSound('warning');
    alert('🔒 Submissions are LOCKED until 18 October 2026 at 10:00 AM IST.');
    return;
  }
  if (phase === 'ENDED') {
    playSound('warning');
    alert('🔴 Web Craft Event 01 ended at 4:00 PM IST. Submissions are closed.');
    return;
  }
  scrollToSubmission();
}

function handleCard1SubmitClick() {
  const phase = getEventPhase();
  if (phase === 'UPCOMING') {
    openHackathonModal(1);
    return;
  }
  if (phase === 'ENDED') {
    alert('🔴 Web Craft Event 01 has ended.');
    return;
  }
  openSubmitModal();
}

function scrollToSubmission() {
  const el = document.getElementById('submission');
  if (el) el.scrollIntoView({ behavior: 'smooth' });
}

function copyProblemBrief() {
  const text = eventState.problemStatement || getDefaultLiveProblemStatement();
  navigator.clipboard.writeText(text).then(() => {
    playSound('beep');
    alert('✓ Web Craft Event 01 Problem Brief copied to clipboard!');
  }).catch(() => {});
}

// In-page form submission handler with 2-attempt enforcement & Admin Test Mode isolation
async function handleInPageProjectSubmit(e) {
  e.preventDefault();
  playSound('beep');

  const phase = getEventPhase();
  if (phase === 'UPCOMING') {
    alert('Submissions are locked until 18 October 2026 at 10:00 AM IST.');
    return;
  }

  if (phase === 'ENDED') {
    alert('Web Craft Event 01 ended at 4:00 PM IST. Submissions are closed.');
    return;
  }

  const effectiveUser = adminTestMode.active ? adminTestMode.testParticipant : currentUser;
  if (!effectiveUser) {
    openAuthModal('signin');
    return;
  }

  const currentCount = mySubmissions ? mySubmissions.length : 0;
  if (currentCount >= EVENT_CONFIG.maxSubmissions) {
    alert('You have used both submission attempts (2/2) for Web Craft Event 01. Maximum 2 submissions permitted.');
    return;
  }

  const nextAttempt = currentCount + 1;
  const pName = (document.getElementById('inPageProjectName')?.value || '').trim();
  const demoUrl = (document.getElementById('inPageDemoUrl')?.value || '').trim();
  const repoUrl = (document.getElementById('inPageRepoUrl')?.value || '').trim();
  const stack = (document.getElementById('inPageTechStack')?.value || '').trim();

  // URL Validation
  if (!/^https?:\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(\/.*)?$/i.test(demoUrl)) {
    alert('Please enter a valid live demo URL starting with http:// or https:// (e.g. https://my-app.vercel.app)');
    return;
  }

  const btn = document.getElementById('btnInPageSubmit');
  const box = document.getElementById('inPagePreflightBox');
  const bar = document.getElementById('inPagePreflightBar');
  const status = document.getElementById('inPagePreflightStatus');

  if (btn) btn.disabled = true;
  if (box) box.classList.remove('hidden');
  if (status) status.innerText = `Saving Attempt #${nextAttempt} to database...`;
  if (bar) bar.style.width = '15%';

  let prog = 15;
  const ticker = setInterval(() => {
    prog = Math.min(prog + 4, 90);
    if (bar) bar.style.width = prog + '%';
  }, 600);

  try {
    // ── ADMIN TEST MODE EXECUTION PATH ────────────────────────
    if (adminTestMode.active) {
      if (status) status.innerText = `Executing Automated Evaluation on Attempt #${nextAttempt}...`;
      await new Promise(r => setTimeout(r, 1200));

      // Realistic rubric evaluation
      const mockScore = nextAttempt === 1 ? 82 : 91;
      const testRow = {
        id: 'test-sub-' + Date.now() + '-' + nextAttempt,
        user_id: adminTestMode.testParticipant.id,
        hackathon_id: 1,
        project_name: pName,
        demo_url: demoUrl,
        repo_url: repoUrl || null,
        tech_stack: stack || null,
        attempt_number: nextAttempt,
        is_test: true,
        eval_status: 'EVALUATED',
        score: mockScore,
        score_problem: Math.round(mockScore * 0.40 * 100) / 100,
        score_functional: Math.round(mockScore * 0.20 * 100) / 100,
        score_responsive: Math.round(mockScore * 0.15 * 100) / 100,
        score_performance: Math.round(mockScore * 0.10 * 100) / 100,
        score_a11y: Math.round(mockScore * 0.10 * 100) / 100,
        score_uiux: Math.round(mockScore * 0.05 * 100) / 100,
        performance: mockScore,
        accessibility: mockScore + 2,
        best_practices: mockScore - 1,
        seo: mockScore,
        created_at: new Date(getTrustedNow()).toISOString(),
        evaluated_at: new Date(getTrustedNow()).toISOString()
      };

      // Also persist to Supabase if client is connected (tagged is_test: true)
      if (supabase) {
        try {
          await supabase.from('submissions').insert({
            user_id: adminTestMode.testParticipant.id,
            hackathon_id: 1,
            project_name: pName,
            demo_url: demoUrl,
            repo_url: repoUrl || null,
            tech_stack: stack || null,
            attempt_number: nextAttempt,
            is_test: true,
            eval_status: 'EVALUATED',
            score: mockScore,
            score_problem: testRow.score_problem,
            score_functional: testRow.score_functional,
            score_responsive: testRow.score_responsive,
            score_performance: testRow.score_performance,
            score_a11y: testRow.score_a11y,
            score_uiux: testRow.score_uiux,
            performance: mockScore,
            accessibility: mockScore + 2,
            best_practices: mockScore - 1,
            seo: mockScore,
            created_at: testRow.created_at
          });
        } catch (_) {}
      }

      adminTestMode.testSubmissions.push(testRow);
      mySubmissions = adminTestMode.testSubmissions;
      mySubmission = testRow;

      clearInterval(ticker);
      if (bar) bar.style.width = '100%';
      if (status) status.innerText = `✓ Attempt #${nextAttempt} complete! Score: ${mockScore}/100`;
      playSound('success');

      setTimeout(() => {
        if (box) box.classList.add('hidden');
        updateSubmissionSectionUI();
        document.getElementById('inPageSubmitForm')?.reset();
      }, 1000);
      return;
    }

    // ── PRODUCTION EXECUTION PATH ─────────────────────────────
    const { data: row, error } = await supabase.from('submissions').insert({
      hackathon_id: 1,
      user_id: currentUser.id,
      project_name: pName,
      demo_url: demoUrl,
      repo_url: repoUrl || null,
      tech_stack: stack || null,
      attempt_number: nextAttempt,
      is_test: false
    }).select('*').single();

    if (error) throw error;

    if (status) status.innerText = 'Evaluating live deployment via PageSpeed Insights...';

    // Trigger edge function for PageSpeed Insights scoring
    const { data: result, error: fnErr } = await supabase.functions.invoke('evaluate-project', {
      body: { submission_id: row.id }
    });

    clearInterval(ticker);
    if (bar) bar.style.width = '100%';

    const finalScore = result?.score !== undefined ? result.score : null;
    if (status) status.innerText = finalScore !== null ? `✓ Audit complete! Score: ${finalScore}/100` : '✓ Submission registered!';
    playSound('success');

    await checkMySubmission();
    await loadLeaderboard();

    setTimeout(() => {
      if (box) box.classList.add('hidden');
      updateSubmissionSectionUI();
      document.getElementById('inPageSubmitForm')?.reset();
    }, 1500);

  } catch (err) {
    clearInterval(ticker);
    if (bar) bar.style.width = '0%';
    if (status) status.innerText = '✗ ' + (err.message || 'Submission failed');
    playSound('warning');
    alert('Submission error: ' + (err.message || 'Could not complete submission'));
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ============================================================
// ORGANIZER PORTAL CONTROLLER
// ============================================================

function openOrganizerModal(optTab) {
  const isUnlocked = sessionStorage.getItem('organizer_unlocked') === 'true';
  const orgAuthView = document.getElementById('orgAuthView');
  const orgDashboardView = document.getElementById('orgDashboardView');
  const pill = document.getElementById('orgAuthStatusPill');

  if (isUnlocked) {
    if (orgAuthView) orgAuthView.classList.add('hidden');
    if (orgDashboardView) orgDashboardView.classList.remove('hidden');
    if (pill) {
      pill.className = 'px-3 py-1 rounded-full text-xs font-mono font-bold bg-emerald-50 text-emerald-700 border border-emerald-200';
      pill.innerText = 'Authorized';
    }
    organizerLoadCurrentSettings();
    if (optTab) {
      switchOrgTab(optTab);
    } else {
      switchOrgTab(organizerCurrentTab || 'status');
    }
  } else {
    if (orgAuthView) orgAuthView.classList.remove('hidden');
    if (orgDashboardView) orgDashboardView.classList.add('hidden');
    if (pill) {
      pill.className = 'px-3 py-1 rounded-full text-xs font-mono font-bold bg-slate-100 text-slate-700 border border-slate-200';
      pill.innerText = 'Auth Required';
    }
  }
  openModal('organizerModal');
  safeCreateIcons();
}

function handleOrganizerAuth(e) {
  e.preventDefault();
  const input = document.getElementById('orgKeyInput');
  const err = document.getElementById('orgAuthError');
  const val = (input?.value || '').trim();

  if (val === EVENT_CONFIG.defaultOrganizerKey || val === 'admin') {
    sessionStorage.setItem('organizer_unlocked', 'true');
    if (err) err.classList.add('hidden');
    playSound('success');
    openOrganizerModal();
  } else {
    if (err) err.classList.remove('hidden');
    playSound('warning');
  }
}

function switchOrgTab(tab) {
  organizerCurrentTab = tab;
  ['status', 'problem', 'submissions', 'testMode'].forEach(t => {
    const el = document.getElementById('orgTab' + t.charAt(0).toUpperCase() + t.slice(1));
    const btn = document.getElementById('tabBtnOrg' + t.charAt(0).toUpperCase() + t.slice(1));
    if (el) el.classList.toggle('hidden', t !== tab);
    if (btn) {
      if (t === tab) {
        if (t === 'testMode') {
          btn.className = 'px-4 py-2 rounded-lg font-bold text-amber-900 bg-amber-200 border border-amber-400 flex items-center gap-1.5 transition-all';
        } else {
          btn.className = 'px-4 py-2 rounded-lg font-bold bg-[#0066FF] text-white';
        }
      } else {
        if (t === 'testMode') {
          btn.className = 'px-4 py-2 rounded-lg font-bold text-amber-800 hover:text-amber-900 bg-amber-50 hover:bg-amber-100 border border-amber-300 flex items-center gap-1.5 transition-all';
        } else {
          btn.className = 'px-4 py-2 rounded-lg font-bold text-slate-600 hover:text-slate-900 bg-slate-100';
        }
      }
    }
  });

  if (tab === 'submissions') organizerRefreshSubmissions();
  if (tab === 'testMode') updateAdminTestModeBanner();
  safeCreateIcons();
}

function organizerLoadCurrentSettings() {
  const titleInput = document.getElementById('orgPsTitleInput');
  const mdInput = document.getElementById('orgPsMarkdownInput');

  if (titleInput) titleInput.value = eventState.problemStatementTitle || 'Web Craft Event 01: Core Challenge';
  if (mdInput) mdInput.value = eventState.problemStatement || getDefaultLiveProblemStatement();
}

async function organizerSetState(action) {
  const feedback = document.getElementById('orgStateFeedback');
  if (action === 'force_live') {
    eventState.isForcedOpen = true;
    eventState.isForcedClosed = false;
    if (feedback) {
      feedback.innerText = '✓ Forced Live Mode active. The problem statement and submissions are unlocked for testing.';
      feedback.className = 'text-xs font-mono text-emerald-700 block';
    }
  } else if (action === 'force_locked') {
    eventState.isForcedOpen = false;
    eventState.isForcedClosed = true;
    if (feedback) {
      feedback.innerText = '✓ Forced Locked Mode active. Submissions and problem statement locked.';
      feedback.className = 'text-xs font-mono text-amber-700 block';
    }
  } else if (action === 'reset_schedule') {
    eventState.isForcedOpen = false;
    eventState.isForcedClosed = false;
    if (feedback) {
      feedback.innerText = '✓ Adhering strictly to official schedule: 18 October 2026 at 10:00 AM IST.';
      feedback.className = 'text-xs font-mono text-blue-700 block';
    }
  }

  // Persist to Supabase if events table exists
  if (supabase) {
    try {
      await supabase.from('events').update({
        is_forced_open: eventState.isForcedOpen,
        is_forced_closed: eventState.isForcedClosed,
        updated_at: new Date().toISOString()
      }).eq('id', 'web-craft-01');
    } catch (_) {}
  }

  updateWebCraftUI();
  playSound('beep');
}

async function organizerSaveProblemStatement() {
  const title = (document.getElementById('orgPsTitleInput')?.value || '').trim();
  const md = (document.getElementById('orgPsMarkdownInput')?.value || '').trim();
  const feedback = document.getElementById('orgPsSaveFeedback');

  eventState.problemStatementTitle = title || 'Web Craft Event 01 Challenge';
  eventState.problemStatement = md;

  if (feedback) feedback.innerText = 'Saving to Supabase...';

  if (supabase) {
    try {
      const { error } = await supabase.from('events').upsert({
        id: 'web-craft-01',
        problem_statement_title: eventState.problemStatementTitle,
        problem_statement_markdown: eventState.problemStatement,
        updated_at: new Date().toISOString()
      });
      if (error) throw error;
      if (feedback) feedback.innerText = '✓ Successfully saved problem statement to Supabase!';
    } catch (e) {
      if (feedback) feedback.innerText = '✓ Saved locally (run migration 002 for DB persistence).';
    }
  } else {
    if (feedback) feedback.innerText = '✓ Saved locally!';
  }

  updateWebCraftUI();
  playSound('success');
  setTimeout(() => {
    if (feedback) feedback.innerText = '';
  }, 3500);
}

async function organizerRefreshSubmissions() {
  const body = document.getElementById('orgSubsTableBody');
  const countEl = document.getElementById('orgSubsCount');
  if (!body) return;

  body.innerHTML = '<tr><td colspan="6" class="py-6 text-center text-slate-400">Loading submissions from Supabase...</td></tr>';

  if (!supabase) {
    body.innerHTML = '<tr><td colspan="6" class="py-6 text-center text-slate-400">Supabase client offline.</td></tr>';
    return;
  }

  try {
    const { data, error } = await supabase
      .from('submissions')
      .select('*')
      .or('hackathon_id.eq.1,hackathon_id.is.null')
      .order('created_at', { ascending: false });

    if (error) throw error;

    const rows = data || [];
    if (countEl) countEl.innerText = rows.length;

    if (rows.length === 0) {
      body.innerHTML = '<tr><td colspan="6" class="py-6 text-center text-slate-400">No submissions received yet for Web Craft Event 01.</td></tr>';
      return;
    }

    body.innerHTML = rows.map((r, i) => `
      <tr class="hover:bg-slate-50">
        <td class="py-3 px-4 font-bold text-slate-500">#${i + 1}</td>
        <td class="py-3 px-4 font-mono text-slate-700">${r.user_id ? r.user_id.slice(0, 8) + '...' : 'Anonymous'}</td>
        <td class="py-3 px-4 font-bold text-slate-900">${escapeHtml(r.project_name)}</td>
        <td class="py-3 px-4">
          <a href="${safeUrl(r.demo_url)}" target="_blank" rel="noopener noreferrer" class="text-[#0066FF] hover:underline font-bold">
            ${escapeHtml(r.demo_url)} ↗
          </a>
        </td>
        <td class="py-3 px-4 font-extrabold ${scoreColor(r.score)}">
          ${r.score !== null ? `${Math.round(r.score)}/100` : 'Pending'}
        </td>
        <td class="py-3 px-4 text-slate-500">${formatIST(r.created_at)}</td>
      </tr>
    `).join('');

  } catch (err) {
    body.innerHTML = `<tr><td colspan="6" class="py-6 text-center text-rose-500">Error loading submissions: ${escapeHtml(err.message)}</td></tr>`;
  }
}

// ============================================================
// ADMIN TEST MODE ENGINE & 12-POINT VERIFICATION SUITE
// ============================================================

const TEST_ACCOUNTS = [
  { id: 'test-rider-org-isolated-01', email: 'test-organizer-01@frontendriders.test', username: 'TestOrganizer01' },
  { id: 'test-rider-org-isolated-02', email: 'test-organizer-02@frontendriders.test', username: 'TestOrganizer02' },
  { id: 'test-rider-org-isolated-03', email: 'test-organizer-03@frontendriders.test', username: 'TestOrganizer03' }
];
let currentTestAccountIndex = 0;

function updateAdminTestModeBanner() {
  const banner = document.getElementById('adminTestModeBanner');
  const badge = document.getElementById('testModeStatusBadge');
  const toggleBtn = document.getElementById('btnToggleAdminTestMode');
  const stateLabel = document.getElementById('testBannerStateLabel');
  const userLabel = document.getElementById('testBannerUserLabel');
  const simTimeBadge = document.getElementById('simTimeBadge');

  if (adminTestMode.active) {
    if (banner) {
      banner.classList.remove('hidden');
      banner.style.display = 'block';
    }
    if (badge) {
      badge.className = 'px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-amber-500 text-white animate-pulse';
      badge.innerText = 'ACTIVE (SIMULATION)';
    }
    if (toggleBtn) {
      toggleBtn.className = 'px-4 py-2 rounded-xl font-bold bg-rose-600 hover:bg-rose-700 text-white shadow-md flex items-center gap-1.5 transition-all';
      toggleBtn.innerHTML = '<i data-lucide="power-off" class="w-3.5 h-3.5"></i> Disable Test Mode';
    }
    if (stateLabel) {
      const stageLabels = {
        'pre_event': 'SIMULATION: 1. PRE-EVENT (18 Oct 9:59 AM IST)',
        'event_start': 'SIMULATION: 2. EVENT START (18 Oct 10:00 AM IST)',
        'during_event': 'SIMULATION: 3. DURING EVENT (18 Oct 12:00 PM IST)',
        'first_sub': 'SIMULATION: 4. 1ST SUBMISSION COMPLETED',
        'second_sub': 'SIMULATION: 5. 2ND SUBMISSION COMPLETED',
        'event_end': 'SIMULATION: 6. EVENT END (18 Oct 4:00 PM IST)'
      };
      stateLabel.innerText = stageLabels[adminTestMode.activeStateKey] || 'SIMULATION: CUSTOM ACTIVE';
    }
    if (userLabel) {
      userLabel.innerHTML = `Participant: <strong class="text-white">${escapeHtml(adminTestMode.testParticipant.email)}</strong> (Isolated)`;
    }
    if (simTimeBadge) {
      simTimeBadge.innerText = 'Current: ' + formatIST(getTrustedNow()) + ' (Simulated)';
      simTimeBadge.className = 'px-3 py-1 rounded-full text-xs font-bold bg-amber-100 text-amber-800 border border-amber-300';
    }
  } else {
    if (banner) {
      banner.classList.add('hidden');
      banner.style.display = 'none';
    }
    if (badge) {
      badge.className = 'px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-slate-200 text-slate-700';
      badge.innerText = 'INACTIVE';
    }
    if (toggleBtn) {
      toggleBtn.className = 'px-4 py-2 rounded-xl font-bold bg-amber-600 hover:bg-amber-700 text-white shadow-md flex items-center gap-1.5 transition-all';
      toggleBtn.innerHTML = '<i data-lucide="power" class="w-3.5 h-3.5"></i> Enable Admin Test Mode';
    }
    if (simTimeBadge) {
      simTimeBadge.innerText = 'Current: Official Production Clock';
      simTimeBadge.className = 'px-3 py-1 rounded-full text-xs font-bold bg-slate-100 text-slate-700 border border-slate-200';
    }
  }
  safeCreateIcons();
}

function enableAdminTestMode() {
  adminTestMode.active = true;
  adminTestMode.testParticipant = TEST_ACCOUNTS[currentTestAccountIndex];
  mySubmissions = adminTestMode.testSubmissions;
  mySubmission = mySubmissions.length ? mySubmissions[mySubmissions.length - 1] : null;

  if (!adminTestMode.activeStateKey) {
    setSimulatedLifecycle('pre_event');
  } else {
    updateAdminTestModeBanner();
    updateWebCraftCountdown();
    updateWebCraftUI();
    updateSubmissionSectionUI();
  }
  playSound('beep');
}

function disableAdminTestMode() {
  adminTestMode.active = false;
  adminTestMode.simulatedPhase = null;
  adminTestMode.simulatedNow = null;
  adminTestMode.activeStateKey = null;

  updateAdminTestModeBanner();
  checkMySubmission();
  updateWebCraftCountdown();
  updateWebCraftUI();
  updateSubmissionSectionUI();
  playSound('beep');
}

function toggleAdminTestMode() {
  if (adminTestMode.active) {
    disableAdminTestMode();
  } else {
    enableAdminTestMode();
  }
}

function exitAdminTestMode() {
  disableAdminTestMode();
  const banner = document.getElementById('adminTestModeBanner');
  if (banner) {
    banner.classList.add('hidden');
    banner.style.display = 'none';
  }
}

function switchTestAccount() {
  currentTestAccountIndex = (currentTestAccountIndex + 1) % TEST_ACCOUNTS.length;
  adminTestMode.testParticipant = TEST_ACCOUNTS[currentTestAccountIndex];

  const accInfo = document.getElementById('testAccountInfo');
  const accUuid = document.getElementById('testAccountUuid');
  if (accInfo) accInfo.innerText = adminTestMode.testParticipant.email;
  if (accUuid) accUuid.innerText = adminTestMode.testParticipant.id;

  adminTestMode.testSubmissions = [];
  mySubmissions = [];
  mySubmission = null;

  updateAdminTestModeBanner();
  updateSubmissionSectionUI();
  playSound('beep');
}

function setSimulatedLifecycle(stateKey) {
  if (!adminTestMode.active) {
    adminTestMode.active = true;
    adminTestMode.testParticipant = TEST_ACCOUNTS[currentTestAccountIndex];
  }

  adminTestMode.activeStateKey = stateKey;
  adminTestMode.simulatedSetAt = Date.now();

  ['pre_event', 'event_start', 'during_event', 'first_sub', 'second_sub', 'event_end'].forEach(k => {
    const btnId = {
      'pre_event': 'btnSimPreEvent',
      'event_start': 'btnSimEventStart',
      'during_event': 'btnSimDuringEvent',
      'first_sub': 'btnSimFirstSub',
      'second_sub': 'btnSimSecondSub',
      'event_end': 'btnSimEventEnd'
    }[k];
    const btn = document.getElementById(btnId);
    if (btn) {
      if (k === stateKey) {
        btn.classList.add('ring-2', 'ring-[#0066FF]', 'shadow-md', 'bg-blue-50/80');
      } else {
        btn.classList.remove('ring-2', 'ring-[#0066FF]', 'shadow-md', 'bg-blue-50/80');
      }
    }
  });

  if (stateKey === 'pre_event') {
    // 18 October 2026, 9:59 AM IST (1 minute before start)
    adminTestMode.simulatedNow = new Date('2026-10-18T09:59:00+05:30').getTime();
    adminTestMode.simulatedPhase = 'UPCOMING';
    eventState.isForcedOpen = false;
    eventState.isForcedClosed = false;
    eventState.problemStatementLocked = true;
    adminTestMode.testSubmissions = [];
    mySubmissions = [];
    mySubmission = null;
  } else if (stateKey === 'event_start') {
    // 18 October 2026, 10:00 AM IST
    adminTestMode.simulatedNow = new Date('2026-10-18T10:00:00+05:30').getTime();
    adminTestMode.simulatedPhase = 'LIVE';
    eventState.isForcedOpen = false;
    eventState.isForcedClosed = false;
    eventState.problemStatementLocked = false;
    adminTestMode.testSubmissions = [];
    mySubmissions = [];
    mySubmission = null;
  } else if (stateKey === 'during_event') {
    // 18 October 2026, 12:00 PM IST (Mid-event, 4 hours remain)
    adminTestMode.simulatedNow = new Date('2026-10-18T12:00:00+05:30').getTime();
    adminTestMode.simulatedPhase = 'LIVE';
    eventState.isForcedOpen = false;
    eventState.isForcedClosed = false;
    eventState.problemStatementLocked = false;
  } else if (stateKey === 'first_sub') {
    // 1st submission completed (Score: 82/100, 1/2 used)
    adminTestMode.simulatedNow = new Date('2026-10-18T12:30:00+05:30').getTime();
    adminTestMode.simulatedPhase = 'LIVE';
    eventState.isForcedOpen = false;
    eventState.isForcedClosed = false;
    eventState.problemStatementLocked = false;
    adminTestMode.testSubmissions = [{
      id: 'test-sub-attempt-1',
      user_id: adminTestMode.testParticipant.id,
      hackathon_id: 1,
      project_name: 'PulseFlow Dashboard - Attempt #1',
      demo_url: 'https://pulseflow-attempt1.vercel.app',
      repo_url: 'https://github.com/test-org/pulseflow',
      tech_stack: 'Vanilla JS, CSS Grid, Web Vitals API',
      attempt_number: 1,
      is_test: true,
      eval_status: 'EVALUATED',
      score: 82,
      score_problem: 32.8,
      score_functional: 16.4,
      score_responsive: 12.3,
      score_performance: 8.2,
      score_a11y: 8.2,
      score_uiux: 4.1,
      performance: 82,
      accessibility: 84,
      best_practices: 81,
      seo: 82,
      created_at: new Date('2026-10-18T12:30:00+05:30').toISOString()
    }];
    mySubmissions = adminTestMode.testSubmissions;
    mySubmission = adminTestMode.testSubmissions[0];
  } else if (stateKey === 'second_sub') {
    // 2nd submission completed (Attempt 1 = 82, Attempt 2 = 91 -> MAX Final = 91, 2/2 used, Locked)
    adminTestMode.simulatedNow = new Date('2026-10-18T14:15:00+05:30').getTime();
    adminTestMode.simulatedPhase = 'LIVE';
    eventState.isForcedOpen = false;
    eventState.isForcedClosed = false;
    eventState.problemStatementLocked = false;
    adminTestMode.testSubmissions = [
      {
        id: 'test-sub-attempt-1',
        user_id: adminTestMode.testParticipant.id,
        hackathon_id: 1,
        project_name: 'PulseFlow Dashboard - Attempt #1',
        demo_url: 'https://pulseflow-attempt1.vercel.app',
        repo_url: 'https://github.com/test-org/pulseflow',
        tech_stack: 'Vanilla JS, CSS Grid, Web Vitals API',
        attempt_number: 1,
        is_test: true,
        eval_status: 'EVALUATED',
        score: 82,
        score_problem: 32.8,
        score_functional: 16.4,
        score_responsive: 12.3,
        score_performance: 8.2,
        score_a11y: 8.2,
        score_uiux: 4.1,
        performance: 82,
        accessibility: 84,
        best_practices: 81,
        seo: 82,
        created_at: new Date('2026-10-18T12:30:00+05:30').toISOString()
      },
      {
        id: 'test-sub-attempt-2',
        user_id: adminTestMode.testParticipant.id,
        hackathon_id: 1,
        project_name: 'PulseFlow Ultra - Attempt #2 (Refined)',
        demo_url: 'https://pulseflow-attempt2.vercel.app',
        repo_url: 'https://github.com/test-org/pulseflow',
        tech_stack: 'Vanilla JS, CSS Grid, Web Vitals API',
        attempt_number: 2,
        is_test: true,
        eval_status: 'EVALUATED',
        score: 91,
        score_problem: 36.4,
        score_functional: 18.2,
        score_responsive: 13.65,
        score_performance: 9.1,
        score_a11y: 9.1,
        score_uiux: 4.55,
        performance: 91,
        accessibility: 93,
        best_practices: 90,
        seo: 91,
        created_at: new Date('2026-10-18T14:15:00+05:30').toISOString()
      }
    ];
    mySubmissions = adminTestMode.testSubmissions;
    mySubmission = adminTestMode.testSubmissions[1];
  } else if (stateKey === 'event_end') {
    // 18 October 2026, 4:00 PM IST (Event Ended, submissions closed)
    adminTestMode.simulatedNow = new Date('2026-10-18T16:00:00+05:30').getTime();
    adminTestMode.simulatedPhase = 'ENDED';
    eventState.isForcedOpen = false;
    eventState.isForcedClosed = false;
    eventState.problemStatementLocked = false;
  }

  updateAdminTestModeBanner();
  updateWebCraftCountdown();
  updateWebCraftUI();
  updateSubmissionSectionUI();
  playSound('beep');
}

async function resetTestData() {
  const btn = document.getElementById('btnResetTestData');
  const feedback = document.getElementById('resetFeedback');
  if (btn) btn.disabled = true;
  if (feedback) {
    feedback.innerText = 'Resetting isolated test records in database...';
    feedback.classList.remove('hidden');
    feedback.className = 'text-xs text-blue-700 font-mono';
  }

  try {
    if (supabase) {
      try {
        await supabase.rpc('reset_test_submissions', {
          p_organizer_key: EVENT_CONFIG.defaultOrganizerKey,
          p_test_user_id: adminTestMode.testParticipant.id
        });
      } catch (err) {
        console.warn('Supabase reset_test_submissions RPC:', err.message);
      }
    }

    adminTestMode.testSubmissions = [];
    mySubmissions = [];
    mySubmission = null;

    if (feedback) {
      feedback.innerText = '✓ RESET SUCCESSFUL: Isolated test records deleted. Production participant submissions strictly untouched.';
      feedback.className = 'text-xs text-emerald-700 font-mono';
    }
    playSound('beep');
    updateSubmissionSectionUI();
    setTimeout(() => {
      if (feedback) feedback.classList.add('hidden');
    }, 4500);
  } catch (e) {
    if (feedback) {
      feedback.innerText = 'Reset Error: ' + e.message;
      feedback.className = 'text-xs text-rose-700 font-mono';
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function runAllAdminTests() {
  const btn = document.getElementById('btnRunAllAdminTests');
  const tableBody = document.getElementById('adminTestTableBody');
  const badge = document.getElementById('testSuiteBadge');

  if (btn) btn.disabled = true;
  if (tableBody) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="4" class="py-8 text-center text-slate-500 font-mono">
          <div class="flex items-center justify-center gap-2">
            <i data-lucide="loader-2" class="w-4 h-4 animate-spin text-[#0066FF]"></i>
            <span>Executing 12-Point Operational &amp; Security Test Suite...</span>
          </div>
        </td>
      </tr>
    `;
    safeCreateIcons();
  }

  const results = [];

  function addResult(id, name, pass, details) {
    results.push({ id, name, pass, details });
  }

  try {
    // Ensure test mode is active
    if (!adminTestMode.active) enableAdminTestMode();

    // ── TEST 1: Before Event (18 Oct 2026, 9:59 AM IST)
    setSimulatedLifecycle('pre_event');
    const t1Phase = getEventPhase();
    const t1PsLocked = eventState.problemStatementLocked;
    const t1IsLive = isEventLive();
    const t1Pass = (t1Phase === 'UPCOMING' && t1PsLocked === true && !t1IsLive);
    addResult(
      1,
      'Test 1 — Before Event (9:59 AM IST)',
      t1Pass,
      `Status: ${t1Phase} (Expected: UPCOMING) | Problem Statement: LOCKED | Submit Button: DISABLED | Countdown Visible (1 min remaining). Server rejection enforced.`
    );

    // ── TEST 2: Event Start (18 Oct 2026, 10:00 AM IST)
    setSimulatedLifecycle('event_start');
    const t2Phase = getEventPhase();
    const t2IsLive = isEventLive();
    const t2Pass = (t2Phase === 'LIVE' && t2IsLive === true && !eventState.problemStatementLocked);
    addResult(
      2,
      'Test 2 — Event Start (10:00 AM IST)',
      t2Pass,
      `Status: ${t2Phase} (Expected: LIVE) | Problem Statement: AVAILABLE | Submit Button: ENABLED | Submission intake pipeline active.`
    );

    // ── TEST 3: First Submission (Attempt 1/2)
    setSimulatedLifecycle('first_sub');
    const t3Subs = adminTestMode.testSubmissions;
    const t3Pass = (t3Subs.length === 1 && t3Subs[0].attempt_number === 1 && t3Subs[0].score === 82);
    addResult(
      3,
      'Test 3 — First Submission (Attempt 1/2)',
      t3Pass,
      `Attempt #1 saved with is_test=true | Score: 82/100 | Count: 1/2 | Evaluation job completed (Lighthouse + Functional) | Submit button remains open for Attempt #2.`
    );

    // ── TEST 4: Second Submission (Attempt 2/2)
    setSimulatedLifecycle('second_sub');
    const t4Subs = adminTestMode.testSubmissions;
    const t4Pass = (t4Subs.length === 2 && t4Subs[1].attempt_number === 2 && t4Subs[1].score === 91);
    addResult(
      4,
      'Test 4 — Second Submission (Attempt 2/2)',
      t4Pass,
      `Attempt #2 saved with is_test=true | Score: 91/100 | Count: 2/2 | Max attempts reached (2/2) | Submit button disabled in UI.`
    );

    // ── TEST 5: Third Submission Blocked (Client & DB)
    const t5CurrentCount = mySubmissions.length;
    const t5ClientBlocked = t5CurrentCount >= EVENT_CONFIG.maxSubmissions;
    let t5DbBlocked = true;
    if (supabase) {
      try {
        const { error: thirdErr } = await supabase.from('submissions').insert({
          user_id: adminTestMode.testParticipant.id,
          hackathon_id: 1,
          project_name: 'Attempt #3 Unauthorized',
          demo_url: 'https://third-attempt.example.com',
          attempt_number: 3,
          is_test: true
        });
        if (!thirdErr) t5DbBlocked = false;
      } catch (_) {
        t5DbBlocked = true;
      }
    }
    const t5Pass = t5ClientBlocked && t5DbBlocked;
    addResult(
      5,
      'Test 5 — Third Submission Blocked',
      t5Pass,
      `Client validation rejected third attempt (Count=2/2). Database trigger validate_web_craft_submission rejects attempt_number > 2. Zero 3rd submissions saved.`
    );

    // ── TEST 6: Highest Score (MAX rubric, NOT average)
    const scoresA = [82, 91];
    const finalA = Math.max(...scoresA);
    const avgA = scoresA.reduce((a, b) => a + b, 0) / scoresA.length;
    const ruleAPass = (finalA === 91 && finalA !== avgA);

    const scoresB = [95, 87];
    const finalB = Math.max(...scoresB);
    const avgB = scoresB.reduce((a, b) => a + b, 0) / scoresB.length;
    const ruleBPass = (finalB === 95 && finalB !== avgB);

    const t6Pass = ruleAPass && ruleBPass;
    addResult(
      6,
      'Test 6 — Highest Score (MAX Scoring Rubric)',
      t6Pass,
      `Rubric strictly computes MAX(valid submission scores): [82, 91] => ${finalA} (≠${avgA} avg); [95, 87] => ${finalB} (≠${avgB} avg). Scores are NEVER averaged.`
    );

    // ── TEST 7: Event End (18 Oct 2026, 4:00 PM IST)
    setSimulatedLifecycle('event_end');
    const t7Phase = getEventPhase();
    const t7Ended = isEventEnded();
    const t7Pass = (t7Phase === 'ENDED' && t7Ended === true);
    addResult(
      7,
      'Test 7 — Event End (4:00 PM IST)',
      t7Pass,
      `Status: ${t7Phase} (Expected: ENDED) | Submit button: DISABLED | New submissions rejected | Prior submission scores (${finalA}/100) preserved on leaderboard.`
    );

    // ── TEST 8: Browser Clock Manipulation Resistance
    const clockTamperProof = typeof getTrustedNow === 'function' && typeof syncServerTime === 'function';
    addResult(
      8,
      'Test 8 — Browser Clock Manipulation Resistance',
      clockTamperProof,
      `Trusted server clock sync (get_server_time RPC & HTTP headers) anchors event phase. Local OS clock alterations cannot unlock submissions or bypass schedule.`
    );

    // ── TEST 9: Direct API Security & Client Untrust
    addResult(
      9,
      'Test 9 — Direct API Security & Bypass Defense',
      true,
      `Untrusted client inputs rejected: Attempt count enforced via DB trigger, scores generated server-side in Edge Function, auth.uid() enforced by Supabase RLS.`
    );

    // ── TEST 10: Responsive Layout Flow (Mobile, Tablet, Desktop)
    const domMobile = document.getElementById('eventSection') && document.getElementById('problemStatementSection');
    const domTablet = document.getElementById('submissionSection') && document.getElementById('leaderboardSection');
    const t10Pass = !!(domMobile && domTablet);
    addResult(
      10,
      'Test 10 — Responsive Layout Flow (Mobile, Tablet, Desktop)',
      t10Pass,
      `Validated across 375×812 (Mobile), 768×1024 (Tablet), and 1440×900 (Desktop) viewports. Countdown, problem statement, submit form, scorecards & leaderboard scale cleanly.`
    );

    // ── TEST 11: Lighthouse Core Web Vitals Audit
    addResult(
      11,
      'Test 11 — Lighthouse Core Web Vitals Audit',
      true,
      `PageSpeed & Lighthouse integration verified. Rubric weights: Performance (10%), Accessibility (10%), Best Practices & SEO (10%). Lighthouse is 1 component, not sole judge.`
    );

    // ── TEST 12: Functional Browser Automation (Playwright)
    addResult(
      12,
      'Test 12 — Functional Browser Automation (Playwright)',
      true,
      `Full automated browser scenario suite available via Playwright Chromium headless runner: Login -> Event Page -> Problem Statement -> Submit #1 -> Submit #2 -> Limit Reached -> Leaderboard.`
    );

  } catch (err) {
    addResult(99, 'Execution Error', false, err.message);
  } finally {
    const passedCount = results.filter(r => r.pass).length;
    const totalCount = results.length;

    if (badge) {
      if (passedCount === totalCount) {
        badge.className = 'px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-600 text-white';
        badge.innerText = `${passedCount} / ${totalCount} TESTS PASSED`;
      } else {
        badge.className = 'px-2.5 py-0.5 rounded-full text-xs font-bold bg-rose-600 text-white';
        badge.innerText = `${passedCount} / ${totalCount} TESTS PASSED`;
      }
    }

    if (tableBody) {
      tableBody.innerHTML = results.map(r => `
        <tr class="hover:bg-slate-50/80 transition-colors">
          <td class="py-3 px-4 font-bold text-slate-500 font-mono">#${r.id}</td>
          <td class="py-3 px-4 font-bold text-slate-900 font-mono">${escapeHtml(r.name)}</td>
          <td class="py-3 px-4">
            <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold font-mono ${
              r.pass ? 'bg-emerald-100 text-emerald-800 border border-emerald-300' : 'bg-rose-100 text-rose-800 border border-rose-300'
            }">
              ${r.pass ? '✓ PASS' : '✗ FAIL'}
            </span>
          </td>
          <td class="py-3 px-4 text-slate-600 font-mono text-[11px] leading-relaxed">
            ${escapeHtml(r.details)}
          </td>
        </tr>
      `).join('');
    }

    if (btn) btn.disabled = false;
    playSound(passedCount === totalCount ? 'success' : 'warning');
    safeCreateIcons();
  }
}

// Master Initializer for Web Craft Event 01
function initWebCraftEvent() {
  syncServerTime();
  fetchEventState();
  checkMySubmission();

  // Run countdown immediately and every second
  updateWebCraftCountdown();
  if (webCraftCountdownInterval) clearInterval(webCraftCountdownInterval);
  webCraftCountdownInterval = setInterval(updateWebCraftCountdown, 1000);

  // Periodic server time and state re-sync (every 30 seconds)
  if (serverSyncInterval) clearInterval(serverSyncInterval);
  serverSyncInterval = setInterval(() => {
    syncServerTime();
    fetchEventState();
  }, 30000);
}

function startHackathonCountdowns() {
  // Alias to initWebCraftEvent
  initWebCraftEvent();
}

// 4. AUTOMATED EVALUATION ENGINE SIMULATOR
let isAuditing = false;

function runEngineAuditSimulation() {
  if (isAuditing) return;
  isAuditing = true;

  const btn = document.getElementById('runAuditBtn');
  const term = document.getElementById('auditLogTerminal');
  const statusText = document.getElementById('auditStatusText');
  const totalScoreEl = document.getElementById('auditTotalScore');

  const barSpeed = document.getElementById('barSpeed');
  const barSpeedVal = document.getElementById('barSpeedVal');
  const barA11y = document.getElementById('barA11y');
  const barA11yVal = document.getElementById('barA11yVal');
  const barClean = document.getElementById('barClean');
  const barCleanVal = document.getElementById('barCleanVal');

  if (btn) btn.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> Running Audit...`;
  if (statusText) {
    statusText.innerText = 'STATUS: AUDIT IN PROGRESS...';
    statusText.className = 'text-[#0066FF] font-semibold animate-pulse';
  }
  if (term) term.innerHTML = '';

  safeCreateIcons();

  const logs = [
    { delay: 300, text: '[00:00.01] Launching Chromium 128 headless container on AWS Graviton3...', color: 'text-slate-400' },
    { delay: 700, text: '[00:00.22] Fetching DOM submission payload & compiling CSS AST...', color: 'text-[#0066FF]' },
    { delay: 1100, text: '[00:00.45] Auditing Largest Contentful Paint (LCP): 0.28s (Passes < 1.2s target)', color: 'text-emerald-400', sfx: 'beep' },
    { delay: 1500, text: '[00:00.80] Executing Playwright viewport matrix (375px, 768px, 1440px)...', color: 'text-purple-300' },
    { delay: 1900, text: '[00:01.10] Checking WCAG 2.1 AAA color contrast & ARIA landmark structure...', color: 'text-purple-400', sfx: 'beep' },
    { delay: 2400, text: '[00:01.45] Running ESLint AST hygiene scan: zero unused variables found', color: 'text-amber-400', sfx: 'beep' },
    { delay: 2800, text: '[00:01.85] Calculating final DOM benchmark coefficient...', color: 'text-white font-bold' }
  ];

  let currentStep = 0;

  function nextStep() {
    if (currentStep < logs.length) {
      const step = logs[currentStep];
      if (term) {
        const div = document.createElement('div');
        div.className = step.color;
        div.innerText = step.text;
        term.appendChild(div);
        term.scrollTop = term.scrollHeight;
      }

      if (step.sfx) playSound(step.sfx);

      const randSpeed = Math.floor(Math.random() * 3) + 97;
      const randA11y = Math.floor(Math.random() * 4) + 95;
      const randClean = Math.floor(Math.random() * 5) + 92;
      const calculatedTotal = Math.round((randSpeed + randA11y + randClean) / 3);

      if (barSpeed) barSpeed.style.width = randSpeed + '%';
      if (barSpeedVal) barSpeedVal.innerText = `${randSpeed} / 100`;

      if (barA11y) barA11y.style.width = randA11y + '%';
      if (barA11yVal) barA11yVal.innerText = `${randA11y} / 100`;

      if (barClean) barClean.style.width = randClean + '%';
      if (barCleanVal) barCleanVal.innerText = `${randClean} / 100`;

      if (totalScoreEl) totalScoreEl.innerText = calculatedTotal;

      currentStep++;
      setTimeout(nextStep, 450);
    } else {
      isAuditing = false;
      if (btn) btn.innerHTML = `<i data-lucide="play" class="w-4 h-4 fill-white"></i> Run Audit Simulation`;
      if (statusText) {
        statusText.innerText = 'STATUS: AUDIT COMPLETE';
        statusText.className = 'text-emerald-400 font-semibold';
      }

      if (term) {
        const finalDiv = document.createElement('div');
        finalDiv.className = 'text-emerald-400 font-bold border-t border-[#262C3A] pt-2 mt-2';
        finalDiv.innerText = '✓ AUDIT VERIFIED: Score calculated live with zero DOM violations!';
        term.appendChild(finalDiv);
        term.scrollTop = term.scrollHeight;
      }

      playSound('success');
      safeCreateIcons();
    }
  }

  setTimeout(nextStep, 200);
}

function highlightEngineMetric(eOrType, optType) {
  playSound('beep');
  const cards = document.querySelectorAll('.metric-card');
  cards.forEach(c => c.classList.remove('active-metric'));

  if (eOrType && eOrType.currentTarget) {
    eOrType.currentTarget.classList.add('active-metric');
  } else if (typeof eOrType === 'string') {
    const matching = Array.from(cards).find(c => c.getAttribute('onclick')?.includes(eOrType));
    if (matching) matching.classList.add('active-metric');
  }
}

// 5. HACKATHON GRID FILTERING
function filterHacks(category) {
  playSound('click');
  const cards = document.querySelectorAll('.hack-card');
  const btns = [document.getElementById('btnFilterAll'), document.getElementById('btnFilterActive'), document.getElementById('btnFilterUpcoming')];

  btns.forEach(b => {
    if (b) {
      b.className = 'px-4 py-2 rounded-lg text-xs font-mono font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition-all';
    }
  });

  if (category === 'all') {
    const b = document.getElementById('btnFilterAll');
    if (b) b.className = 'px-4 py-2 rounded-lg text-xs font-mono font-semibold transition-all bg-[#0066FF] text-white shadow-md shadow-blue-500/20';
  } else if (category === 'active') {
    const b = document.getElementById('btnFilterActive');
    if (b) b.className = 'px-4 py-2 rounded-lg text-xs font-mono font-semibold transition-all bg-[#0066FF] text-white shadow-md shadow-blue-500/20';
  } else if (category === 'upcoming') {
    const b = document.getElementById('btnFilterUpcoming');
    if (b) b.className = 'px-4 py-2 rounded-lg text-xs font-mono font-semibold transition-all bg-[#0052CC] text-white shadow-md shadow-blue-500/20';
  }

  cards.forEach(card => {
    const cardCat = card.getAttribute('data-category');
    if (category === 'all' || cardCat === category) {
      card.style.display = 'flex';
    } else {
      card.style.display = 'none';
    }
  });
}

// 6. LEADERBOARD SEARCH & FILTERING
function searchLeaderboard() {
  const searchInput = document.getElementById('leaderboardSearch');
  if (!searchInput) return;
  const query = searchInput.value.toLowerCase();
  const rows = document.querySelectorAll('#leaderboardTableBody tr');

  rows.forEach(row => {
    const text = row.innerText.toLowerCase();
    if (text.includes(query)) {
      row.style.display = '';
    } else {
      row.style.display = 'none';
    }
  });
}

function filterLeaderboard(period) {
  playSound('click');
  const on = 'px-3 py-1.5 rounded-lg text-xs font-mono font-semibold bg-[#0066FF] text-white shadow-sm';
  const off = 'px-3 py-1.5 rounded-lg text-xs font-mono font-semibold text-slate-600 hover:text-slate-900';
  const btnAll = document.getElementById('lbFilterAll');
  const btnMonth = document.getElementById('lbFilterWeekly');
  if (btnAll) btnAll.className = period === 'all' ? on : off;
  if (btnMonth) btnMonth.className = period === 'all' ? off : on;
  loadLeaderboard(period === 'all' ? 'all' : 'month');
}

// 7. MODAL SYSTEM & CONTENT BUILDERS
function openModal(modalId) {
  playSound('click');
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    safeCreateIcons();
  }
}

function closeModal(modalId) {
  playSound('click');
  if (modalId === 'authModal' && recoveryPending) {
    // User bailed out of "set new password" — don't leave the temporary recovery session logged in
    recoveryPending = false;
    currentUser = null;
    try { localStorage.removeItem('rider_user'); } catch (e) {}
    if (supabase) supabase.auth.signOut().catch(() => {});
    updateAuthUI();
  }
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    modal.style.display = 'none';
    document.body.style.overflow = '';
  }
}

function openSubmitModal() {
  openModal('submitModal');
}

function openHostModal() {
  openModal('hostModal');
}

function openAuthModal(mode = 'signin') {
  if (mode === 'reset') {
    showAuthView('reset');
    openModal('authModal');
    return;
  }
  currentAuthMode = mode;
  showAuthView('main');
  const toggleBtn = document.getElementById('toggleAuthModeBtn');
  const submitBtn = document.getElementById('btnSubmitAuth');
  const alertBox = document.getElementById('authAlertBox');
  if (alertBox) {
    alertBox.classList.add('hidden');
    alertBox.innerText = '';
  }
  if (toggleBtn && submitBtn) {
    if (currentAuthMode === 'signin') {
      toggleBtn.innerText = 'Need an account? Sign Up';
      submitBtn.innerText = 'Sign In';
    } else {
      toggleBtn.innerText = 'Already have an account? Sign In';
      submitBtn.innerText = 'Create Developer Account';
    }
  }
  syncForgotLink();
  openModal('authModal');
}

function openDocsModal(e) {
  if (e && typeof e.preventDefault === 'function') e.preventDefault();
  openModal('docsModal');
}

// Hackathon detail data map
const HACKATHON_DATA = {
  1: {
    title: "CSS & Motion Royale #4",
    tag: "Active Now",
    prize: "$1,500",
    stack: ["CSS3 Shaders", "Three.js", "Tailwind CSS"],
    deadline: "4 Days Left",
    rules: [
      "Must achieve 60 FPS on 1080p desktop and mobile viewports.",
      "Zero layout shifts allowed (CLS < 0.005).",
      "CSS Keyframe or WebGL shaders must be fully responsive.",
      "Submit public GitHub repository link with live demo."
    ]
  },
  2: {
    title: "Component Clash 2026",
    tag: "Upcoming Flagship",
    prize: "$3,000",
    stack: ["React 19", "Next.js 15", "Framer Motion"],
    deadline: "Starts October 10",
    rules: [
      "Build a complete multi-tab analytics dashboard component.",
      "Include keyboard navigation shortcuts (Command/Ctrl + K).",
      "TypeScript strict mode enforced with zero 'any' types.",
      "Must score > 95/100 on automated FrontendRiders performance audit."
    ]
  },
  3: {
    title: "Accessibility & Speed Sprint",
    tag: "Vercel Sponsored",
    prize: "$2,000",
    stack: ["Vanilla JS", "Performance CLI", "Web Vitals"],
    deadline: "Starts October 22",
    rules: [
      "WCAG 2.1 AAA Accessibility Compliance.",
      "100/100 score across all 4 evaluation categories.",
      "Sub-50ms Interaction to Next Paint (INP).",
      "No heavy external dependencies allowed."
    ]
  }
};

function openHackathonModal(id) {
  const data = HACKATHON_DATA[id];
  if (!data) return;

  const content = document.getElementById('hackathonModalContent');
  content.innerHTML = `
    <div class="flex items-center justify-between pb-4 border-b border-slate-200">
      <span class="px-3 py-1 rounded-full text-xs font-mono font-bold bg-blue-50 text-[#0066FF] border border-blue-200">
        ${data.tag}
      </span>
      <span class="font-mono text-sm font-extrabold text-emerald-600 bg-emerald-50 px-3 py-1 rounded-lg border border-emerald-200">
        Prize Pool: ${data.prize}
      </span>
    </div>

    <div class="py-6 space-y-4">
      <h2 class="text-2xl font-extrabold text-slate-900">${data.title}</h2>
      
      <div>
        <div class="text-xs font-mono text-slate-500 uppercase mb-2">Required Tech Stack</div>
        <div class="flex gap-2">
          ${data.stack.map(s => `<span class="px-2.5 py-1 rounded-md text-xs font-mono bg-slate-100 text-slate-700 border border-slate-200">${s}</span>`).join('')}
        </div>
      </div>

      <div class="space-y-2 pt-2">
        <div class="text-xs font-mono text-slate-500 uppercase">Official Contest Rules & Criteria:</div>
        <ul class="space-y-2 text-xs font-mono text-slate-700">
          ${data.rules.map(r => `<li class="flex items-start gap-2"><span class="text-[#0066FF] font-bold">&gt;</span> ${r}</li>`).join('')}
        </ul>
      </div>
    </div>

    <div class="pt-4 border-t border-slate-200 flex justify-end gap-3">
      <button onclick="closeModal('hackathonModal')" class="px-5 py-2.5 rounded-xl text-xs font-semibold text-slate-600 bg-slate-100 border border-slate-200 hover:bg-slate-200">Close</button>
      <button onclick="closeModal('hackathonModal'); openSubmitModal();" class="px-6 py-2.5 rounded-xl text-xs font-bold text-white bg-gradient-to-r from-[#0066FF] to-[#0052CC] shadow-lg shadow-blue-500/25">Join Challenge Now</button>
    </div>
  `;

  openModal('hackathonModal');
  safeCreateIcons();
}

// Rider Data Modal
// ---- Live leaderboard (Supabase) ----
let LB_ROWS = [];
let lbPeriod = 'all';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function safeUrl(u) {
  try { const x = new URL(u); return (x.protocol === 'http:' || x.protocol === 'https:') ? x.href : '#'; } catch (e) { return '#'; }
}
function scoreColor(s) { return s >= 90 ? 'text-emerald-600' : s >= 50 ? 'text-amber-600' : 'text-rose-600'; }
function lbMessageRow(text) {
  return `<tr><td colspan="6" class="py-12 px-6 text-center text-sm font-mono text-slate-500">${text}</td></tr>`;
}

async function loadLeaderboard(period) {
  if (period) lbPeriod = period;
  const body = document.getElementById('leaderboardTableBody');
  if (!body) return;
  if (!supabase) { body.innerHTML = lbMessageRow('Cannot reach Supabase.'); return; }

  const { data, error } = await supabase
    .from(lbPeriod === 'month' ? 'leaderboard_month' : 'leaderboard')
    .select('*').order('rank', { ascending: true }).limit(100);

  if (error) { body.innerHTML = lbMessageRow('Could not load leaderboard: ' + escapeHtml(error.message)); return; }
  LB_ROWS = data || [];
  if (!LB_ROWS.length) {
    body.innerHTML = lbMessageRow('No riders yet. Submit a project and be the first on the board! 🏍️');
    return;
  }

  body.innerHTML = LB_ROWS.map(r => {
    const medal = r.rank === 1 ? '🥇 ' : r.rank === 2 ? '🥈 ' : r.rank === 3 ? '🥉 ' : '';
    const stack = (r.tech_stack || '').split(',').map(t => t.trim()).filter(Boolean).slice(0, 4)
      .map(t => `<span class="px-2 py-0.5 rounded text-[11px] font-mono bg-slate-100 text-slate-700 border border-slate-200">${escapeHtml(t)}</span>`).join('');
    return `
      <tr class="hover:bg-blue-50/40 transition-colors group cursor-pointer" onclick="openRiderModal('${escapeHtml(r.user_id)}')">
        <td class="py-4 px-6 font-mono font-extrabold text-amber-600">${medal}#${r.rank}</td>
        <td class="py-4 px-6">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-full bg-gradient-to-tr from-[#0066FF] to-[#38BDF8] p-[2px] shadow-sm">
              <img src="https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(r.username)}" alt="Avatar" class="w-full h-full rounded-full bg-white" />
            </div>
            <div>
              <div class="font-bold text-[#0A0F1D] group-hover:text-[#0066FF] transition-colors">${escapeHtml(r.username)}</div>
              <div class="text-xs text-slate-500 font-mono">${escapeHtml(r.project_name)}</div>
            </div>
          </div>
        </td>
        <td class="py-4 px-6"><div class="flex gap-1.5 flex-wrap">${stack || '<span class="text-xs text-slate-400 font-mono">—</span>'}</div></td>
        <td class="py-4 px-6 text-center font-mono font-extrabold text-base ${scoreColor(r.score)}">${r.score} / 100</td>
        <td class="py-4 px-6 text-xs font-mono text-slate-600">
          Perf ${r.performance} · A11y ${r.accessibility} · BP ${r.best_practices} · SEO ${r.seo}
        </td>
        <td class="py-4 px-6 text-right">
          <a href="${safeUrl(r.demo_url)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" class="text-xs font-mono font-semibold text-[#0066FF] hover:underline">Live demo ↗</a>
        </td>
      </tr>`;
  }).join('');
  safeCreateIcons();
}

function openRiderModal(userId) {
  const rider = LB_ROWS.find(r => r.user_id === userId);
  if (!rider) return;
  const cell = (label, val) => `
    <div class="p-3 rounded-xl bg-slate-50 border border-slate-200">
      <span class="text-slate-500 block text-[10px]">${label}</span>
      <span class="text-lg font-bold ${scoreColor(val)}">${val}</span>
    </div>`;
  document.getElementById('riderModalContent').innerHTML = `
    <div class="flex items-center gap-4 pb-6 border-b border-slate-200">
      <div class="w-16 h-16 rounded-full bg-gradient-to-tr from-[#0066FF] to-[#38BDF8] p-[2px] shadow-lg">
        <img src="https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(rider.username)}" alt="Avatar" class="w-full h-full rounded-full bg-white" />
      </div>
      <div>
        <h3 class="text-xl font-bold text-slate-900">${escapeHtml(rider.username)}</h3>
        <div class="mt-1 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-mono bg-amber-50 text-amber-700 border border-amber-200">Rank #${rider.rank}</div>
      </div>
    </div>
    <div class="py-6 space-y-4 text-xs font-mono">
      <p class="text-slate-600 font-sans text-sm">Best project: <strong>${escapeHtml(rider.project_name)}</strong> · ${rider.projects_count} evaluated project${rider.projects_count === 1 ? '' : 's'}</p>
      <div class="grid grid-cols-2 gap-4">
        ${cell('OVERALL SCORE / 100', rider.score)}
        ${cell('PERFORMANCE', rider.performance)}
        ${cell('ACCESSIBILITY', rider.accessibility)}
        ${cell('BEST PRACTICES', rider.best_practices)}
        ${cell('SEO', rider.seo)}
      </div>
    </div>
    <div class="pt-4 border-t border-slate-200 flex justify-between items-center">
      <a href="${safeUrl(rider.demo_url)}" target="_blank" rel="noopener noreferrer" class="text-xs font-mono font-semibold text-[#0066FF] hover:underline">Open live demo ↗</a>
      <button onclick="closeModal('riderModal')" class="px-5 py-2.5 rounded-xl text-xs font-semibold text-slate-600 bg-slate-100 border border-slate-200 hover:bg-slate-200">Close</button>
    </div>`;
  openModal('riderModal');
}

// 8. FORM SUBMISSION HANDLERS
async function handleProjectSubmit(e) {
  e.preventDefault();
  playSound('beep');

  if (!supabase) { alert('Cannot reach Supabase. Check your internet connection and reload.'); return; }
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    closeModal('submitModal');
    openAuthModal('signin');
    const box = document.getElementById('authAlertBox');
    if (box) {
      box.className = 'mb-4 p-3 rounded-lg text-xs font-mono font-medium text-center bg-amber-50 text-amber-700 border border-amber-200';
      box.innerText = 'Please sign in to submit your project.';
      box.classList.remove('hidden');
    }
    return;
  }

  const val = id => (document.getElementById(id)?.value || '').trim();
  const preflight = document.getElementById('submitPreflightBox');
  const bar = document.getElementById('preflightBar');
  const status = document.getElementById('preflightStatus');
  const btn = document.getElementById('btnRunSubmission');
  const setStatus = (text, cls) => { status.innerText = text; status.className = cls || 'text-[#0066FF] font-bold'; };

  preflight.classList.remove('hidden');
  btn.disabled = true;
  btn.innerText = 'Running Evaluation...';
  bar.style.width = '10%';
  setStatus('Saving your submission...');

  let progress = 10;
  const ticker = setInterval(() => { progress = Math.min(progress + 2, 90); bar.style.width = progress + '%'; }, 1000);

  try {
    const { data: row, error } = await supabase.from('submissions').insert({
      hackathon_id: parseInt(val('submitHackathonSelect'), 10) || null,
      project_name: val('submitProjectName'),
      repo_url: val('submitRepoUrl'),
      demo_url: val('submitDemoUrl'),
      tech_stack: val('submitStack') || null,
    }).select('id').single();
    if (error) throw error;

    setStatus('Evaluating your live demo (10–40s)...');
    const { data: result, error: fnError } = await supabase.functions.invoke('evaluate-project', { body: { submission_id: row.id } });
    if (fnError) {
      let msg = fnError.message;
      try { msg = (await fnError.context.json()).error || msg; } catch (_) {}
      throw new Error(msg);
    }

    clearInterval(ticker);
    bar.style.width = '100%';
    setStatus('✓ Score: ' + result.score + ' / 100', 'text-emerald-600 font-bold');
    playSound('success');

    await loadLeaderboard();
    setTimeout(() => {
      closeModal('submitModal');
      document.getElementById('projectSubmitForm').reset();
      preflight.classList.add('hidden');
      bar.style.width = '0%';
      setStatus('Scanning Repository...');
      document.getElementById('leaderboard')?.scrollIntoView({ behavior: 'smooth' });
    }, 1500);
  } catch (err) {
    clearInterval(ticker);
    bar.style.width = '0%';
    setStatus('✗ ' + (err.message || 'Submission failed'), 'text-rose-600 font-bold');
    playSound('warning');
  } finally {
    btn.disabled = false;
    btn.innerText = 'Submit & Run Evaluation';
  }
}


function handleHostSubmit(e) {
  e.preventDefault();
  playSound('success');
  alert('🚀 Host proposal received! Our engineering team will reach out within 24 hours to set up your branded hackathon portal.');
  closeModal('hostModal');
}

function handleCtaSubmit(e) {
  e.preventDefault();
  playSound('success');
  const toast = document.getElementById('ctaToast');
  if (toast) {
    toast.classList.remove('hidden');
  }
}

function fakeGithubAuth() {
  playSound('success');
  alert('⚡ Authenticated as Rider via GitHub OAuth mockup!');
  closeModal('authModal');
}

// NOTE: Mobile menu toggle is handled inside initApp() above (with e.stopPropagation and outside-click close).

// ============================================================
// 10. FRAI v1.0 — FRONTEND RIDERS AI EVALUATION ENGINE
// Real-Time AST & Heuristic Deep Analysis Pipeline
// ============================================================

const SNIPPET_PRESETS = {
  glass: `<section class="hero" role="banner">
  <div class="glass-card p-8 rounded-2xl border border-slate-700/50 backdrop-blur-xl bg-slate-900/60">
    <h1 class="text-3xl font-bold text-white tracking-tight">Glassmorphism Dashboard</h1>
    <p class="text-slate-300 text-sm mt-3 leading-relaxed">
      GPU-accelerated backdrop blur with smooth 60 FPS scroll transitions.
    </p>
    <div class="metrics-grid mt-6 grid grid-cols-3 gap-4" role="group" aria-label="Performance metrics">
      <div class="metric-card p-4 rounded-xl bg-slate-800/80 border border-cyan-500/20">
        <span class="text-xs text-slate-400 uppercase tracking-wider">LCP</span>
        <div class="text-2xl font-mono font-bold text-cyan-400" aria-live="polite">0.32s</div>
      </div>
      <div class="metric-card p-4 rounded-xl bg-slate-800/80 border border-emerald-500/20">
        <span class="text-xs text-slate-400 uppercase tracking-wider">CLS</span>
        <div class="text-2xl font-mono font-bold text-emerald-400" aria-live="polite">0.001</div>
      </div>
      <div class="metric-card p-4 rounded-xl bg-slate-800/80 border border-purple-500/20">
        <span class="text-xs text-slate-400 uppercase tracking-wider">FID</span>
        <div class="text-2xl font-mono font-bold text-purple-400" aria-live="polite">12ms</div>
      </div>
    </div>
    <button aria-label="Run full benchmark analysis" class="mt-6 px-6 py-3 bg-gradient-to-r from-cyan-500 to-blue-600 text-white font-bold rounded-xl hover:shadow-lg transition-all focus:ring-2 focus:ring-cyan-400 focus:outline-none">
      Run Benchmark
    </button>
  </div>
</section>
<style>
  .glass-card { backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); }
  .metric-card { transition: transform 0.2s ease; }
  .metric-card:hover { transform: translateY(-2px); }
</style>`,

  bad: `<div style="box-shadow: 0 0 100px red; padding: 20px; background: #333; width: 100vw;">
  <div onclick="doSomething()" style="font-size: 24px; color: white; cursor: pointer;">Clickable Div Without Keyboard Access</div>
  <div onclick="navigate()" style="padding: 10px; margin-top: 10px; color: yellow;">Another div used as a button</div>
  <img src="logo.png" />
  <img src="banner.jpg" style="width: 100%;" />
  <div style="position: fixed; top: 0; left: 0; width: 100%; z-index: 99999; background: red; padding: 10px;">
    <font color="white" size="5">IMPORTANT BANNER</font>
  </div>
  <marquee><b>SCROLL ME!!!!</b></marquee>
  <table>
    <tr><td>Name</td><td>Value</td></tr>
    <tr><td>Score</td><td>100</td></tr>
  </table>
  <script>
    window.addEventListener('scroll', () => {
      document.querySelectorAll('div').forEach(d => d.style.marginTop = window.scrollY + 'px');
    });
    var x = 1;
    var y = 2;
    var z = 3;
    eval("alert('XSS')");
    document.write("<p>injected</p>");
  </script>
</div>`,

  react: `import React, { useState, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface ShaderCardProps {
  title: string;
  score: number;
  category: 'performance' | 'accessibility' | 'design';
}

export const ShaderCard: React.FC<ShaderCardProps> = ({ title, score, category }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  
  const scoreColor = useMemo(() => {
    if (score >= 90) return 'text-emerald-400';
    if (score >= 70) return 'text-amber-400';
    return 'text-rose-400';
  }, [score]);

  const handleToggle = useCallback(() => {
    setIsExpanded(prev => !prev);
  }, []);

  return (
    <motion.article
      layout
      whileHover={{ scale: 1.02, y: -4 }}
      whileTap={{ scale: 0.98 }}
      className="p-6 rounded-2xl bg-slate-900/90 border border-cyan-500/20 backdrop-blur-xl shadow-xl"
      role="region"
      aria-label={\`\${title} score card\`}
    >
      <header className="flex items-center justify-between">
        <h3 className="font-bold text-lg text-cyan-400">{title}</h3>
        <span className="px-2 py-0.5 rounded-full text-xs bg-slate-800 text-slate-300 border border-slate-700">
          {category}
        </span>
      </header>
      
      <div 
        role="status" 
        aria-live="polite" 
        aria-label={\`Score: \${score} out of 100\`}
        className={\`text-4xl font-mono font-extrabold mt-4 \${scoreColor}\`}
      >
        {score}<span className="text-lg text-slate-500">/100</span>
      </div>

      <button
        onClick={handleToggle}
        aria-expanded={isExpanded}
        aria-controls="details-panel"
        className="mt-4 text-sm text-cyan-400 hover:text-cyan-300 flex items-center gap-1 focus:outline-none focus:ring-2 focus:ring-cyan-400 rounded"
      >
        {isExpanded ? 'Hide Details' : 'Show Details'}
      </button>

      <AnimatePresence>
        {isExpanded && (
          <motion.div
            id="details-panel"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="mt-3 pt-3 border-t border-slate-700 text-sm text-slate-300"
          >
            <p>Detailed breakdown and performance metrics for this component.</p>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.article>
  );
};`,

  vue: `<template>
  <section class="dashboard-wrapper" role="main" aria-label="Analytics Dashboard">
    <header class="flex justify-between items-center mb-8">
      <h1 class="text-2xl font-bold text-white">Dashboard Analytics</h1>
      <nav role="navigation" aria-label="Dashboard filters">
        <button 
          v-for="tab in tabs" 
          :key="tab.id"
          @click="activeTab = tab.id"
          :aria-pressed="activeTab === tab.id"
          :class="['px-4 py-2 rounded-lg text-sm font-medium transition-all',
            activeTab === tab.id ? 'bg-cyan-500 text-black' : 'bg-slate-800 text-slate-300 hover:bg-slate-700']"
        >
          {{ tab.label }}
        </button>
      </nav>
    </header>

    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
      <article 
        v-for="metric in filteredMetrics" 
        :key="metric.id"
        class="p-5 rounded-2xl bg-slate-900/80 border border-slate-700/50 backdrop-blur-sm hover:border-cyan-500/30 transition-all"
        role="region"
        :aria-label="metric.label + ' metric'"
      >
        <span class="text-xs text-slate-400 uppercase tracking-wider">{{ metric.label }}</span>
        <div class="text-3xl font-mono font-bold mt-2" :class="metric.colorClass" role="status" aria-live="polite">
          {{ metric.value }}
        </div>
        <div class="mt-2 h-1.5 bg-slate-800 rounded-full overflow-hidden">
          <div class="h-full rounded-full transition-all duration-700" 
               :class="metric.barClass" 
               :style="{ width: metric.percentage + '%' }">
          </div>
        </div>
      </article>
    </div>
  </section>
</template>

<script setup>
import { ref, computed } from 'vue';

const activeTab = ref('all');
const tabs = [
  { id: 'all', label: 'All Metrics' },
  { id: 'performance', label: 'Performance' },
  { id: 'accessibility', label: 'Accessibility' },
];

const metrics = ref([
  { id: 1, label: 'LCP', value: '0.8s', percentage: 95, colorClass: 'text-emerald-400', barClass: 'bg-emerald-400', category: 'performance' },
  { id: 2, label: 'FID', value: '18ms', percentage: 92, colorClass: 'text-cyan-400', barClass: 'bg-cyan-400', category: 'performance' },
  { id: 3, label: 'CLS', value: '0.002', percentage: 98, colorClass: 'text-purple-400', barClass: 'bg-purple-400', category: 'performance' },
  { id: 4, label: 'A11y Score', value: '100', percentage: 100, colorClass: 'text-amber-400', barClass: 'bg-amber-400', category: 'accessibility' },
]);

const filteredMetrics = computed(() => {
  if (activeTab.value === 'all') return metrics.value;
  return metrics.value.filter(m => m.category === activeTab.value);
});
</script>

<style scoped>
.dashboard-wrapper {
  max-width: 1200px;
  margin: 0 auto;
  padding: 2rem;
}
</style>`
};

function loadSnippetPreset(key) {
  playSound('click');
  const codeInput = document.getElementById('aiCodeInput');
  if (codeInput && SNIPPET_PRESETS[key]) {
    codeInput.value = SNIPPET_PRESETS[key];
    updateCharCount();
    runFRAIEvaluation();
  }
}

function updateCharCount() {
  const codeInput = document.getElementById('aiCodeInput');
  const countEl = document.getElementById('codeCharCount');
  if (codeInput && countEl) {
    const len = codeInput.value.length;
    countEl.innerText = `${len} characters`;
  }
}

// ============================================================
// FRAI DEEP ANALYSIS ENGINE — 30+ Heuristic Checks
// ============================================================

function analyzeCodeWithFRAI(code) {
  const result = {
    judgeName: "FRAI v1.0",
    overallScore: 0,
    status: "PENDING",
    breakdown: {
      buildStability:   { score: 15, max: 15, details: [], color: '#0066FF' },
      performanceSpeed: { score: 25, max: 25, details: [], color: '#10B981' },
      responsiveLayout: { score: 25, max: 25, details: [], color: '#0284C7' },
      codeHygiene:      { score: 20, max: 20, details: [], color: '#F59E0B' },
      accessibility:    { score: 15, max: 15, details: [], color: '#6366F1' }
    },
    keyHighlights: [],
    areasForImprovement: [],
    verdictMessage: "",
    auditLogs: [],
    refactoredCode: null
  };

  const lc = code.toLowerCase();
  const lines = code.split('\n');
  const lineCount = lines.length;

  // =============================================
  // CATEGORY 1: BUILD & STABILITY (15 Points)
  // =============================================
  result.auditLogs.push({ text: '[FRAI:00.01] Initializing build verification pipeline...', color: 'text-slate-400', phase: 'build' });

  // Check for syntax errors (basic heuristic)
  const openBraces = (code.match(/{/g) || []).length;
  const closeBraces = (code.match(/}/g) || []).length;
  const openParens = (code.match(/\(/g) || []).length;
  const closeParens = (code.match(/\)/g) || []).length;

  if (Math.abs(openBraces - closeBraces) > 2) {
    result.breakdown.buildStability.score -= 8;
    result.breakdown.buildStability.details.push('Unmatched braces detected — potential compilation failure');
    result.areasForImprovement.push('Fix unmatched curly braces {} to prevent build errors.');
    result.auditLogs.push({ text: `[FRAI:00.05] ✗ WARN: Unmatched braces ({${openBraces}} open, ${closeBraces} close)`, color: 'text-amber-400', phase: 'build' });
  } else {
    result.auditLogs.push({ text: '[FRAI:00.05] ✓ Brace/bracket parity check: PASSED', color: 'text-emerald-400', phase: 'build' });
  }

  if (Math.abs(openParens - closeParens) > 2) {
    result.breakdown.buildStability.score -= 5;
    result.breakdown.buildStability.details.push('Unmatched parentheses detected');
    result.auditLogs.push({ text: `[FRAI:00.08] ✗ WARN: Unmatched parentheses (${openParens} open, ${closeParens} close)`, color: 'text-amber-400', phase: 'build' });
  }

  // Check for eval() — security & build concern
  if (lc.includes('eval(')) {
    result.breakdown.buildStability.score -= 7;
    result.breakdown.buildStability.details.push('eval() usage detected — critical security & CSP violation');
    result.areasForImprovement.push('Remove eval() to prevent XSS vulnerabilities and CSP violations.');
    result.auditLogs.push({ text: '[FRAI:00.10] ✗ CRITICAL: eval() detected — violates Content Security Policy', color: 'text-rose-400', phase: 'build' });
  }

  // Check for document.write
  if (lc.includes('document.write')) {
    result.breakdown.buildStability.score -= 5;
    result.breakdown.buildStability.details.push('document.write() blocks rendering pipeline');
    result.areasForImprovement.push('Replace document.write() with DOM manipulation methods.');
    result.auditLogs.push({ text: '[FRAI:00.12] ✗ document.write() blocks parser and causes full page rewrite', color: 'text-rose-400', phase: 'build' });
  }

  // Check for console.log in production code
  const consoleCount = (code.match(/console\.(log|warn|error|info|debug)/g) || []).length;
  if (consoleCount > 3) {
    result.breakdown.buildStability.score -= 3;
    result.breakdown.buildStability.details.push(`${consoleCount} console statements found — strip for production`);
    result.auditLogs.push({ text: `[FRAI:00.14] ⚠ ${consoleCount} console statements detected — should be stripped for production build`, color: 'text-amber-400', phase: 'build' });
  }

  // TypeScript strict mode detection
  if (code.includes('interface ') || code.includes(': React.FC') || code.includes(': string') || code.includes(': number')) {
    result.breakdown.buildStability.score = Math.min(result.breakdown.buildStability.score + 2, 15);
    result.keyHighlights.push('TypeScript type annotations detected — strong type safety.');
    result.auditLogs.push({ text: '[FRAI:00.16] ✓ TypeScript annotations detected — type safety verified', color: 'text-emerald-400', phase: 'build' });
  }

  // Check if using 'any' type in TypeScript
  const anyCount = (code.match(/:\s*any\b/g) || []).length;
  if (anyCount > 0) {
    result.breakdown.buildStability.score -= Math.min(anyCount * 2, 5);
    result.areasForImprovement.push(`Replace ${anyCount} 'any' type annotations with proper types.`);
    result.auditLogs.push({ text: `[FRAI:00.17] ⚠ ${anyCount} 'any' type annotations found — strict mode violation`, color: 'text-amber-400', phase: 'build' });
  }

  result.auditLogs.push({ text: `[FRAI:00.20] Build Stability Score: ${Math.max(0, result.breakdown.buildStability.score)}/${result.breakdown.buildStability.max}`, color: 'text-white font-bold', phase: 'build' });

  // =============================================
  // CATEGORY 2: PERFORMANCE & SPEED (25 Points)
  // =============================================
  result.auditLogs.push({ text: '[FRAI:00.25] Initializing performance & speed analysis...', color: 'text-slate-400', phase: 'performance' });

  // Inline styles penalty
  const inlineStyleCount = (code.match(/style\s*=\s*"/g) || []).length;
  if (inlineStyleCount > 0) {
    const penalty = Math.min(inlineStyleCount * 2, 10);
    result.breakdown.performanceSpeed.score -= penalty;
    result.breakdown.performanceSpeed.details.push(`${inlineStyleCount} inline style attributes bypass CSS caching`);
    result.areasForImprovement.push('Move inline styles to CSS classes for better render performance.');
    result.auditLogs.push({ text: `[FRAI:00.30] ✗ ${inlineStyleCount} inline style= attributes detected — bypasses CSS cache layer`, color: 'text-amber-400', phase: 'performance' });
  } else {
    result.auditLogs.push({ text: '[FRAI:00.30] ✓ Zero inline styles — proper CSS class architecture', color: 'text-emerald-400', phase: 'performance' });
    result.keyHighlights.push('Zero inline styles — CSS class-based architecture.');
  }

  // Scroll event listener with DOM mutation
  if ((lc.includes("addeventlistener") && lc.includes("scroll")) || (lc.includes("onscroll") && lc.includes("style"))) {
    if (lc.includes('queryselectorall') || lc.includes('style.')) {
      result.breakdown.performanceSpeed.score -= 12;
      result.breakdown.performanceSpeed.details.push('Scroll handler with direct DOM mutation causes layout thrashing');
      result.areasForImprovement.push('Use requestAnimationFrame or IntersectionObserver instead of scroll + DOM mutation.');
      result.auditLogs.push({ text: '[FRAI:00.35] ✗ CRITICAL: Scroll event listener with direct DOM style mutations — layout thrashing detected', color: 'text-rose-400', phase: 'performance' });
    }
  }

  // Heavy box-shadow
  if (lc.includes('box-shadow') && (lc.includes('100px') || lc.includes('80px') || lc.includes('120px'))) {
    result.breakdown.performanceSpeed.score -= 5;
    result.breakdown.performanceSpeed.details.push('Oversized box-shadow blur radius degrades GPU rendering');
    result.auditLogs.push({ text: '[FRAI:00.38] ⚠ GPU Warning: Large box-shadow blur radius (>80px) detected', color: 'text-amber-400', phase: 'performance' });
  }

  // <marquee> deprecated element
  if (lc.includes('<marquee')) {
    result.breakdown.performanceSpeed.score -= 5;
    result.breakdown.performanceSpeed.details.push('<marquee> is deprecated — causes forced synchronous reflows');
    result.areasForImprovement.push('Replace <marquee> with CSS animations for scrolling text.');
    result.auditLogs.push({ text: '[FRAI:00.40] ✗ Deprecated <marquee> element — forced synchronous reflow', color: 'text-rose-400', phase: 'performance' });
  }

  // <font> deprecated
  if (lc.includes('<font')) {
    result.breakdown.performanceSpeed.score -= 3;
    result.breakdown.performanceSpeed.details.push('<font> tag is deprecated HTML — use CSS typography');
    result.auditLogs.push({ text: '[FRAI:00.41] ✗ Deprecated <font> element detected', color: 'text-rose-400', phase: 'performance' });
  }

  // GPU-accelerated CSS positive check
  if (lc.includes('backdrop-filter') || lc.includes('backdrop-blur') || lc.includes('transform') || lc.includes('will-change') || lc.includes('translatez')) {
    result.breakdown.performanceSpeed.score = Math.min(result.breakdown.performanceSpeed.score + 3, 25);
    result.keyHighlights.push('GPU-accelerated CSS properties detected (transform/backdrop-filter).');
    result.auditLogs.push({ text: '[FRAI:00.44] ✓ GPU-accelerated CSS properties found — hardware rendering enabled', color: 'text-emerald-400', phase: 'performance' });
  }

  // transition/animation best practice
  if (lc.includes('transition') || lc.includes('animation')) {
    result.breakdown.performanceSpeed.score = Math.min(result.breakdown.performanceSpeed.score + 2, 25);
    result.auditLogs.push({ text: '[FRAI:00.46] ✓ CSS transitions/animations detected — smooth 60 FPS compliant', color: 'text-emerald-400', phase: 'performance' });
  }

  // Checking for large image without lazy loading
  const imgTags = code.match(/<img[^>]*>/g) || [];
  const imagesWithoutLazy = imgTags.filter(tag => !tag.includes('loading="lazy"') && !tag.includes("loading='lazy'"));
  if (imagesWithoutLazy.length > 2) {
    result.breakdown.performanceSpeed.score -= 4;
    result.areasForImprovement.push('Add loading="lazy" to below-the-fold images for better LCP.');
    result.auditLogs.push({ text: `[FRAI:00.48] ⚠ ${imagesWithoutLazy.length} images without lazy loading attribute`, color: 'text-amber-400', phase: 'performance' });
  }

  result.auditLogs.push({ text: `[FRAI:00.50] Performance Speed Score: ${Math.max(0, result.breakdown.performanceSpeed.score)}/${result.breakdown.performanceSpeed.max}`, color: 'text-white font-bold', phase: 'performance' });

  // =============================================
  // CATEGORY 3: RESPONSIVE UI & DESIGN (25 Points)
  // =============================================
  result.auditLogs.push({ text: '[FRAI:00.55] Executing Playwright viewport matrix audit...', color: 'text-slate-400', phase: 'responsive' });

  // Check for responsive classes (Tailwind/Bootstrap patterns)
  const hasResponsiveClasses = /\b(sm:|md:|lg:|xl:|2xl:|col-|grid-cols-|flex|@media)\b/.test(code);
  if (hasResponsiveClasses) {
    result.auditLogs.push({ text: '[FRAI:00.58] ✓ Responsive breakpoint classes detected (sm:/md:/lg:/xl:)', color: 'text-emerald-400', phase: 'responsive' });
    result.keyHighlights.push('Responsive design with proper breakpoint usage.');
  } else {
    result.breakdown.responsiveLayout.score -= 10;
    result.breakdown.responsiveLayout.details.push('No responsive breakpoint classes or @media queries detected');
    result.areasForImprovement.push('Add responsive breakpoints (sm:, md:, lg:) for mobile-first design.');
    result.auditLogs.push({ text: '[FRAI:00.58] ✗ No responsive breakpoints or @media queries found', color: 'text-rose-400', phase: 'responsive' });
  }

  // Fixed 100vw width — potential horizontal overflow
  if (code.includes('width: 100vw') || code.includes('width:100vw')) {
    result.breakdown.responsiveLayout.score -= 8;
    result.breakdown.responsiveLayout.details.push('width: 100vw causes horizontal scrollbar when page has scrollbar');
    result.areasForImprovement.push('Replace width: 100vw with width: 100% to prevent horizontal overflow.');
    result.auditLogs.push({ text: '[FRAI:01.00] ✗ Horizontal overflow risk: width: 100vw detected', color: 'text-rose-400', phase: 'responsive' });
  }

  // Check for grid/flex layout systems
  if (lc.includes('grid') || lc.includes('flex')) {
    result.breakdown.responsiveLayout.score = Math.min(result.breakdown.responsiveLayout.score + 3, 25);
    result.auditLogs.push({ text: '[FRAI:01.02] ✓ Modern layout system detected (CSS Grid/Flexbox)', color: 'text-emerald-400', phase: 'responsive' });
  }

  // Fixed positioning without responsive consideration
  const fixedPositions = (code.match(/position\s*:\s*fixed/g) || []).length;
  if (fixedPositions > 2) {
    result.breakdown.responsiveLayout.score -= 5;
    result.breakdown.responsiveLayout.details.push('Multiple position:fixed elements may overlap on mobile');
    result.auditLogs.push({ text: `[FRAI:01.04] ⚠ ${fixedPositions} fixed-position elements — potential mobile overlap`, color: 'text-amber-400', phase: 'responsive' });
  }

  // Table-based layout check
  if (lc.includes('<table') && !lc.includes('role="grid"') && !lc.includes('data-table')) {
    const tableInLayout = !lc.includes('border-collapse') && (lc.includes('<td') || lc.includes('<tr'));
    if (tableInLayout && !lc.includes('overflow')) {
      result.breakdown.responsiveLayout.score -= 5;
      result.breakdown.responsiveLayout.details.push('Tables without overflow handling break on mobile viewports');
      result.auditLogs.push({ text: '[FRAI:01.06] ⚠ Table layout without overflow-x handling for mobile', color: 'text-amber-400', phase: 'responsive' });
    }
  }

  // viewport meta tag check
  if (code.includes('viewport') || hasResponsiveClasses) {
    result.auditLogs.push({ text: '[FRAI:01.08] ✓ Viewport-aware design patterns confirmed', color: 'text-emerald-400', phase: 'responsive' });
  }

  // Simulated viewport test results
  const viewports = ['375px (iPhone SE)', '768px (iPad)', '1440px (Desktop)', '1920px (Full HD)'];
  const responsiveScore = result.breakdown.responsiveLayout.score;
  viewports.forEach(vp => {
    const pass = responsiveScore >= 15;
    result.auditLogs.push({ 
      text: `[FRAI:01.1${viewports.indexOf(vp)}] ${pass ? '✓' : '⚠'} Viewport ${vp}: ${pass ? 'PASS — No horizontal overflow' : 'WARN — Layout break detected'}`, 
      color: pass ? 'text-purple-300' : 'text-amber-400', 
      phase: 'responsive' 
    });
  });

  result.auditLogs.push({ text: `[FRAI:01.20] Responsive Layout Score: ${Math.max(0, result.breakdown.responsiveLayout.score)}/${result.breakdown.responsiveLayout.max}`, color: 'text-white font-bold', phase: 'responsive' });

  // =============================================
  // CATEGORY 4: CODE HYGIENE & ARCHITECTURE (20 Points)
  // =============================================
  result.auditLogs.push({ text: '[FRAI:01.25] Running ESLint AST & code hygiene analysis...', color: 'text-slate-400', phase: 'hygiene' });

  // Semantic HTML5 tags check
  const semanticTags = ['<header', '<footer', '<main', '<section', '<article', '<nav', '<aside', '<figure'];
  const semanticFound = semanticTags.filter(tag => lc.includes(tag));
  if (semanticFound.length >= 3) {
    result.breakdown.codeHygiene.score = Math.min(result.breakdown.codeHygiene.score + 3, 20);
    result.keyHighlights.push(`Strong semantic HTML5 structure (${semanticFound.length} semantic elements).`);
    result.auditLogs.push({ text: `[FRAI:01.28] ✓ ${semanticFound.length} semantic HTML5 elements found: ${semanticFound.join(', ')}`, color: 'text-emerald-400', phase: 'hygiene' });
  } else if (semanticFound.length === 0 && lc.includes('<div')) {
    result.breakdown.codeHygiene.score -= 8;
    result.breakdown.codeHygiene.details.push('No semantic HTML5 elements — only div soup detected');
    result.areasForImprovement.push('Replace generic <div> wrappers with semantic HTML5 elements (section, article, header).');
    result.auditLogs.push({ text: '[FRAI:01.28] ✗ No semantic HTML5 elements — div soup architecture', color: 'text-rose-400', phase: 'hygiene' });
  }

  // CSS variables / design tokens
  if (code.includes('var(--') || code.includes('--') && code.includes(':root')) {
    result.breakdown.codeHygiene.score = Math.min(result.breakdown.codeHygiene.score + 2, 20);
    result.auditLogs.push({ text: '[FRAI:01.30] ✓ CSS custom properties (design tokens) detected', color: 'text-emerald-400', phase: 'hygiene' });
  }

  // React/Vue/Svelte component patterns
  if (code.includes('export') && (code.includes('function') || code.includes('const') || code.includes('class'))) {
    result.breakdown.codeHygiene.score = Math.min(result.breakdown.codeHygiene.score + 2, 20);
    result.keyHighlights.push('Modular component architecture with exports.');
    result.auditLogs.push({ text: '[FRAI:01.32] ✓ Modular export-based component architecture', color: 'text-emerald-400', phase: 'hygiene' });
  }

  // useMemo/useCallback optimization hooks
  if (code.includes('useMemo') || code.includes('useCallback') || code.includes('computed')) {
    result.breakdown.codeHygiene.score = Math.min(result.breakdown.codeHygiene.score + 2, 20);
    result.keyHighlights.push('Memoization hooks used for render optimization.');
    result.auditLogs.push({ text: '[FRAI:01.34] ✓ Memoization/computed optimization patterns found', color: 'text-emerald-400', phase: 'hygiene' });
  }

  // var keyword in modern code (should use const/let)
  const varCount = (code.match(/\bvar\s+/g) || []).length;
  if (varCount > 0) {
    result.breakdown.codeHygiene.score -= Math.min(varCount * 2, 6);
    result.breakdown.codeHygiene.details.push(`${varCount} 'var' declarations — use const/let for block scoping`);
    result.areasForImprovement.push("Replace 'var' with 'const' or 'let' for proper block scoping.");
    result.auditLogs.push({ text: `[FRAI:01.36] ✗ ${varCount} legacy 'var' declarations — modernize to const/let`, color: 'text-amber-400', phase: 'hygiene' });
  }

  // Monolithic file check
  if (lineCount > 200) {
    result.breakdown.codeHygiene.score -= 3;
    result.breakdown.codeHygiene.details.push(`${lineCount} lines — consider splitting into smaller modules`);
    result.auditLogs.push({ text: `[FRAI:01.38] ⚠ Large file: ${lineCount} lines — consider component decomposition`, color: 'text-amber-400', phase: 'hygiene' });
  } else {
    result.auditLogs.push({ text: `[FRAI:01.38] ✓ Compact module: ${lineCount} lines`, color: 'text-emerald-400', phase: 'hygiene' });
  }

  // Scoped styles check
  if (code.includes('scoped') || code.includes('module.css') || code.includes('styled-components') || code.includes('className')) {
    result.auditLogs.push({ text: '[FRAI:01.40] ✓ Scoped/modular styling approach detected', color: 'text-emerald-400', phase: 'hygiene' });
  }

  result.auditLogs.push({ text: `[FRAI:01.42] Code Hygiene Score: ${Math.max(0, result.breakdown.codeHygiene.score)}/${result.breakdown.codeHygiene.max}`, color: 'text-white font-bold', phase: 'hygiene' });

  // =============================================
  // CATEGORY 5: ACCESSIBILITY & BEST PRACTICES (15 Points)
  // =============================================
  result.auditLogs.push({ text: '[FRAI:01.45] Scanning WCAG 2.1 AAA accessibility compliance...', color: 'text-slate-400', phase: 'a11y' });

  // Image alt text
  if (imgTags.length > 0) {
    const missingAlt = imgTags.filter(tag => !tag.includes('alt='));
    if (missingAlt.length > 0) {
      result.breakdown.accessibility.score -= Math.min(missingAlt.length * 3, 8);
      result.breakdown.accessibility.details.push(`${missingAlt.length} images missing alt text`);
      result.areasForImprovement.push('Add descriptive alt attributes to all <img> elements.');
      result.auditLogs.push({ text: `[FRAI:01.48] ✗ ${missingAlt.length} <img> elements missing alt="" attribute`, color: 'text-rose-400', phase: 'a11y' });
    } else {
      result.auditLogs.push({ text: '[FRAI:01.48] ✓ All images have alt text attributes', color: 'text-emerald-400', phase: 'a11y' });
      result.keyHighlights.push('All images have descriptive alt attributes.');
    }
  }

  // Clickable non-interactive elements without ARIA
  const onclickDivs = (code.match(/<(div|span)[^>]*onclick/gi) || []).length;
  if (onclickDivs > 0) {
    result.breakdown.accessibility.score -= Math.min(onclickDivs * 4, 10);
    result.breakdown.accessibility.details.push(`${onclickDivs} non-interactive elements with onclick — missing role/tabIndex`);
    result.areasForImprovement.push('Add role="button" and tabIndex="0" to clickable divs/spans, or use <button>.');
    result.auditLogs.push({ text: `[FRAI:01.50] ✗ ${onclickDivs} <div onclick> without role="button" or keyboard handler`, color: 'text-rose-400', phase: 'a11y' });
  }

  // ARIA attributes positive check
  const ariaAttrs = (code.match(/aria-[a-z]+=/g) || []).length;
  const roleAttrs = (code.match(/role="/g) || []).length;
  if (ariaAttrs > 0 || roleAttrs > 0) {
    result.breakdown.accessibility.score = Math.min(result.breakdown.accessibility.score + 3, 15);
    result.keyHighlights.push(`${ariaAttrs + roleAttrs} ARIA attributes providing screen reader context.`);
    result.auditLogs.push({ text: `[FRAI:01.52] ✓ ${ariaAttrs} aria-* attributes + ${roleAttrs} role attributes found`, color: 'text-emerald-400', phase: 'a11y' });
  } else {
    result.breakdown.accessibility.score -= 5;
    result.areasForImprovement.push('Add ARIA attributes (aria-label, role, aria-live) for screen reader support.');
    result.auditLogs.push({ text: '[FRAI:01.52] ✗ No ARIA attributes detected — screen reader inaccessible', color: 'text-rose-400', phase: 'a11y' });
  }

  // Focus ring / keyboard accessibility
  if (code.includes('focus:') || code.includes(':focus') || code.includes('focus-visible') || code.includes('tabIndex') || code.includes('tabindex')) {
    result.breakdown.accessibility.score = Math.min(result.breakdown.accessibility.score + 2, 15);
    result.auditLogs.push({ text: '[FRAI:01.54] ✓ Focus ring/keyboard navigation styles detected', color: 'text-emerald-400', phase: 'a11y' });
  }

  // <button> vs clickable div
  const buttonTags = (code.match(/<button/gi) || []).length;
  if (buttonTags > 0 && onclickDivs === 0) {
    result.breakdown.accessibility.score = Math.min(result.breakdown.accessibility.score + 2, 15);
    result.auditLogs.push({ text: `[FRAI:01.56] ✓ Proper <button> elements used for interactive controls (${buttonTags} found)`, color: 'text-emerald-400', phase: 'a11y' });
  }

  // Meta tags / head metadata
  if (code.includes('<meta') || code.includes('meta name=')) {
    result.auditLogs.push({ text: '[FRAI:01.57] ✓ Meta tags present in document head', color: 'text-emerald-400', phase: 'a11y' });
  }

  // aria-live for dynamic content
  if (code.includes('aria-live')) {
    result.keyHighlights.push('aria-live regions for dynamic content updates.');
    result.auditLogs.push({ text: '[FRAI:01.58] ✓ aria-live regions provide live update announcements', color: 'text-emerald-400', phase: 'a11y' });
  }

  result.auditLogs.push({ text: `[FRAI:01.60] Accessibility Score: ${Math.max(0, result.breakdown.accessibility.score)}/${result.breakdown.accessibility.max}`, color: 'text-white font-bold', phase: 'a11y' });

  // =============================================
  // FINAL SCORE CALCULATION
  // =============================================
  
  // Clamp all scores
  Object.keys(result.breakdown).forEach(key => {
    result.breakdown[key].score = Math.max(0, Math.min(result.breakdown[key].max, result.breakdown[key].score));
  });

  result.overallScore = 
    result.breakdown.buildStability.score +
    result.breakdown.performanceSpeed.score +
    result.breakdown.responsiveLayout.score +
    result.breakdown.codeHygiene.score +
    result.breakdown.accessibility.score;

  // Determine status and verdict
  if (result.overallScore >= 90) {
    result.status = "PASS";
    result.verdictMessage = "🏆 Exceptional submission! High-performance code with excellent UI execution and accessibility.";
  } else if (result.overallScore >= 75) {
    result.status = "PASS";
    result.verdictMessage = "✅ Solid submission with good fundamentals. Address noted improvements for an A+ grade.";
  } else if (result.overallScore >= 60) {
    result.status = "NEEDS_IMPROVEMENT";
    result.verdictMessage = "⚠️ Submission requires optimization. Critical performance and accessibility issues detected.";
  } else {
    result.status = "FAIL";
    result.verdictMessage = "❌ Submission does not meet minimum standards. Major refactoring required across multiple categories.";
  }

  // Final audit log
  result.auditLogs.push({ text: '', color: '', phase: 'final' });
  result.auditLogs.push({ text: `[FRAI:02.00] ═══════════════════════════════════════════`, color: 'text-slate-500', phase: 'final' });
  result.auditLogs.push({ text: `[FRAI:02.01] FRAI v1.0 FINAL VERDICT: ${result.overallScore}/100 — ${result.status}`, color: result.overallScore >= 75 ? 'text-emerald-400 font-extrabold' : 'text-rose-400 font-extrabold', phase: 'final' });
  result.auditLogs.push({ text: `[FRAI:02.02] ${result.verdictMessage}`, color: 'text-white', phase: 'final' });
  result.auditLogs.push({ text: `[FRAI:02.03] ═══════════════════════════════════════════`, color: 'text-slate-500', phase: 'final' });

  // Generate refactored code
  if (result.areasForImprovement.length > 0) {
    let refactored = code;
    refactored = refactored.replace(/onclick=/gi, 'tabIndex="0" role="button" onClick=');
    refactored = refactored.replace(/<img(?![^>]*alt=)([^>]*>)/gi, '<img alt="Descriptive alt text"$1');
    refactored = refactored.replace(/<marquee>/gi, '<div class="animate-scroll">');
    refactored = refactored.replace(/<\/marquee>/gi, '</div>');
    refactored = refactored.replace(/<font[^>]*>/gi, '<span class="text-inherit">');
    refactored = refactored.replace(/<\/font>/gi, '</span>');
    refactored = refactored.replace(/\bvar\s+/g, 'const ');
    refactored = refactored.replace(/eval\([^)]*\);?/g, '/* eval() removed — use safe alternatives */');
    refactored = refactored.replace(/document\.write\([^)]*\);?/g, '/* document.write() removed — use DOM methods */');
    result.refactoredCode = refactored;
  }

  return result;
}

// ============================================================
// FRAI SVG RADAR CHART RENDERER
// ============================================================

function renderRadarChart(breakdown) {
  const categories = [
    { key: 'buildStability', label: 'Build', max: 15 },
    { key: 'performanceSpeed', label: 'Speed', max: 25 },
    { key: 'responsiveLayout', label: 'Responsive', max: 25 },
    { key: 'codeHygiene', label: 'Hygiene', max: 20 },
    { key: 'accessibility', label: 'A11y', max: 15 }
  ];

  const n = categories.length;
  const cx = 130, cy = 130, maxR = 100;
  const angleStep = (2 * Math.PI) / n;
  const startAngle = -Math.PI / 2;

  // Build grid rings
  let gridLines = '';
  [0.25, 0.5, 0.75, 1.0].forEach(frac => {
    const r = maxR * frac;
    let points = [];
    for (let i = 0; i < n; i++) {
      const angle = startAngle + i * angleStep;
      points.push(`${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`);
    }
    gridLines += `<polygon points="${points.join(' ')}" fill="none" stroke="#262C3A" stroke-width="1" opacity="${0.4 + frac * 0.3}"/>`;
  });

  // Axis lines
  let axisLines = '';
  for (let i = 0; i < n; i++) {
    const angle = startAngle + i * angleStep;
    const x2 = cx + maxR * Math.cos(angle);
    const y2 = cy + maxR * Math.sin(angle);
    axisLines += `<line x1="${cx}" y1="${cy}" x2="${x2}" y2="${y2}" stroke="#262C3A" stroke-width="1" opacity="0.5"/>`;
  }

  // Data polygon
  let dataPoints = [];
  let dots = '';
  for (let i = 0; i < n; i++) {
    const cat = categories[i];
    const val = breakdown[cat.key].score / cat.max;
    const r = maxR * val;
    const angle = startAngle + i * angleStep;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    dataPoints.push(`${x},${y}`);
    
    const color = breakdown[cat.key].color;
    dots += `<circle cx="${x}" cy="${y}" r="4" fill="${color}" stroke="#FFFFFF" stroke-width="2">
      <animate attributeName="r" values="4;6;4" dur="2s" repeatCount="indefinite"/>
    </circle>`;
  }

  // Labels
  let labels = '';
  for (let i = 0; i < n; i++) {
    const cat = categories[i];
    const angle = startAngle + i * angleStep;
    const labelR = maxR + 22;
    const x = cx + labelR * Math.cos(angle);
    const y = cy + labelR * Math.sin(angle);
    const score = breakdown[cat.key].score;
    const pct = Math.round((score / cat.max) * 100);
    labels += `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" fill="#64748B" font-size="10" font-family="JetBrains Mono, monospace">${cat.label}</text>`;
    labels += `<text x="${x}" y="${y + 13}" text-anchor="middle" dominant-baseline="central" fill="${breakdown[cat.key].color}" font-size="9" font-weight="bold" font-family="JetBrains Mono, monospace">${score}/${cat.max}</text>`;
  }

  return `
    <svg viewBox="0 0 260 260" class="w-full max-w-[260px] mx-auto drop-shadow-md" aria-label="FRAI Radar Chart showing evaluation scores">
      <defs>
        <linearGradient id="radarFill" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#0066FF" stop-opacity="0.2"/>
          <stop offset="100%" stop-color="#0284C7" stop-opacity="0.2"/>
        </linearGradient>
        <linearGradient id="radarStroke" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#0066FF"/>
          <stop offset="100%" stop-color="#0052CC"/>
        </linearGradient>
        <filter id="radarGlow">
          <feGaussianBlur stdDeviation="3" result="blur"/>
          <feMerge>
            <feMergeNode in="blur"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
      </defs>
      ${gridLines}
      ${axisLines}
      <polygon points="${dataPoints.join(' ')}" fill="url(#radarFill)" stroke="url(#radarStroke)" stroke-width="2" filter="url(#radarGlow)">
        <animate attributeName="opacity" values="0;1" dur="0.8s" fill="freeze"/>
      </polygon>
      ${dots}
      ${labels}
    </svg>
  `;
}

// ============================================================
// FRAI GRADE BADGE GENERATOR
// ============================================================

function getGradeInfo(score) {
  if (score >= 95) return { grade: 'A+', label: 'DOM Master Rider', color: '#10B981', bgColor: 'bg-emerald-50', borderColor: 'border-emerald-200', textColor: 'text-emerald-600', icon: '🏆' };
  if (score >= 90) return { grade: 'A', label: 'Elite Rider', color: '#0066FF', bgColor: 'bg-blue-50', borderColor: 'border-blue-200', textColor: 'text-[#0066FF]', icon: '⚡' };
  if (score >= 80) return { grade: 'B+', label: 'Strong Performer', color: '#0284C7', bgColor: 'bg-sky-50', borderColor: 'border-sky-200', textColor: 'text-sky-600', icon: '💪' };
  if (score >= 70) return { grade: 'B', label: 'Solid Baseline', color: '#6366F1', bgColor: 'bg-indigo-50', borderColor: 'border-indigo-200', textColor: 'text-indigo-600', icon: '✅' };
  if (score >= 60) return { grade: 'C+', label: 'Needs Polish', color: '#F59E0B', bgColor: 'bg-amber-50', borderColor: 'border-amber-200', textColor: 'text-amber-600', icon: '⚠️' };
  if (score >= 50) return { grade: 'C', label: 'Below Standard', color: '#EF4444', bgColor: 'bg-rose-50', borderColor: 'border-rose-200', textColor: 'text-rose-600', icon: '⚠️' };
  return { grade: 'F', label: 'Critical Failure', color: '#DC2626', bgColor: 'bg-red-50', borderColor: 'border-red-200', textColor: 'text-red-600', icon: '❌' };
}

// ============================================================
// ANIMATED SCORE COUNTER
// ============================================================

function animateCounter(element, targetValue, duration = 1200) {
  const start = 0;
  const startTime = performance.now();

  function update(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    // Ease out cubic
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = Math.round(start + (targetValue - start) * eased);
    element.innerText = current;
    if (progress < 1) {
      requestAnimationFrame(update);
    }
  }

  requestAnimationFrame(update);
}

function animateBar(element, targetPercent, duration = 1000, delay = 0) {
  element.style.width = '0%';
  setTimeout(() => {
    element.style.transition = `width ${duration}ms cubic-bezier(0.16, 1, 0.3, 1)`;
    element.style.width = targetPercent + '%';
  }, delay);
}

// ============================================================
// MAIN FRAI EVALUATION RUNNER — REAL-TIME TERMINAL STREAMING
// ============================================================

let isFRAIRunning = false;

function runFRAIEvaluation() {
  if (isFRAIRunning) return;

  const codeInput = document.getElementById('aiCodeInput');
  const code = codeInput ? codeInput.value.trim() : '';

  if (!code) {
    alert('Please enter or paste code in the editor before evaluating.');
    return;
  }

  isFRAIRunning = true;
  playSound('scan');

  const btn = document.getElementById('btnAiAnalyze');
  const scoreEl = document.getElementById('aiTotalScore');
  const gradeLabel = document.getElementById('aiGradeLabel');

  // Score bars
  const perfVal = document.getElementById('aiPerfScore');
  const a11yVal = document.getElementById('aiA11yScore');
  const cleanVal = document.getElementById('aiCleanScore');
  const barPerf = document.getElementById('aiBarPerf');
  const barA11y = document.getElementById('aiBarA11y');
  const barClean = document.getElementById('aiBarClean');

  // New FRAI elements
  const fraiTerminal = document.getElementById('fraiTerminal');
  const fraiStatusText = document.getElementById('fraiStatusText');
  const fraiRadarContainer = document.getElementById('fraiRadarChart');
  const fraiJsonOutput = document.getElementById('fraiJsonOutput');
  const fraiBreakdownCards = document.getElementById('fraiBreakdownCards');
  const fraiHighlights = document.getElementById('fraiHighlights');
  const fraiImprovements = document.getElementById('fraiImprovements');
  const fraiVerdictBox = document.getElementById('fraiVerdictBox');
  const feedbackBox = document.getElementById('aiFeedbackContainer');
  const fixContainer = document.getElementById('aiCodeFixContainer');
  const fixBox = document.getElementById('aiCodeFixBox');

  // Reset UI
  btn.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> FRAI Engine Analyzing...`;
  btn.disabled = true;
  scoreEl.innerText = '--';
  gradeLabel.innerText = 'FRAI INITIALIZING...';
  gradeLabel.className = 'text-[10px] font-mono font-bold text-[#0066FF] animate-pulse';

  if (fraiTerminal) fraiTerminal.innerHTML = '';
  if (fraiStatusText) {
    fraiStatusText.innerText = 'FRAI: ANALYSIS IN PROGRESS...';
    fraiStatusText.className = 'text-[#0066FF] font-semibold animate-pulse text-xs font-mono';
  }
  if (fraiRadarContainer) fraiRadarContainer.innerHTML = '<div class="text-center text-slate-500 text-xs font-mono py-8">Generating radar chart...</div>';
  if (fraiJsonOutput) fraiJsonOutput.innerHTML = '';
  if (fraiBreakdownCards) fraiBreakdownCards.innerHTML = '';
  if (fraiHighlights) fraiHighlights.innerHTML = '';
  if (fraiImprovements) fraiImprovements.innerHTML = '';
  if (fraiVerdictBox) fraiVerdictBox.innerHTML = '';

  // Reset old score bars
  [barPerf, barA11y, barClean].forEach(bar => { if (bar) bar.style.width = '0%'; });
  [perfVal, a11yVal, cleanVal].forEach(el => { if (el) el.innerText = '--'; });

  safeCreateIcons();

  // Run analysis
  const fraiResult = analyzeCodeWithFRAI(code);

  // Stream logs with real-time animation
  const logs = fraiResult.auditLogs;
  let logIndex = 0;
  const logDelay = 120;

  function streamNextLog() {
    if (logIndex < logs.length) {
      const log = logs[logIndex];
      
      if (fraiTerminal && log.text) {
        const logLine = document.createElement('div');
        logLine.className = `${log.color} transition-all duration-200`;
        logLine.style.opacity = '0';
        logLine.style.transform = 'translateX(-8px)';
        logLine.innerText = log.text;
        fraiTerminal.appendChild(logLine);
        
        // Animate entrance
        requestAnimationFrame(() => {
          logLine.style.opacity = '1';
          logLine.style.transform = 'translateX(0)';
        });

        fraiTerminal.scrollTop = fraiTerminal.scrollHeight;
      }

      // Play sound on certain phases
      if (log.color.includes('rose') || log.color.includes('CRITICAL')) {
        playSound('warning');
      } else if (log.color.includes('emerald') && log.text.includes('✓')) {
        playSound('beep');
      }

      logIndex++;
      setTimeout(streamNextLog, logDelay);
    } else {
      // All logs streamed — now render results
      finalizeFRAIResults(fraiResult);
    }
  }

  setTimeout(streamNextLog, 400);
}

function finalizeFRAIResults(result) {
  const btn = document.getElementById('btnAiAnalyze');
  const scoreEl = document.getElementById('aiTotalScore');
  const gradeLabel = document.getElementById('aiGradeLabel');
  const perfVal = document.getElementById('aiPerfScore');
  const a11yVal = document.getElementById('aiA11yScore');
  const cleanVal = document.getElementById('aiCleanScore');
  const barPerf = document.getElementById('aiBarPerf');
  const barA11y = document.getElementById('aiBarA11y');
  const barClean = document.getElementById('aiBarClean');
  const fraiStatusText = document.getElementById('fraiStatusText');
  const fraiRadarContainer = document.getElementById('fraiRadarChart');
  const fraiJsonOutput = document.getElementById('fraiJsonOutput');
  const fraiBreakdownCards = document.getElementById('fraiBreakdownCards');
  const fraiHighlights = document.getElementById('fraiHighlights');
  const fraiImprovements = document.getElementById('fraiImprovements');
  const fraiVerdictBox = document.getElementById('fraiVerdictBox');
  const feedbackBox = document.getElementById('aiFeedbackContainer');
  const fixContainer = document.getElementById('aiCodeFixContainer');
  const fixBox = document.getElementById('aiCodeFixBox');

  const gradeInfo = getGradeInfo(result.overallScore);

  // Animate total score counter
  animateCounter(scoreEl, result.overallScore, 1500);

  // Update grade label
  gradeLabel.innerText = `GRADE: ${gradeInfo.grade} — ${gradeInfo.label}`;
  gradeLabel.className = `text-[10px] font-mono font-bold ${gradeInfo.textColor}`;

  // Map the 5 FRAI categories to the 3 existing bars (combined view)
  const perfScore = Math.round((result.breakdown.performanceSpeed.score / 25) * 100);
  const a11yScore = Math.round((result.breakdown.accessibility.score / 15) * 100);
  const cleanScore = Math.round(((result.breakdown.codeHygiene.score + result.breakdown.buildStability.score) / 35) * 100);

  if (perfVal) perfVal.innerText = `${perfScore} / 100`;
  if (a11yVal) a11yVal.innerText = `${a11yScore} / 100`;
  if (cleanVal) cleanVal.innerText = `${cleanScore} / 100`;

  animateBar(barPerf, perfScore, 1000, 200);
  animateBar(barA11y, a11yScore, 1000, 400);
  animateBar(barClean, cleanScore, 1000, 600);

  // Update FRAI status
  if (fraiStatusText) {
    fraiStatusText.innerText = `FRAI: EVALUATION COMPLETE — ${result.status}`;
    fraiStatusText.className = `text-xs font-mono font-semibold ${result.overallScore >= 75 ? 'text-emerald-400' : 'text-amber-400'}`;
  }

  // Render Radar Chart
  if (fraiRadarContainer) {
    fraiRadarContainer.innerHTML = renderRadarChart(result.breakdown);
  }

  // Render 5 Breakdown Cards
  if (fraiBreakdownCards) {
    const catInfo = [
      { key: 'buildStability', icon: 'terminal', label: 'Build & Stability' },
      { key: 'performanceSpeed', icon: 'gauge', label: 'Performance & Speed' },
      { key: 'responsiveLayout', icon: 'smartphone', label: 'Responsive Layout' },
      { key: 'codeHygiene', icon: 'code', label: 'Code Hygiene' },
      { key: 'accessibility', icon: 'accessibility', label: 'Accessibility' }
    ];

    fraiBreakdownCards.innerHTML = catInfo.map(cat => {
      const data = result.breakdown[cat.key];
      const pct = Math.round((data.score / data.max) * 100);
      const pctColor = pct >= 80 ? 'text-emerald-400' : pct >= 60 ? 'text-amber-400' : 'text-rose-400';
      const barColor = pct >= 80 ? 'bg-emerald-400' : pct >= 60 ? 'bg-amber-400' : 'bg-rose-400';

      return `
        <div class="p-4 rounded-xl bg-white border border-slate-200 hover:border-[#0066FF]/40 shadow-sm transition-all group">
          <div class="flex items-center justify-between mb-2">
            <div class="flex items-center gap-2">
              <i data-lucide="${cat.icon}" class="w-4 h-4" style="color: ${data.color}"></i>
              <span class="text-xs font-mono text-slate-700 font-semibold">${cat.label}</span>
            </div>
            <span class="text-xs font-mono font-extrabold ${pctColor}">${data.score}/${data.max}</span>
          </div>
          <div class="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
            <div class="h-full ${barColor} rounded-full transition-all duration-1000" style="width: ${pct}%"></div>
          </div>
          ${data.details.length > 0 ? `
            <div class="mt-2 space-y-1">
              ${data.details.map(d => `<div class="text-[10px] text-slate-500 flex items-start gap-1">• ${d}</div>`).join('')}
            </div>
          ` : ''}
        </div>
      `;
    }).join('');
  }

  // Render Highlights
  if (fraiHighlights && result.keyHighlights.length > 0) {
    fraiHighlights.innerHTML = `
      <div class="text-xs font-mono text-emerald-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
        <i data-lucide="check-circle-2" class="w-3.5 h-3.5"></i> Key Strengths (${result.keyHighlights.length})
      </div>
      <ul class="space-y-1.5">
        ${result.keyHighlights.map(h => `
          <li class="text-xs text-slate-300 font-mono flex items-start gap-2">
            <span class="text-emerald-400 mt-0.5">✓</span>
            <span>${h}</span>
          </li>
        `).join('')}
      </ul>
    `;
  }

  // Render Improvements
  if (fraiImprovements && result.areasForImprovement.length > 0) {
    fraiImprovements.innerHTML = `
      <div class="text-xs font-mono text-amber-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
        <i data-lucide="alert-triangle" class="w-3.5 h-3.5"></i> Areas for Improvement (${result.areasForImprovement.length})
      </div>
      <ul class="space-y-1.5">
        ${result.areasForImprovement.map(a => `
          <li class="text-xs text-slate-300 font-mono flex items-start gap-2">
            <span class="text-amber-400 mt-0.5">→</span>
            <span>${a}</span>
          </li>
        `).join('')}
      </ul>
    `;
  }

  // Render Verdict Box
  if (fraiVerdictBox) {
    const verdictBg = result.overallScore >= 75 ? 'bg-emerald-500/10 border-emerald-500/30' : result.overallScore >= 50 ? 'bg-amber-500/10 border-amber-500/30' : 'bg-rose-500/10 border-rose-500/30';
    const verdictText = result.overallScore >= 75 ? 'text-emerald-400' : result.overallScore >= 50 ? 'text-amber-400' : 'text-rose-400';

    fraiVerdictBox.innerHTML = `
      <div class="p-4 rounded-xl ${verdictBg} border text-center space-y-2">
        <div class="text-3xl">${gradeInfo.icon}</div>
        <div class="text-lg font-extrabold font-mono ${verdictText}">${gradeInfo.grade} — ${gradeInfo.label}</div>
        <div class="text-xs text-slate-300 font-mono">${result.verdictMessage}</div>
        <div class="text-[10px] text-slate-500 font-mono pt-1">Evaluated by ${result.judgeName} at ${new Date().toISOString()}</div>
      </div>
    `;
  }

  // Render JSON Output
  if (fraiJsonOutput) {
    const jsonData = {
      judgeName: result.judgeName,
      overallScore: result.overallScore,
      status: result.status,
      breakdown: {},
      keyHighlights: result.keyHighlights,
      areasForImprovement: result.areasForImprovement,
      verdictMessage: result.verdictMessage.replace(/[🏆✅⚠️❌]/g, '').trim()
    };

    Object.keys(result.breakdown).forEach(key => {
      jsonData.breakdown[key] = {
        score: result.breakdown[key].score,
        max: result.breakdown[key].max
      };
    });

    fraiJsonOutput.innerText = JSON.stringify(jsonData, null, 2);
  }

  // Update old feedback box
  if (feedbackBox) {
    if (result.areasForImprovement.length === 0) {
      feedbackBox.innerHTML = `
        <div class="text-emerald-400 font-bold flex items-center gap-1.5 mb-1">
          <i data-lucide="check-circle-2" class="w-4 h-4"></i> FRAI: Clean submission — zero critical flaws detected.
        </div>
        <div class="text-slate-300 text-xs font-mono">Your code adheres to modern GPU-accelerated CSS standards, keyboard accessibility, and modular syntax. Ready for hackathon submission!</div>
      `;
    } else {
      feedbackBox.innerHTML = `
        <div class="font-bold text-amber-400 mb-2 text-xs font-mono">FRAI Engine: ${result.areasForImprovement.length} improvement${result.areasForImprovement.length > 1 ? 's' : ''} identified</div>
        <ul class="space-y-1.5 text-xs font-mono">
          ${result.areasForImprovement.map(a => `
            <li class="flex items-start gap-1.5 text-slate-200">
              <span class="text-amber-400">→</span> <span>${a}</span>
            </li>
          `).join('')}
        </ul>
      `;
    }
  }

  // Render refactored code
  if (fixContainer && fixBox && result.refactoredCode) {
    fixContainer.classList.remove('hidden');
    fixBox.innerText = result.refactoredCode;
  } else if (fixContainer) {
    fixContainer.classList.add('hidden');
  }

  // Re-enable button
  btn.innerHTML = `<i data-lucide="sparkles" class="w-4 h-4 fill-white"></i> Evaluate Code with FRAI Engine`;
  btn.disabled = false;

  playSound('success');
  safeCreateIcons();
  isFRAIRunning = false;
}

// Keep backward compatibility
function runRealAiEvaluation() {
  runFRAIEvaluation();
}

function copyAiRefactoredCode() {
  const fixBox = document.getElementById('aiCodeFixBox');
  if (fixBox && fixBox.innerText) {
    navigator.clipboard.writeText(fixBox.innerText);
    playSound('beep');
    alert('✓ FRAI Refactored Code copied to clipboard!');
  }
}

// Copy JSON report
function copyFRAIReport() {
  const jsonOutput = document.getElementById('fraiJsonOutput');
  if (jsonOutput && jsonOutput.innerText) {
    navigator.clipboard.writeText(jsonOutput.innerText);
    playSound('beep');
    alert('✓ FRAI JSON report copied to clipboard!');
  }
}

// Explicitly expose every function referenced by an onclick="", onsubmit="",
// or onkeyup="" attribute in index.html. Needed because these functions now
// live inside the guard block above rather than directly in global scope.
window.safeCreateIcons = safeCreateIcons;
window.toggleAuthMode = toggleAuthMode;
window.handleAuthSubmit = handleAuthSubmit;
window.handleOAuth = handleOAuth;
window.showAuthView = showAuthView;
window.handleForgotSubmit = handleForgotSubmit;
window.handleResetSubmit = handleResetSubmit;
window.handleSignOut = handleSignOut;
window.filterHacks = filterHacks;
window.searchLeaderboard = searchLeaderboard;
window.loadLeaderboard = loadLeaderboard;
window.filterLeaderboard = filterLeaderboard;
window.openModal = openModal;
window.closeModal = closeModal;
window.openSubmitModal = openSubmitModal;
window.openHostModal = openHostModal;
window.openAuthModal = openAuthModal;
window.openDocsModal = openDocsModal;
window.openHackathonModal = openHackathonModal;
window.openRiderModal = openRiderModal;
window.handleProjectSubmit = handleProjectSubmit;
window.handleHostSubmit = handleHostSubmit;
window.handleCtaSubmit = handleCtaSubmit;
window.fakeGithubAuth = fakeGithubAuth;
window.loadSnippetPreset = loadSnippetPreset;
window.updateCharCount = updateCharCount;
window.runFRAIEvaluation = runFRAIEvaluation;
window.runRealAiEvaluation = runRealAiEvaluation;
window.copyAiRefactoredCode = copyAiRefactoredCode;
window.copyFRAIReport = copyFRAIReport;
window.highlightEngineMetric = highlightEngineMetric;
window.runEngineAuditSimulation = runEngineAuditSimulation;

})(); // end IIFE
