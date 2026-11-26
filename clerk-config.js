/**
 * Momentum Chasers · Clerk Auth Integration (clerk-config.js)
 * Bridges Clerk Browser JS SDK with MomentumAuth / MOMENTUM_SUPABASE interface
 * so login.html, index.html, and script.js work seamlessly with Clerk.
 */
(function () {
  'use strict';

  const DEFAULT_CLERK_PUB_KEY = 'pk_test_dmFsdWVkLXBhcnJvdC02MTg3LmNsZXJrLmFjY291bnRzLmRldiQ';
  let clerkReadyPromise = null;
  const authListeners = [];

  function mapClerkUser(user) {
    if (!user) return null;
    const primaryEmail = (user.primaryEmailAddress && user.primaryEmailAddress.emailAddress) ||
      (user.emailAddresses && user.emailAddresses[0] && user.emailAddresses[0].emailAddress) || '';
    const fullName = user.fullName ||
      [user.firstName, user.lastName].filter(Boolean).join(' ') ||
      user.username ||
      (primaryEmail ? primaryEmail.split('@')[0] : 'Trader');
    const avatar = user.imageUrl || (primaryEmail ? primaryEmail.charAt(0).toUpperCase() : 'U');
    const extAccounts = user.externalAccounts || [];
    const hasGoogle = extAccounts.some(a => String(a.provider || '').includes('google'));

    return {
      id: user.id,
      name: fullName,
      email: primaryEmail,
      plan: 'PRO Terminal',
      avatar: avatar,
      provider: hasGoogle ? 'google' : 'clerk',
      broker: 'Kite / Demat Linked',
      signedAt: new Date().toISOString()
    };
  }

  function syncLocalProfile(profile) {
    if (!profile || !profile.email) return;
    try {
      localStorage.setItem('momentum_user', JSON.stringify(profile));
      localStorage.setItem('momentum_auth_user', JSON.stringify(profile));
      localStorage.setItem('mc_user_email', profile.email);
      if (profile.name) localStorage.setItem('mc_user_name', profile.name);
      localStorage.removeItem('momentum_signed_out');
      localStorage.removeItem('mc_clerk_oauth_pending');
      if (window.MomentumCloudSync && window.MomentumCloudSync.syncProfile) {
        window.MomentumCloudSync.syncProfile(profile);
      }
    } catch (_) { }
  }

  async function getPubKey() {
    if (window.CLERK_PUBLISHABLE_KEY) return window.CLERK_PUBLISHABLE_KEY;
    try {
      const res = await fetch('/api/auth/config', { headers: { 'Accept': 'application/json' } });
      if (res.ok) {
        const data = await res.json();
        if (data && data.clerkPublishableKey) return data.clerkPublishableKey;
      }
    } catch (_) { }
    return DEFAULT_CLERK_PUB_KEY;
  }

  function ensureClerkLoaded() {
    if (clerkReadyPromise) return clerkReadyPromise;
    clerkReadyPromise = (async () => {
      const deadline = Date.now() + 8000;
      while (!window.Clerk && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 80));
      }
      if (!window.Clerk) return null;

      try {
        if (!window.Clerk.loaded) {
          const pubKey = await getPubKey();
          await window.Clerk.load({ publishableKey: pubKey });
        }
        const isOAuthReturn = window.location.hash.includes('sso-callback') ||
          window.location.search.includes('__clerk') ||
          localStorage.getItem('mc_clerk_oauth_pending') === '1';
        if (isOAuthReturn && !window.Clerk.user && typeof window.Clerk.handleRedirectCallback === 'function') {
          try {
            await window.Clerk.handleRedirectCallback({
              afterSignInUrl: window.location.origin + '/index.html#screener',
              afterSignUpUrl: window.location.origin + '/index.html#screener'
            });
          } catch (_) { }
        }
        if (window.Clerk.user) {
          const profile = mapClerkUser(window.Clerk.user);
          syncLocalProfile(profile);
          authListeners.forEach(cb => {
            try { cb('SIGNED_IN', { user: profile }); } catch (_) { }
          });
        }
        window.Clerk.addListener(({ user }) => {
          if (user) {
            const profile = mapClerkUser(user);
            syncLocalProfile(profile);
            authListeners.forEach(cb => {
              try { cb('SIGNED_IN', { user: profile }); } catch (_) { }
            });
          } else {
            authListeners.forEach(cb => {
              try { cb('SIGNED_OUT', null); } catch (_) { }
            });
          }
        });
        console.log('✅ Clerk Auth Client successfully initialized.');
        return window.Clerk;
      } catch (err) {
        console.warn('⚠️ Clerk initialization warning:', err);
        return null;
      }
    })();
    return clerkReadyPromise;
  }

  ensureClerkLoaded();

  const authShim = {
    async getSession() {
      const clerk = await ensureClerkLoaded();
      if (clerk && clerk.user) {
        const profile = mapClerkUser(clerk.user);
        return { data: { session: { user: profile, access_token: null } }, error: null };
      }
      return { data: { session: null }, error: null };
    },
    onAuthStateChange(cb) {
      if (typeof cb === 'function') authListeners.push(cb);
      return { data: { subscription: { unsubscribe: () => { } } } };
    }
  };

  const MOMENTUM_CLERK_AUTH = {
    client: { auth: authShim },

    get isConfigured() {
      return true;
    },

    getUser() {
      if (window.Clerk && window.Clerk.user) {
        return mapClerkUser(window.Clerk.user);
      }
      try {
        if (localStorage.getItem('momentum_signed_out') === '1') return null;
        const raw = localStorage.getItem('momentum_user') || localStorage.getItem('momentum_auth_user');
        return raw ? JSON.parse(raw) : null;
      } catch (_) {
        return null;
      }
    },

    async signInWithGoogle() {
      try {
        try {
          localStorage.removeItem('momentum_signed_out');
          localStorage.setItem('mc_clerk_oauth_pending', '1');
        } catch (_) { }
        const clerk = await ensureClerkLoaded();
        if (!clerk) return { success: false, error: 'Clerk SDK is still loading. Please try again.' };
        const targetUrl = window.location.origin + '/index.html';
        if (typeof clerk.openSignIn === 'function') {
          clerk.openSignIn({
            forceRedirectUrl: targetUrl,
            fallbackRedirectUrl: targetUrl,
            signUpForceRedirectUrl: targetUrl,
            signUpFallbackRedirectUrl: targetUrl
          });
          return { success: true };
        }
        if (clerk.client && clerk.client.signIn) {
          await clerk.client.signIn.authenticateWithRedirect({
            strategy: 'oauth_google',
            redirectUrl: window.location.origin + '/login.html#/sso-callback',
            redirectUrlComplete: targetUrl
          });
          return { success: true };
        }
        return { success: false, error: 'Clerk sign-in is unavailable.' };
      } catch (err) {
        return { success: false, error: (err && err.errors && err.errors[0] && err.errors[0].longMessage) || err.message || 'Google sign-in failed' };
      }
    },

    async signInWithPassword(email, password) {
      try {
        const clerk = await ensureClerkLoaded();
        if (!clerk || !clerk.client) return { success: false, error: 'Clerk not initialized yet.' };
        const res = await clerk.client.signIn.create({
          identifier: email.trim(),
          password: password
        });
        if (res.status === 'complete' && res.createdSessionId) {
          await clerk.setActive({ session: res.createdSessionId });
          const profile = mapClerkUser(clerk.user);
          syncLocalProfile(profile);
          return { success: true, user: profile };
        }
        clerk.openSignIn({
          afterSignInUrl: window.location.origin + '/index.html'
        });
        return { success: false, error: 'Additional verification required. Complete sign-in in the popup.' };
      } catch (err) {
        const msg = (err && err.errors && err.errors[0] && (err.errors[0].longMessage || err.errors[0].message)) || err.message || 'Invalid email or password';
        return { success: false, error: msg };
      }
    },

    async signUp(email, password, metadata = {}) {
      try {
        const clerk = await ensureClerkLoaded();
        if (!clerk || !clerk.client) return { success: false, error: 'Clerk not initialized yet.' };
        const fullName = typeof metadata === 'string' ? metadata : (metadata.full_name || '');
        const parts = fullName.trim().split(/\s+/);
        const firstName = parts[0] || undefined;
        const lastName = parts.length > 1 ? parts.slice(1).join(' ') : undefined;

        const res = await clerk.client.signUp.create({
          emailAddress: email.trim(),
          password: password,
          firstName,
          lastName
        });
        if (res.status === 'complete' && res.createdSessionId) {
          await clerk.setActive({ session: res.createdSessionId });
          const profile = mapClerkUser(clerk.user);
          syncLocalProfile(profile);
          return { success: true, user: profile };
        }
        if (res.status === 'missing_requirements') {
          try {
            await res.prepareEmailAddressVerification({ strategy: 'email_code' });
          } catch (_) { }
          const code = window.prompt('Enter the 6-digit verification code sent to ' + email.trim() + ':');
          if (code && code.trim()) {
            const verifyRes = await res.attemptEmailAddressVerification({ code: code.trim() });
            if (verifyRes.status === 'complete' && verifyRes.createdSessionId) {
              await clerk.setActive({ session: verifyRes.createdSessionId });
              const profile = mapClerkUser(clerk.user);
              syncLocalProfile(profile);
              return { success: true, user: profile };
            }
          }
          return { success: true, confirmationRequired: true, message: 'Verification code sent to ' + email.trim() };
        }
        return { success: true, confirmationRequired: true };
      } catch (err) {
        const msg = (err && err.errors && err.errors[0] && (err.errors[0].longMessage || err.errors[0].message)) || err.message || 'Sign up failed';
        return { success: false, error: msg };
      }
    },

    async handleOAuthCallback() {
      const clerk = await ensureClerkLoaded();
      if (clerk && clerk.user) {
        const profile = mapClerkUser(clerk.user);
        syncLocalProfile(profile);
        return profile;
      }
      return null;
    },

    async signOut() {
      try {
        localStorage.setItem('momentum_signed_out', '1');
        localStorage.removeItem('momentum_user');
        localStorage.removeItem('momentum_auth_user');
        localStorage.removeItem('mc_user_email');
        const clerk = await ensureClerkLoaded();
        if (clerk) await clerk.signOut();
      } catch (_) { }
      return { success: true };
    }
  };

  window.MOMENTUM_CLERK = MOMENTUM_CLERK_AUTH;
  window.MOMENTUM_SUPABASE = MOMENTUM_CLERK_AUTH;
  window.MomentumAuth = MOMENTUM_CLERK_AUTH;
})();
