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
      // Automatically keep momentum_user in sync with Supabase Auth state changes
      try {
        supabaseClient.auth.onAuthStateChange((event, session) => {
          if (session && session.user) {
            const profile = mapSupabaseUser(session.user, session);
            localStorage.setItem('momentum_user', JSON.stringify(profile));
            localStorage.setItem('momentum_auth_user', JSON.stringify(profile));
            try { localStorage.removeItem('momentum_signed_out'); } catch (_) {}
            if (window.MomentumCloudSync && window.MomentumCloudSync.syncProfile) {
              window.MomentumCloudSync.syncProfile(profile);
            }
          }
        });
      } catch (_) {}
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
    // Always redirect back to /index.html on current origin for unified session exchange
    return origin + '/index.html';
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
              prompt: 'select_account'
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
          localStorage.setItem('momentum_auth_user', JSON.stringify(profile));
          try { localStorage.removeItem('momentum_signed_out'); } catch (_) {}
          if (window.MomentumCloudSync) {
            window.MomentumCloudSync.syncProfile(profile);
          }
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
          if (window.MomentumCloudSync) {
            window.MomentumCloudSync.syncProfile(profile);
          }
          return { success: true, user: profile, session: data.session, confirmationRequired: !data.session };
        }
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },

    /**
     * Resend Signup Confirmation Email
     */
    async resendConfirmation(email) {
      try {
        const client = this.client;
        if (!client) {
          return { success: false, error: 'Supabase client not initialized.' };
        }
        const { data, error } = await client.auth.resend({
          type: 'signup',
          email: email.trim()
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
      localStorage.removeItem('momentum_auth_user');
      try { localStorage.setItem('momentum_signed_out', '1'); } catch (_) {}
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
        hash.includes('error=') ||
        search.includes('error=');

      if (!hasOAuthTokens) return null;

      // Handle OAuth errors passed back in URL params
      try {
        const params = new URLSearchParams(search || hash.replace(/^#/, '?'));
        const errDesc = params.get('error_description') || params.get('error');
        if (errDesc) {
          const cleanErr = decodeURIComponent(errDesc).replace(/\+/g, ' ');
          console.warn('⚠️ OAuth redirect returned error:', cleanErr);
          const cleanPath = window.location.pathname.includes('login') ? '/index.html' : window.location.pathname;
          history.replaceState(null, '', window.location.origin + cleanPath + '#screener');
          const isExchangeError = cleanErr.toLowerCase().includes('external code') || cleanErr.toLowerCase().includes('exchange');
          return {
            error: cleanErr,
            isOAuthExchangeError: isExchangeError,
            code: params.get('error') || 'server_error'
          };
        }
      } catch (_) {}

      console.log('🔄 Detecting Supabase OAuth callback tokens in URL...');
      const client = this.client;
      if (!client) return null;

      try {
        let session = null;

        // 1. Check if Supabase detectSessionInUrl or existing session already resolved
        try {
          const { data: initialData } = await client.auth.getSession();
          if (initialData && initialData.session && initialData.session.user) {
            session = initialData.session;
          }
        } catch (_) {}

        // 2. If not yet resolved and code is present, try manual PKCE exchange
        if (!session && search.includes('code=')) {
          const params = new URLSearchParams(search);
          const code = params.get('code');
          if (code && typeof client.auth.exchangeCodeForSession === 'function') {
            try {
              console.log('🔄 Exchanging PKCE authorization code for session...');
              const { data: exData, error: exErr } = await client.auth.exchangeCodeForSession(code);
              if (!exErr && exData && exData.session) {
                session = exData.session;
              } else if (exErr) {
                console.warn('PKCE exchange note (may be handled concurrently by detectSessionInUrl):', exErr);
              }
            } catch (exchangeEx) {
              console.warn('PKCE exchange caught exception:', exchangeEx);
            }
          }
        }

        // 3. If session still not resolved, poll getSession for up to 3s (handles async detectSessionInUrl on slow connections)
        if (!session) {
          for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 200));
            try {
              const { data: pollData } = await client.auth.getSession();
              if (pollData && pollData.session && pollData.session.user) {
                session = pollData.session;
                break;
              }
            } catch (_) {}
          }
        }

        if (session && session.user) {
          const profile = mapSupabaseUser(session.user, session);
          localStorage.setItem('momentum_user', JSON.stringify(profile));
          localStorage.setItem('momentum_auth_user', JSON.stringify(profile));
          try { localStorage.removeItem('momentum_signed_out'); } catch (_) {}

          // Clean up tokens and codes from URL without reloading
          const cleanPath = window.location.pathname.includes('login') ? '/index.html' : window.location.pathname;
          const cleanUrl = window.location.origin + cleanPath + '#screener';
          history.replaceState(null, '', cleanUrl);

          console.log('🎉 Google OAuth sign-in verified via Supabase:', profile.email);
          if (window.MomentumCloudSync) {
            window.MomentumCloudSync.syncProfile(profile);
          }
          return profile;
        }
      } catch (err) {
        console.warn('handleOAuthCallback exception:', err);
      }
      return null;
    }
  };

  // 7. Cloud Data Sync Service for Profiles, Watchlists & Portfolio Holdings
  const MomentumCloudSync = {
    async syncProfile(user) {
      if (!user || !user.id || !MOMENTUM_SUPABASE.client) return;
      try {
        const client = MOMENTUM_SUPABASE.client;
        await client.from('profiles').upsert({
          id: user.id,
          email: user.email,
          full_name: user.name || (user.email ? user.email.split('@')[0] : 'Trader'),
          avatar_url: user.avatar || '👤',
          updated_at: new Date().toISOString()
        }, { onConflict: 'id' });
        console.log('☁️ [CloudSync] User profile synced to Supabase:', user.email);
      } catch (e) {
        console.warn('⚠️ [CloudSync] Profile sync notice:', e?.message || e);
      }
    },

    async saveWatchlist(symbols) {
      if (!Array.isArray(symbols) || !MOMENTUM_SUPABASE.client) return;
      try {
        const session = await MOMENTUM_SUPABASE.getSession();
        if (!session || !session.user) return;
        const client = MOMENTUM_SUPABASE.client;
        await client.from('user_watchlists').upsert({
          user_id: session.user.id,
          symbols: symbols,
          updated_at: new Date().toISOString()
        }, { onConflict: 'user_id' });
        console.log('☁️ [CloudSync] Watchlist synced to Supabase:', symbols.length, 'stocks');
      } catch (e) {
        console.warn('⚠️ [CloudSync] Watchlist save error:', e?.message || e);
      }
    },

    async loadWatchlist() {
      if (!MOMENTUM_SUPABASE.client) return null;
      try {
        const session = await MOMENTUM_SUPABASE.getSession();
        if (!session || !session.user) return null;
        const client = MOMENTUM_SUPABASE.client;
        const { data, error } = await client
          .from('user_watchlists')
          .select('symbols')
          .eq('user_id', session.user.id)
          .maybeSingle();
        if (!error && data && Array.isArray(data.symbols)) {
          console.log('☁️ [CloudSync] Loaded watchlist from Supabase:', data.symbols);
          return data.symbols;
        }
      } catch (e) {
        console.warn('⚠️ [CloudSync] Watchlist load error:', e?.message || e);
      }
      return null;
    },

    async savePortfolio(holdings) {
      if (!Array.isArray(holdings) || !MOMENTUM_SUPABASE.client) return;
      try {
        const session = await MOMENTUM_SUPABASE.getSession();
        if (!session || !session.user) return;
        const client = MOMENTUM_SUPABASE.client;
        await client.from('portfolio_holdings').delete().eq('user_id', session.user.id);
        if (holdings.length > 0) {
          const rows = holdings.map(h => ({
            user_id: session.user.id,
            account_label: h.account || h.broker || 'Account A (Zerodha)',
            symbol: h.symbol,
            quantity: Math.max(1, parseInt(h.qty || h.quantity, 10) || 1),
            avg_buy_price: parseFloat(h.buyPrice || h.avgPrice || h.price) || 0
          }));
          await client.from('portfolio_holdings').insert(rows);
          console.log('☁️ [CloudSync] Portfolio holdings synced to Supabase:', rows.length, 'holdings');
        }
      } catch (e) {
        console.warn('⚠️ [CloudSync] Portfolio save error:', e?.message || e);
      }
    },

    async loadPortfolio() {
      if (!MOMENTUM_SUPABASE.client) return null;
      try {
        const session = await MOMENTUM_SUPABASE.getSession();
        if (!session || !session.user) return null;
        const client = MOMENTUM_SUPABASE.client;
        const { data, error } = await client
          .from('portfolio_holdings')
          .select('*')
          .eq('user_id', session.user.id);
        if (!error && Array.isArray(data) && data.length > 0) {
          console.log('☁️ [CloudSync] Loaded portfolio from Supabase:', data.length, 'holdings');
          return data.map((row, idx) => ({
            id: row.id || `h_cloud_${idx}`,
            symbol: row.symbol,
            name: row.symbol,
            broker: row.account_label || 'Zerodha',
            account: row.account_label || 'Zerodha',
            qty: row.quantity,
            buyPrice: parseFloat(row.avg_buy_price),
            cmp: parseFloat(row.avg_buy_price),
            yahooSymbol: `${row.symbol}.NS`
          }));
        }
      } catch (e) {
        console.warn('⚠️ [CloudSync] Portfolio load error:', e?.message || e);
      }
      return null;
    }
  };

  window.MOMENTUM_SUPABASE = MOMENTUM_SUPABASE;
  window.MomentumAuth = MOMENTUM_SUPABASE;
  window.MomentumCloudSync = MomentumCloudSync;
})();
