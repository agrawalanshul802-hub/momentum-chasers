/**
 * Momentum Chasers · Supabase & Google Auth Integration (supabase-config.js)
 * Production-ready authentication engine connecting Supabase Auth, Google OAuth,
 * and session state management across Momentum Chasers.
 */

(function () {
  'use strict';

  // 1. Default Configuration
  // Paste your Supabase project credentials below or set them in .env / Netlify environment variables.
  const DEFAULT_CONFIG = {
    url: 'https://jxrvdlduhhcfbwjfqvog.supabase.co',
    anonKey: 'sb_publishable_e8oMJgGwxyXf0YomGTXYRg_wL2uxY12'
  };

  // 2. State & Client Container
  let supabaseClient = null;
  const config = {
    url: window.SUPABASE_URL || localStorage.getItem('MOMENTUM_SUPABASE_URL') || DEFAULT_CONFIG.url || '',
    anonKey: window.SUPABASE_ANON_KEY || localStorage.getItem('MOMENTUM_SUPABASE_ANON_KEY') || DEFAULT_CONFIG.anonKey || ''
  };

  // Helper: check if valid Supabase URL & Key
  function isValidConfig(url, key) {
    return Boolean(
      url &&
      key &&
      url.startsWith('https://') &&
      url.includes('.supabase.co') &&
      !url.includes('your-project-ref') &&
      key.length > 20
    );
  }

  // 3. Initialize Supabase Client
  function initClient(url, anonKey) {
    if (!url || !anonKey || !window.supabase) {
      return null;
    }

    try {
      supabaseClient = window.supabase.createClient(url, anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          storage: window.localStorage,
          flowType: 'pkce'
        }
      });
      console.log('✅ Supabase Auth Client successfully initialized.');
      return supabaseClient;
    } catch (err) {
      console.warn('⚠️ Supabase client initialization error:', err);
      return null;
    }
  }

  // Attempt initial load
  if (isValidConfig(config.url, config.anonKey)) {
    initClient(config.url, config.anonKey);
  }

  // 4. Try fetching config from server /api/auth/config (for local Node server)
  async function fetchServerConfig() {
    if (isValidConfig(config.url, config.anonKey)) return true;

    try {
      const endpoints = ['/api/auth/config'];
      for (const ep of endpoints) {
        try {
          const res = await fetch(ep, { headers: { 'Accept': 'application/json' } });
          if (res.ok) {
            const data = await res.json();
            if (data && isValidConfig(data.supabaseUrl, data.supabaseAnonKey)) {
              config.url = data.supabaseUrl;
              config.anonKey = data.supabaseAnonKey;
              localStorage.setItem('MOMENTUM_SUPABASE_URL', data.supabaseUrl);
              localStorage.setItem('MOMENTUM_SUPABASE_ANON_KEY', data.supabaseAnonKey);
              initClient(config.url, config.anonKey);
              return true;
            }
          }
        } catch (_) {}
      }
    } catch (_) {}
    return false;
  }

  // Execute background fetch
  fetchServerConfig();

  // 5. Auth Action Helpers

  /**
   * Helper: compute absolute redirect URL for OAuth
   */
  function getOAuthRedirectUrl() {
    const origin = window.location.origin;
    const pathname = window.location.pathname;
    // Redirect to index.html dashboard
    if (pathname.includes('login.html')) {
      return origin + pathname.replace('login.html', 'index.html');
    }
    return origin + pathname;
  }

  /**
   * Helper: map Supabase User object to Momentum Chasers User Profile
   */
  function mapSupabaseUser(user, session = null) {
    if (!user) return null;
    const meta = user.user_metadata || {};
    const fullName = meta.full_name || meta.name || user.email?.split('@')[0] || 'Trader';
    const avatar = meta.avatar_url || meta.picture || (user.email ? user.email.charAt(0).toUpperCase() : 'U');
    const provider = user.app_metadata?.provider || 'supabase';

    return {
      id: user.id,
      name: fullName,
      email: user.email,
      plan: 'PRO Terminal',
      avatar: avatar,
      provider: provider,
      broker: 'Kite / Demat Linked',
      accessToken: session ? session.access_token : null,
      signedAt: new Date().toISOString()
    };
  }

  // 6. Public API Object
  const MOMENTUM_SUPABASE = {
    get client() {
      if (!supabaseClient && isValidConfig(config.url, config.anonKey) && window.supabase) {
        initClient(config.url, config.anonKey);
      }
      return supabaseClient;
    },

    get isConfigured() {
      return isValidConfig(config.url, config.anonKey);
    },

    getConfig() {
      return { url: config.url, anonKey: config.anonKey };
    },

    /**
     * Manually configure credentials from UI or developer console
     */
    configure(url, anonKey) {
      if (!isValidConfig(url, anonKey)) {
        return { success: false, error: 'Invalid Supabase URL or Anon Key' };
      }
      config.url = url.trim();
      config.anonKey = anonKey.trim();
      localStorage.setItem('MOMENTUM_SUPABASE_URL', config.url);
      localStorage.setItem('MOMENTUM_SUPABASE_ANON_KEY', config.anonKey);
      const client = initClient(config.url, config.anonKey);
      return { success: !!client, client };
    },

    /**
     * 1-Click Google OAuth Sign-In via Supabase
     */
    async signInWithGoogle(options = {}) {
      try {
        const client = this.client;
        if (!client) {
          return { success: false, error: 'Supabase client not initialized. Check your credentials.' };
        }

        const redirectTo = options.redirectTo || getOAuthRedirectUrl();
        const { data, error } = await client.auth.signInWithOAuth({
          provider: 'google',
          options: {
            redirectTo: redirectTo,
            queryParams: {
              access_type: 'offline',
              prompt: 'consent'
            }
          }
        });

        if (error) {
          return { success: false, error: error.message };
        }
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err.message || 'Google OAuth failed' };
      }
    },

    /**
     * Email & Password Sign In
     */
    async signInWithPassword(email, password) {
      try {
        const client = this.client;
        if (!client) {
          return { success: false, error: 'Supabase client not initialized.' };
        }

        const { data, error } = await client.auth.signInWithPassword({
          email: email.trim(),
          password: password
        });

        if (error) {
          return { success: false, error: error.message };
        }

        if (data && data.user) {
          const profile = mapSupabaseUser(data.user, data.session);
          localStorage.setItem('momentum_user', JSON.stringify(profile));
          return { success: true, user: profile, session: data.session };
        }
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },

    /**
     * Email & Password Sign Up (Registration)
     */
    async signUp(email, password, metadata = {}) {
      try {
        const client = this.client;
        if (!client) {
          return { success: false, error: 'Supabase client not initialized.' };
        }

        const metaObj = typeof metadata === 'string' ? { full_name: metadata } : (metadata || {});
        const { data, error } = await client.auth.signUp({
          email: email.trim(),
          password: password,
          options: {
            data: {
              full_name: metaObj.full_name || email.split('@')[0],
              ...metaObj
            }
          }
        });

        if (error) {
          return { success: false, error: error.message };
        }

        if (data && data.user) {
          const profile = mapSupabaseUser(data.user, data.session);
          if (data.session) {
            localStorage.setItem('momentum_user', JSON.stringify(profile));
          }
          return { success: true, user: profile, session: data.session, confirmationRequired: !data.session };
        }
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },

    /**
     * Password Reset Request
     */
    async resetPassword(email) {
      try {
        const client = this.client;
        if (!client) {
          return { success: false, error: 'Supabase client not initialized.' };
        }

        const redirectTo = window.location.origin + window.location.pathname.replace('index.html', 'login.html') + '#reset';
        const { data, error } = await client.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: redirectTo
        });

        if (error) {
          return { success: false, error: error.message };
        }
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },

    /**
     * Sign Out
     */
    async signOut() {
      localStorage.removeItem('momentum_user');
      const client = this.client;
      if (client) {
        try {
          await client.auth.signOut();
        } catch (e) {
          console.warn('Supabase signOut error:', e);
        }
      }
      return true;
    },

    /**
     * Retrieve current active session
     */
    async getSession() {
      const client = this.client;
      if (!client) return null;
      try {
        const { data, error } = await client.auth.getSession();
        if (error || !data) return null;
        return data.session;
      } catch (_) {
        return null;
      }
    },

    /**
     * Detect and handle Google OAuth redirect callback (tokens in URL)
     */
    async handleOAuthCallback() {
      const hash = window.location.hash || '';
      const search = window.location.search || '';

      const hasOAuthTokens =
        hash.includes('access_token=') ||
        hash.includes('refresh_token=') ||
        search.includes('code=') ||
        hash.includes('error=');

      if (!hasOAuthTokens) return null;

      console.log('🔄 Detecting Supabase OAuth callback tokens in URL...');
      const client = this.client;
      if (!client) return null;

      try {
        const { data, error } = await client.auth.getSession();
        if (error) {
          console.warn('OAuth session extraction error:', error);
          return null;
        }

        if (data && data.session && data.session.user) {
          const profile = mapSupabaseUser(data.session.user, data.session);
          localStorage.setItem('momentum_user', JSON.stringify(profile));

          // Clean up tokens from URL without reloading
          const cleanUrl = window.location.origin + window.location.pathname + '#screener';
          history.replaceState(null, '', cleanUrl);

          console.log('🎉 Google OAuth sign-in verified via Supabase:', profile.email);
          return profile;
        }
      } catch (err) {
        console.warn('handleOAuthCallback exception:', err);
      }
      return null;
    }
  };

  window.MOMENTUM_SUPABASE = MOMENTUM_SUPABASE;
  window.MomentumAuth = MOMENTUM_SUPABASE;
})();
