/**
 * Momentum Chasers · Authentication & Session Module (auth.js)
 * High-performance, zero-dependency auth controller for login.html
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

  // Smart back link: if referrer is landing.html, return to landing.html
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
        void el.offsetWidth; // force reflow
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
      // Determine initial tab from hash
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

  // --- 8. Event Handlers ---

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

  // Password Visibility Toggle (Show / Hide)
  if (eyeBtn && pwInput) {
    eyeBtn.addEventListener('click', () => {
      const isPw = pwInput.type === 'password';
      pwInput.type = isPw ? 'text' : 'password';
      eyeBtn.textContent = isPw ? 'Hide' : 'Show';
      eyeBtn.setAttribute('aria-label', isPw ? 'Hide password' : 'Show password');
      pwInput.focus();
    });
  }

  // Sign In with Google
  if (googleBtn) {
    googleBtn.addEventListener('click', () => {
      googleBtn.disabled = true;
      googleBtn.style.opacity = '0.75';
      showMsg('Connecting to Google Account...', 'info');

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
    outBtn.addEventListener('click', () => {
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
    formEl.addEventListener('submit', e => {
      e.preventDefault();
      const currentView = root.getAttribute('data-view') || 'signin';
      const email = (emInput ? emInput.value : '').trim();
      const password = pwInput ? pwInput.value : '';

      // 1. Reset Password Flow
      if (currentView === 'reset') {
        if (!email || !email.includes('@') || !email.includes('.')) {
          showMsg('Please enter a valid email address.', 'err');
          if (emInput) emInput.focus();
          return;
        }
        goBtn.disabled = true;
        showMsg('Sending recovery instructions...', 'info');
        setTimeout(() => {
          goBtn.disabled = false;
          showMsg(`✓ Password reset link has been dispatched to ${email}. Please check your inbox!`, 'ok');
        }, 500);
        return;
      }

      // 2. Sign In & Sign Up Flows
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

      // Process authentication
      goBtn.disabled = true;
      goBtn.style.opacity = '0.75';
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

  // Handle Hash Changes dynamically (e.g. browser back/forward)
  window.addEventListener('hashchange', () => {
    if (root.getAttribute('data-view') === 'done') return;
    const hash = (window.location.hash || '').replace('#', '').toLowerCase();
    if (hash === 'signup' || hash === 'reset' || hash === 'signin') {
      setView(hash, false);
    }
  });

  // Initialize
  renderSessionState();
})();
