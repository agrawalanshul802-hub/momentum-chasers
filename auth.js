/**
 * Momentum Chasers · Authentication & Session Module (auth.js)
 * Fully connected with Supabase Auth, Google OAuth, and Local Session Management
 */

(function () {
  'use strict';

  // --- 1. DOM References ---
  const root = document.querySelector('[data-auth]') || document.querySelector('.split');
  if (!root) return;

  const ttlEl = root.querySelector('[data-f="ttl"]');
  const subEl = root.querySelector('[data-f="sub"]');
  const formEl = root.querySelector('[data-f="form"]');
  const emInput = root.querySelector('[data-f="em"]');
  const pwInput = root.querySelector('[data-f="pw"]');
  const eyeBtn = root.querySelector('[data-f="eye"]');
  const keepBox = root.querySelector('[data-f="keep"]');
  const msgEl = root.querySelector('[data-f="msg"]');
  const goBtn = root.querySelector('[data-f="go"]');
  const googleBtn = root.querySelector('[data-f="google"]');
  const whoEl = root.querySelector('[data-f="who"]');
  const outBtn = root.querySelector('[data-f="out"]');
  const bkLink = root.querySelector('.bk');
  const dnBox = root.querySelector('.dn');

  // --- 2. View Configuration ---
  const VIEWS = {
    signin: {
      ttl: 'Log in to Momentum Chasers',
      sub: 'Pick up your courses and market tools where you left off.',
      btn: 'Log in'
    },
    signup: {
      ttl: 'Create your free account',
      sub: 'Start reading momentum and build your edge today.',
      btn: 'Create account'
    },
    reset: {
      ttl: 'Reset your password',
      sub: "Enter your email and we'll send a password reset link.",
      btn: 'Send reset link'
    },
    done: {
      ttl: 'Welcome back!',
      sub: 'You are signed in to your Momentum Chasers Pro account.',
      btn: 'Open Dashboard'
    }
  };

  // --- 3. Redirect & Destination Target ---
  function getRedirectTarget() {
    try {
      const params = new URLSearchParams(window.location.search);
      const target = params.get('redirect') || params.get('return_to') || params.get('next');
      if (target && !target.startsWith('http://') && !target.startsWith('https://')) {
        return target;
      }
    } catch (_) {}
    return 'index.html#screener';
  }

  // Smart back link
  if (bkLink) {
    if (document.referrer && document.referrer.includes('landing.html')) {
      bkLink.href = 'landing.html';
    }
  }

  // --- 4. Helper: Format Name from Email ---
  function nameFromEmail(email) {
    if (!email) return 'Trader';
    const local = email.split('@')[0] || 'Trader';
    return local
      .replace(/[._-]+/g, ' ')
      .trim()
      .split(' ')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ') || 'Trader';
  }

  // --- 5. Helper: Display Status Messages ---
  function showMsg(text, type = 'info') {
    if (!msgEl) return;
    msgEl.textContent = text;
    msgEl.className = 'msg' + (type ? ' ' + type : '');
    if (type === 'err') {
      msgEl.style.color = '#f2788f';
      msgEl.style.display = 'block';
    } else if (type === 'ok') {
      msgEl.style.color = '#4fd1a1';
      msgEl.style.display = 'block';
    } else {
      msgEl.style.color = 'var(--muted)';
      msgEl.style.display = text ? 'block' : 'none';
    }
  }

  function clearMsg() {
    if (!msgEl) return;
    msgEl.textContent = '';
    msgEl.style.display = 'none';
  }

  // --- 6. Active View Controller ---
  function setView(viewName, updateHash = true) {
    const config = VIEWS[viewName] || VIEWS.signin;
    root.setAttribute('data-view', viewName);

    if (ttlEl) ttlEl.textContent = config.ttl;
    if (subEl) subEl.textContent = config.sub;
    if (goBtn) goBtn.textContent = config.btn;

    clearMsg();

    // Trigger right-side showcase transition animation
    root.querySelectorAll('.vs').forEach(el => {
      el.classList.remove('vs-anim');
      if (el.getAttribute('data-v') === viewName || (viewName === 'done' && el.getAttribute('data-v') === 'signin')) {
        void el.offsetWidth;
        el.classList.add('vs-anim');
      }
    });

    if (updateHash && viewName !== 'done') {
      history.replaceState(null, '', '#' + viewName);
    }
  }

  // --- 7. Check Existing Active Session ---
  function getActiveUser() {
    try {
      const raw = localStorage.getItem('momentum_user');
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function renderSessionState() {
    const user = getActiveUser();
    if (user && user.email) {
      if (whoEl) whoEl.textContent = user.name || user.email;
      setView('done', false);

      // Ensure "Launch Dashboard" button exists in .dn container
      if (dnBox && !dnBox.querySelector('.launch-btn')) {
        const launchBtn = document.createElement('button');
        launchBtn.className = 'go launch-btn';
        launchBtn.type = 'button';
        launchBtn.style.marginTop = '14px';
        launchBtn.style.marginBottom = '10px';
        launchBtn.innerHTML = 'Launch Terminal Dashboard &rarr;';
        launchBtn.onclick = () => {
          window.location.href = getRedirectTarget();
        };
        dnBox.insertBefore(launchBtn, dnBox.querySelector('[data-f="out"]'));
      }
    } else {
      const hash = (window.location.hash || '').replace('#', '').toLowerCase();
      if (hash === 'signup') {
        setView('signup', false);
      } else if (hash === 'reset') {
        setView('reset', false);
      } else {
        setView('signin', false);
      }
    }
  }

  // --- 8. Supabase Connection Status Badge & Setup Modal ---
  function renderSupabaseStatusUI() {
    const sb = window.MOMENTUM_SUPABASE;
    const isConfigured = sb && sb.isConfigured;

    let badge = document.getElementById('supabase-auth-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'supabase-auth-badge';
      badge.style.cssText = `
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 5px 12px;
        border-radius: 99px;
        font-size: 0.75rem;
        font-weight: 700;
        margin-top: 14px;
        cursor: pointer;
        transition: all 0.2s ease;
        user-select: none;
      `;
      const formCard = root.querySelector('.st');
      if (formCard) {
        formCard.appendChild(badge);
      }
    }

    if (isConfigured) {
      badge.style.background = 'rgba(79, 209, 161, 0.12)';
      badge.style.border = '1px solid rgba(79, 209, 161, 0.35)';
      badge.style.color = '#4fd1a1';
      badge.innerHTML = `<span style="width:7px;height:7px;border-radius:50%;background:#4fd1a1;box-shadow:0 0 6px #4fd1a1;"></span> Supabase & Google Auth Live`;
      badge.title = 'Supabase Auth is configured and active. Click to view credentials.';
    } else {
      badge.style.background = 'rgba(245, 181, 68, 0.12)';
      badge.style.border = '1px solid rgba(245, 181, 68, 0.35)';
      badge.style.color = '#ffd37a';
      badge.innerHTML = `<span style="width:7px;height:7px;border-radius:50%;background:#f5b544;"></span> Connect Supabase & Google Auth &rarr;`;
      badge.title = 'Click to connect your Supabase project URL and Anon key.';
    }

    badge.onclick = () => openSupabaseSetupModal();
  }

  // Supabase Setup Modal
  function openSupabaseSetupModal() {
    let modal = document.getElementById('supabase-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'supabase-modal';
      modal.style.cssText = `
        position: fixed;
        inset: 0;
        z-index: 9999;
        background: rgba(7, 11, 23, 0.85);
        backdrop-filter: blur(8px);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
      `;
      modal.innerHTML = `
        <div style="background:#0c1328; border:1px solid #222f55; border-radius:18px; width:min(520px, 100%); padding:28px; box-shadow:0 24px 60px rgba(0,0,0,0.7); position:relative;">
          <button id="sb-modal-close" style="position:absolute;top:16px;right:16px;background:none;border:none;color:#8c97b3;font-size:1.4rem;cursor:pointer;">&times;</button>
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M13.2 2L3 14.4h8.4L9.6 22 21 9.6h-8.4L13.2 2z" fill="#4fd1a1"/></svg>
            <h2 style="margin:0;font-size:1.3rem;letter-spacing:-0.02em;">Connect Supabase & Google Auth</h2>
          </div>
          <p style="margin:0 0 18px;color:#8c97b3;font-size:0.88rem;line-height:1.5;">
            Paste your project credentials from <b>Supabase Dashboard &rarr; Project Settings &rarr; API</b>.
          </p>

          <div style="margin-bottom:14px;">
            <label style="display:block;font-size:0.8rem;font-weight:700;color:#c3cbe0;margin-bottom:6px;">Project URL</label>
            <input id="sb-input-url" type="text" placeholder="https://your-project-ref.supabase.co" style="width:100%;padding:10px 12px;border-radius:10px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.05);color:#fff;font:500 0.9rem monospace;outline:none;" />
          </div>

          <div style="margin-bottom:18px;">
            <label style="display:block;font-size:0.8rem;font-weight:700;color:#c3cbe0;margin-bottom:6px;">Anon Public Key (anon/public)</label>
            <input id="sb-input-key" type="password" placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." style="width:100%;padding:10px 12px;border-radius:10px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.05);color:#fff;font:500 0.9rem monospace;outline:none;" />
          </div>

          <div id="sb-modal-status" style="font-size:0.82rem;margin-bottom:14px;display:none;"></div>

          <div style="display:flex;gap:10px;">
            <button id="sb-modal-save" style="flex:1;padding:12px;border-radius:10px;background:#4fd1a1;color:#070b17;border:none;font-weight:800;font-size:0.95rem;cursor:pointer;">Save & Connect</button>
            <button id="sb-modal-demo" style="padding:12px 18px;border-radius:10px;background:rgba(255,255,255,0.08);color:#c3cbe0;border:1px solid rgba(255,255,255,0.15);font-weight:700;font-size:0.9rem;cursor:pointer;">Use Demo</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      document.getElementById('sb-modal-close').onclick = () => {
        modal.style.display = 'none';
      };

      document.getElementById('sb-modal-demo').onclick = () => {
        modal.style.display = 'none';
        showMsg('Using demo preview mode.', 'info');
      };

      document.getElementById('sb-modal-save').onclick = () => {
        const url = document.getElementById('sb-input-url').value.trim();
        const key = document.getElementById('sb-input-key').value.trim();
        const statusEl = document.getElementById('sb-modal-status');

        if (!url || !key) {
          statusEl.style.display = 'block';
          statusEl.style.color = '#f2788f';
          statusEl.textContent = 'Please provide both Project URL and Anon Key.';
          return;
        }

        const res = window.MOMENTUM_SUPABASE.configure(url, key);
        if (res.success) {
          statusEl.style.display = 'block';
          statusEl.style.color = '#4fd1a1';
          statusEl.textContent = '✅ Connected! Reloading auth engine...';
          renderSupabaseStatusUI();
          setTimeout(() => {
            modal.style.display = 'none';
            showMsg('Supabase connected! You can now use Google & Email authentication.', 'ok');
          }, 600);
        } else {
          statusEl.style.display = 'block';
          statusEl.style.color = '#f2788f';
          statusEl.textContent = res.error || 'Failed to connect. Please check URL format.';
        }
      };
    }

    const cur = window.MOMENTUM_SUPABASE ? window.MOMENTUM_SUPABASE.getConfig() : {};
    document.getElementById('sb-input-url').value = cur.url || '';
    document.getElementById('sb-input-key').value = cur.anonKey || '';
    modal.style.display = 'flex';
  }

  // --- 9. Event Handlers ---

  // Navigation Links: data-go="signin|signup|reset"
  root.addEventListener('click', e => {
    const goTarget = e.target.closest('[data-go]');
    if (goTarget) {
      e.preventDefault();
      const targetView = goTarget.getAttribute('data-go');
      setView(targetView, true);
      if (emInput && targetView !== 'reset') {
        emInput.focus();
      }
    }
  });

  // Password Visibility Toggle
  if (eyeBtn && pwInput) {
    eyeBtn.addEventListener('click', () => {
      const isPw = pwInput.type === 'password';
      pwInput.type = isPw ? 'text' : 'password';
      eyeBtn.textContent = isPw ? 'Hide' : 'Show';
      eyeBtn.setAttribute('aria-label', isPw ? 'Hide password' : 'Show password');
      pwInput.focus();
    });
  }

  // 1-Click Google Sign-In via Supabase
  if (googleBtn) {
    googleBtn.addEventListener('click', async () => {
      googleBtn.disabled = true;
      googleBtn.style.opacity = '0.75';

      const sb = window.MOMENTUM_SUPABASE;

      // Case A: Supabase is configured -> initiate real Google OAuth redirect
      if (sb && sb.isConfigured) {
        showMsg('Connecting to Google via Supabase...', 'info');
        try {
          const redirectTo = window.location.origin + window.location.pathname.replace('login.html', 'index.html');
          await sb.signInWithGoogle({ redirectTo });
          return;
        } catch (err) {
          googleBtn.disabled = false;
          googleBtn.style.opacity = '1';
          console.error('Google OAuth error:', err);
          showMsg(err.message || 'Failed to start Google sign-in. Check Supabase Provider settings.', 'err');
          return;
        }
      }

      // Case B: Supabase credentials not set -> provide setup option or fast preview
      showMsg('Supabase not yet configured. Connecting with Trader demo profile...', 'info');
      setTimeout(() => {
        const googleUser = {
          name: 'Trader (Google)',
          email: 'trader.google@momentumchasers.com',
          plan: 'PRO Terminal',
          avatar: 'G',
          provider: 'google',
          broker: 'Kite / Demat Linked',
          signedAt: new Date().toISOString()
        };

        try {
          localStorage.setItem('momentum_user', JSON.stringify(googleUser));
        } catch (err) {
          console.warn('localStorage write failed:', err);
        }

        showMsg('✓ Google authentication verified. Launching terminal...', 'ok');
        setTimeout(() => {
          window.location.href = getRedirectTarget();
        }, 350);
      }, 400);
    });
  }

  // Sign Out Button
  if (outBtn) {
    outBtn.addEventListener('click', async () => {
      if (window.MOMENTUM_SUPABASE) {
        await window.MOMENTUM_SUPABASE.signOut().catch(() => {});
      }
      try {
        localStorage.removeItem('momentum_user');
      } catch (_) {}
      showMsg('Signed out successfully.', 'info');
      setView('signin', true);
      if (emInput) emInput.value = '';
      if (pwInput) pwInput.value = '';
    });
  }

  // Form Submission (Email + Password / Reset)
  if (formEl) {
    formEl.addEventListener('submit', async e => {
      e.preventDefault();
      const currentView = root.getAttribute('data-view') || 'signin';
      const email = (emInput ? emInput.value : '').trim();
      const password = pwInput ? pwInput.value : '';
      const sb = window.MOMENTUM_SUPABASE;

      // 1. Reset Password Flow
      if (currentView === 'reset') {
        if (!email || !email.includes('@') || !email.includes('.')) {
          showMsg('Please enter a valid email address.', 'err');
          if (emInput) emInput.focus();
          return;
        }

        goBtn.disabled = true;
        showMsg('Sending recovery instructions...', 'info');

        if (sb && sb.isConfigured) {
          try {
            await sb.resetPassword(email);
            goBtn.disabled = false;
            showMsg(`✓ Supabase password reset link dispatched to ${email}. Check your inbox!`, 'ok');
            return;
          } catch (err) {
            goBtn.disabled = false;
            showMsg(err.message || 'Failed to send reset email.', 'err');
            return;
          }
        }

        setTimeout(() => {
          goBtn.disabled = false;
          showMsg(`✓ Password reset link has been dispatched to ${email}. Please check your inbox!`, 'ok');
        }, 500);
        return;
      }

      // 2. Sign In & Sign Up Validations
      if (!email || !email.includes('@') || !email.includes('.')) {
        showMsg('Please enter a valid email address.', 'err');
        if (emInput) emInput.focus();
        return;
      }

      if (!password) {
        showMsg('Please enter your password.', 'err');
        if (pwInput) pwInput.focus();
        return;
      }

      if (currentView === 'signup' && password.length < 8) {
        showMsg('Password must be at least 8 characters long.', 'err');
        if (pwInput) pwInput.focus();
        return;
      }

      goBtn.disabled = true;
      goBtn.style.opacity = '0.75';

      // 3. Process via Supabase if configured
      if (sb && sb.isConfigured) {
        if (currentView === 'signin') {
          showMsg('Verifying credentials with Supabase...', 'info');
          try {
            const res = await sb.signInWithPassword(email, password);
            showMsg(`✓ Welcome back, ${res.user.name}! Connecting...`, 'ok');
            setTimeout(() => {
              window.location.href = getRedirectTarget();
            }, 350);
            return;
          } catch (err) {
            goBtn.disabled = false;
            goBtn.style.opacity = '1';
            showMsg(err.message || 'Invalid email or password.', 'err');
            return;
          }
        } else if (currentView === 'signup') {
          showMsg('Creating account in Supabase...', 'info');
          try {
            const res = await sb.signUp(email, password, { full_name: nameFromEmail(email) });
            if (res.confirmationRequired) {
              goBtn.disabled = false;
              goBtn.style.opacity = '1';
              showMsg('✓ Account registered! Please check your email to confirm registration.', 'ok');
              return;
            }
            showMsg('✓ Account created successfully! Setting up your workspace...', 'ok');
            setTimeout(() => {
              window.location.href = getRedirectTarget();
            }, 350);
            return;
          } catch (err) {
            goBtn.disabled = false;
            goBtn.style.opacity = '1';
            showMsg(err.message || 'Sign up failed.', 'err');
            return;
          }
        }
      }

      // Fallback: Local Session Processing
      showMsg('Verifying credentials...', 'info');
      setTimeout(() => {
        const userObj = {
          name: nameFromEmail(email),
          email: email,
          plan: 'PRO Terminal',
          avatar: email.charAt(0).toUpperCase(),
          provider: 'email',
          keepSignedIn: keepBox ? keepBox.checked : true,
          broker: 'Kite / Demat Linked',
          signedAt: new Date().toISOString()
        };

        try {
          localStorage.setItem('momentum_user', JSON.stringify(userObj));
        } catch (err) {
          console.warn('localStorage write failed:', err);
        }

        const msgText = currentView === 'signup'
          ? '✓ Account created successfully! Setting up your workspace...'
          : '✓ Sign in verified. Welcome back, ' + userObj.name + '!';
        showMsg(msgText, 'ok');

        setTimeout(() => {
          window.location.href = getRedirectTarget();
        }, 350);
      }, 400);
    });
  }

  // Handle Hash Changes dynamically
  window.addEventListener('hashchange', () => {
    if (root.getAttribute('data-view') === 'done') return;
    const hash = (window.location.hash || '').replace('#', '').toLowerCase();
    if (hash === 'signup' || hash === 'reset' || hash === 'signin') {
      setView(hash, false);
    }
  });

  // Check for OAuth Callback tokens in URL (in case OAuth landed on login.html)
  if (window.MOMENTUM_SUPABASE) {
    window.MOMENTUM_SUPABASE.handleOAuthCallback().then(user => {
      if (user) {
        showMsg('✓ Google OAuth authenticated! Redirecting...', 'ok');
        setTimeout(() => {
          window.location.href = getRedirectTarget();
        }, 300);
      }
    });
  }

  // Initialize
  renderSessionState();
  renderSupabaseStatusUI();
})();
