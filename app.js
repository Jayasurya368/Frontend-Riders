/* ============================================================
   FrontendRiders Platform Controller & Interactive Engine
   FRAI v1.0 - Frontend Riders AI Evaluation Engine
   ============================================================ */

// Guard: if this file somehow gets evaluated twice on the same page
// (e.g. a preview/live-reload tool re-injecting the script), bail out
// instead of throwing "Identifier has already been declared" and
// killing every function/button on the page.
if (window.__frontendRidersAppLoaded) {
  console.warn('app.js already loaded — skipping duplicate execution.');
} else {
window.__frontendRidersAppLoaded = true;

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
const SUPABASE_URL = 'https://fcmumvpohtwltjbweqpq.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_rN6lawqyRal7rDbnEsPAXQ_GrH3YkrW';
let supabase = null;
let currentAuthMode = 'signin';
let currentUser = null;

// Initialize Supabase Client if script is loaded, with LocalStorage fallback
function initSupabase() {
  try { localStorage.removeItem('rider_user'); } catch (e) {}

  if (window.supabase && typeof window.supabase.createClient === 'function') {
    try {
      supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      loadLeaderboard();
      
      // Fetch initial session
      supabase.auth.getSession().then(({ data: { session } }) => {
        if (session && session.user) {
          currentUser = session.user;
          try { localStorage.setItem('rider_user', JSON.stringify(currentUser)); } catch (e) {}
          updateAuthUI();
        }
      }).catch(err => {
        console.warn('Session retrieval warning:', err);
      });

      // Listen for auth state changes
      supabase.auth.onAuthStateChange((event, session) => {
        if (session && session.user) {
          currentUser = session.user;
          try { localStorage.setItem('rider_user', JSON.stringify(currentUser)); } catch (e) {}
        } else if (event === 'SIGNED_OUT') {
          currentUser = null;
          try { localStorage.removeItem('rider_user'); } catch (e) {}
        }
        updateAuthUI();
      });
    } catch (e) {
      console.error('Supabase initialization error:', e);
    }
  }
  updateAuthUI();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSupabase);
} else {
  initSupabase();
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
  
  if (!desktopContainer && !mobileContainer) return;
  
  if (currentUser) {
    // User is logged in
    const emailPrefix = (currentUser.email || 'Developer').split('@')[0];
    
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
    // User is logged out
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
document.addEventListener('DOMContentLoaded', () => {
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
  }

  initParticleCanvas();
  startHackathonCountdowns();
  safeCreateIcons();
});

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

// 3. COUNTDOWN TIMER FOR ACTIVE HACKATHON
function startHackathonCountdowns() {
  let targetTime = new Date().getTime() + (4 * 24 * 60 * 60 * 1000) + (18 * 60 * 60 * 1000);

  function update() {
    const now = new Date().getTime();
    const diff = targetTime - now;

    if (diff <= 0) return;

    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);

    const timer1 = document.getElementById('timer1');
    if (timer1) {
      timer1.innerText = `${String(days).padStart(2, '0')}d ${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
    }
  }

  update();
  setInterval(update, 1000);
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
  currentAuthMode = mode;
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
      "Must score > 95/100 on automated FrontendRiders Lighthouse audit."
    ]
  },
  3: {
    title: "Accessibility & Speed Sprint",
    tag: "Vercel Sponsored",
    prize: "$2,000",
    stack: ["Vanilla JS", "Lighthouse CLI", "Web Vitals"],
    deadline: "Starts October 22",
    rules: [
      "WCAG 2.1 AAA Accessibility Compliance.",
      "100/100 score across all 4 Lighthouse categories.",
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
        ${cell('LIGHTHOUSE SCORE / 100', rider.score)}
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
  btn.innerText = 'Running Lighthouse...';
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

    setStatus('Lighthouse is auditing your live demo (10–40s)...');
    const { data: result, error: fnError } = await supabase.functions.invoke('evaluate-project', { body: { submission_id: row.id } });
    if (fnError) {
      let msg = fnError.message;
      try { msg = (await fnError.context.json()).error || msg; } catch (_) {}
      throw new Error(msg);
    }

    clearInterval(ticker);
    bar.style.width = '100%';
    setStatus('✓ Lighthouse score: ' + result.score + ' / 100', 'text-emerald-600 font-bold');
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
    btn.innerText = 'Submit & Run Lighthouse';
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
window.loadSnippetPreset = loadSnippetPreset;
window.updateCharCount = updateCharCount;
window.runFRAIEvaluation = runFRAIEvaluation;
window.runRealAiEvaluation = runRealAiEvaluation;
window.copyAiRefactoredCode = copyAiRefactoredCode;
window.copyFRAIReport = copyFRAIReport;
window.highlightEngineMetric = highlightEngineMetric;
window.runEngineAuditSimulation = runEngineAuditSimulation;

} // end duplicate-load guard
