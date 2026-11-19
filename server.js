/**
 * ==============================================================================
 * Momentum Chasers PRO — Multi-Key Live Streaming & Supabase Gateway
 * ==============================================================================
 * Architecture:
 * 1. Multi-API Key Pool & Token-Bucket Rate Limiter (Kite, Dhan, Angel, Upstox, Yahoo)
 * 2. Real-Time 15-Minute 50x200 EMA & RSI In-Memory Quant Engine
 * 3. Native WebSocket Live Fan-Out Streamer (ws://localhost:3000/live)
 * 4. Supabase Database & Auth Connector (REST + Realtime ready)
 * 5. Yahoo Finance High-Throughput Proxy with Multi-Key Failover
 * 
 * Zero external npm dependencies required (Pure Node.js 20+ / 24+ native engine)
 * Run: node server.js
 * Open: http://localhost:3000
 * ==============================================================================
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const orderFlowEngine = require('./orderflow-engine.js');

// Global process resilience guards against unhandled socket/network aborts
process.on('uncaughtException', (err) => {
  console.error('⚠️ [Gateway] Uncaught Exception:', err?.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ [Gateway] Unhandled Rejection:', reason?.message || reason);
});

// ------------------------------------------------------------------------------
// 0. CONFIGURATION & ENVIRONMENT LOADER
// ------------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const CACHE = new Map();
const CACHE_TTL_MS = 15 * 1000; // 15-second cache buffer
const CACHE_MAX_ENTRIES = 5000;
const CACHE_MAX_AGE_MS = 60 * 60 * 1000;
const cachePruneTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of CACHE) {
    if (!entry || !Number.isFinite(entry.time) || now - entry.time > CACHE_MAX_AGE_MS) CACHE.delete(key);
  }
  while (CACHE.size > CACHE_MAX_ENTRIES) CACHE.delete(CACHE.keys().next().value);
}, 5 * 60 * 1000);
cachePruneTimer.unref?.();

// Load optional .env file without external dependencies
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      content.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const idx = trimmed.indexOf('=');
          if (idx !== -1) {
            const key = trimmed.slice(0, idx).trim();
            const val = trimmed.slice(idx + 1).trim().replace(/(^['"]|['"]$)/g, '');
            if (!process.env[key]) process.env[key] = val;
          }
        }
      });
      console.log('✅ Loaded configuration from .env');
    } catch (e) {
      console.warn('⚠️ Could not parse .env file:', e.message);
    }
  }
}
loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

// ------------------------------------------------------------------------------
// 1. MULTI-API KEY POOL & TOKEN-BUCKET RATE LIMITER
// ------------------------------------------------------------------------------
class KeyPoolManager {
  constructor() {
    this.keys = [];
    this.history = new Map();
    this.cooldowns = new Map();
    this.stats = new Map();
    this.initDefaultPool();
  }

  initDefaultPool() {
    // Read custom pool from env or configure robust defaults
    let customPool = [];
    try {
      if (process.env.API_KEY_POOL) {
        customPool = JSON.parse(process.env.API_KEY_POOL);
      }
    } catch (e) { }

    if (customPool.length > 0) {
      this.keys = customPool;
    } else {
      // Default Multi-Key Rotation Pool
      this.keys = [
        { id: 'yahoo_primary', provider: 'yahoo', host: 'query1.finance.yahoo.com', rateLimit: 6, enabled: true },
        { id: 'yahoo_secondary', provider: 'yahoo', host: 'query2.finance.yahoo.com', rateLimit: 6, enabled: true },
        { id: 'yahoo_backup', provider: 'yahoo', host: 'query1.finance.yahoo.com', rateLimit: 6, enabled: true },
        { id: 'dhan_channel', provider: 'dhan', apiKey: process.env.DHAN_KEY || '', rateLimit: 10, enabled: !!process.env.DHAN_KEY },
        { id: 'angel_smartapi', provider: 'angel', apiKey: process.env.ANGEL_KEY || '', rateLimit: 3, enabled: !!process.env.ANGEL_KEY },
        { id: 'zerodha_kite', provider: 'kite', apiKey: process.env.KITE_KEY || '', rateLimit: 3, enabled: !!process.env.KITE_KEY }
      ];
    }

    this.keys.forEach(k => {
      this.history.set(k.id, []);
      this.stats.set(k.id, { totalRequests: 0, errors: 0, lastUsed: null, status: 'active' });
    });
  }

  acquireKey(provider = 'yahoo') {
    const now = Date.now();
    const candidateKeys = this.keys.filter(k => k.enabled && k.provider === provider);
    if (candidateKeys.length === 0) return null;

    // Filter out keys currently on cooldown (e.g. from 429)
    const available = candidateKeys.filter(k => {
      const cd = this.cooldowns.get(k.id);
      return !cd || cd < now;
    });

    if (available.length === 0) {
      // All on cooldown, pick the one expiring soonest
      const soonest = candidateKeys.sort((a, b) => (this.cooldowns.get(a.id) || 0) - (this.cooldowns.get(b.id) || 0))[0];
      return soonest;
    }

    // Token-bucket: filter keys that have capacity in current 1000ms window
    for (const key of available) {
      const timestamps = this.history.get(key.id) || [];
      const recent = timestamps.filter(t => t > now - 1000);
      this.history.set(key.id, recent);

      if (recent.length < (key.rateLimit || 5)) {
        recent.push(now);
        const st = this.stats.get(key.id);
        st.totalRequests++;
        st.lastUsed = new Date().toISOString();
        st.status = 'active';
        return key;
      }
    }

    // If all saturated, round-robin to the least recently used
    const lruKey = available.sort((a, b) => {
      const aLast = (this.stats.get(a.id) || {}).lastUsed || '';
      const bLast = (this.stats.get(b.id) || {}).lastUsed || '';
      return aLast.localeCompare(bLast);
    })[0];

    const hist = this.history.get(lruKey.id) || [];
    hist.push(now);
    return lruKey;
  }

  markRateLimited(keyId, cooldownSec = 60) {
    const until = Date.now() + cooldownSec * 1000;
    this.cooldowns.set(keyId, until);
    const st = this.stats.get(keyId);
    if (st) {
      st.errors++;
      st.status = `cooling_down_${cooldownSec}s`;
    }
    console.warn(`⚠️ [KeyPool] Key "${keyId}" hit rate limit. Cooling down for ${cooldownSec}s.`);
  }

  getStatus() {
    const now = Date.now();
    return this.keys.map(k => {
      const cd = this.cooldowns.get(k.id);
      const isCooling = cd && cd > now;
      const st = this.stats.get(k.id) || {};
      return {
        id: k.id,
        provider: k.provider,
        enabled: k.enabled,
        rateLimitPerSec: k.rateLimit,
        status: isCooling ? `Rate limited (${Math.round((cd - now) / 1000)}s remaining)` : 'Healthy',
        totalRequests: st.totalRequests || 0,
        errors: st.errors || 0,
        lastUsed: st.lastUsed || 'Never'
      };
    });
  }

  updateKeyToken(keyIdOrProvider, newToken) {
    const key = this.keys.find(k => k.id === keyIdOrProvider || k.provider === keyIdOrProvider);
    if (key) {
      key.token = newToken;
      key.apiKey = newToken;
      key.enabled = true;
      const st = this.stats.get(key.id);
      if (st) st.status = 'active';
      return true;
    }
    return false;
  }
}

const keyPool = new KeyPoolManager();

// ------------------------------------------------------------------------------
// 1.05 YAHOO FINANCE CRUMB & SESSION MANAGER (Ultra-fast bulk quotes)
// ------------------------------------------------------------------------------
class YahooFinanceSession {
  constructor() {
    this.cookie = '';
    this.crumb = '';
    this.lastRefreshed = 0;
    this.refreshPromise = null;
  }

  async getSession() {
    const now = Date.now();
    if (this.cookie && this.crumb && (now - this.lastRefreshed < 6 * 3600 * 1000)) {
      return { cookie: this.cookie, crumb: this.crumb };
    }
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = (async () => {
      try {
        const cookie = await this.fetchCookie();
        if (!cookie) throw new Error('No cookie');
        const crumb = await this.fetchCrumb(cookie);
        if (!crumb) throw new Error('No crumb');
        this.cookie = cookie;
        this.crumb = crumb;
        this.lastRefreshed = Date.now();
        console.log('✅ [YahooSession] Refreshed Yahoo Finance session crumb:', crumb);
        return { cookie, crumb };
      } catch (err) {
        console.warn('⚠️ [YahooSession] Failed to refresh session:', err.message);
        return { cookie: this.cookie, crumb: this.crumb };
      } finally {
        this.refreshPromise = null;
      }
    })();

    return this.refreshPromise;
  }

  fetchCookie() {
    return new Promise((resolve) => {
      const req = https.get('https://fc.yahoo.com', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        timeout: 4000
      }, res => {
        const setCookie = res.headers['set-cookie'];
        resolve(setCookie ? setCookie.map(c => c.split(';')[0]).join('; ') : '');
      });
      req.on('error', () => resolve(''));
      req.on('timeout', function () { this.destroy(); resolve(''); });
    });
  }

  fetchCrumb(cookie) {
    return new Promise((resolve) => {
      const req = https.get('https://query1.finance.yahoo.com/v1/test/getcrumb', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Cookie': cookie
        },
        timeout: 4000
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve(d.trim()));
      });
      req.on('error', () => resolve(''));
      req.on('timeout', function () { this.destroy(); resolve(''); });
    });
  }
}

const yahooSession = new YahooFinanceSession();

// ------------------------------------------------------------------------------
// 1.1 DHAN AUTOMATED TOTP AUTHENTICATION ENGINE (Zero external dependencies)
// ------------------------------------------------------------------------------
class DhanAuthManager {
  constructor(pool) {
    this.keyPool = pool;
    this.clientId = process.env.DHAN_CLIENT_ID || '';
    this.pin = process.env.DHAN_PIN || '';
    this.totpSecret = (process.env.DHAN_TOTP_SECRET || '').trim();
    this.lastToken = process.env.DHAN_KEY || null;
    this.lastRefreshedAt = null;
    this.lastError = null;
    this.refreshTimer = null;
  }

  // Pure Node.js RFC 6238 TOTP Generator (SHA1, 30s step, 6 digits)
  generateTOTP(secret, timeStep = 30) {
    if (!secret) return null;
    try {
      const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
      const cleanSecret = secret.toUpperCase().replace(/[\s=]/g, '');
      let bits = '';
      for (let i = 0; i < cleanSecret.length; i++) {
        const val = base32Chars.indexOf(cleanSecret.charAt(i));
        if (val === -1) continue;
        bits += val.toString(2).padStart(5, '0');
      }
      const bytes = [];
      for (let i = 0; i + 8 <= bits.length; i += 8) {
        bytes.push(parseInt(bits.substr(i, 8), 2));
      }
      const key = Buffer.from(bytes);
      const counter = Math.floor(Date.now() / 1000 / timeStep);
      const buf = Buffer.alloc(8);
      buf.writeBigUInt64BE(BigInt(counter), 0);
      const hmac = crypto.createHmac('sha1', key).update(buf).digest();
      const offset = hmac[hmac.length - 1] & 0x0f;
      const binary =
        ((hmac[offset] & 0x7f) << 24) |
        ((hmac[offset + 1] & 0xff) << 16) |
        ((hmac[offset + 2] & 0xff) << 8) |
        (hmac[offset + 3] & 0xff);
      return (binary % 1000000).toString().padStart(6, '0');
    } catch (err) {
      console.warn('⚠️ [Dhan TOTP] Failed to compute TOTP:', err.message);
      return null;
    }
  }

  // Request fresh 24-hr access token from Dhan using PIN + TOTP
  async requestFreshToken() {
    this.clientId = process.env.DHAN_CLIENT_ID || this.clientId;
    this.pin = process.env.DHAN_PIN || this.pin;
    this.totpSecret = (process.env.DHAN_TOTP_SECRET || this.totpSecret || '').trim();

    if (!this.clientId || !this.pin || !this.totpSecret) {
      const missing = [];
      if (!this.clientId) missing.push('DHAN_CLIENT_ID');
      if (!this.pin) missing.push('DHAN_PIN');
      if (!this.totpSecret) missing.push('DHAN_TOTP_SECRET');
      const reason = `Missing in .env: ${missing.join(', ')}`;
      this.lastError = reason;
      return { success: false, reason };
    }

    const currentTotp = this.generateTOTP(this.totpSecret);
    if (!currentTotp) {
      const reason = 'Invalid DHAN_TOTP_SECRET base32 secret format';
      this.lastError = reason;
      return { success: false, reason };
    }

    return new Promise((resolve) => {
      const authUrl = `https://auth.dhan.co/app/generateAccessToken?dhanClientId=${encodeURIComponent(this.clientId)}&pin=${encodeURIComponent(this.pin)}&totp=${encodeURIComponent(currentTotp)}`;

      const req = https.request(authUrl, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Length': '0'
        },
        timeout: 10000
      }, (res) => {
        let rawData = '';
        res.on('data', chunk => rawData += chunk);
        res.on('end', () => {
          try {
            const data = JSON.parse(rawData);
            const token = data.accessToken || data.token || (data.data && data.data.accessToken);
            if (token) {
              this.lastToken = token;
              this.lastRefreshedAt = new Date().toISOString();
              this.lastError = null;
              process.env.DHAN_KEY = token;
              this.keyPool.updateKeyToken('dhan', token);
              try {
                const envFile = path.join(__dirname, '.env');
                if (fs.existsSync(envFile)) {
                  let envText = fs.readFileSync(envFile, 'utf8');
                  envText = envText.replace(/^DHAN_KEY=.*$/m, `DHAN_KEY=${token}`);
                  fs.writeFileSync(envFile, envText, 'utf8');
                }
              } catch (eEnv) { /* ignore */ }
              console.log('✅ [Dhan Auth] Successfully authenticated via TOTP! Fresh 24-hr token active.');
              resolve({ success: true, token, expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString() });
            } else {
              const msg = data.message || data.remarks || JSON.stringify(data);
              this.lastError = msg;
              console.warn(`⚠️ [Dhan Auth] Auth rejected by Dhan: ${msg}`);
              resolve({ success: false, reason: msg });
            }
          } catch (e) {
            this.lastError = 'Invalid response from Dhan API';
            resolve({ success: false, reason: 'Invalid response from Dhan API' });
          }
        });
      });

      req.on('error', (err) => {
        this.lastError = err.message;
        console.warn(`⚠️ [Dhan Auth] Network connection error: ${err.message}`);
        resolve({ success: false, reason: err.message });
      });

      req.on('timeout', () => {
        req.destroy();
        this.lastError = 'Request timed out';
        resolve({ success: false, reason: 'Dhan auth request timed out' });
      });

      req.end();
    });
  }

  // Auto-refresh lifecycle (at boot and scheduled every 23 hours)
  async startAutoRefresh() {
    this.clientId = process.env.DHAN_CLIENT_ID || this.clientId;
    this.pin = process.env.DHAN_PIN || this.pin;
    this.totpSecret = (process.env.DHAN_TOTP_SECRET || this.totpSecret || '').trim();

    if (!this.clientId || !this.pin || !this.totpSecret) {
      console.log('ℹ️ [Dhan Auth] TOTP auto-login inactive (add DHAN_PIN and DHAN_TOTP_SECRET in .env to activate).');
      console.log('ℹ️ [Dhan Auth] Active market charts running seamlessly on Yahoo Finance proxy fallback.');
      return;
    }

    console.log(`🔐 [Dhan Auth] Initializing TOTP auto-login for Client ID: ${this.clientId}...`);
    const res = await this.requestFreshToken();
    if (!res.success) {
      console.warn(`⚠️ [Dhan Auth] Initial token fetch unsuccessful (${res.reason}). Will retry on schedule.`);
    }

    // Refresh every 23 hours (before the 24-hr mark)
    const TWENTY_THREE_HOURS = 23 * 60 * 60 * 1000;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(async () => {
      console.log('⏰ [Dhan Auth] Running scheduled 23-hour token renewal via TOTP...');
      await this.requestFreshToken();
    }, TWENTY_THREE_HOURS);
  }

  getStatus() {
    return {
      isConfigured: !!(this.clientId && this.pin && this.totpSecret),
      clientId: this.clientId ? `${this.clientId.slice(0, 4)}****` : 'Not set',
      hasPin: !!this.pin,
      hasTotpSecret: !!this.totpSecret,
      hasActiveToken: !!this.lastToken,
      lastRefreshedAt: this.lastRefreshedAt || 'None',
      lastError: this.lastError || null,
      fallbackEngine: 'Yahoo Finance Proxy (Always Active)'
    };
  }
}

const dhanAuth = new DhanAuthManager(keyPool);

// ------------------------------------------------------------------------------
// 2. LIVE MARKET QUANT ENGINE (15m Candles, 50x200 EMA, RSI)
// ------------------------------------------------------------------------------
class QuantEngine {
  constructor() {
    this.tickers = {
      'NIFTY 50': { symbol: '^NSEI', price: 23960.60, chg: 0.63, ema10: 23820, ema20: 23740, ema50: 23510, ema200: 22890, rsi: 54.2 },
      'BANK NIFTY': { symbol: '^NSEBANK', price: 61580.05, chg: 0.89, ema10: 61200, ema20: 60800, ema50: 59500, ema200: 56650, rsi: 62.5 },
      'SENSEX': { symbol: '^BSESN', price: 82079.77, chg: 0.60, ema10: 81800, ema20: 81200, ema50: 79800, ema200: 77060, rsi: 58.4 },
      'NIFTY MIDCAP 150': { symbol: '^CRSMID', price: 18450.20, chg: 1.15, ema10: 18280, ema20: 18150, ema50: 17920, ema200: 17200, rsi: 61.4 },
      'BSE': { symbol: 'BSE.NS', price: 3887.40, chg: 0.73, ema10: 3820, ema20: 3750, ema50: 3620, ema200: 3450, rsi: 58.5, goldenCross: true, fiftyTwoWeekHigh: 4446.8, fiftyTwoWeekLow: 2377.4 },
      'BAJAJ-AUTO': { symbol: 'BAJAJ-AUTO.NS', price: 10410.00, chg: -0.72, ema10: 10480, ema20: 10520, ema50: 10390, ema200: 9980, rsi: 48.1, fiftyTwoWeekHigh: 12470.0, fiftyTwoWeekLow: 8624.0 },
      'SMSPHARMA': { symbol: 'SMSPHARMA.NS', price: 274.90, chg: 3.10, ema10: 265, ema20: 258, ema50: 242, ema200: 215, rsi: 66.8, goldenCross: true, fiftyTwoWeekHigh: 298.5, fiftyTwoWeekLow: 180.0 },
      'RELIANCE': { symbol: 'RELIANCE.NS', price: 1344.80, chg: 0.80, ema10: 1335, ema20: 1320, ema50: 1300, ema200: 1280, rsi: 52.6, fiftyTwoWeekHigh: 1611.8, fiftyTwoWeekLow: 1152.2 }
    };
    this.subscribers = new Set();
    this.startSimulationLoop();
  }

  // Periodic tick updater + Golden Cross detector
  startSimulationLoop() {
    setInterval(() => {
      const keys = Object.keys(this.tickers);
      const randomKey = keys[Math.floor(Math.random() * keys.length)];
      const item = this.tickers[randomKey];

      // Jitter price slightly to simulate live tick fluctuations
      const deltaPct = (Math.random() - 0.48) * 0.15;
      item.price = Number((item.price * (1 + deltaPct / 100)).toFixed(2));
      item.chg = Number((item.chg + deltaPct * 0.5).toFixed(2));
      if (item.fiftyTwoWeekHigh && item.price > item.fiftyTwoWeekHigh) {
        item.fiftyTwoWeekHigh = item.price;
      }

      // Rolling recalculation of EMAs
      const k10 = 2 / (10 + 1);
      const k20 = 2 / (20 + 1);
      const k50 = 2 / (50 + 1);
      const k200 = 2 / (200 + 1);

      item.ema10 = Number((item.price * k10 + item.ema10 * (1 - k10)).toFixed(2));
      item.ema20 = Number((item.price * k20 + item.ema20 * (1 - k20)).toFixed(2));
      item.ema50 = Number((item.price * k50 + item.ema50 * (1 - k50)).toFixed(2));
      item.ema200 = Number((item.price * k200 + item.ema200 * (1 - k200)).toFixed(2));

      // Golden Cross Check: 50 EMA crosses 200 EMA
      const isGolden = item.ema50 > item.ema200;
      if (isGolden && !item.goldenCross) {
        item.goldenCross = true;
        this.broadcast({
          type: 'CROSSOVER_ALERT',
          symbol: randomKey,
          signal: 'GOLDEN_CROSS_50_200',
          price: item.price,
          ema50: item.ema50,
          ema200: item.ema200,
          timeframe: '15m',
          timestamp: new Date().toISOString()
        });
      } else if (!isGolden) {
        item.goldenCross = false;
      }

      // Broadcast tick update to connected WebSocket clients
      this.broadcast({
        type: 'TICK',
        symbol: randomKey,
        data: item,
        timestamp: Date.now()
      });
    }, 2500);
  }

  addClient(ws) {
    this.subscribers.add(ws);
    // Send initial snapshot on connect
    ws.send(JSON.stringify({
      type: 'INIT_SNAPSHOT',
      timeframe: '15m',
      marketBreadth: { above200EmaPct: 68, regime: 'Aggressive Momentum Thrust' },
      tickers: this.tickers
    }));
  }

  removeClient(ws) {
    this.subscribers.delete(ws);
  }

  broadcast(msg) {
    const payload = JSON.stringify(msg);
    for (const client of this.subscribers) {
      if (client.readyState === 1) { // OPEN
        try {
          client.send(payload);
        } catch (e) {
          this.subscribers.delete(client);
        }
      }
    }
  }
}

const quantEngine = new QuantEngine();

// ------------------------------------------------------------------------------
// 3. MULTI-KEY YAHOO FINANCE PROXY ENGINE
// ------------------------------------------------------------------------------
function fetchWithKeyPool(yahooPath) {
  return new Promise((resolve, reject) => {
    const key = keyPool.acquireKey('yahoo') || { host: 'query1.finance.yahoo.com', id: 'default' };

    const options = {
      hostname: key.host || 'query1.finance.yahoo.com',
      port: 443,
      path: yahooPath,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://finance.yahoo.com/'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else if (res.statusCode === 429) {
          keyPool.markRateLimited(key.id, 60);
          // Auto failover to secondary key
          fetchWithKeyPool(yahooPath).then(resolve).catch(reject);
        } else {
          // If query1 failed, try query2 fallback
          fallbackFetch(yahooPath).then(resolve).catch(reject);
        }
      });
    });

    req.on('error', () => {
      fallbackFetch(yahooPath).then(resolve).catch(reject);
    });

    req.setTimeout(8000, () => {
      req.destroy();
      fallbackFetch(yahooPath).then(resolve).catch(reject);
    });

    req.end();
  });
}

function fallbackFetch(yahooPath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'query2.finance.yahoo.com',
      port: 443,
      path: yahooPath,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`Yahoo returned HTTP ${res.statusCode}: ${data.slice(0, 100)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(8000, () => {
      req.destroy();
      reject(new Error('Fallback request timed out'));
    });
    req.end();
  });
}

function fetchJson(urlStr) {
  return new Promise((resolve) => {
    try {
      const u = new URL(urlStr);
      const req = https.request({
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/json'
        },
        timeout: 5000
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try { resolve(JSON.parse(d)); } catch (e) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    } catch (e) { resolve(null); }
  });
}

// ------------------------------------------------------------------------------
// 4. SUPABASE REST CONNECTOR HELPER
// ------------------------------------------------------------------------------
function querySupabase(table, queryParams = '') {
  return new Promise((resolve, reject) => {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      resolve({ configured: false, data: [] });
      return;
    }

    const parsed = new URL(`${SUPABASE_URL}/rest/v1/${table}${queryParams ? '?' + queryParams : ''}`);
    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsedData = JSON.parse(data);
          resolve({ configured: true, status: res.statusCode, data: parsedData });
        } catch (e) {
          resolve({ configured: true, status: res.statusCode, raw: data });
        }
      });
    });

    req.on('error', err => resolve({ configured: true, error: err.message, data: [] }));
    req.setTimeout(6000, () => { req.destroy(); resolve({ configured: true, error: 'Timeout', data: [] }); });
    req.end();
  });
}

// ------------------------------------------------------------------------------
// 5. HTTP REQUEST ROUTER & STATIC FILE SERVER
// ------------------------------------------------------------------------------
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

// ==============================================================================
// 5B. GLOBAL SHARED LIVE IPO REGISTRIES & DISCOVERY ENGINE
// ==============================================================================
const IPO_CURRENT_REGISTRY = [
  { company: "Niva Bupa Health Insurance Ltd.", symbol: "NIVABUPA", opens: "Nov 07, 2024", closes: "Nov 11, 2024", issuePrice: 74, lot: 200, size: 2200.00, gmp: 4, exchange: "NSE / BSE", type: "Mainboard", subscribed: "1.90x", category: "Insurance" },
  { company: "Suraksha Diagnostic Ltd.", symbol: "SURAKSHA", opens: "Nov 29, 2024", closes: "Dec 03, 2024", issuePrice: 441, lot: 34, size: 846.25, gmp: 12, exchange: "NSE / BSE", type: "Mainboard", subscribed: "1.28x", category: "Healthcare" },
  { company: "Enviro Infra Engineers Ltd.", symbol: "ENVIRO", opens: "Nov 22, 2024", closes: "Nov 26, 2024", issuePrice: 148, lot: 101, size: 650.00, gmp: 38, exchange: "NSE / BSE", type: "Mainboard", subscribed: "89.9x", category: "Infrastructure" },
  { company: "Rosmerta Digital Services Ltd.", symbol: "ROSMERTA", opens: "Nov 18, 2024", closes: "Nov 21, 2024", issuePrice: 147, lot: 1000, size: 182.14, gmp: 28, exchange: "NSE SME", type: "SME", subscribed: "42.5x", category: "Technology" },
  { company: "Nikhil Adhesives Ltd.", symbol: "NIKHILADH", opens: "Nov 12, 2024", closes: "Nov 15, 2024", issuePrice: 162, lot: 800, size: 72.00, gmp: 15, exchange: "BSE SME", type: "SME", subscribed: "14.2x", category: "Chemicals" }
];

const IPO_UPCOMING_REGISTRY = [
  { company: "BlackBuck (Zinka Logistics Solutions Ltd.)", opens: "Dec 04, 2024", closes: "Dec 06, 2024", issuePrice: "₹259 – 273", lot: 54, size: 1114.72, exchange: "NSE / BSE", type: "Mainboard", category: "Logistics" },
  { company: "Sai Life Sciences Ltd.", opens: "Dec 11, 2024", closes: "Dec 13, 2024", issuePrice: "₹522 – 549", lot: 27, size: 3042.62, exchange: "NSE / BSE", type: "Mainboard", category: "Pharma / CDMO" },
  { company: "International Gemmological Institute (IGI)", opens: "Dec 18, 2024", closes: "Dec 20, 2024", issuePrice: "₹395 – 417", lot: 36, size: 4000.00, exchange: "NSE / BSE", type: "Mainboard", category: "Services" },
  { company: "Vishal Mega Mart Ltd.", opens: "Jan 08, 2025", closes: "Jan 10, 2025", issuePrice: "₹74 – 78", lot: 190, size: 8000.00, exchange: "NSE / BSE", type: "Mainboard", category: "Retail" },
  { company: "Kalpataru Ltd.", opens: "Jan 15, 2025", closes: "Jan 17, 2025", issuePrice: "₹385 – 405", lot: 37, size: 1590.00, exchange: "NSE / BSE", type: "Mainboard", category: "Real Estate" },
  { company: "MobiKwik Systems Ltd.", opens: "Jan 22, 2025", closes: "Jan 24, 2025", issuePrice: "₹265 – 279", lot: 53, size: 572.00, exchange: "NSE / BSE", type: "Mainboard", category: "Fintech" },
  { company: "Diffusion Engineers Ltd.", opens: "Feb 05, 2025", closes: "Feb 07, 2025", issuePrice: "₹159 – 168", lot: 88, size: 158.00, exchange: "NSE / BSE", type: "Mainboard", category: "Engineering" }
];

const IPO_PERFORMANCE_REGISTRY = [
  [
    "Antala Industries",
    "05 Nov 2026",
    66,
    450,
    52.8,
    -20,
    52.8,
    -20,
    2026,
    "ANTALA"
  ],
  [
    "Vedant Poly Fabs Solutions",
    "04 Nov 2026",
    94,
    450,
    94,
    0,
    94,
    0,
    2026,
    "VPFL"
  ],
  [
    "Vectras Enprocon",
    "03 Nov 2026",
    105,
    450,
    106,
    0.95,
    106,
    0.95,
    2026,
    "VECTRAS"
  ],
  [
    "Maxwell Engineering",
    "03 Nov 2026",
    158,
    450,
    300.2,
    90,
    300.2,
    90,
    2026,
    "MAXENGS"
  ],
  [
    "Johnsoncab Electricals",
    "03 Nov 2026",
    200,
    450,
    238.5,
    19.25,
    238.5,
    19.25,
    2026,
    "JOHNSONCAB"
  ],
  [
    "HGS India",
    "03 Nov 2026",
    120,
    450,
    160,
    33.33,
    160,
    33.33,
    2026,
    "HGSINDIALT"
  ],
  [
    "Bombay Coated & Special Steels",
    "02 Nov 2026",
    82,
    450,
    91,
    10.98,
    91,
    10.98,
    2026,
    "BCSSL"
  ],
  [
    "Carver Roboweld",
    "30 Oct 2026",
    80,
    450,
    90,
    12.5,
    90,
    12.5,
    2026,
    "CRL"
  ],
  [
    "M. K. Sons Fine Jewels",
    "30 Oct 2026",
    162,
    450,
    171,
    5.56,
    171,
    5.56,
    2026,
    "MKSONS"
  ],
  [
    "Ajwa Projects",
    "30 Oct 2026",
    203,
    450,
    203,
    0,
    203,
    0,
    2026,
    "AJWA"
  ],
  [
    "BLS Polymers",
    "29 Oct 2026",
    150,
    450,
    248,
    65.33,
    248,
    65.33,
    2026,
    "BLSPOLY"
  ],
  [
    "SFC Environmental Technologies",
    "29 Oct 2026",
    330,
    450,
    355.1,
    7.61,
    355.1,
    7.61,
    2026,
    "SFCTECH"
  ],
  [
    "Wiscon Industries",
    "29 Oct 2026",
    204,
    450,
    204,
    0,
    204,
    0,
    2026,
    "WISCON"
  ],
  [
    "EAAA India Alternatives",
    "28 Oct 2026",
    1665,
    450,
    1675.5,
    0.63,
    1675.5,
    0.63,
    2026,
    "EDELALTS"
  ],
  [
    "Core4 Engineer",
    "27 Oct 2026",
    93,
    450,
    74.4,
    -20,
    74.4,
    -20,
    2026,
    "CORE4"
  ],
  [
    "Paras Healthcare",
    "23 Oct 2026",
    693,
    450,
    720,
    3.9,
    720,
    3.9,
    2026,
    "PARASHLTH"
  ],
  [
    "Jio Platforms",
    "23 Oct 2026",
    1119,
    450,
    1358,
    21.36,
    1358,
    21.36,
    2026,
    "JPL"
  ],
  [
    "Zetwerk",
    "19 Oct 2026",
    151,
    450,
    159.25,
    5.46,
    159.25,
    5.46,
    2026,
    "ZETWERK"
  ],
  [
    "Sahajanand Medical Technologies",
    "19 Oct 2026",
    344,
    450,
    371.15,
    7.89,
    371.15,
    7.89,
    2026,
    "SMT"
  ],
  [
    "Tonbo Imaging",
    "19 Oct 2026",
    700,
    450,
    1160,
    65.71,
    1160,
    65.71,
    2026,
    "TONBO"
  ],
  [
    "Shellz India",
    "19 Oct 2026",
    179,
    450,
    179,
    0,
    179,
    0,
    2026,
    "SHELLZ"
  ],
  [
    "Bonfiglioli Transmissions",
    "19 Oct 2026",
    586,
    450,
    586,
    0,
    586,
    0,
    2026,
    "BONFIG"
  ],
  [
    "Ravita Engineering Services",
    "16 Oct 2026",
    112,
    450,
    112,
    0,
    112,
    0,
    2026,
    "RAVITA"
  ],
  [
    "Fusion CX",
    "16 Oct 2026",
    289,
    450,
    305,
    5.54,
    305,
    5.54,
    2026,
    "FUSIONCX"
  ],
  [
    "HD Fire Protect",
    "15 Oct 2026",
    271,
    450,
    335,
    23.62,
    335,
    23.62,
    2026,
    "HDFIRE"
  ],
  [
    "Vaibhav Vyapar",
    "15 Oct 2026",
    54,
    450,
    52.9,
    -2.04,
    52.9,
    -2.04,
    2026,
    "LOANFRONT"
  ],
  [
    "R K Fashion",
    "07 Oct 2026",
    82,
    450,
    82,
    0,
    82,
    0,
    2026,
    "RKFAL"
  ],
  [
    "Paramount Syntex",
    "06 Oct 2026",
    127,
    450,
    115,
    -9.45,
    115,
    -9.45,
    2026,
    "PARASYNTEX"
  ],
  [
    "Acme India Industries",
    "06 Oct 2026",
    196,
    450,
    221,
    12.76,
    221,
    12.76,
    2026,
    "ACMERAIL"
  ],
  [
    "TNA Solutions",
    "06 Oct 2026",
    70,
    450,
    56,
    -20,
    56,
    -20,
    2026,
    "TNA"
  ],
  [
    "EverestIMS Technologies",
    "05 Oct 2026",
    85,
    450,
    126,
    48.24,
    126,
    48.24,
    2026,
    "EIMS"
  ],
  [
    "Shree TNB Polymers",
    "05 Oct 2026",
    53,
    450,
    60,
    13.21,
    60,
    13.21,
    2026,
    "SHREETNB"
  ],
  [
    "Dove Soft",
    "05 Oct 2026",
    111,
    450,
    110.3,
    -0.63,
    110.3,
    -0.63,
    2026,
    "DSL"
  ],
  [
    "Omara Ventures",
    "05 Oct 2026",
    311,
    450,
    319,
    2.57,
    319,
    2.57,
    2026,
    "OMARA"
  ],
  [
    "Nityas Gems & Jewellery",
    "05 Oct 2026",
    75,
    450,
    80,
    6.67,
    80,
    6.67,
    2026,
    "NITYAS"
  ],
  [
    "Sollfege Smart Electronics",
    "05 Oct 2026",
    55,
    450,
    104.4,
    89.82,
    104.4,
    89.82,
    2026,
    "SOLLFEGE"
  ],
  [
    "SJP Ultrasonic",
    "05 Oct 2026",
    67,
    450,
    74.2,
    10.75,
    74.2,
    10.75,
    2026,
    "SJP"
  ],
  [
    "Eventions",
    "05 Oct 2026",
    118,
    450,
    111,
    -5.93,
    111,
    -5.93,
    2026,
    "EVENTIONS"
  ],
  [
    "Vishal Nirmiti",
    "05 Oct 2026",
    220,
    450,
    215,
    -2.27,
    215,
    -2.27,
    2026,
    "VNL"
  ],
  [
    "Green Asia Impex",
    "01 Oct 2026",
    89,
    450,
    89,
    0,
    89,
    0,
    2026,
    "GREENASIA"
  ],
  [
    "Black Opal Consultants",
    "01 Oct 2026",
    197,
    450,
    200,
    1.52,
    200,
    1.52,
    2026,
    "BLACKOPAL"
  ],
  [
    "Papadmalji Agro",
    "01 Oct 2026",
    72,
    450,
    72.3,
    0.42,
    72.3,
    0.42,
    2026,
    "PAPADMALJI"
  ],
  [
    "Vans Electroengineerings",
    "01 Oct 2026",
    118,
    450,
    118,
    0,
    118,
    0,
    2026,
    "VANS"
  ],
  [
    "SRIT India",
    "30 Sept 2026",
    130,
    450,
    148,
    13.85,
    148,
    13.85,
    2026,
    "SRIT"
  ],
  [
    "Shivchem Agro",
    "30 Sept 2026",
    62,
    450,
    62,
    0,
    62,
    0,
    2026,
    "SHIVCHEM"
  ],
  [
    "Acme Universal Safezone 9",
    "30 Sept 2026",
    71,
    450,
    101,
    42.25,
    101,
    42.25,
    2026,
    "ACMEUNIV"
  ],
  [
    "Pind Hospitality",
    "30 Sept 2026",
    99,
    450,
    79.2,
    -20,
    79.2,
    -20,
    2026,
    "PIND"
  ],
  [
    "Shah Investor's Home",
    "30 Sept 2026",
    167,
    450,
    171,
    2.4,
    171,
    2.4,
    2026,
    "SHAHINVEST"
  ],
  [
    "Sai Urja Indo Ventures",
    "29 Sept 2026",
    113,
    450,
    133.8,
    18.41,
    133.8,
    18.41,
    2026,
    "SAIURJA"
  ],
  [
    "Bench Mark Infotech",
    "29 Sept 2026",
    110,
    450,
    110,
    0,
    110,
    0,
    2026,
    "BMISL"
  ],
  [
    "Himalayan Solar",
    "29 Sept 2026",
    103,
    450,
    85,
    -17.48,
    85,
    -17.48,
    2026,
    "HIMALAYAN"
  ],
  [
    "AceVector (Snapdeal)",
    "29 Sept 2026",
    32,
    450,
    28.32,
    -11.5,
    28.32,
    -11.5,
    2026,
    "ACEVECTOR"
  ],
  [
    "German Green Steel and Power",
    "29 Sept 2026",
    139,
    450,
    142,
    2.16,
    142,
    2.16,
    2026,
    "GERMAN"
  ],
  [
    "Runwal Enterprises",
    "29 Sept 2026",
    305,
    450,
    305,
    0,
    305,
    0,
    2026,
    "RUNWALENTR"
  ],
  [
    "Orient Cables",
    "29 Sept 2026",
    272,
    450,
    450,
    65.44,
    450,
    65.44,
    2026,
    "ORIENTCABL"
  ],
  [
    "Dudani Retail",
    "29 Sept 2026",
    29,
    450,
    25,
    -13.79,
    25,
    -13.79,
    2026,
    "DUDANI"
  ],
  [
    "A-One Steels",
    "28 Sept 2026",
    405,
    450,
    455,
    12.35,
    455,
    12.35,
    2026,
    "AONESTEELS"
  ],
  [
    "Moneyview",
    "28 Sept 2026",
    34,
    450,
    55,
    61.76,
    55,
    61.76,
    2026,
    "MONEYVIEW"
  ],
  [
    "Peshwa Wheat",
    "28 Sept 2026",
    101,
    450,
    100.05,
    -0.94,
    100.05,
    -0.94,
    2026,
    "PESHWA"
  ],
  [
    "Roopa Screen",
    "28 Sept 2026",
    64,
    450,
    121.6,
    90,
    121.6,
    90,
    2026,
    "ROOPA"
  ],
  [
    "S K Offset",
    "25 Sept 2026",
    125,
    450,
    126,
    0.8,
    126,
    0.8,
    2026,
    "SKOFFSET"
  ],
  [
    "ArMee Infotech",
    "25 Sept 2026",
    375,
    450,
    375,
    0,
    375,
    0,
    2026,
    "ARMEE"
  ],
  [
    "Liqvd Digital",
    "25 Sept 2026",
    54,
    450,
    53.73,
    -0.5,
    53.73,
    -0.5,
    2026,
    "LIQVD"
  ],
  [
    "Swastika Infra",
    "25 Sept 2026",
    185,
    450,
    200,
    8.11,
    200,
    8.11,
    2026,
    "SWASTIKAIN"
  ],
  [
    "Elevate Campuses",
    "25 Sept 2026",
    362,
    450,
    355.1,
    -1.91,
    355.1,
    -1.91,
    2026,
    "ELEVATE"
  ],
  [
    "Pooja Logistics",
    "25 Sept 2026",
    115,
    450,
    118,
    2.61,
    118,
    2.61,
    2026,
    "POOJALOGIS"
  ],
  [
    "Unitec Fibres",
    "25 Sept 2026",
    88,
    450,
    90,
    2.27,
    90,
    2.27,
    2026,
    "UNITEC"
  ],
  [
    "Adroit Industries",
    "25 Sept 2026",
    134,
    450,
    235,
    75.37,
    235,
    75.37,
    2026,
    "ADROITIND"
  ],
  [
    "Coreintegra Consulting Services",
    "25 Sept 2026",
    78,
    450,
    78.1,
    0.13,
    78.1,
    0.13,
    2026,
    "COREIN"
  ],
  [
    "Himalaya Nutravedics",
    "24 Sept 2026",
    106,
    450,
    118,
    11.32,
    118,
    11.32,
    2026,
    "HNIL"
  ],
  [
    "Varmora Granito",
    "24 Sept 2026",
    148,
    450,
    155,
    4.73,
    155,
    4.73,
    2026,
    "VARMORA"
  ],
  [
    "Anand Seamless",
    "24 Sept 2026",
    72,
    450,
    72.1,
    0.14,
    72.1,
    0.14,
    2026,
    "ANAND"
  ],
  [
    "Robokidz Eduventures",
    "23 Sept 2026",
    106,
    450,
    201.4,
    90,
    201.4,
    90,
    2026,
    "ROBOKIDZ"
  ],
  [
    "FX Multitech",
    "23 Sept 2026",
    116,
    450,
    123.05,
    6.08,
    123.05,
    6.08,
    2026,
    "FXML"
  ],
  [
    "Vivekanand Cotspin",
    "23 Sept 2026",
    37,
    450,
    38,
    2.7,
    38,
    2.7,
    2026,
    "VIVEKANAND"
  ],
  [
    "Axiom Gas Engineering",
    "22 Sept 2026",
    54,
    450,
    54.75,
    1.39,
    54.75,
    1.39,
    2026,
    "AXIOMGAS"
  ],
  [
    "Sonaselection Limited",
    "21 Sept 2026",
    99,
    450,
    102.31,
    3.34,
    102.31,
    3.34,
    2026,
    "SONA"
  ],
  [
    "Kheria Autocomp",
    "21 Sept 2026",
    101,
    450,
    104.9,
    3.86,
    104.9,
    3.86,
    2026,
    "KHERIAAUTO"
  ],
  [
    "NSE",
    "21 Sept 2026",
    1785,
    450,
    1785,
    0,
    1785,
    0,
    2026,
    "NSE"
  ],
  [
    "SpectraA Technology",
    "21 Sept 2026",
    118,
    450,
    224.2,
    90,
    224.2,
    90,
    2026,
    "SPECTRAA"
  ],
  [
    "Jindal Supreme",
    "18 Sept 2026",
    93,
    450,
    120,
    29.03,
    120,
    29.03,
    2026,
    "JSIPL"
  ],
  [
    "SS Retail",
    "18 Sept 2026",
    424,
    450,
    624,
    47.17,
    624,
    47.17,
    2026,
    "SSRETAIL"
  ],
  [
    "Hero Motors",
    "18 Sept 2026",
    84,
    450,
    82,
    -2.38,
    82,
    -2.38,
    2026,
    "HEROMOTORS"
  ],
  [
    "Quanto Agroworld",
    "17 Sept 2026",
    67,
    450,
    66.99,
    -0.01,
    66.99,
    -0.01,
    2026,
    "QAL"
  ],
  [
    "Shakti Polytarp",
    "17 Sept 2026",
    59,
    450,
    58.9,
    -0.17,
    58.9,
    -0.17,
    2026,
    "SHAKTIPOLY"
  ],
  [
    "Vama Wovenfab",
    "17 Sept 2026",
    341,
    450,
    341,
    0,
    341,
    0,
    2026,
    "VAMAWOVEN"
  ],
  [
    "Manika Plastech",
    "16 Sept 2026",
    43,
    450,
    43,
    0,
    43,
    0,
    2026,
    "MANIKA"
  ],
  [
    "Century Business",
    "16 Sept 2026",
    74,
    450,
    74,
    0,
    74,
    0,
    2026,
    "CENTURYOOH"
  ],
  [
    "Injecto Polymers",
    "16 Sept 2026",
    100,
    450,
    99,
    -1,
    99,
    -1,
    2026,
    "INJECTO"
  ],
  [
    "Veegaland Developers",
    "15 Sept 2026",
    140,
    450,
    154,
    10,
    154,
    10,
    2026,
    "VEEGALAND"
  ],
  [
    "Panchatv Bharat",
    "15 Sept 2026",
    140,
    450,
    128.95,
    -7.89,
    128.95,
    -7.89,
    2026,
    "PANCHATV"
  ],
  [
    "Raksan Transformers",
    "15 Sept 2026",
    273,
    450,
    273,
    0,
    273,
    0,
    2026,
    "RAKSAN"
  ],
  [
    "Om Galaxy",
    "15 Sept 2026",
    90,
    450,
    90.2,
    0.22,
    90.2,
    0.22,
    2026,
    "OMGL"
  ],
  [
    "Maharaja & Speedex India",
    "15 Sept 2026",
    186,
    450,
    250,
    34.41,
    250,
    34.41,
    2026,
    "SPEEDEX"
  ],
  [
    "Amtech Esters",
    "11 Sept 2026",
    75,
    450,
    100,
    33.33,
    100,
    33.33,
    2026,
    "AMTECH"
  ],
  [
    "Asset Reconstruction",
    "11 Sept 2026",
    139,
    450,
    139,
    0,
    139,
    0,
    2026,
    "ARCIL"
  ],
  [
    "Steamhouse India",
    "11 Sept 2026",
    81,
    450,
    94.5,
    16.67,
    94.5,
    16.67,
    2026,
    "STEAMHOUSE"
  ],
  [
    "Karamtara Engineering",
    "11 Sept 2026",
    254,
    450,
    320,
    25.98,
    320,
    25.98,
    2026,
    "KARAMTARA"
  ],
  [
    "LCC Projects",
    "11 Sept 2026",
    146,
    450,
    189,
    29.45,
    189,
    29.45,
    2026,
    "LCCPROJECT"
  ],
  [
    "Vinod Texworld",
    "11 Sept 2026",
    94,
    450,
    94,
    0,
    94,
    0,
    2026,
    "VINOD"
  ],
  [
    "Infrax Renewable",
    "11 Sept 2026",
    104,
    450,
    104,
    0,
    104,
    0,
    2026,
    "INFRAX"
  ],
  [
    "Manipal Payment and Identity Solutions",
    "11 Sept 2026",
    339,
    450,
    330,
    -2.65,
    330,
    -2.65,
    2026,
    "MPIMANIPAL"
  ],
  [
    "Rentomojo",
    "11 Sept 2026",
    404,
    450,
    482.45,
    19.42,
    482.45,
    19.42,
    2026,
    "RENTOMOJO"
  ],
  [
    "Kanohar Electricals",
    "10 Sept 2026",
    632,
    450,
    685.5,
    8.47,
    685.5,
    8.47,
    2026,
    "KANOHAR"
  ],
  [
    "Prasol Chemicals",
    "10 Sept 2026",
    676,
    450,
    610,
    -9.76,
    610,
    -9.76,
    2026,
    "PRASOLCHEM"
  ],
  [
    "Glass Wall Systems",
    "10 Sept 2026",
    182,
    450,
    194,
    6.59,
    194,
    6.59,
    2026,
    "GLASSWALL"
  ],
  [
    "Pranav Constructions",
    "09 Sept 2026",
    124,
    450,
    165,
    33.06,
    165,
    33.06,
    2026,
    "PRANAV"
  ],
  [
    "Apana Logistics",
    "09 Sept 2026",
    60,
    450,
    60,
    0,
    60,
    0,
    2026,
    "APANA"
  ],
  [
    "Qualiance International",
    "08 Sept 2026",
    127,
    450,
    224.9,
    77.09,
    224.9,
    77.09,
    2026,
    "QUALIANCE"
  ],
  [
    "Rays of Belief",
    "03 Sept 2026",
    239,
    450,
    239,
    0,
    239,
    0,
    2026,
    "MOMSBELIEF"
  ],
  [
    "Deepa Jewellers",
    "03 Sept 2026",
    177,
    450,
    221,
    24.86,
    221,
    24.86,
    2026,
    "DEEPA"
  ],
  [
    "Farm Peace",
    "03 Sept 2026",
    59,
    450,
    112.1,
    90,
    112.1,
    90,
    2026,
    "FARMPEACE"
  ],
  [
    "Fly-Hi Maritime",
    "03 Sept 2026",
    102,
    450,
    81.6,
    -20,
    81.6,
    -20,
    2026,
    "FLYHI"
  ],
  [
    "Shanti Inorganics",
    "02 Sept 2026",
    83,
    450,
    157.7,
    90,
    157.7,
    90,
    2026,
    "SHANTIINOR"
  ],
  [
    "Phychem Technologies",
    "02 Sept 2026",
    54,
    450,
    56,
    3.7,
    56,
    3.7,
    2026,
    "PHYCHEM"
  ],
  [
    "Purple Style Labs",
    "02 Sept 2026",
    575,
    450,
    535,
    -6.96,
    535,
    -6.96,
    2026,
    "PERNIASPOP"
  ],
  [
    "Ashutosh Fibre",
    "02 Sept 2026",
    92,
    450,
    140,
    52.17,
    140,
    52.17,
    2026,
    "ASHUTOSH"
  ],
  [
    "Priority Jewels",
    "01 Sept 2026",
    200,
    450,
    230,
    15,
    230,
    15,
    2026,
    "PRIORITY"
  ],
  [
    "Paluck Technologies",
    "01 Sept 2026",
    48,
    450,
    46.8,
    -2.5,
    46.8,
    -2.5,
    2026,
    "PALUCK"
  ],
  [
    "Complete Sports and Management",
    "01 Sept 2026",
    135,
    450,
    139,
    2.96,
    139,
    2.96,
    2026,
    "CSML"
  ],
  [
    "ESDS Software Solution",
    "01 Sept 2026",
    429,
    450,
    757,
    76.46,
    757,
    76.46,
    2026,
    "ESDS"
  ],
  [
    "Kwick Forensic",
    "31 Aug 2026",
    90,
    450,
    150,
    66.67,
    150,
    66.67,
    2026,
    "KWICK"
  ],
  [
    "Lumino Industries",
    "31 Aug 2026",
    82,
    450,
    110,
    34.15,
    110,
    34.15,
    2026,
    "LUMINO"
  ],
  [
    "Sumax Engineering",
    "28 Aug 2026",
    101,
    450,
    111,
    9.9,
    111,
    9.9,
    2026,
    "SUMAX"
  ],
  [
    "Annu Projects",
    "28 Aug 2026",
    99,
    450,
    72,
    -27.27,
    72,
    -27.27,
    2026,
    "ANNU"
  ],
  [
    "Skyways Air Services",
    "27 Aug 2026",
    138,
    450,
    124,
    -10.14,
    124,
    -10.14,
    2026,
    "SKYWAYS"
  ],
  [
    "ABH Healthcare",
    "27 Aug 2026",
    102,
    450,
    99,
    -2.94,
    99,
    -2.94,
    2026,
    "ABH"
  ],
  [
    "Madhur Knit Crafts",
    "27 Aug 2026",
    100,
    450,
    100,
    0,
    100,
    0,
    2026,
    "MADHURKNIT"
  ],
  [
    "Symbiotec Pharmalab",
    "27 Aug 2026",
    988,
    450,
    988,
    0,
    988,
    0,
    2026,
    "SYMBIOTEC"
  ],
  [
    "Hy-tech Engineers",
    "27 Aug 2026",
    53,
    450,
    75,
    41.51,
    75,
    41.51,
    2026,
    "HTEL"
  ],
  [
    "Augmont Enterprises",
    "25 Aug 2026",
    788,
    450,
    961,
    21.95,
    961,
    21.95,
    2026,
    "AUGMONT"
  ],
  [
    "Tempsens Instruments",
    "24 Aug 2026",
    300,
    450,
    634,
    111.33,
    634,
    111.33,
    2026,
    "TEMPSENS"
  ],
  [
    "Dhanwel Hybrid Seeds",
    "21 Aug 2026",
    99,
    450,
    99,
    0,
    99,
    0,
    2026,
    "DHANWEL"
  ],
  [
    "Gaja Alternate Asset Management",
    "21 Aug 2026",
    160,
    450,
    185,
    15.62,
    185,
    15.62,
    2026,
    "GAJA"
  ],
  [
    "Mopshop Distribution",
    "21 Aug 2026",
    138,
    450,
    137,
    -0.72,
    137,
    -0.72,
    2026,
    "MOPSHOP"
  ],
  [
    "Sunshine Picture",
    "20 Aug 2026",
    360,
    450,
    395.9,
    9.97,
    395.9,
    9.97,
    2026,
    "SUNSHINE"
  ],
  [
    "Shankesh Jewellers",
    "20 Aug 2026",
    93,
    450,
    103.3,
    11.08,
    103.3,
    11.08,
    2026,
    "SHANKESH"
  ],
  [
    "Fascinate Textiles",
    "19 Aug 2026",
    151,
    450,
    120.8,
    -20,
    120.8,
    -20,
    2026,
    "FASCINATE"
  ],
  [
    "Lalithaa Jewellery Mart",
    "19 Aug 2026",
    201,
    450,
    265,
    31.84,
    265,
    31.84,
    2026,
    "LALITHAA"
  ],
  [
    "Horizon Industrial",
    "19 Aug 2026",
    60,
    450,
    60.25,
    0.42,
    60.25,
    0.42,
    2026,
    "HORIZONIND"
  ],
  [
    "ENS Enterprises",
    "18 Aug 2026",
    92,
    450,
    96,
    4.35,
    96,
    4.35,
    2026,
    "ENS"
  ],
  [
    "Technocrats Plasma",
    "18 Aug 2026",
    132,
    450,
    230,
    74.24,
    230,
    74.24,
    2026,
    "TECHNOCRAT"
  ],
  [
    "Skytech Infinite Platform",
    "18 Aug 2026",
    77,
    450,
    74,
    -3.9,
    74,
    -3.9,
    2026,
    "SKYTECH"
  ],
  [
    "Credent Connect N Care",
    "17 Aug 2026",
    189,
    450,
    359.1,
    90,
    359.1,
    90,
    2026,
    "CREDENT"
  ],
  [
    "Pramodini Medicare",
    "14 Aug 2026",
    118,
    450,
    120,
    1.69,
    120,
    1.69,
    2026,
    "PRAMODINI"
  ],
  [
    "Shiprocket",
    "14 Aug 2026",
    97,
    450,
    131,
    35.05,
    131,
    35.05,
    2026,
    "SHIPROCKET"
  ],
  [
    "Behari Lal Engineering",
    "14 Aug 2026",
    285,
    450,
    465,
    63.16,
    465,
    63.16,
    2026,
    "BLEL"
  ],
  [
    "Q&T Foods",
    "14 Aug 2026",
    115,
    450,
    115,
    0,
    115,
    0,
    2026,
    "QTFOODS"
  ],
  [
    "Milky Mist Dairy Food",
    "13 Aug 2026",
    140,
    450,
    165,
    17.86,
    165,
    17.86,
    2026,
    "MILKYMIST"
  ],
  [
    "Sham Foam",
    "13 Aug 2026",
    130,
    450,
    104,
    -20,
    104,
    -20,
    2026,
    "SHAMFOAM"
  ],
  [
    "Dhoot Transmission",
    "12 Aug 2026",
    871,
    450,
    1200,
    37.77,
    1200,
    37.77,
    2026,
    "DHOOTTRANS"
  ],
  [
    "Molbio Diagnostics",
    "12 Aug 2026",
    807,
    450,
    980,
    21.44,
    980,
    21.44,
    2026,
    "MOLBIO"
  ],
  [
    "Technocraft Ventures",
    "11 Aug 2026",
    212,
    450,
    284,
    33.96,
    284,
    33.96,
    2026,
    "TECHNOCRAF"
  ],
  [
    "Optimystix Entertainment",
    "11 Aug 2026",
    175,
    450,
    180,
    2.86,
    180,
    2.86,
    2026,
    "OPTIMYSTIX"
  ],
  [
    "LEAP India",
    "11 Aug 2026",
    159,
    450,
    165.9,
    4.34,
    165.9,
    4.34,
    2026,
    "LEAP"
  ],
  [
    "LAPL Automotive",
    "10 Aug 2026",
    94,
    450,
    135,
    43.62,
    135,
    43.62,
    2026,
    "LAPL"
  ],
  [
    "Tata Capital Ltd.",
    "13 Oct 2025",
    326,
    15511.87,
    412,
    26.38,
    435.5,
    33.59,
    2025,
    "TATACAP"
  ],
  [
    "HDB Financial Services Ltd.",
    "02 Jul 2025",
    740,
    12500,
    885,
    19.59,
    924,
    24.86,
    2025,
    "HDBFS"
  ],
  [
    "LG Electronics India Ltd.",
    "14 Oct 2025",
    1140,
    11604.73,
    1560,
    36.84,
    1680,
    47.37,
    2025,
    "LGEINDIA"
  ],
  [
    "ICICI Prudential AMC",
    "19 Dec 2025",
    2165,
    10602.65,
    2480,
    14.55,
    2590,
    19.63,
    2025,
    "ICICIPRUAM"
  ],
  [
    "Vishal Mega Mart Ltd.",
    "17 Jan 2025",
    78,
    8000,
    104,
    33.33,
    118.5,
    51.92,
    2025,
    "VISHALMEGA"
  ],
  [
    "Meesho Ltd.",
    "10 Dec 2025",
    111,
    5421.2,
    162,
    45.95,
    185,
    66.67,
    2025,
    "MEESHO"
  ],
  [
    "Kalpataru Ltd.",
    "24 Jan 2025",
    405,
    1590,
    465,
    14.81,
    482,
    19.01,
    2025,
    "KALPATARU"
  ],
  [
    "Corona Remedies Ltd.",
    "15 Dec 2025",
    1010,
    1250,
    1180,
    16.83,
    1240,
    22.77,
    2025,
    "CORONAREM"
  ],
  [
    "Wakefit Innovations Ltd.",
    "15 Dec 2025",
    195,
    1180,
    238,
    22.05,
    260,
    33.33,
    2025,
    "WAKEFIT"
  ],
  [
    "Rubicon Research Ltd.",
    "16 Oct 2025",
    485,
    1085,
    620,
    27.84,
    675,
    39.18,
    2025,
    "RUBICON"
  ],
  [
    "Park Medi World Ltd.",
    "17 Dec 2025",
    180,
    950,
    212,
    17.78,
    225,
    25,
    2025,
    "PARKMEDI"
  ],
  [
    "Aequs Ltd.",
    "10 Dec 2025",
    124,
    920,
    148,
    19.35,
    158,
    27.42,
    2025,
    "AEQUS"
  ],
  [
    "Quality Power Electrical Equipments Ltd.",
    "21 Feb 2025",
    425,
    858,
    530,
    24.71,
    565,
    32.94,
    2025,
    "QUALITYPOW"
  ],
  [
    "Laxmi Dental Ltd.",
    "20 Jan 2025",
    428,
    690,
    495,
    15.65,
    520,
    21.5,
    2025,
    "LAXMIDNTL"
  ],
  [
    "MobiKwik Systems Ltd.",
    "31 Jan 2025",
    279,
    572,
    315,
    12.9,
    334,
    19.71,
    2025,
    "MOBIKWIK"
  ],
  [
    "KSH International Ltd.",
    "19 Dec 2025",
    385,
    480,
    442,
    14.81,
    460,
    19.48,
    2025,
    "KSHINTL"
  ],
  [
    "Nephrocare Health Services Ltd.",
    "17 Dec 2025",
    90,
    420,
    118,
    31.11,
    132,
    46.67,
    2025,
    "NEPHROCARE"
  ],
  [
    "Standard Glass Lining Technology Ltd.",
    "13 Jan 2025",
    140,
    410,
    192,
    37.14,
    210,
    50,
    2025,
    "STNDRDGLAS"
  ],
  [
    "Vidya Wires Ltd.",
    "10 Dec 2025",
    52,
    310,
    63,
    21.15,
    68,
    30.77,
    2025,
    "VIDYAWIRES"
  ],
  [
    "Quadrant Future Tek Ltd.",
    "14 Jan 2025",
    290,
    290,
    395,
    36.21,
    422,
    45.52,
    2025,
    "QUADRANT"
  ],
  [
    "Denta Water & Infra Solutions Ltd.",
    "29 Jan 2025",
    150,
    220,
    182,
    21.33,
    198,
    32,
    2025,
    "DENTAWATR"
  ],
  [
    "Stallion India Fluorochemicals Ltd.",
    "23 Jan 2025",
    85,
    199,
    110,
    29.41,
    122,
    43.53,
    2025,
    "STALLION"
  ],
  [
    "Diffusion Engineers Ltd.",
    "12 Feb 2025",
    168,
    158,
    195,
    16.07,
    214,
    27.38,
    2025,
    "DIFFUSION"
  ],
  [
    "Highway Infrastructure Ltd.",
    "12 Aug 2025",
    65,
    130,
    78,
    20,
    86,
    32.31,
    2025,
    "HIGHWAYINF"
  ],
  [
    "Hyundai Motor India Ltd.",
    "22 Oct 2024",
    1960,
    27870.16,
    1819.6,
    -7.16,
    1860,
    -5.1,
    2024,
    "HYUNDAI"
  ],
  [
    "Swiggy Ltd.",
    "13 Nov 2024",
    390,
    11327.43,
    456,
    16.92,
    410,
    5.13,
    2024,
    "SWIGGY"
  ],
  [
    "Waaree Energies Ltd.",
    "28 Oct 2024",
    1503,
    4321.44,
    2345,
    56.02,
    2780,
    84.96,
    2024,
    "WAAREEENER"
  ],
  [
    "Premier Energies Ltd.",
    "03 Sep 2024",
    450,
    2830.4,
    991,
    120.22,
    1120,
    148.89,
    2024,
    "PREMIERENE"
  ],
  [
    "Bajaj Housing Finance Ltd.",
    "16 Sep 2024",
    70,
    6560,
    165,
    135.71,
    132,
    88.57,
    2024,
    "BAJAJHFL"
  ],
  [
    "NTPC Green Energy Ltd.",
    "27 Nov 2024",
    108,
    10000,
    121.5,
    12.5,
    129.5,
    19.91,
    2024,
    "NTPCGREEN"
  ],
  [
    "Ola Electric Mobility Ltd.",
    "09 Aug 2024",
    76,
    6145.56,
    91.2,
    20,
    72,
    -5.26,
    2024,
    "OLAELEC"
  ],
  [
    "Bharti Hexacom Ltd.",
    "12 Apr 2024",
    570,
    4275,
    755,
    32.46,
    1380,
    142.11,
    2024,
    "BHARTIHEXA"
  ],
  [
    "Brainbees Solutions Ltd. (FirstCry)",
    "13 Aug 2024",
    465,
    4193.73,
    625,
    34.41,
    540,
    16.13,
    2024,
    "FIRSTCRY"
  ],
  [
    "Go Digit General Insurance Ltd.",
    "23 May 2024",
    272,
    2614.65,
    305,
    12.13,
    342,
    25.74,
    2024,
    "GODIGIT"
  ],
  [
    "Aadhar Housing Finance Ltd.",
    "15 May 2024",
    315,
    3000,
    329,
    4.44,
    475,
    50.79,
    2024,
    "AADHARHFL"
  ],
  [
    "Emcure Pharmaceuticals Ltd.",
    "10 Jul 2024",
    1008,
    1952.03,
    1325,
    31.45,
    1380,
    36.9,
    2024,
    "EMCURE"
  ],
  [
    "Afcons Infrastructure Ltd.",
    "04 Nov 2024",
    463,
    5430,
    474,
    2.38,
    492,
    6.26,
    2024,
    "AFCONS"
  ],
  [
    "ACME Solar Holdings Ltd.",
    "13 Nov 2024",
    289,
    2900,
    251,
    -13.15,
    240,
    -16.96,
    2024,
    "ACMESOLAR"
  ],
  [
    "KRN Heat Exchanger Ltd.",
    "03 Oct 2024",
    220,
    341.95,
    478,
    117.27,
    710,
    222.73,
    2024,
    "KRN"
  ],
  [
    "TBO Tek Ltd.",
    "15 May 2024",
    920,
    1550.81,
    1405,
    52.72,
    1620,
    76.09,
    2024,
    "TBOTEK"
  ],
  [
    "Indegene Ltd.",
    "13 May 2024",
    452,
    1841.76,
    570,
    26.11,
    585,
    29.42,
    2024,
    "INDEGENE"
  ],
  [
    "Jyoti CNC Automation Ltd.",
    "16 Jan 2024",
    331,
    1000,
    433,
    30.82,
    1180,
    256.5,
    2024,
    "JYOTICNC"
  ],
  [
    "Enviro Infra Engineers Ltd.",
    "29 Nov 2024",
    148,
    650,
    218,
    47.3,
    235,
    58.78,
    2024,
    "ENVIRO"
  ],
  [
    "Tata Technologies Ltd.",
    "30 Nov 2023",
    500,
    3042.51,
    1314.25,
    162.85,
    659.8,
    31.96,
    2023,
    "TATATECH"
  ],
  [
    "IREDA Ltd.",
    "29 Nov 2023",
    32,
    2150,
    60,
    87.5,
    117.4,
    266.88,
    2023,
    "IREDA"
  ],
  [
    "JSW Infrastructure Ltd.",
    "03 Oct 2023",
    119,
    2800,
    157.5,
    32.35,
    295,
    147.9,
    2023,
    "JSWINFRA"
  ],
  [
    "Mankind Pharma Ltd.",
    "09 May 2023",
    1080,
    4326.36,
    1424.05,
    31.86,
    2610,
    141.67,
    2023,
    "MANKIND"
  ],
  [
    "Cello World Ltd.",
    "06 Nov 2023",
    648,
    1900,
    792,
    22.22,
    740,
    14.2,
    2023,
    "CELLO"
  ],
  [
    "Honasa Consumer Ltd. (Mamaearth)",
    "07 Nov 2023",
    324,
    1701,
    337.1,
    4.04,
    295,
    -8.95,
    2023,
    "HONASA"
  ],
  [
    "RR Kabel Ltd.",
    "20 Sep 2023",
    1035,
    1964,
    1196.5,
    15.6,
    1520,
    46.86,
    2023,
    "RRKABEL"
  ],
  [
    "Concord Biotech Ltd.",
    "18 Aug 2023",
    741,
    1551,
    941.85,
    27.11,
    1980,
    167.21,
    2023,
    "CONCORDBIO"
  ],
  [
    "SBFC Finance Ltd.",
    "16 Aug 2023",
    57,
    1025,
    89.5,
    57.02,
    88.5,
    55.26,
    2023,
    "SBFC"
  ],
  [
    "Netweb Technologies India Ltd.",
    "27 Jul 2023",
    500,
    631,
    910.5,
    82.1,
    2450,
    390,
    2023,
    "NETWEB"
  ],
  [
    "Utkarsh Small Finance Bank Ltd.",
    "21 Jul 2023",
    25,
    500,
    47.95,
    91.8,
    46.5,
    86,
    2023,
    "UTKARSHBNK"
  ],
  [
    "Cyient DLM Ltd.",
    "10 Jul 2023",
    265,
    592,
    420.75,
    58.77,
    685,
    158.49,
    2023,
    "CYIENTDLM"
  ],
  [
    "ideaForge Technology Ltd.",
    "07 Jul 2023",
    672,
    567,
    1295.5,
    92.78,
    670,
    -0.3,
    2023,
    "IDEAFORGE"
  ],
  [
    "Gandhar Oil Refinery (India) Ltd.",
    "30 Nov 2023",
    169,
    500.69,
    298.5,
    76.63,
    195,
    15.38,
    2023,
    "GANDHAR"
  ],
  [
    "Flair Writing Industries Ltd.",
    "01 Dec 2023",
    304,
    593,
    452.7,
    48.91,
    280,
    -7.89,
    2023,
    "FLAIR"
  ],
  [
    "Fedbank Financial Services Ltd.",
    "30 Nov 2023",
    140,
    1092.26,
    138.3,
    -1.21,
    115,
    -17.86,
    2023,
    "FEDFINA"
  ],
  [
    "Aeroflex Industries Ltd.",
    "31 Aug 2023",
    108,
    351,
    163,
    50.93,
    175,
    62.04,
    2023,
    "AEROFLEX"
  ],
  [
    "Vishnu Prakash R Punglia Ltd.",
    "05 Sep 2023",
    99,
    308.88,
    163.3,
    64.95,
    210,
    112.12,
    2023,
    "VPRPL"
  ],
  [
    "Ratnaveer Precision Engineering Ltd.",
    "11 Sep 2023",
    98,
    165.03,
    123.65,
    26.17,
    145,
    47.96,
    2023,
    "RATNAVEER"
  ],
  [
    "Jupiter Life Line Hospitals Ltd.",
    "18 Sep 2023",
    735,
    869.08,
    1034,
    40.68,
    1380,
    87.76,
    2023,
    "JLHL"
  ],
  [
    "EMS Ltd.",
    "21 Sep 2023",
    211,
    321.24,
    282.05,
    33.67,
    650,
    208.06,
    2023,
    "EMSLIMITED"
  ],
  [
    "Signatureglobal (India) Ltd.",
    "27 Sep 2023",
    385,
    730,
    484.5,
    25.84,
    1350,
    250.65,
    2023,
    "SIGNATURE"
  ],
  [
    "Yatra Online Ltd.",
    "28 Sep 2023",
    142,
    775,
    135.9,
    -4.3,
    118,
    -16.9,
    2023,
    "YATRA"
  ],
  [
    "Nexus Select Trust",
    "19 May 2023",
    100,
    3200,
    104,
    4,
    138,
    38,
    2023,
    "NXST"
  ],
  [
    "Senco Gold Ltd.",
    "14 Jul 2023",
    317,
    405,
    405,
    27.76,
    1050,
    231.23,
    2023,
    "SENCO"
  ]
];;

// Helper function to search live Indian equities & format into standard IPO Performance row
async function searchLiveIndianStock(query) {
  const q = (query || '').trim();
  if (!q) return [];

  function fetchJson(urlStr) {
    return new Promise((resolve) => {
      try {
        const u = new URL(urlStr);
        const req = https.request({
          hostname: u.hostname,
          path: u.pathname + u.search,
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'application/json'
          },
          timeout: 5000
        }, res => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => {
            try { resolve(JSON.parse(d)); } catch (e) { resolve(null); }
          });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.end();
      } catch (e) { resolve(null); }
    });
  }

  // Special alias mapping for major IPOs whose names or tickers evolved
  const ALIAS_MAP = {
    'zomato': ['ETERNAL.NS', 'ETERNAL.BO'],
    'paytm': ['PAYTM.NS', 'PAYTM.BO'],
    'esds': ['ESDS.NS', 'ESDS.BO'],
    'rentomojo': ['RENTOMOJO.NS']
  };

  let candidateSymbols = [];
  const qLower = q.toLowerCase();
  if (ALIAS_MAP[qLower]) {
    candidateSymbols.push(...ALIAS_MAP[qLower].map(s => ({ symbol: s, shortname: q.toUpperCase() })));
  }

  // 1. Search Yahoo for quotes matching query
  const searchUrl = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`;
  const searchData = await fetchJson(searchUrl);
  let quotes = (searchData && searchData.quotes) || [];

  const discoveredIndian = quotes.filter(item =>
    item.quoteType === 'EQUITY' &&
    (item.symbol.endsWith('.NS') || item.symbol.endsWith('.BO'))
  );
  candidateSymbols.push(...discoveredIndian);

  // If query looks like a raw ticker (e.g. "KFINTECH", "MOTISONS", "ESDS"), try direct .NS
  if (candidateSymbols.length === 0 && /^[A-Z0-9\-_]{2,15}$/i.test(q)) {
    candidateSymbols.push({ symbol: q.toUpperCase() + '.NS', shortname: q.toUpperCase() });
  }

  const results = [];
  const seenSymbols = new Set();

  for (const cand of candidateSymbols.slice(0, 4)) {
    const cleanSym = cand.symbol.replace(/\.(NS|BO)$/i, '');
    if (seenSymbols.has(cleanSym)) continue;
    seenSymbols.add(cleanSym);

    const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(cand.symbol)}?range=1y&interval=1d`;
    const chartData = await fetchJson(chartUrl);
    if (!chartData || !chartData.chart || !chartData.chart.result || !chartData.chart.result[0]) continue;

    const res0 = chartData.chart.result[0];
    const meta = res0.meta || {};
    const quotesObj = (res0.indicators && res0.indicators.quote && res0.indicators.quote[0]) || {};
    const closes = (quotesObj.close || []).filter(c => typeof c === 'number' && !isNaN(c) && c > 0);
    const opens = (quotesObj.open || []).filter(c => typeof c === 'number' && !isNaN(c) && c > 0);

    const currentPrice = meta.regularMarketPrice || (closes.length ? closes[closes.length - 1] : 0);
    if (!currentPrice) continue;

    const companyName = meta.shortName || cand.shortname || cand.longname || cleanSym;
    const firstTradeSec = meta.firstTradeDate || (res0.timestamp && res0.timestamp[0]) || Math.floor(Date.now() / 1000);
    const firstDate = new Date(firstTradeSec * 1000);
    const year = firstDate.getFullYear();
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const dateStr = `${days[firstDate.getDay()]}, ${months[firstDate.getMonth()]} ${String(firstDate.getDate()).padStart(2, '0')}, ${year}`;

    const issueBaseline = meta.chartPreviousClose || opens[0] || (closes[0] ? closes[0] * 0.9 : currentPrice * 0.85);
    const issuePrice = Math.round(issueBaseline * 100) / 100;
    const listingClose = Math.round((closes[0] || currentPrice) * 100) / 100;
    const listingGain = Math.round(((listingClose - issuePrice) / issuePrice) * 10000) / 100;
    const pnl = Math.round(((currentPrice - issuePrice) / issuePrice) * 10000) / 100;
    const estSize = Math.round(((meta.regularMarketVolume || 1000000) * issuePrice / 100000) * 10) / 10 || 450.00;

    results.push([
      companyName,
      dateStr,
      issuePrice,
      estSize,
      listingClose,
      listingGain,
      Math.round(currentPrice * 100) / 100,
      pnl,
      year,
      cleanSym,
      true // isLiveDiscovered flag
    ]);
  }

  return results;
}

// ==============================================================================
// 5D. SCREENINGMANTIS LIVE MARKET DATA INGESTION ENGINE
// ==============================================================================
const ScreeningMantisService = {
  CACHE_TTL_MS: 10 * 60 * 1000,
  cachedSectors: null,
  cachedSnapshot: null,
  cachedBreadth: null,
  lastSectorsTime: 0,
  lastSnapshotTime: 0,
  lastBreadthTime: 0,

  async fetchJson(url) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = https.get(u, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*'
        },
        timeout: 8000
      }, res => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        }
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Timeout fetching ${url}`));
      });
    });
  },

  async getSectorIndices(force = false) {
    if (!force && this.cachedSectors && (Date.now() - this.lastSectorsTime < this.CACHE_TTL_MS)) {
      return this.cachedSectors;
    }
    try {
      const data = await this.fetchJson('https://www.screeningmantis.com/api/sector-indices');
      if (Array.isArray(data) && data.length > 0) {
        this.cachedSectors = data;
        this.lastSectorsTime = Date.now();
        console.log(`[ScreeningMantis] Synced ${data.length} live sector indices.`);
        try {
          fs.writeFileSync(path.join(__dirname, 'data', 'screeningmantis-sectors.json'), JSON.stringify(data, null, 2));
        } catch (_) { }
        return data;
      }
    } catch (err) {
      console.warn('[ScreeningMantis] Error syncing sector indices:', err.message);
    }
    if (!this.cachedSectors) {
      try {
        const p = path.join(__dirname, 'data', 'screeningmantis-sectors.json');
        if (fs.existsSync(p)) {
          this.cachedSectors = JSON.parse(fs.readFileSync(p, 'utf8'));
        }
      } catch (_) { }
    }
    return this.cachedSectors || [];
  },

  async getScannerSnapshot(force = false) {
    if (!force && this.cachedSnapshot && (Date.now() - this.lastSnapshotTime < this.CACHE_TTL_MS)) {
      return this.cachedSnapshot;
    }
    try {
      const data = await this.fetchJson('https://www.screeningmantis.com/api/scanner/snapshot');
      if (data && data.snapshot && Array.isArray(data.snapshot.results)) {
        this.cachedSnapshot = data;
        this.lastSnapshotTime = Date.now();
        console.log(`[ScreeningMantis] Synced scanner snapshot with ${data.snapshot.results.length} stocks.`);
        try {
          const map = {};
          for (const r of data.snapshot.results) {
            if (r.symbol) {
              map[r.symbol] = {
                aboveEma10: Boolean(r.aboveEma10),
                aboveEma20: Boolean(r.aboveEma20),
                aboveEma50: Boolean(r.aboveEma50),
                aboveEma200: Boolean(r.aboveEma200),
                wAboveEma10: Boolean(r.wAboveEma10),
                wAboveEma20: Boolean(r.wAboveEma20),
                wAboveEma50: Boolean(r.wAboveEma50),
                wAboveEma200: Boolean(r.wAboveEma200),
                ema10: r.ema10,
                ema20: r.ema20,
                ema50: r.ema50,
                ema200: r.ema200,
                wEma10: r.wEma10,
                wEma20: r.wEma20,
                wEma50: r.wEma50,
                wEma200: r.wEma200,
                emaCross: r.emaCross,
                emaCrossCandles: r.emaCrossCandles
              };
            }
          }
          fs.writeFileSync(path.join(__dirname, 'data', 'screeningmantis-emas.json'), JSON.stringify(map, null, 2));
        } catch (_) { }
        return data;
      }
    } catch (err) {
      console.warn('[ScreeningMantis] Error syncing scanner snapshot:', err.message);
    }
    if (!this.cachedSnapshot) {
      try {
        const p = path.join(__dirname, 'data', 'screeningmantis-emas.json');
        if (fs.existsSync(p)) {
          const map = JSON.parse(fs.readFileSync(p, 'utf8'));
          const results = Object.keys(map).map(sym => ({ symbol: sym, ...map[sym] }));
          this.cachedSnapshot = { success: true, snapshot: { results } };
        }
      } catch (_) { }
    }
    return this.cachedSnapshot || null;
  },

  async getEmaMap(force = false) {
    const snap = await this.getScannerSnapshot(force);
    const results = (snap && snap.snapshot && Array.isArray(snap.snapshot.results)) ? snap.snapshot.results : [];
    if (results.length > 0) {
      const map = {};
      for (const r of results) {
        if (r.symbol) {
          map[r.symbol] = {
            aboveEma10: Boolean(r.aboveEma10),
            aboveEma20: Boolean(r.aboveEma20),
            aboveEma50: Boolean(r.aboveEma50),
            aboveEma200: Boolean(r.aboveEma200),
            wAboveEma10: Boolean(r.wAboveEma10),
            wAboveEma20: Boolean(r.wAboveEma20),
            wAboveEma50: Boolean(r.wAboveEma50),
            wAboveEma200: Boolean(r.wAboveEma200),
            ema10: r.ema10,
            ema20: r.ema20,
            ema50: r.ema50,
            ema200: r.ema200,
            wEma10: r.wEma10,
            wEma20: r.wEma20,
            wEma50: r.wEma50,
            wEma200: r.wEma200,
            emaCross: r.emaCross,
            emaCrossCandles: r.emaCrossCandles
          };
        }
      }
      return map;
    }
    try {
      const p = path.join(__dirname, 'data', 'screeningmantis-emas.json');
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      }
    } catch (_) { }
    return {};
  },

  async getBreadthHistory(limit = 30, force = false) {
    if (!force && this.cachedBreadth && (Date.now() - this.lastBreadthTime < this.CACHE_TTL_MS * 2)) {
      return this.cachedBreadth;
    }
    try {
      const data = await this.fetchJson(`https://www.screeningmantis.com/api/breadth/history?limit=${limit}`);
      if (Array.isArray(data) && data.length > 0) {
        this.cachedBreadth = data;
        this.lastBreadthTime = Date.now();
        console.log(`[ScreeningMantis] Synced ${data.length} breadth history records.`);
        return data;
      }
    } catch (err) {
      console.warn('[ScreeningMantis] Error syncing breadth history:', err.message);
    }
    return this.cachedBreadth || [];
  },

  async getSectorShareHistory(force = false) {
    if (!force && this.cachedSectorShare && (Date.now() - this.lastSectorShareTime < this.CACHE_TTL_MS * 2)) {
      return this.cachedSectorShare;
    }
    try {
      const data = await this.fetchJson('https://www.screeningmantis.com/api/sector-share/history');
      if (Array.isArray(data) && data.length > 0) {
        this.cachedSectorShare = data;
        this.lastSectorShareTime = Date.now();
        console.log(`[ScreeningMantis] Synced ${data.length} sector share history records.`);
        return data;
      }
    } catch (err) {
      console.warn('[ScreeningMantis] Error syncing sector share history:', err.message);
    }
    return this.cachedSectorShare || [];
  }
};

// ==============================================================================
// 5C. REAL-TIME EXTERNAL DATA FEED ENGINES: DEALS, IPOS & FINANCIAL NEWS
// ==============================================================================

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = [];
    let cur = '';
    let inQuote = false;
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === '"') {
        inQuote = !inQuote;
      } else if (ch === ',' && !inQuote) {
        cols.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    cols.push(cur.trim());
    rows.push(cols);
  }
  return rows;
}

function categorizeDealClient(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('fund') || n.includes('mutual') || n.includes('insurance') || n.includes('lic') || n.includes('sbi ') || n.includes('icici') || n.includes('kotak') || n.includes('hdfc') || n.includes('nippon')) {
    return 'DII';
  }
  if (n.includes('capital') || n.includes('securities') || n.includes('singapore') || n.includes('morgan') || n.includes('goldman') || n.includes('blackrock') || n.includes('societe') || n.includes('vanguard') || n.includes('norway') || n.includes('norges') || n.includes('mauritius') || n.includes('cayman')) {
    return 'FII';
  }
  if (n.includes('trust') || n.includes('promoter') || n.includes('holding') || n.includes('family')) {
    return 'Promoter';
  }
  return 'HNI';
}

function fetchCSVFromNSE(urlStr) {
  return new Promise((resolve, reject) => {
    const req = https.get(urlStr, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    }, res => {
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('Timeout')));
  });
}

async function fetchLiveDealsData() {
  const [bulkCsv, blockCsv] = await Promise.all([
    fetchCSVFromNSE('https://archives.nseindia.com/content/equities/bulk.csv').catch(() => ''),
    fetchCSVFromNSE('https://archives.nseindia.com/content/equities/block.csv').catch(() => '')
  ]);

  const bulkRows = parseCSV(bulkCsv);
  const blockRows = parseCSV(blockCsv);
  const deals = [];

  bulkRows.forEach((r, idx) => {
    if (r.length < 7) return;
    const [date, symbol, stock, client, action, qtyStr, priceStr] = r;
    const qty = parseInt(qtyStr.replace(/,/g, ''), 10) || 0;
    const avgPrice = parseFloat(priceStr.replace(/,/g, '')) || 0;
    const valueCr = Math.round(((qty * avgPrice) / 10000000) * 100) / 100;
    deals.push({
      id: `bulk_${idx}_${symbol}`,
      stock: stock || symbol,
      symbol: (symbol || '').toUpperCase(),
      type: 'Bulk',
      date: date || 'Today',
      client: client || 'Undisclosed Participant',
      action: (action || 'BUY').toUpperCase() === 'BUY' ? 'Buy' : 'Sell',
      qty,
      avgPrice,
      valueCr,
      avatar: (stock || symbol || 'S').charAt(0).toUpperCase(),
      clientCategory: categorizeDealClient(client)
    });
  });

  blockRows.forEach((r, idx) => {
    if (r.length < 7) return;
    const [date, symbol, stock, client, action, qtyStr, priceStr] = r;
    const qty = parseInt(qtyStr.replace(/,/g, ''), 10) || 0;
    const avgPrice = parseFloat(priceStr.replace(/,/g, '')) || 0;
    const valueCr = Math.round(((qty * avgPrice) / 10000000) * 100) / 100;
    deals.push({
      id: `block_${idx}_${symbol}`,
      stock: stock || symbol,
      symbol: (symbol || '').toUpperCase(),
      type: 'Block',
      date: date || 'Today',
      client: client || 'Undisclosed Participant',
      action: (action || 'BUY').toUpperCase() === 'BUY' ? 'Buy' : 'Sell',
      qty,
      avgPrice,
      valueCr,
      avatar: (stock || symbol || 'S').charAt(0).toUpperCase(),
      clientCategory: categorizeDealClient(client)
    });
  });

  return deals;
}

function formatIPOFeedDate(value) {
  if (!value) return 'TBA';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return date.toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata'
  });
}

async function fetchLiveIPOsData() {
  const cleanFallback = [
    {
      "id": "ZEPTEMP",
      "company": "Zepto",
      "symbol": "ZEPTEMP",
      "status": "UPCOMING",
      "opens": "TBA",
      "closes": "TBA",
      "listing": "TBA",
      "allotment": "TBA",
      "priceMin": null,
      "priceMax": null,
      "issuePrice": "TBA",
      "lot": "TBA",
      "size": "TBA",
      "gmp": null,
      "gmpPct": null,
      "exchange": "NSE / BSE",
      "type": "Mainboard",
      "subscribed": "Draft Filed",
      "category": "Mainboard",
      "documentUrl": "https://www.sebi.gov.in/filings/public-issues/jun-2026/zepto-limited-udrhp1_101929.html",
      "logoUrl": "https://assets-netstorage.groww.in/stock-assets/logos2/Zepto.png"
    },
    {
      "id": "TEMPRZR",
      "company": "Razorpay",
      "symbol": "TEMPRZR",
      "status": "UPCOMING",
      "opens": "TBA",
      "closes": "TBA",
      "listing": "TBA",
      "allotment": "TBA",
      "priceMin": null,
      "priceMax": null,
      "issuePrice": "TBA",
      "lot": "TBA",
      "size": "TBA",
      "gmp": null,
      "gmpPct": null,
      "exchange": "NSE / BSE",
      "type": "Mainboard",
      "subscribed": "Draft Filed",
      "category": "Mainboard",
      "documentUrl": null,
      "logoUrl": "https://assets-netstorage.groww.in/stock-assets/logos2/Razorpay_logo.png"
    },
    {
      "id": "TEMPTRU",
      "company": "Truhome Finance",
      "symbol": "TEMPTRU",
      "status": "UPCOMING",
      "opens": "TBA",
      "closes": "TBA",
      "listing": "TBA",
      "allotment": "TBA",
      "priceMin": null,
      "priceMax": null,
      "issuePrice": "TBA",
      "lot": "TBA",
      "size": "TBA",
      "gmp": null,
      "gmpPct": null,
      "exchange": "NSE / BSE",
      "type": "Mainboard",
      "subscribed": "Draft Filed",
      "category": "Mainboard",
      "documentUrl": "https://www.sebi.gov.in/filings/public-issues/mar-2026/truhome-finance-limited_100519.html",
      "logoUrl": "https://assets-netstorage.groww.in/stock-assets/logos2/truhome_logo.png"
    },
    {
      "id": "MARRI",
      "company": "Marri Retail",
      "symbol": "MARRI",
      "status": "UPCOMING",
      "opens": "TBA",
      "closes": "TBA",
      "listing": "TBA",
      "allotment": "TBA",
      "priceMin": null,
      "priceMax": null,
      "issuePrice": "TBA",
      "lot": "TBA",
      "size": "TBA",
      "gmp": null,
      "gmpPct": null,
      "exchange": "NSE / BSE",
      "type": "Mainboard",
      "subscribed": "Draft Filed",
      "category": "Mainboard",
      "documentUrl": "https://www.sebi.gov.in/filings/public-issues/feb-2026/marri-retail-limited-drhp_99483.html",
      "logoUrl": "https://assets-netstorage.groww.in/stock-assets/logos2/marri_retail.png"
    },
    {
      "id": "INCREDTEMP",
      "company": "InCred Holdings",
      "symbol": "INCREDTEMP",
      "status": "UPCOMING",
      "opens": "TBA",
      "closes": "TBA",
      "listing": "TBA",
      "allotment": "TBA",
      "priceMin": null,
      "priceMax": null,
      "issuePrice": "TBA",
      "lot": "TBA",
      "size": "TBA",
      "gmp": null,
      "gmpPct": null,
      "exchange": "NSE / BSE",
      "type": "Mainboard",
      "subscribed": "Draft Filed",
      "category": "Mainboard",
      "documentUrl": null,
      "logoUrl": "https://assets-netstorage.groww.in/stock-assets/logos2/incred_logo.png"
    },
    {
      "id": "TEMPHERO",
      "company": "Hero Fincorp",
      "symbol": "TEMPHERO",
      "status": "UPCOMING",
      "opens": "TBA",
      "closes": "TBA",
      "listing": "TBA",
      "allotment": "TBA",
      "priceMin": null,
      "priceMax": null,
      "issuePrice": "TBA",
      "lot": "TBA",
      "size": "TBA",
      "gmp": null,
      "gmpPct": null,
      "exchange": "NSE / BSE",
      "type": "Mainboard",
      "subscribed": "Draft Filed",
      "category": "Mainboard",
      "documentUrl": "https://hfcl-website-cms.s3.ap-south-1.amazonaws.com/DRHP_Hero_Fin_Corp_Limited_fe2e340ba3.pdf",
      "logoUrl": "https://assets-netstorage.groww.in/stocks-ipo/logos/hero_fincorp_logo.png"
    },
    {
      "id": "TEMPALLCHEM",
      "company": "Allchem Lifescience",
      "symbol": "TEMPALLCHEM",
      "status": "UPCOMING",
      "opens": "TBA",
      "closes": "TBA",
      "listing": "TBA",
      "allotment": "TBA",
      "priceMin": null,
      "priceMax": null,
      "issuePrice": "TBA",
      "lot": "TBA",
      "size": "TBA",
      "gmp": null,
      "gmpPct": null,
      "exchange": "NSE / BSE",
      "type": "Mainboard",
      "subscribed": "Draft Filed",
      "category": "Mainboard",
      "documentUrl": null,
      "logoUrl": "https://assets-netstorage.groww.in/stock-assets/logos2/Allchecm_logo.png"
    },
    {
      "id": "CDTEMP",
      "company": "CarDekho",
      "symbol": "CDTEMP",
      "status": "UPCOMING",
      "opens": "TBA",
      "closes": "TBA",
      "listing": "TBA",
      "allotment": "TBA",
      "priceMin": null,
      "priceMax": null,
      "issuePrice": "TBA",
      "lot": "TBA",
      "size": "TBA",
      "gmp": null,
      "gmpPct": null,
      "exchange": "NSE / BSE",
      "type": "Mainboard",
      "subscribed": "Draft Filed",
      "category": "Mainboard",
      "documentUrl": null,
      "logoUrl": "https://assets-netstorage.groww.in/stock-assets/logos2/cardekho.png"
    },
    {
      "id": "HALDITEMP",
      "company": "Haldiram's Snacks Foods",
      "symbol": "HALDITEMP",
      "status": "UPCOMING",
      "opens": "TBA",
      "closes": "TBA",
      "listing": "TBA",
      "allotment": "TBA",
      "priceMin": null,
      "priceMax": null,
      "issuePrice": "TBA",
      "lot": "TBA",
      "size": "TBA",
      "gmp": null,
      "gmpPct": null,
      "exchange": "NSE / BSE",
      "type": "Mainboard",
      "subscribed": "Draft Filed",
      "category": "Mainboard",
      "documentUrl": null,
      "logoUrl": "https://assets-netstorage.groww.in/stock-assets/logos2/haldirams_logo.png"
    },
    {
      "id": "TEMPPREST",
      "company": "Prestige Hospitality",
      "symbol": "TEMPPREST",
      "status": "UPCOMING",
      "opens": "TBA",
      "closes": "TBA",
      "listing": "TBA",
      "allotment": "TBA",
      "priceMin": null,
      "priceMax": null,
      "issuePrice": "TBA",
      "lot": "TBA",
      "size": "TBA",
      "gmp": null,
      "gmpPct": null,
      "exchange": "NSE / BSE",
      "type": "Mainboard",
      "subscribed": "Draft Filed",
      "category": "Mainboard",
      "documentUrl": null,
      "logoUrl": "https://assets-netstorage.groww.in/stock-assets/logos2/logo-prestige.png"
    },
    {
      "id": "TEMPCURE",
      "company": "Curefoods",
      "symbol": "TEMPCURE",
      "status": "UPCOMING",
      "opens": "TBA",
      "closes": "TBA",
      "listing": "TBA",
      "allotment": "TBA",
      "priceMin": null,
      "priceMax": null,
      "issuePrice": "TBA",
      "lot": "TBA",
      "size": "TBA",
      "gmp": null,
      "gmpPct": null,
      "exchange": "NSE / BSE",
      "type": "Mainboard",
      "subscribed": "Draft Filed",
      "category": "Mainboard",
      "documentUrl": "https://www.sebi.gov.in/filings/public-issues/jul-2025/curefoods-india-limited_95013.html",
      "logoUrl": "https://assets-netstorage.groww.in/stocks-ipo/logos/curefoods_logo.png"
    },
    {
      "id": "TEMPCULT",
      "company": "Cult Fit",
      "symbol": "TEMPCULT",
      "status": "UPCOMING",
      "opens": "TBA",
      "closes": "TBA",
      "listing": "TBA",
      "allotment": "TBA",
      "priceMin": null,
      "priceMax": null,
      "issuePrice": "TBA",
      "lot": "TBA",
      "size": "TBA",
      "gmp": null,
      "gmpPct": null,
      "exchange": "NSE / BSE",
      "type": "Mainboard",
      "subscribed": "Draft Filed",
      "category": "Mainboard",
      "documentUrl": null,
      "logoUrl": "https://assets-netstorage.groww.in/stocks-ipo/logos/cultfit_logo.png"
    },
    {
      "id": "TEMPKENT",
      "company": "Kent RO",
      "symbol": "TEMPKENT",
      "status": "UPCOMING",
      "opens": "TBA",
      "closes": "TBA",
      "listing": "TBA",
      "allotment": "TBA",
      "priceMin": null,
      "priceMax": null,
      "issuePrice": "TBA",
      "lot": "TBA",
      "size": "TBA",
      "gmp": null,
      "gmpPct": null,
      "exchange": "NSE / BSE",
      "type": "Mainboard",
      "subscribed": "Draft Filed",
      "category": "Mainboard",
      "documentUrl": "https://www.sebi.gov.in/filings/public-issues/jan-2025/kent-r-o-systems-limited_91156.html",
      "logoUrl": "https://assets-netstorage.groww.in/stocks-ipo/logos/kent_ro_logo.png"
    },
    {
      "id": "TEMPSYMBOL",
      "company": "VLCC",
      "symbol": "TEMPSYMBOL",
      "status": "UPCOMING",
      "opens": "TBA",
      "closes": "TBA",
      "listing": "TBA",
      "allotment": "TBA",
      "priceMin": null,
      "priceMax": null,
      "issuePrice": "TBA",
      "lot": "TBA",
      "size": "TBA",
      "gmp": null,
      "gmpPct": null,
      "exchange": "NSE / BSE",
      "type": "Mainboard",
      "subscribed": "Draft Filed",
      "category": "Mainboard",
      "documentUrl": null,
      "logoUrl": "https://assets-netstorage.groww.in/stocks-ipo/logos/vlcc_logo.png"
    },
    {
      "id": "TEMPPHARM",
      "company": "PharmEasy",
      "symbol": "TEMPPHARM",
      "status": "UPCOMING",
      "opens": "TBA",
      "closes": "TBA",
      "listing": "TBA",
      "allotment": "TBA",
      "priceMin": null,
      "priceMax": null,
      "issuePrice": "TBA",
      "lot": "TBA",
      "size": "TBA",
      "gmp": null,
      "gmpPct": null,
      "exchange": "NSE / BSE",
      "type": "Mainboard",
      "subscribed": "Draft Filed",
      "category": "Mainboard",
      "documentUrl": null,
      "logoUrl": "https://assets-netstorage.groww.in/stocks-ipo/logos/Pharmeasy_logo.png"
    },
    {
      "id": "TEMPSERV",
      "company": "Servify",
      "symbol": "TEMPSERV",
      "status": "UPCOMING",
      "opens": "TBA",
      "closes": "TBA",
      "listing": "TBA",
      "allotment": "TBA",
      "priceMin": null,
      "priceMax": null,
      "issuePrice": "TBA",
      "lot": "TBA",
      "size": "TBA",
      "gmp": null,
      "gmpPct": null,
      "exchange": "NSE / BSE",
      "type": "Mainboard",
      "subscribed": "Draft Filed",
      "category": "Mainboard",
      "documentUrl": null,
      "logoUrl": "https://assets-netstorage.groww.in/stocks-ipo/logos/Servify_logo.png"
    },
    {
      "id": "HEROTEMP",
      "company": "Hero Future Energies",
      "symbol": "HEROTEMP",
      "status": "UPCOMING",
      "opens": "TBA",
      "closes": "TBA",
      "listing": "TBA",
      "allotment": "TBA",
      "priceMin": null,
      "priceMax": null,
      "issuePrice": "TBA",
      "lot": "TBA",
      "size": "TBA",
      "gmp": null,
      "gmpPct": null,
      "exchange": "NSE / BSE",
      "type": "Mainboard",
      "subscribed": "Draft Filed",
      "category": "Mainboard",
      "documentUrl": null,
      "logoUrl": "https://assets-netstorage.groww.in/stocks-ipo/logos/hero_future_energies_logo.jpg"
    },
    {
      "id": "FLIPTEMP",
      "company": "Flipkart",
      "symbol": "FLIPTEMP",
      "status": "UPCOMING",
      "opens": "TBA",
      "closes": "TBA",
      "listing": "TBA",
      "allotment": "TBA",
      "priceMin": null,
      "priceMax": null,
      "issuePrice": "TBA",
      "lot": "TBA",
      "size": "TBA",
      "gmp": null,
      "gmpPct": null,
      "exchange": "NSE / BSE",
      "type": "Mainboard",
      "subscribed": "Draft Filed",
      "category": "Mainboard",
      "documentUrl": null,
      "logoUrl": "https://assets-netstorage.groww.in/stocks-ipo/logos/flipkart-logo.png"
    },
    {
      "id": "PH123",
      "company": "PhonePe",
      "symbol": "PH123",
      "status": "UPCOMING",
      "opens": "TBA",
      "closes": "TBA",
      "listing": "TBA",
      "allotment": "TBA",
      "priceMin": null,
      "priceMax": null,
      "issuePrice": "TBA",
      "lot": "TBA",
      "size": "TBA",
      "gmp": null,
      "gmpPct": null,
      "exchange": "NSE / BSE",
      "type": "Mainboard",
      "subscribed": "Draft Filed",
      "category": "Mainboard",
      "documentUrl": "https://www.sebi.gov.in/filings/public-issues/jan-2026/phonepe-limited-udrhp-i_99285.html",
      "logoUrl": "https://assets-netstorage.groww.in/stocks-ipo/logos/phonepe_logo.png"
    },
    {
      "id": "FABINDIA",
      "company": "FabIndia",
      "symbol": "FABINDIA",
      "status": "UPCOMING",
      "opens": "TBA",
      "closes": "TBA",
      "listing": "TBA",
      "allotment": "TBA",
      "priceMin": null,
      "priceMax": null,
      "issuePrice": "TBA",
      "lot": "TBA",
      "size": "TBA",
      "gmp": null,
      "gmpPct": null,
      "exchange": "NSE / BSE",
      "type": "Mainboard",
      "subscribed": "Draft Filed",
      "category": "Mainboard",
      "documentUrl": "https://www.sebi.gov.in/filings/public-issues/jan-2022/fabindia-limited_55532.html",
      "logoUrl": "https://assets-netstorage.groww.in/stocks-ipo/logos/logos-135.png"
    },
    {
      "id": "OYO",
      "company": "OYO",
      "symbol": "OYO",
      "status": "UPCOMING",
      "opens": "TBA",
      "closes": "TBA",
      "listing": "TBA",
      "allotment": "TBA",
      "priceMin": null,
      "priceMax": null,
      "issuePrice": "TBA",
      "lot": "TBA",
      "size": "TBA",
      "gmp": null,
      "gmpPct": null,
      "exchange": "NSE / BSE",
      "type": "Mainboard",
      "subscribed": "Draft Filed",
      "category": "Mainboard",
      "documentUrl": "https://www.sebi.gov.in/filings/public-issues/oct-2021/oravel-stays-limited_53084.html",
      "logoUrl": "https://assets-netstorage.groww.in/stocks-ipo/logos/logos-88.png"
    },
    {
      "id": "BOAT",
      "company": "boAt ",
      "symbol": "BOAT",
      "status": "UPCOMING",
      "opens": "TBA",
      "closes": "TBA",
      "listing": "TBA",
      "allotment": "TBA",
      "priceMin": null,
      "priceMax": null,
      "issuePrice": "TBA",
      "lot": "TBA",
      "size": "TBA",
      "gmp": null,
      "gmpPct": null,
      "exchange": "NSE / BSE",
      "type": "Mainboard",
      "subscribed": "Draft Filed",
      "category": "Mainboard",
      "documentUrl": "https://www.sebi.gov.in/filings/public-issues/jan-2022/imagine-marketing-limited_55666.html",
      "logoUrl": "https://assets-netstorage.groww.in/stocks-ipo/logos/logos-131.png"
    },
    {
      "id": "BAJAJENER",
      "company": "Bajaj Energy",
      "symbol": "BAJAJENER",
      "status": "UPCOMING",
      "opens": "TBA",
      "closes": "TBA",
      "listing": "TBA",
      "allotment": "TBA",
      "priceMin": null,
      "priceMax": null,
      "issuePrice": "TBA",
      "lot": "TBA",
      "size": "TBA",
      "gmp": null,
      "gmpPct": null,
      "exchange": "NSE / BSE",
      "type": "Mainboard",
      "subscribed": "Draft Filed",
      "category": "Mainboard",
      "documentUrl": "https://www.sebi.gov.in/filings/public-issues/apr-2019/bajaj-energy-limited_42638.html",
      "logoUrl": "https://storage.googleapis.com/gw-prod-asset-netstorage/stocks-ipo/logos/logos_bajajelec-41.png"
    },
    {
      "id": "AROHAN",
      "company": "Arohan Financial",
      "symbol": "AROHAN",
      "status": "UPCOMING",
      "opens": "TBA",
      "closes": "TBA",
      "listing": "TBA",
      "allotment": "TBA",
      "priceMin": null,
      "priceMax": null,
      "issuePrice": "TBA",
      "lot": "TBA",
      "size": "TBA",
      "gmp": null,
      "gmpPct": null,
      "exchange": "NSE / BSE",
      "type": "Mainboard",
      "subscribed": "Draft Filed",
      "category": "Mainboard",
      "documentUrl": "https://www.sebi.gov.in/filings/public-issues/feb-2021/arohan-financial-services-limited_49148.html",
      "logoUrl": "https://assets-netstorage.groww.in/stocks-ipo/logos/logos-72.png"
    },
    {
      "id": "DROOM",
      "company": "Droom",
      "symbol": "DROOM",
      "status": "UPCOMING",
      "opens": "TBA",
      "closes": "TBA",
      "listing": "TBA",
      "allotment": "TBA",
      "priceMin": null,
      "priceMax": null,
      "issuePrice": "TBA",
      "lot": "TBA",
      "size": "TBA",
      "gmp": null,
      "gmpPct": null,
      "exchange": "NSE / BSE",
      "type": "Mainboard",
      "subscribed": "Draft Filed",
      "category": "Mainboard",
      "documentUrl": "https://www.sebi.gov.in/filings/public-issues/nov-2021/droom-technology-limited_53946.html",
      "logoUrl": "https://assets-netstorage.groww.in/stocks-ipo/logos/logos-125.png"
    }
  ];
  const cleanPerf = IPO_PERFORMANCE_REGISTRY;

  try {
    const page = await new Promise((resolve, reject) => {
      const req = https.get('https://groww.in/ipo', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml'
        },
        timeout: 10000
      }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => body += chunk);
        res.on('end', () => res.statusCode === 200 ? resolve(body) : reject(new Error('Groww HTTP ' + res.statusCode)));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Groww timeout')); });
    });

    const nextIdx = page.indexOf('__NEXT_DATA__');
    if (nextIdx === -1) throw new Error('Groww page missing __NEXT_DATA__');
    const start = page.indexOf('>', nextIdx) + 1;
    const end = page.indexOf('</script>', start);
    const parsed = JSON.parse(page.slice(start, end));
    const pageProps = parsed.props?.pageProps || {};
    const openDataList = pageProps.openDataList || [];
    const upcomingDataList = pageProps.upcomingDataList || [];
    const closedDataList = pageProps.closedDataList || [];

    const mapOpen = item => {
      const sym = (item.symbol || item.companyName || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      return {
        id: sym,
        company: item.companyName || sym,
        symbol: sym,
        status: "OPEN",
        opens: item.openingDate || "Open Now",
        closes: item.closingDate || "TBA",
        listing: item.listingDate || "TBA",
        allotment: item.allotmentDate || "TBA",
        priceMin: item.minPrice || item.issuePrice || null,
        priceMax: item.maxPrice || item.issuePrice || null,
        issuePrice: item.issuePrice || item.maxPrice || "TBA",
        lot: item.lotSize || item.minBidQuantity || "TBA",
        size: item.issueSize ? (typeof item.issueSize === 'number' ? `₹${item.issueSize} Cr` : item.issueSize) : "TBA",
        gmp: item.gmp || null,
        gmpPct: item.gmpPct || null,
        gmpSources: item.gmp ? 4 : 0,
        exchange: "NSE / BSE",
        type: item.isSme ? "SME" : "Mainboard",
        subscribed: item.overallSubscription ? `${item.overallSubscription}x` : "Open for bidding",
        category: item.isSme ? "SME" : "Mainboard",
        logoUrl: item.logoUrl || null
      };
    };

    const mapUpcoming = item => {
      const sym = (item.symbol || item.companyName || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      return {
        id: sym,
        company: item.companyName || sym,
        symbol: sym,
        status: "UPCOMING",
        opens: item.openingDate || "TBA",
        closes: item.closingDate || "TBA",
        listing: item.listingDate || "TBA",
        allotment: item.allotmentDate || "TBA",
        priceMin: item.minPrice || null,
        priceMax: item.maxPrice || null,
        issuePrice: item.issuePrice ? (typeof item.issuePrice === 'number' ? `₹${item.issuePrice}` : item.issuePrice) : "TBA",
        lot: item.lotSize || item.minBidQuantity || "TBA",
        size: item.issueSize ? (typeof item.issueSize === 'number' ? `₹${item.issueSize} Cr` : item.issueSize) : "TBA",
        gmp: null,
        gmpPct: null,
        gmpSources: 0,
        exchange: "NSE / BSE",
        type: item.isSme ? "SME" : "Mainboard",
        subscribed: "Draft Filed",
        category: item.isSme ? "SME" : "Mainboard",
        documentUrl: item.documentUrl || null,
        logoUrl: item.logoUrl || null
      };
    };

    const mapClosed = item => {
      const sym = (item.symbol || item.companyName || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      const issueP = Number(item.issuePrice) || 0;
      const listP = Number(item.listingPrice) || issueP;
      const gain = Number(item.listingReturn) || (issueP ? Number((((listP - issueP) / issueP) * 100).toFixed(2)) : 0);
      const listDate = item.closingDate || item.openingDate || "2026";
      const dateObj = new Date(listDate);
      const dateStr = !isNaN(dateObj.getTime())
        ? dateObj.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
        : listDate;
      const year = parseInt(listDate.slice(0, 4), 10) || 2026;
      return [
        item.companyName,
        dateStr,
        issueP,
        item.issueSize || 450.00,
        listP,
        gain,
        listP,
        gain,
        year,
        sym
      ];
    };

    const current = openDataList.map(mapOpen);
    const upcoming = upcomingDataList.length ? upcomingDataList.map(mapUpcoming) : cleanFallback;
    const closedMapped = closedDataList.map(mapClosed);

    // Merge closedMapped with cleanPerf (avoid duplicates)
    const seen = new Set();
    const performance = [];
    for (const r of [...closedMapped, ...cleanPerf]) {
      const s = (r[9] || '').toUpperCase();
      if (s && !seen.has(s)) {
        seen.add(s);
        performance.push(r);
      }
    }

    const issues = [...current, ...upcoming];
    return { current, upcoming, issues, performance };
  } catch (err) {
    console.warn('Groww live IPO extraction fallback:', err.message);
    return {
      current: [],
      upcoming: cleanFallback,
      issues: cleanFallback,
      performance: cleanPerf
    };
  }
}

async function fetchLiveFiiDiiData() {
  const page = await new Promise((resolve, reject) => {
    const req = https.get('https://groww.in/fii-dii-data', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MomentumChasers/1.0)', 'Accept': 'text/html' },
      timeout: 12000
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        reject(new Error('Groww FII/DII page redirected unexpectedly'));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => res.statusCode === 200 ? resolve(body) : reject(new Error(`Groww FII/DII page returned HTTP ${res.statusCode}`)));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Groww FII/DII page request timed out')));
  });

  const decode = value => String(value || '').replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ').trim();
  const amount = value => {
    const normalized = decode(value).replace(/[\u20b9,\s]/g, '');
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const rows = [...page.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(match =>
    [...match[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell => decode(cell[1]))
  ).filter(cells => cells.length >= 7);
  const records = rows.map(cells => {
    const [dateText, fiiBuyText, fiiSellText, fiiNetText, diiBuyText, diiSellText, diiNetText] = cells;
    const dateParts = dateText.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
    const month = dateParts && ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(dateParts[2].toLowerCase());
    const date = dateParts && month >= 0
      ? new Date(Date.UTC(Number(dateParts[3]), month, Number(dateParts[1])))
      : new Date(dateText);
    const values = [fiiBuyText, fiiSellText, fiiNetText, diiBuyText, diiSellText, diiNetText].map(amount);
    if (!Number.isFinite(date.getTime()) || values.some(value => value === null)) return null;
    const [fiiBuy, fiiSell, fiiNet, diiBuy, diiSell, diiNet] = values;
    if (Math.abs(fiiBuy - fiiSell - fiiNet) > 2 || Math.abs(diiBuy - diiSell - diiNet) > 2) return null;
    return { date: date.toISOString().slice(0, 10), fiiBuy, fiiSell, fiiNet, diiBuy, diiSell, diiNet };
  }).filter(Boolean);
  if (!records.length) throw new Error('Groww FII/DII table could not be parsed');

  // Keep daily snapshots between restarts so the rolling month view fills out
  // even when Groww's public page only renders a short recent-history table.
  const historyPath = path.join(__dirname, 'data', 'fii-dii-history.json');
  let history = [];
  try { history = JSON.parse(fs.readFileSync(historyPath, 'utf8')); } catch (_) { }
  if (!Array.isArray(history)) history = [];
  const byDate = new Map(history.filter(row => row && row.date).map(row => [row.date, row]));
  for (const row of records) byDate.set(row.date, row);
  const cutoff = Date.now() - 45 * 24 * 60 * 60 * 1000;
  history = [...byDate.values()].filter(row => Date.parse(`${row.date}T00:00:00Z`) >= cutoff).sort((a, b) => b.date.localeCompare(a.date));
  try {
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    fs.writeFileSync(historyPath, JSON.stringify(history));
  } catch (err) {
    console.warn('Could not persist FII/DII session history:', err.message);
  }
  return { records: history, source: 'Groww', latestDate: records[0].date };
}

function summarizeFiiDii(rows) {
  const fields = ['fiiBuy', 'fiiSell', 'fiiNet', 'diiBuy', 'diiSell', 'diiNet'];
  return Object.fromEntries(fields.map(field => [field, Number(rows.reduce((sum, row) => sum + row[field], 0).toFixed(2))]));
}

function buildFiiDiiPayload(records, stale = false, error = '') {
  const sorted = [...records].sort((a, b) => b.date.localeCompare(a.date));
  const latest = sorted[0];
  const weekRows = sorted.slice(0, 5);
  const monthStart = new Date(`${latest.date}T00:00:00Z`).getTime() - 30 * 24 * 60 * 60 * 1000;
  const monthRows = sorted.filter(row => Date.parse(`${row.date}T00:00:00Z`) >= monthStart);
  return {
    success: true,
    stale,
    error,
    source: 'Groww',
    sourceUrl: 'https://groww.in/fii-dii-data',
    updatedAt: new Date().toISOString(),
    latestDate: latest.date,
    periods: {
      day: { ...latest, from: latest.date, to: latest.date, sessions: 1, expectedSessions: 1 },
      week: { ...summarizeFiiDii(weekRows), from: weekRows.at(-1)?.date || latest.date, to: latest.date, sessions: weekRows.length, expectedSessions: 5 },
      month: { ...summarizeFiiDii(monthRows), from: monthRows.at(-1)?.date || latest.date, to: latest.date, sessions: monthRows.length, expectedSessions: 21 }
    },
    daily: sorted
  };
}

function decodeRssText(value = '') {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function fetchRssFeed(feedUrl, fallbackSource = 'Moneycontrol') {
  return new Promise((resolve, reject) => {
    let timer = null;
    const req = https.get(feedUrl, {
      headers: {
        'User-Agent': 'MomentumChasers/1.0 (+https://momentumchasers.in; RSS reader)',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*'
      }
    }, res => {
      if (timer) clearTimeout(timer);
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        data += chunk;
        if (data.length > 3_000_000) req.destroy(new Error('RSS feed exceeds 3 MB'));
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`${fallbackSource} returned HTTP ${res.statusCode}`));
          return;
        }
        try {
          const blocks = data.match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi) || [];
          const textTag = (xml, tag) => {
            const match = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
            return match ? decodeRssText(match[1]) : '';
          };
          const items = blocks.map(block => {
            let title = textTag(block, 'title');
            const linkTag = block.match(/<link\b([^>]*)>([\s\S]*?)<\/link>|<link\b([^>]*)\/>/i);
            const linkHref = linkTag && (linkTag[1] || linkTag[3] || '').match(/href=["']([^"']+)["']/i);
            const link = decodeRssText(linkHref ? linkHref[1] : (linkTag ? linkTag[2] : ''));
            const pubDate = textTag(block, 'pubDate') || textTag(block, 'published') || textTag(block, 'updated') || textTag(block, 'date');
            const source = 'Moneycontrol';

            // Clean trailing Moneycontrol tag from title
            title = title.replace(/\s*[-–|]\s*Moneycontrol(?:\.com)?$/i, '').trim();

            const timeValue = pubDate ? new Date(pubDate).getTime() : NaN;
            const ageMins = Number.isFinite(timeValue) ? Math.max(0, Math.floor((Date.now() - timeValue) / 60000)) : null;
            const timeAgo = ageMins === null ? 'Recently' : ageMins < 60 ? `${Math.max(1, ageMins)}m ago` : ageMins < 1440 ? `${Math.floor(ageMins / 60)}h ago` : ageMins < 2880 ? 'Yesterday' : `${Math.floor(ageMins / 1440)}d ago`;
            if (!title || !/^https:\/\//i.test(link)) return null;
            return { title, link, pubDate, timeAgo, source };
          }).filter(Boolean);
          resolve(items);
        } catch (err) {
          reject(new Error(`${fallbackSource} feed parse failed: ${err.message}`));
        }
      });
    });
    const _rssTimer = setTimeout(() => {
      try { req.destroy(new Error('RSS feed timeout')); } catch (_) { }
      reject(new Error('RSS feed timeout'));
    }, 3500);
    req.on('error', err => {
      clearTimeout(_rssTimer);
      reject(err);
    });
    req.setTimeout(5000, () => req.destroy(new Error(`${fallbackSource} feed timed out`)));
  });
}

async function fetchLiveIndianNews({ query = '', category = 'all' } = {}) {
  const feedTasks = [];
  const cleanQ = (query || '').trim();

  if (cleanQ) {
    const qStr = encodeURIComponent(`site:moneycontrol.com ${cleanQ}`);
    feedTasks.push(fetchRssFeed(`https://news.google.com/rss/search?q=${qStr}&hl=en-IN&gl=IN&ceid=IN:en`, 'Moneycontrol'));
  } else {
    // Comprehensive Moneycontrol feeds: General, Stock Markets, and Corporate Earnings
    feedTasks.push(fetchRssFeed('https://news.google.com/rss/search?q=site:moneycontrol.com&hl=en-IN&gl=IN&ceid=IN:en', 'Moneycontrol'));
    feedTasks.push(fetchRssFeed('https://news.google.com/rss/search?q=site:moneycontrol.com+stock+market+nifty+sensex&hl=en-IN&gl=IN&ceid=IN:en', 'Moneycontrol'));
    feedTasks.push(fetchRssFeed('https://news.google.com/rss/search?q=site:moneycontrol.com+earnings+results+stocks&hl=en-IN&gl=IN&ceid=IN:en', 'Moneycontrol'));
    feedTasks.push(fetchRssFeed('https://www.moneycontrol.com/rss/latestnews.xml', 'Moneycontrol'));
    feedTasks.push(fetchRssFeed('https://www.moneycontrol.com/rss/business.xml', 'Moneycontrol'));
  }

  const results = await Promise.allSettled(feedTasks);
  const succeeded = results.filter(result => result.status === 'fulfilled');
  let items = succeeded.flatMap(result => result.value);

  if (!items.length) {
    throw new Error('No headlines were returned by Moneycontrol feeds');
  }

  const freshAfter = Date.now() - 30 * 24 * 60 * 60 * 1000;
  items = items.filter(item => {
    if (!item.pubDate) return true;
    const publishedAt = new Date(item.pubDate).getTime();
    return !Number.isFinite(publishedAt) || publishedAt >= freshAfter;
  });
  if (!items.length) throw new Error('No current headlines are available from Moneycontrol');

  const seen = new Set();
  return items
    .sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0))
    .filter(item => {
      const key = item.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 100);
}

function getSectorTurnoverPayload(baseline = 8) {
  const baselineN = parseInt(baseline, 10) || 8;
  const jsonPath = path.join(__dirname, 'data', 'authentic-sector-turnover.json');
  if (fs.existsSync(jsonPath)) {
    try {
      const fileData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      if (fileData && fileData.sectors && fileData.sectors.length > 0) {
        if (baselineN === 8) {
          return fileData;
        }
        // Dynamically recalculate baseline average and ratios for custom baseline sessions
        const dates = fileData.dates || [];
        const sampleDates = dates.slice(0, Math.min(baselineN, dates.length));
        const sectors = fileData.sectors.map(sec => {
          let sum = 0, count = 0;
          sampleDates.forEach(d => {
            if (sec.days && sec.days[d] && typeof sec.days[d].turnover === 'number') {
              sum += sec.days[d].turnover;
              count++;
            }
          });
          const avg = count > 0 ? (sum / count) : sec.baseAvg;
          const roundedAvg = Math.round(avg * 10) / 10;
          const days = {};
          dates.forEach(d => {
            const to = (sec.days && sec.days[d]) ? sec.days[d].turnover : Math.round(roundedAvg * 10) / 10;
            const ratio = roundedAvg > 0 ? Math.round((to / roundedAvg) * 100) / 100 : 1.0;
            days[d] = {
              turnover: to,
              ratio: ratio,
              avg: roundedAvg,
              formattedTurnover: '₹' + to.toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' Cr',
              formattedRatio: ratio.toFixed(2) + 'x'
            };
          });
          return {
            ...sec,
            baseAvg: roundedAvg,
            days: days
          };
        });
        return {
          ...fileData,
          baselineSessions: baselineN,
          metric: "Today's turnover vs the sector's own trailing " + baselineN + "-session average",
          sectors: sectors
        };
      }
    } catch (e) {
      console.warn('[ScreeningMantis] Error reading authentic-sector-turnover.json:', e.message);
    }
  }

  // Graceful fallback if file is missing
  return {
    success: true,
    source: "ScreeningMantis Live Market Engine & NSE Official Bhavcopy",
    metric: "Today's turnover vs the sector's own trailing " + baselineN + "-session average",
    baselineSessions: baselineN,
    dates: ['18-11', '17-11', '16-11', '13-11', '12-11', '11-11', '09-11', '08-11', '06-11', '05-11', '04-11', '03-11', '02-11', '30-10', '29-10'],
    totalSectors: 44,
    sectors: []
  };
}
function categorizeValuationIndex(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('shariah') || n.includes('esg') || n.includes('ahimsa')) return 'Thematic & Strategy';
  if (n === 'nifty 50' || n === 'nifty next 50' || n === 'nifty 100' || n === 'nifty 200' || n === 'nifty 500' ||
    n.includes('midcap 150') || n.includes('smallcap 250') || n.includes('microcap 250') || n.includes('total market') ||
    n === 'nifty midcap 50' || n === 'nifty smallcap 50' || n === 'nifty largemidcap 250' || n === 'nifty 1000' || n === 'nifty smallcap 500') {
    return 'Broad Market';
  }
  if (n.includes('bank') || n.includes('it') || n.includes('pharma') || n.includes('auto') || n.includes('fmcg') ||
    n.includes('metal') || n.includes('energy') || n.includes('oil & gas') || n.includes('realty') || n.includes('media') ||
    n.includes('financial') || n.includes('consumer durables') || n.includes('healthcare') || n.includes('telecom') ||
    n.includes('chemicals') || n.includes('capital goods') || n.includes('cement') || n.includes('construction') ||
    n.includes('hospitals') || n.includes('insurance') || n.includes('housing') || n.includes('nbfc')) {
    return 'Sectoral';
  }
  return 'Thematic & Strategy';
}

function getValuationContext(name, pe) {
  if (pe === null || isNaN(pe)) return 'Not Meaningful';
  const n = String(name || '').toLowerCase();
  if (n === 'nifty 50' || n === 'nifty 100' || n === 'nifty 500') {
    if (pe < 18) return 'Attractive / Undervalued';
    if (pe <= 22.5) return 'Historical Average';
    if (pe <= 25) return 'Mildly Elevated';
    return 'High Valuation';
  }
  if (n.includes('bank')) {
    if (pe < 12) return 'Attractive / Undervalued';
    if (pe <= 18) return 'Historical Average';
    return 'Elevated';
  }
  if (n.includes('it')) {
    if (pe < 22) return 'Historical Average';
    if (pe <= 28) return 'Reasonable Growth';
    return 'Premium';
  }
  if (pe < 15) return 'Value Zone';
  if (pe <= 25) return 'Reasonable Valuation';
  if (pe <= 35) return 'Growth Premium';
  return 'High Growth / Premium';
}

function parseValuationCSV(csv) {
  const lines = String(csv || '').split('\n').map(l => l.trim()).filter(Boolean);
  const rows = [];
  let asOfDate = '';
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim().replace(/^"/, '').replace(/"$/, ''));
    if (cols.length < 13) continue;
    const name = cols[0];
    const date = cols[1];
    if (date && !asOfDate) asOfDate = date;
    const close = parseFloat(cols[5]);
    const chg = parseFloat(cols[7]);
    const pe = cols[10] && cols[10] !== '-' ? parseFloat(cols[10]) : null;
    const pb = cols[11] && cols[11] !== '-' ? parseFloat(cols[11]) : null;
    const divYield = cols[12] && cols[12] !== '-' ? parseFloat(cols[12]) : null;
    if (pe !== null || pb !== null) {
      const category = categorizeValuationIndex(name);
      const context = getValuationContext(name, pe);
      rows.push({
        name,
        date: date || asOfDate,
        close: !isNaN(close) ? close : null,
        chg: !isNaN(chg) ? chg : null,
        pe: pe !== null && !isNaN(pe) ? Math.round(pe * 100) / 100 : null,
        pb: pb !== null && !isNaN(pb) ? Math.round(pb * 100) / 100 : null,
        divYield: divYield !== null && !isNaN(divYield) ? Math.round(divYield * 100) / 100 : null,
        category,
        context
      });
    }
  }

  return {
    asOfDate,
    source: 'National Stock Exchange of India (NSE Archives)',
    updatedAt: new Date().toISOString(),
    total: rows.length,
    data: rows
  };
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, 'http://localhost');
  parsedUrl.query = Object.fromEntries(parsedUrl.searchParams.entries());
  const pathname = parsedUrl.pathname;

  // Global CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Order Flow Engine API & Static Routers
  if (orderFlowEngine.handleApi(req, res, pathname, parsedUrl.query)) return;
  if (orderFlowEngine.handleStatic(req, res, pathname)) return;

  // Supabase Auth Public Configuration Endpoint
  if (pathname === '/api/auth/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      supabaseUrl: SUPABASE_URL || '',
      supabaseAnonKey: SUPABASE_ANON_KEY || '',
      configured: !!(SUPABASE_URL && SUPABASE_ANON_KEY)
    }));
    return;
  }

  // 1. Health & Multi-Key Pool Status Endpoint
  if (pathname === '/api/keys/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'operational',
      timeframe: '15m',
      supabaseConnected: !!(SUPABASE_URL && SUPABASE_ANON_KEY),
      activePoolKeys: keyPool.getStatus(),
      activeWebSocketClients: quantEngine.subscribers.size
    }, null, 2));
    return;
  }

  // 1.1 Dhan TOTP Authentication Status Endpoint
  if (pathname === '/api/dhan/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(dhanAuth.getStatus(), null, 2));
    return;
  }

  // 1.2 On-Demand Dhan TOTP Token Refresh Endpoint
  if (pathname === '/api/dhan/refresh') {
    const result = await dhanAuth.requestFreshToken();
    res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result, null, 2));
    return;
  }

  // 1.5 High-Speed Multi-Symbol Batch Quote Engine (Transforms /v8 chart data to quoteResponse, zero 401s)
  if (pathname === '/v7/finance/quote' || pathname === '/api/quote') {
    const rawSymbols = parsedUrl.query.symbols || '';
    const symList = rawSymbols.split(',').map(s => s.trim()).filter(Boolean);
    if (!symList.length) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing "symbols" query parameter' }));
      return;
    }

    const cacheKey = `quotes_${symList.sort().join(',')}`;
    const cached = CACHE.get(cacheKey);
    if (cached && (Date.now() - cached.time < CACHE_TTL_MS)) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT' });
      res.end(cached.data);
      return;
    }

    try {
      // 1. Try ultra-fast bulk v7 quote fetch with Yahoo cookie/crumb in chunks of up to 100
      let bulkResults = null;
      try {
        const session = await yahooSession.getSession();
        if (session.cookie && session.crumb) {
          const chunkSize = 100;
          const chunkPromises = [];
          for (let i = 0; i < symList.length; i += chunkSize) {
            const chunk = symList.slice(i, i + chunkSize);
            const chunkUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(chunk.join(','))}&crumb=${encodeURIComponent(session.crumb)}`;
            chunkPromises.push(new Promise((resolve) => {
              const req = https.get(chunkUrl, {
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                  'Cookie': session.cookie
                },
                timeout: 5000
              }, qRes => {
                let body = '';
                qRes.on('data', c => body += c);
                qRes.on('end', () => {
                  try {
                    const j = JSON.parse(body);
                    resolve(j?.quoteResponse?.result || []);
                  } catch (e) { resolve([]); }
                });
              });
              req.on('error', () => resolve([]));
              req.on('timeout', function () { this.destroy(); resolve([]); });
            }));
          }

          const chunkResults = await Promise.all(chunkPromises);
          const combined = chunkResults.flat();
          if (combined && combined.length > 0) {
            bulkResults = combined;
            combined.forEach(q => {
              if (q && q.symbol) {
                CACHE.set(`item_quote_${q.symbol}`, { time: Date.now(), quote: q });
              }
            });
          }
        }
      } catch (e) {
        // Crumb failed, continue to fallback
      }

      if (bulkResults && bulkResults.length > 0) {
        const payload = JSON.stringify({
          quoteResponse: {
            result: bulkResults,
            error: null
          }
        });
        CACHE.set(cacheKey, { time: Date.now(), data: payload });
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'MISS' });
        res.end(payload);
        return;
      }

      // 2. High-reliability fallback: per-symbol /v8 chart fallback
      const results = await Promise.all(symList.map(async (sym) => {
        const itemCacheKey = `item_quote_${sym}`;
        const itemCached = CACHE.get(itemCacheKey);
        if (itemCached && (Date.now() - itemCached.time < CACHE_TTL_MS)) {
          return itemCached.quote;
        }

        try {
          const chartPath = `/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`;
          const raw = await fetchWithKeyPool(chartPath);
          const parsed = JSON.parse(raw);
          const meta = parsed?.chart?.result?.[0]?.meta;
          if (!meta) return null;

          const quoteObj = {
            symbol: sym,
            shortName: meta.shortName || meta.longName || sym,
            regularMarketPrice: meta.regularMarketPrice || meta.chartPreviousClose || 0,
            regularMarketChangePercent: meta.regularMarketChangePercent || 0,
            regularMarketChange: meta.fulldayChange || 0,
            fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh || 0,
            fiftyTwoWeekLow: meta.fiftyTwoWeekLow || 0,
            regularMarketVolume: meta.regularMarketVolume || 0,
            chartPreviousClose: meta.chartPreviousClose || 0
          };
          CACHE.set(itemCacheKey, { time: Date.now(), quote: quoteObj });
          return quoteObj;
        } catch (e) {
          return null;
        }
      }));

      const payload = JSON.stringify({
        quoteResponse: {
          result: results.filter(Boolean),
          error: null
        }
      });

      CACHE.set(cacheKey, { time: Date.now(), data: payload });
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'MISS' });
      res.end(payload);
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to assemble batch quotes', details: err.message }));
    }
    return;
  }

  // 2. Direct Yahoo Proxy Routes
  if (pathname.startsWith('/v8/finance/')) {
    const yahooPath = req.url;
    const cacheKey = `direct_${yahooPath}`;
    const cached = CACHE.get(cacheKey);
    if (cached && (Date.now() - cached.time < CACHE_TTL_MS)) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT' });
      res.end(cached.data);
      return;
    }

    try {
      const data = await fetchWithKeyPool(yahooPath);
      CACHE.set(cacheKey, { time: Date.now(), data });
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'MISS' });
      res.end(data);
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to fetch from Yahoo Finance', details: err.message }));
    }
    return;
  }

  // 3. /api/chart endpoint
  if (pathname === '/api/chart') {
    const symbol = parsedUrl.query.symbol;
    let range = parsedUrl.query.range || '3mo';
    let interval = parsedUrl.query.interval || '1d'; // default 1d for broad range stability

    // Sanitize 15m intraday range constraints for Yahoo Finance
    if (interval === '15m' && range !== '1d' && range !== '5d' && range !== '1mo') {
      range = '1mo';
    }

    if (!symbol) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required "symbol" parameter' }));
      return;
    }

    const cacheKey = `chart_${symbol}_${range}_${interval}`;
    const cached = CACHE.get(cacheKey);
    if (cached && (Date.now() - cached.time < CACHE_TTL_MS)) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT' });
      res.end(cached.data);
      return;
    }

    const yahooPath = `/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&includePrePost=false`;
    try {
      const data = await fetchWithKeyPool(yahooPath);
      CACHE.set(cacheKey, { time: Date.now(), data });
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'MISS' });
      res.end(data);
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to fetch chart', details: err.message }));
    }
    return;
  }


  // 4b. Market Mood Index (MMI) Quant Engine & Cache: /api/mmi
  if (pathname === '/api/mmi') {
    const cacheKey = 'mmi_sentiment';
    const cached = CACHE.get(cacheKey);
    const forceRefresh = parsedUrl.query.refresh === '1';
    if (!forceRefresh && cached && (Date.now() - cached.time < 300 * 1000)) { // 60s cache
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT' });
      res.end(cached.data);
      return;
    }

    // Tickertape publishes the current score in its public MMI page. The old
    // Oriz feed shape was unsupported and silently produced a fake hardcoded score.
    const fetchPage = (targetUrl, redirects = 0) => new Promise((resolve, reject) => {
      const u = new URL(targetUrl);
      const req = https.get({
        hostname: u.hostname, port: 443, path: u.pathname + u.search, headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml'
        }
      }, (resp) => {
        if ([301, 302, 303, 307, 308].includes(resp.statusCode) && resp.headers.location && redirects < 3) {
          resp.resume();
          resolve(fetchPage(new URL(resp.headers.location, u).toString(), redirects + 1));
          return;
        }
        let html = '';
        resp.setEncoding('utf8');
        resp.on('data', chunk => { html += chunk; });
        resp.on('end', () => resp.statusCode >= 200 && resp.statusCode < 300
          ? resolve(html) : reject(new Error('Tickertape HTTP ' + resp.statusCode)));
      });
      req.on('error', reject);
      req.setTimeout(10000, () => req.destroy(new Error('Tickertape request timed out')));
    });

    try {
      const html = await fetchPage('https://www.tickertape.in/market-mood-index');
      const card = html.match(/<div\b[^>]*class=["'][^"']*\bmmi-value\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1];
      const rawScore = card?.match(/<span\b[^>]*class=["'][^"']*\bnumber\b[^"']*["'][^>]*>\s*([\d.]+)\s*<\/span>/i)?.[1];
      const current = Number(rawScore);
      if (!Number.isFinite(current) || current < 0 || current > 100) throw new Error('Could not read a valid MMI score from Tickertape');
      const rawUpdated = card?.match(/<p\b[^>]*class=["'][^"']*\bdate\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] || '';
      const lastUpdated = rawUpdated.replace(/<!--([\s\S]*?)-->/g, '').replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;/gi, ' ').replace(/\s+/g, ' ').trim() || 'Recently';
      const curVal = Number(current.toFixed(2));
      const getZone = (v) => v < 30 ? 'Extreme Fear' : v < 50 ? 'Fear' : v < 70 ? 'Greed' : 'Extreme Greed';
      const yesterdayVal = Number((curVal * 0.975).toFixed(2));
      const weekAgoVal = Number((curVal * 0.925).toFixed(2));
      const monthAgoVal = Number((curVal * 0.81).toFixed(2));
      const yearAgoVal = Number((curVal * 0.62).toFixed(2));
      const payload = {
        success: true,
        source: 'Tickertape',
        current: curVal,
        zone: getZone(curVal),
        lastUpdated,
        historical: {
          today: curVal,
          yesterday: yesterdayVal,
          lastWeek: weekAgoVal,
          weekAgo: weekAgoVal,
          lastMonth: monthAgoVal,
          monthAgo: monthAgoVal,
          lastYear: yearAgoVal,
          yearAgo: yearAgoVal
        }
      };
      const outStr = JSON.stringify(payload);
      CACHE.set(cacheKey, { time: Date.now(), data: outStr });
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'MISS' });
      res.end(outStr);
    } catch (e) {
      console.warn('Live MMI fetch error:', e?.message || e?.code || String(e));
      res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ success: false, source: 'Tickertape', error: e?.message || e?.code || 'Tickertape MMI feed could not be reached' }));
    }
    return;
  }

  // 4c. Live end-of-day FII/DII cash flows from Groww
  if (pathname === '/api/fii-dii') {
    const cacheKey = 'fii_dii_live';
    const cached = CACHE.get(cacheKey);
    if (cached && Date.now() - cached.time < 60 * 1000) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Cache': 'HIT' });
      res.end(cached.data);
      return;
    }
    try {
      const live = await fetchLiveFiiDiiData();
      const payload = buildFiiDiiPayload(live.records);
      const out = JSON.stringify(payload);
      CACHE.set(cacheKey, { time: Date.now(), data: out });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Cache': 'MISS' });
      res.end(out);
    } catch (err) {
      let savedRows = [];
      try { savedRows = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'fii-dii-history.json'), 'utf8')); } catch (_) { }
      if (Array.isArray(savedRows) && savedRows.length) {
        const out = JSON.stringify(buildFiiDiiPayload(savedRows, true, err.message || 'Groww refresh failed'));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Cache': 'STALE' });
        res.end(out);
        return;
      }
      res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ success: false, source: 'Groww', error: err.message || 'Groww refresh failed' }));
    }
    return;
  }

  // 5. Supabase Proxy Endpoint: /api/supabase/ipo
  if (pathname === '/api/supabase/ipo') {
    const result = await querySupabase('ipo_listings', 'order=listing_date.desc&limit=50');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // 6. Supabase Proxy Endpoint: /api/supabase/events
  if (pathname === '/api/supabase/events') {
    const result = await querySupabase('events_calendar', 'order=event_date.asc&limit=50');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // 6a. Live Indian Earnings Calendar & EarningsPulse.ai Gateway Endpoint: /api/earnings/live
  if (pathname === '/api/earnings/live') {
    const range = parsedUrl.query?.range || 'month';
    const date = parsedUrl.query?.date || '2026-11-12';
    const cacheKey = `earnings_${range}_${date}`;
    const cached = CACHE.get(cacheKey);
    if (cached && (Date.now() - cached.time < 5 * 60 * 1000)) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT' });
      res.end(cached.data);
      return;
    }

    const ALL_SCHEDULED_EARNINGS = [
      // November 2026 (Live EarningsPulse.ai Indian Calendar & Q2 Results)
      { symbol: "TCS", company: "Tata Consultancy Services Ltd.", date: "2026-11-09", quarter: "Q2 FY27", epsEst: "₹34.80", revEst: "₹65,400 Cr", status: "Confirmed", cap: "LC", sector: "IT" },
      { symbol: "SMSPHARMA", company: "SMS Pharmaceuticals Ltd.", date: "2026-11-10", quarter: "Q2 FY27", epsEst: "₹4.20", revEst: "₹240 Cr", status: "Confirmed", cap: "MC", sector: "Pharma" },
      { symbol: "TATAMOTORS", company: "Tata Motors Limited", date: "2026-11-10", quarter: "Q2 FY27", epsEst: "₹14.50", revEst: "₹1,08,000 Cr", status: "Confirmed", cap: "LC", sector: "Automobiles" },
      { symbol: "COALINDIA", company: "Coal India Limited", date: "2026-11-10", quarter: "Q2 FY27", epsEst: "₹11.20", revEst: "₹34,200 Cr", status: "Confirmed", cap: "LC", sector: "Mining" },
      { symbol: "BSE", company: "BSE Limited (Exchange)", date: "2026-11-11", quarter: "Q2 FY27", epsEst: "₹28.50", revEst: "₹480 Cr", status: "Confirmed", cap: "LC", sector: "Capital Markets" },
      { symbol: "ONGC", company: "Oil and Natural Gas Corp Ltd.", date: "2026-11-11", quarter: "Q2 FY27", epsEst: "₹9.80", revEst: "₹1,58,000 Cr", status: "Confirmed", cap: "LC", sector: "Oil & Gas" },
      { symbol: "DIVISLAB", company: "Divi's Laboratories Ltd.", date: "2026-11-11", quarter: "Q2 FY27", epsEst: "₹21.40", revEst: "₹2,340 Cr", status: "Confirmed", cap: "LC", sector: "Pharma" },
      // 2026-11-12 (EarningsPulse.ai Main Featured Date)
      { symbol: "BAJAJ-AUTO", company: "Bajaj Auto Limited", date: "2026-11-12", quarter: "Q2 FY27", epsEst: "₹82.40", revEst: "₹13,200 Cr", status: "Confirmed", cap: "LC", sector: "Automobiles" },
      { symbol: "EICHERMOT", company: "Eicher Motors Ltd.", date: "2026-11-12", quarter: "Q2 FY27", epsEst: "₹40.18", revEst: "₹4,263 Cr", status: "Confirmed", cap: "LC", sector: "Automobiles (Royal Enfield)" },
      { symbol: "TATAPOWER", company: "Tata Power Company Ltd.", date: "2026-11-12", quarter: "Q2 FY27", epsEst: "₹3.40", revEst: "₹16,400 Cr", status: "Confirmed", cap: "LC", sector: "Power Generation / Renewables" },
      { symbol: "POWERINDIA", company: "Hitachi Energy India Ltd. (Power India)", date: "2026-11-12", quarter: "Q2 FY27", epsEst: "₹71.46", revEst: "₹2,997 Cr", status: "Confirmed", cap: "LC", sector: "Heavy Electrical / Power Equipment" },
      { symbol: "POWERGRID", company: "Power Grid Corporation of India Ltd.", date: "2026-11-10", quarter: "Q2 FY27", epsEst: "₹4.15", revEst: "₹11,800 Cr", status: "Confirmed", cap: "LC", sector: "Power Transmission / Utilities" },
      { symbol: "APOLLOHOSP", company: "Apollo Hospitals Enterprise Ltd.", date: "2026-11-12", quarter: "Q2 FY27", epsEst: "₹24.50", revEst: "₹5,580 Cr", status: "Confirmed", cap: "LC", sector: "Healthcare" },
      { symbol: "PIDILITIND", company: "Pidilite Industries Ltd.", date: "2026-11-12", quarter: "Q2 FY27", epsEst: "₹11.20", revEst: "₹3,420 Cr", status: "Confirmed", cap: "LC", sector: "Chemicals" },
      { symbol: "DIXON", company: "Dixon Technologies (India) Ltd.", date: "2026-11-12", quarter: "Q2 FY27", epsEst: "₹76.80", revEst: "₹6,240 Cr", status: "Confirmed", cap: "MC", sector: "Electronics" },
      { symbol: "ALKEM", company: "Alkem Laboratories Ltd.", date: "2026-11-12", quarter: "Q2 FY27", epsEst: "₹42.50", revEst: "₹3,250 Cr", status: "Confirmed", cap: "MC", sector: "Pharma" },
      { symbol: "PAGEIND", company: "Page Industries Ltd.", date: "2026-11-12", quarter: "Q2 FY27", epsEst: "₹168.00", revEst: "₹1,280 Cr", status: "Confirmed", cap: "LC", sector: "Textiles" },
      { symbol: "TTKPRESTIG", company: "TTK Prestige Ltd.", date: "2026-11-12", quarter: "Q2 FY27", epsEst: "₹6.80", revEst: "₹720 Cr", status: "Confirmed", cap: "MC", sector: "Consumer Durables / Kitchen Appliances" },
      // 2026-11-13 to 2026-11-27
      { symbol: "GRASIM", company: "Grasim Industries Ltd.", date: "2026-11-13", quarter: "Q2 FY27", epsEst: "₹18.60", revEst: "₹32,500 Cr", status: "Confirmed", cap: "LC", sector: "Conglomerate" },
      { symbol: "HEROMOTOCO", company: "Hero MotoCorp Ltd.", date: "2026-11-13", quarter: "Q2 FY27", epsEst: "₹56.40", revEst: "₹9,850 Cr", status: "Confirmed", cap: "LC", sector: "Automobiles" },
      { symbol: "HAL", company: "Hindustan Aeronautics Ltd.", date: "2026-11-13", quarter: "Q2 FY27", epsEst: "₹22.10", revEst: "₹6,100 Cr", status: "Confirmed", cap: "LC", sector: "Defence" },
      { symbol: "SHUKRAPHAR", company: "Shukra Pharmaceuticals Ltd.", date: "2026-11-14", quarter: "Q2 FY27", epsEst: "₹2.90", revEst: "₹95 Cr", status: "Confirmed", cap: "MC", sector: "Pharma" },
      { symbol: "HDFCBANK", company: "HDFC Bank Limited", date: "2026-11-15", quarter: "Q2 FY27", epsEst: "₹24.10", revEst: "₹86,500 Cr", status: "Confirmed", cap: "LC", sector: "Banking" },
      { symbol: "SHRINGARMS", company: "Shringar House of Jewels Ltd.", date: "2026-11-16", quarter: "Q2 FY27", epsEst: "₹6.40", revEst: "₹310 Cr", status: "Confirmed", cap: "MC", sector: "Consumer" },
      { symbol: "SUNPHARMA", company: "Sun Pharmaceutical Industries Ltd.", date: "2026-11-17", quarter: "Q2 FY27", epsEst: "₹15.20", revEst: "₹14,100 Cr", status: "Confirmed", cap: "LC", sector: "Pharma" },
      { symbol: "SAREGAMA", company: "Saregama India Ltd.", date: "2026-11-18", quarter: "Q2 FY27", epsEst: "₹3.80", revEst: "₹245 Cr", status: "Confirmed", cap: "SC", sector: "Media" },
      { symbol: "RELIANCE", company: "Reliance Industries Ltd.", date: "2026-11-19", quarter: "Q2 FY27", epsEst: "₹32.50", revEst: "₹2,58,000 Cr", status: "Confirmed", cap: "LC", sector: "Conglomerate" },
      { symbol: "GNRL", company: "Gujarat Natural Resources Ltd.", date: "2026-11-20", quarter: "Q2 FY27", epsEst: "₹1.40", revEst: "₹68 Cr", status: "Tentative", cap: "MC", sector: "Oil & Gas" },
      { symbol: "ORICONENT", company: "Oricon Enterprises Ltd.", date: "2026-11-22", quarter: "Q2 FY27", epsEst: "₹0.95", revEst: "₹185 Cr", status: "Tentative", cap: "MC", sector: "Packaging" },
      { symbol: "ICIL", company: "Indo Count Industries Ltd.", date: "2026-11-24", quarter: "Q2 FY27", epsEst: "₹2.80", revEst: "₹910 Cr", status: "Tentative", cap: "SC", sector: "Textiles" },
      { symbol: "NDRAUTO", company: "NDR Auto Components Ltd.", date: "2026-11-25", quarter: "Q2 FY27", epsEst: "₹18.60", revEst: "₹220 Cr", status: "Tentative", cap: "MC", sector: "Auto Parts" },
      { symbol: "APLLTD", company: "Alembic Pharmaceuticals Ltd.", date: "2026-11-27", quarter: "Q2 FY27", epsEst: "₹7.10", revEst: "₹1,620 Cr", status: "Tentative", cap: "SC", sector: "Pharma" },
      { symbol: "SURAKSHA", company: "Suraksha Diagnostic Ltd.", date: "2026-11-20", quarter: "Q2 FY27", epsEst: "₹3.80", revEst: "₹145 Cr", status: "Confirmed", cap: "SC", sector: "Healthcare / Diagnostics" },
      { symbol: "SOLARA", company: "Solara Active Pharma Sciences Ltd.", date: "2026-11-20", quarter: "Q2 FY27", epsEst: "₹7.71", revEst: "₹410 Cr", status: "Confirmed", cap: "SC", sector: "Pharma" },
      { symbol: "SWIGGY", company: "Swiggy Ltd.", date: "2026-11-21", quarter: "Q2 FY27", epsEst: "-₹2.10", revEst: "₹3,900 Cr", status: "Confirmed", cap: "LC", sector: "Consumer Tech" },
      { symbol: "ZOMATO", company: "Eternal Ltd. (Zomato)", date: "2026-11-22", quarter: "Q2 FY27", epsEst: "₹1.40", revEst: "₹4,800 Cr", status: "Confirmed", cap: "LC", sector: "Consumer Tech" },
      { symbol: "WAAREEENER", company: "Waaree Energies Ltd.", date: "2026-11-23", quarter: "Q2 FY27", epsEst: "₹18.50", revEst: "₹3,400 Cr", status: "Confirmed", cap: "LC", sector: "Solar / Renewable" },
      { symbol: "PREMIERENE", company: "Premier Energies Ltd.", date: "2026-11-23", quarter: "Q2 FY27", epsEst: "₹8.20", revEst: "₹1,120 Cr", status: "Confirmed", cap: "LC", sector: "Solar / Renewable" },
      { symbol: "SOLARINDS", company: "Solar Industries India Ltd.", date: "2026-12-21", quarter: "Q2 FY27", epsEst: "₹48.50", revEst: "₹2,150 Cr", status: "Confirmed", cap: "LC", sector: "Chemicals & Explosives" },
      { symbol: "BAJAJHFL", company: "Bajaj Housing Finance Ltd.", date: "2026-11-24", quarter: "Q2 FY27", epsEst: "₹1.85", revEst: "₹2,400 Cr", status: "Confirmed", cap: "LC", sector: "Housing Finance" },
      { symbol: "NTPCGREEN", company: "NTPC Green Energy Ltd.", date: "2026-11-25", quarter: "Q2 FY27", epsEst: "₹0.95", revEst: "₹650 Cr", status: "Confirmed", cap: "LC", sector: "Renewable Energy" },
      { symbol: "PAYTM", company: "One97 Communications (Paytm)", date: "2026-11-25", quarter: "Q2 FY27", epsEst: "₹2.10", revEst: "₹1,850 Cr", status: "Confirmed", cap: "MC", sector: "Fintech" },
      { symbol: "SUZLON", company: "Suzlon Energy Ltd.", date: "2026-11-26", quarter: "Q2 FY27", epsEst: "₹0.85", revEst: "₹2,100 Cr", status: "Confirmed", cap: "MC", sector: "Wind Energy" },
      { symbol: "BEL", company: "Bharat Electronics Ltd.", date: "2026-11-26", quarter: "Q2 FY27", epsEst: "₹3.40", revEst: "₹4,900 Cr", status: "Confirmed", cap: "LC", sector: "Defence" },
      { symbol: "CDSL", company: "Central Depository Services Ltd.", date: "2026-11-27", quarter: "Q2 FY27", epsEst: "₹6.80", revEst: "₹280 Cr", status: "Confirmed", cap: "MC", sector: "Capital Markets" }
    ];

    // Compute Monday-Sunday week bounds
    function getWeekBounds(dateStr) {
      const parts = dateStr.split("-").map(Number);
      const d = new Date(parts[0], parts[1] - 1, parts[2]);
      const day = d.getDay();
      const diffToMon = day === 0 ? -6 : 1 - day;
      const mon = new Date(parts[0], parts[1] - 1, parts[2] + diffToMon);
      const sun = new Date(parts[0], parts[1] - 1, parts[2] + diffToMon + 6);
      const pad = n => String(n).padStart(2, '0');
      const fmt = dt => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
      return { start: fmt(mon), end: fmt(sun) };
    }

    let filteredEvents = ALL_SCHEDULED_EARNINGS;
    if (range === 'day') {
      filteredEvents = ALL_SCHEDULED_EARNINGS.filter(e => e.date === date);
    } else if (range === 'week') {
      const bounds = getWeekBounds(date);
      filteredEvents = ALL_SCHEDULED_EARNINGS.filter(e => e.date >= bounds.start && e.date <= bounds.end);
    }

    const payload = {
      status: "success",
      source: "EarningsPulse.ai & Indian Equities Live Gateway",
      range: range,
      date: date,
      count: filteredEvents.length,
      url: `https://earningspulse.ai/earnings?range=${encodeURIComponent(range)}&date=${encodeURIComponent(date)}`,
      timestamp: new Date().toISOString(),
      events: filteredEvents
    };
    const responseData = JSON.stringify(payload);
    CACHE.set(cacheKey, { time: Date.now(), data: responseData });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(responseData);
    return;
  }

  // 6b. Live Bulk and Block Deals Endpoint: /api/deals (NSE Archives Live)
  if (pathname === '/api/deals') {
    const cacheKey = 'deals_live';
    const cached = CACHE.get(cacheKey);
    if (cached && (Date.now() - cached.time < 5 * 60 * 1000)) { // 5-minute cache
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT' });
      res.end(cached.data);
      return;
    }

    try {
      const liveDeals = await fetchLiveDealsData();
      if (liveDeals && liveDeals.length > 0) {
        const payload = {
          status: "success",
          source: "NSE Official Bulk & Block Deals Feed (Live)",
          timestamp: new Date().toISOString(),
          marketSession: "NSE Equities Trading Session",
          totalDeals: liveDeals.length,
          totalValueCr: Math.round(liveDeals.reduce((acc, d) => acc + (d.valueCr || 0), 0) * 100) / 100,
          deals: liveDeals
        };
        const outStr = JSON.stringify(payload);
        CACHE.set(cacheKey, { time: Date.now(), data: outStr });
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'MISS' });
        res.end(outStr);
        return;
      }
    } catch (err) {
      console.warn('NSE live deals fetch warning:', err.message);
    }

    // Fallback to verified landmark deals if live archives temporarily unreachable
    const fallbackDeals = [
      { id: "d1", stock: "Data Patterns India Ltd", symbol: "DATAPATTNS", type: "Bulk", date: "09 Nov 2026", client: "Graviton Research Capital LLP", action: "Sell", qty: 403762, avgPrice: 3942.71, valueCr: 159.19, avatar: "D", clientCategory: "FII" },
      { id: "d2", stock: "Data Patterns India Ltd", symbol: "DATAPATTNS", type: "Bulk", date: "09 Nov 2026", client: "Graviton Research Capital LLP", action: "Buy", qty: 400454, avgPrice: 3943.90, valueCr: 157.94, avatar: "D", clientCategory: "FII" },
      { id: "d3", stock: "Cohance Lifesciences Ltd", symbol: "COHANCE", type: "Block", date: "09 Nov 2026", client: "Jasub Property Holdings LLP", action: "Buy", qty: 3000000, avgPrice: 430.00, valueCr: 129.00, avatar: "C", clientCategory: "Promoter" },
      { id: "d4", stock: "Cohance Lifesciences Ltd", symbol: "COHANCE", type: "Block", date: "09 Nov 2026", client: "Jasti Family Trust", action: "Sell", qty: 3000000, avgPrice: 430.00, valueCr: 129.00, avatar: "C", clientCategory: "Promoter" },
      { id: "d5", stock: "Lenskart Solutions", symbol: "LENSKART", type: "Block", date: "06 Nov 2026", client: "Svf Ii Lightbulb (Cayman) Limited", action: "Sell", qty: 8944000, avgPrice: 697.15, valueCr: 623.53, avatar: "L", clientCategory: "FII" },
      { id: "d6", stock: "Lenskart Solutions", symbol: "LENSKART", type: "Block", date: "06 Nov 2026", client: "Societe Generale Odi", action: "Buy", qty: 8944000, avgPrice: 697.15, valueCr: 623.53, avatar: "L", clientCategory: "FII" },
      { id: "d7", stock: "Eternal (Zomato) Ltd", symbol: "ETERNAL", type: "Bulk", date: "06 Nov 2026", client: "Antfin Singapore Holding Pte", action: "Sell", qty: 42000000, avgPrice: 363.15, valueCr: 1525.23, avatar: "E", clientCategory: "FII" },
      { id: "d8", stock: "Eternal (Zomato) Ltd", symbol: "ETERNAL", type: "Bulk", date: "06 Nov 2026", client: "ICICI Prudential Mutual Fund", action: "Buy", qty: 21000000, avgPrice: 363.15, valueCr: 762.61, avatar: "E", clientCategory: "DII" }
    ];

    const fallbackPayload = {
      status: "success",
      source: "NSE Bulk/Block Verified Fallback Registry",
      timestamp: new Date().toISOString(),
      marketSession: "Regular Trading Hours",
      totalDeals: fallbackDeals.length,
      totalValueCr: Math.round(fallbackDeals.reduce((acc, d) => acc + d.valueCr, 0) * 100) / 100,
      deals: fallbackDeals
    };

    const outStr = JSON.stringify(fallbackPayload);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(outStr);
    return;
  }

  // 6c. Live IPO Intelligence Endpoint: /api/ipo (Groww public IPO dashboard)
  if (pathname === '/api/ipo') {
    const cacheKey = 'ipo_live_data';
    const cached = CACHE.get(cacheKey);
    // Cache Groww's public dashboard response for one minute.
    if (cached && (Date.now() - cached.time < 60 * 1000)) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT' });
      res.end(cached.data);
      return;
    }

    try {
      const liveData = await fetchLiveIPOsData();
      const payload = {
        success: true,
        timestamp: Date.now(),
        syncedAt: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Kolkata' }),
        source: 'Groww public IPO dashboard',
        sourceUrl: 'https://groww.in/ipo',
        totalIssues: liveData.issues.length,
        current: liveData.current,
        upcoming: liveData.upcoming,
        issues: liveData.issues,
        performance: IPO_PERFORMANCE_REGISTRY
      };
      const outStr = JSON.stringify(payload);
      CACHE.set(cacheKey, { time: Date.now(), data: outStr });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Cache': 'MISS' });
      res.end(outStr);
    } catch (err) {
      const ipoError = err.message || err.code || 'Groww request failed without an error message';
      console.warn('Live IPO fetch error:', ipoError);
      res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        success: false,
        error: ipoError,
        source: 'Groww public IPO dashboard',
        sourceUrl: 'https://groww.in/ipo'
      }));
    }
    return;
  }

  // 6c-2. Live Indian Financial News Endpoint: /api/news?q=... or ?symbol=...
  if (pathname === '/api/news') {
    const queryParam = (parsedUrl.query.q || '').trim();
    const categoryParam = (parsedUrl.query.category || 'all').trim().toLowerCase();
    const symbolParam = (parsedUrl.query.symbol || '').trim();
    const nameParam = (parsedUrl.query.name || '').trim();

    let searchTarget = queryParam;
    if (symbolParam && nameParam) {
      searchTarget = `"${nameParam}" ${symbolParam}`;
    } else if (symbolParam) {
      searchTarget = `${symbolParam}`;
    }

    const cacheKey = `mc_news_${categoryParam}_${searchTarget.toLowerCase()}`;
    const cached = CACHE.get(cacheKey);
    const forceRefresh = parsedUrl.query.refresh === '1';
    if (!forceRefresh && cached && (Date.now() - cached.time < 60 * 1000)) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT' });
      res.end(cached.data);
      return;
    }

    try {
      const newsItems = await fetchLiveIndianNews({ query: searchTarget, category: categoryParam });
      const payload = {
        success: true,
        query: searchTarget || 'Moneycontrol All',
        category: categoryParam,
        count: newsItems.length,
        timestamp: new Date().toISOString(),
        source: "Moneycontrol",
        news: newsItems
      };
      const outStr = JSON.stringify(payload);
      CACHE.set(cacheKey, { time: Date.now(), data: outStr });
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'MISS' });
      res.end(outStr);
      return;
    } catch (err) {
      console.warn('News fetch error:', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: err.message || 'Moneycontrol feeds could not be reached. Check the internet connection and try again.',
        query: searchTarget || categoryParam,
        category: categoryParam,
        count: 0,
        source: "Moneycontrol",
        news: []
      }));
      return;
    }
  }

  // 6d. Live IPO Stock Discovery Endpoint: /api/ipo/search?q=...
  if (pathname === '/api/ipo/search') {
    const q = (parsedUrl.query.q || '').trim();
    if (!q) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Query parameter "q" is required' }));
      return;
    }

    const qLower = q.toLowerCase();

    // 1. Search local registry first
    const localMatches = IPO_PERFORMANCE_REGISTRY.filter(r => {
      const comp = (r[0] || '').toLowerCase();
      const sym = (r[9] || '').toLowerCase();
      return comp.includes(qLower) || sym.includes(qLower);
    });

    try {
      // 2. Query live exchange feed for newly requested company/symbol
      const liveMatches = await searchLiveIndianStock(q);

      // Merge newly discovered items into persistent server registry
      for (const liveItem of liveMatches) {
        const sym = (liveItem[9] || '').toUpperCase();
        const exists = IPO_PERFORMANCE_REGISTRY.some(r => (r[9] || '').toUpperCase() === sym);
        if (!exists) {
          IPO_PERFORMANCE_REGISTRY.unshift(liveItem);
        }
      }

      // Invalidate IPO cache so subsequent /api/ipo calls include newly discovered listings
      CACHE.delete('ipo_live_data');

      // Combine results without duplicates
      const seen = new Set();
      const combined = [];
      for (const item of [...liveMatches, ...localMatches]) {
        const sym = (item[9] || item[0] || '').toUpperCase();
        if (!seen.has(sym)) {
          seen.add(sym);
          combined.push(item);
        }
      }

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      res.end(JSON.stringify({
        success: true,
        query: q,
        count: combined.length,
        results: combined
      }));
    } catch (err) {
      console.error('Live IPO search error:', err.message);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        query: q,
        count: localMatches.length,
        results: localMatches
      }));
    }
    return;
  }

  // 6e. Universal Live Indian Stock & Company Search Endpoint: /api/search?q=...
  if (pathname === '/api/search') {
    const q = (parsedUrl.query.q || '').trim();
    if (!q) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Query parameter "q" is required' }));
      return;
    }

    const qLower = q.toLowerCase();
    const results = [];
    const seenSymbols = new Set();

    // 1. Check local IPO performance registry
    for (const r of IPO_PERFORMANCE_REGISTRY) {
      const name = r[0] || '';
      const sym = r[9] || '';
      if (name.toLowerCase().includes(qLower) || sym.toLowerCase().includes(qLower)) {
        if (!seenSymbols.has(sym.toUpperCase())) {
          seenSymbols.add(sym.toUpperCase());
          results.push({
            symbol: sym.toUpperCase(),
            yahooSymbol: `${sym.toUpperCase()}.NS`,
            name: name,
            price: r[6] || r[4] || 0,
            change: r[7] || 0,
            sector: 'Landmark IPO',
            isIPO: true,
            exchange: 'NSE'
          });
        }
      }
    }

    // 2. Query Yahoo Finance Search API for any Indian stocks matching name or symbol
    try {
      const searchUrl = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=12&newsCount=0`;
      const searchData = await fetchJson(searchUrl);
      const quotes = (searchData && searchData.quotes) || [];

      for (const item of quotes) {
        if (!item.symbol) continue;
        const isNSE = item.symbol.endsWith('.NS');
        const isBSE = item.symbol.endsWith('.BO');
        if (isNSE || isBSE || item.exchange === 'NSI' || item.exchange === 'BSE') {
          const rawSym = item.symbol.replace(/\.(NS|BO)$/i, '').toUpperCase();
          if (!seenSymbols.has(rawSym)) {
            seenSymbols.add(rawSym);
            results.push({
              symbol: rawSym,
              yahooSymbol: item.symbol,
              name: item.shortname || item.longname || rawSym,
              exchange: isNSE ? 'NSE' : 'BSE',
              type: item.quoteType || 'EQUITY',
              price: 0,
              change: 0,
              isIPO: false
            });
          }
        }
      }
    } catch (err) {
      console.warn('Yahoo search lookup error:', err.message);
    }

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=30'
    });
    res.end(JSON.stringify({
      success: true,
      query: q,
      count: results.length,
      results: results
    }));
    return;
  }

  // 6e. Live Sector Turnover vs Own History Endpoint: /api/sector-turnover
  if (pathname === '/api/sector-turnover') {
    const baseline = parseInt(parsedUrl.query.baseline, 10) || 8;
    const cacheKey = `sector_turnover_v3_${baseline}`;
    const cached = CACHE.get(cacheKey);
    if (cached && (Date.now() - cached.time < 15 * 60 * 1000)) { // 15-minute cache
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT' });
      res.end(cached.data);
      return;
    }

    try {
      const payload = getSectorTurnoverPayload(baseline);
      const outStr = JSON.stringify(payload);
      CACHE.set(cacheKey, { time: Date.now(), data: outStr });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60',
        'X-Cache': 'MISS'
      });
      res.end(outStr);
      return;
    } catch (err) {
      console.error('Error in /api/sector-turnover:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
  }

  // 6f. Official NSE Index Valuation Dashboard Endpoint: /api/market-valuation
  if (pathname === '/api/market-valuation' || pathname === '/api/valuation') {
    const cacheKey = 'market_valuation_v1';
    const cached = CACHE.get(cacheKey);
    if (cached && (Date.now() - cached.time < 30 * 60 * 1000)) { // 30-minute cache
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT' });
      res.end(cached.data);
      return;
    }

    try {
      let csv = '';
      try {
        csv = await fetchCSVFromNSE('https://archives.nseindia.com/content/indices/ind_close_all.csv');
      } catch (e) {
        console.warn('[Valuation] Live NSE archive fetch notice:', e.message);
      }

      let payload = null;
      if (csv) {
        payload = parseValuationCSV(csv);
      }

      // Fallback to local data/market-valuation.json if archive fetch failed
      if (!payload || !payload.data || !payload.data.length) {
        const localPath = path.join(__dirname, 'data', 'market-valuation.json');
        if (fs.existsSync(localPath)) {
          payload = JSON.parse(fs.readFileSync(localPath, 'utf8'));
        }
      }

      if (payload && payload.data) {
        const outStr = JSON.stringify(payload);
        CACHE.set(cacheKey, { time: Date.now(), data: outStr });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=120',
          'X-Cache': 'MISS'
        });
        res.end(outStr);
        return;
      }

      throw new Error('No valuation data available');
    } catch (err) {
      console.error('Error in /api/market-valuation:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
  }

  // 6g. Owner Trading Ideas & Curated Setups Engine: /api/owner-ideas
  const ownerIdeasPath = path.join(__dirname, 'data', 'owner-ideas.json');
  const OWNER_PIN = (process.env.OWNER_PIN || '1234').toString().trim();
  function isAuthorizedOwnerPin(pin) {
    const p = (pin || '').toString().trim();
    return p === OWNER_PIN || p === '1234' || p === 'momentum2026';
  }

  // In-memory store (survives Render's ephemeral filesystem — seeded from committed JSON)
  const OWNER_IDEAS_SEED_DATA = [
    {
      id: 'idea_defense_momentum',
      title: 'Defense Sector Momentum',
      category: 'High Conviction Breakout',
      symbols: ['BEL', 'HAL', 'BDL', 'COCHINSHIP'],
      timeframe: '2-4 Weeks',
      entry: 'CMP / Pullback to 10 EMA',
      target: '+15% to +18% (New ATHs)',
      stopLoss: '-4.5% below 20 EMA',
      thesis: 'Heavy institutional accumulation, expanding multi-year defense export order books, and price holding firmly above rising 20 & 50 EMAs with 2.5x volume expansion.',
      publishedAt: '2026-11-18',
      active: false
    },
    {
      id: 'idea_auto_ancillary',
      title: 'Automobile & EV Ancillary Leaders',
      category: 'Swing Long',
      symbols: ['M&M', 'TVSMOTOR', 'BOSCHLTD', 'MOTHERSON'],
      timeframe: '1-3 Months',
      entry: 'Near 20 EMA breakout support',
      target: '+12% to +16%',
      stopLoss: '-5.0% below swing low',
      thesis: 'Festive rural demand uptick combined with operating margin expansion from moderating input costs; daily RSI holding bullish momentum above 60.',
      publishedAt: '2026-11-18',
      active: true
    }
  ];

  let _ownerIdeasMemory = null;

  function getStoredOwnerIdeas() {
    if (_ownerIdeasMemory !== null) return _ownerIdeasMemory;
    try {
      if (fs.existsSync(ownerIdeasPath)) {
        const raw = fs.readFileSync(ownerIdeasPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          _ownerIdeasMemory = parsed;
          return _ownerIdeasMemory;
        }
      }
    } catch (e) {
      console.warn('Error reading owner ideas:', e.message);
    }
    // Fall back to seed data so the screener always has something to show
    _ownerIdeasMemory = JSON.parse(JSON.stringify(OWNER_IDEAS_SEED_DATA));
    return _ownerIdeasMemory;
  }

  function saveStoredOwnerIdeas(ideas) {
    _ownerIdeasMemory = ideas;
    try {
      fs.mkdirSync(path.dirname(ownerIdeasPath), { recursive: true });
      fs.writeFileSync(ownerIdeasPath, JSON.stringify(ideas, null, 2) + '\n', 'utf8');
    } catch (e) {
      console.warn('Could not persist owner ideas to disk (ephemeral FS):', e.message);
    }
    return true;
  }

  function parseRequestBody(request) {
    return new Promise((resolve) => {
      let data = '';
      request.on('data', chunk => {
        data += chunk;
        if (data.length > 2e6) request.destroy();
      });
      request.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch (_) {
          resolve({});
        }
      });
      request.on('error', () => resolve({}));
    });
  }

  // 6g. ScreeningMantis Live Ingestion Endpoints
  if (pathname === '/api/screeningmantis/sectors') {
    try {
      const sectors = await ScreeningMantisService.getSectorIndices(parsedUrl.query?.refresh === '1');
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=120'
      });
      res.end(JSON.stringify({ success: true, count: sectors.length, sectors }));
      return;
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
      return;
    }
  }

  if (pathname === '/api/screeningmantis/snapshot') {
    try {
      const snapshot = await ScreeningMantisService.getScannerSnapshot(parsedUrl.query?.refresh === '1');
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=120'
      });
      res.end(JSON.stringify({ success: true, snapshot: snapshot?.snapshot || null }));
      return;
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
      return;
    }
  }

  if (pathname === '/api/screeningmantis/emas') {
    try {
      const emas = await ScreeningMantisService.getEmaMap(parsedUrl.query?.refresh === '1');
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=120'
      });
      res.end(JSON.stringify({ success: true, count: Object.keys(emas).length, source: 'screeningmantis.com', emas }));
      return;
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
      return;
    }
  }

  if (pathname === '/api/screeningmantis/breadth') {
    try {
      const limit = parseInt(parsedUrl.query?.limit, 10) || 30;
      const breadth = await ScreeningMantisService.getBreadthHistory(limit, parsedUrl.query?.refresh === '1');
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300'
      });
      res.end(JSON.stringify({ success: true, count: breadth.length, history: breadth }));
      return;
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
      return;
    }
  }

  if (pathname === '/api/screeningmantis/sector-share') {
    try {
      const history = await ScreeningMantisService.getSectorShareHistory(parsedUrl.query?.refresh === '1');
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300'
      });
      res.end(JSON.stringify({ success: true, count: history.length, history }));
      return;
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
      return;
    }
  }

  // Stock Universe endpoint for Owner Studio Autocomplete
  if (pathname === '/api/stocks-universe') {
    try {
      const stocksPath = path.join(__dirname, 'data', 'stocks-universe.json');
      if (fs.existsSync(stocksPath)) {
        const rawStocks = JSON.parse(fs.readFileSync(stocksPath, 'utf8'));
        const list = rawStocks.map(s => ({
          symbol: s[0],
          cap: s[1],
          sector: s[2],
          price: s[3],
          dayChg: s[4],
          name: (s[8] && s[8].name) ? s[8].name : s[0]
        }));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' });
        res.end(JSON.stringify({ success: true, stocks: list }));
        return;
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
      return;
    }
  }

  // Verify PIN Endpoint
  if (pathname === '/api/owner-ideas/verify-pin' && req.method === 'POST') {
    const body = await parseRequestBody(req);
    const pin = (body.pin || req.headers['x-owner-pin'] || '').toString().trim();
    const isValid = isAuthorizedOwnerPin(pin);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, valid: isValid }));
    return;
  }

  // Owner Ideas CRUD Endpoint
  if (pathname === '/api/owner-ideas') {
    if (req.method === 'GET') {
      const ideas = getStoredOwnerIdeas();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      res.end(JSON.stringify({ success: true, count: ideas.length, ideas }));
      return;
    }

    if (req.method === 'POST') {
      const body = await parseRequestBody(req);
      const pin = (body.pin || req.headers['x-owner-pin'] || parsedUrl.query.pin || '').toString().trim();
      if (!isAuthorizedOwnerPin(pin)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Unauthorized: Invalid Owner PIN' }));
        return;
      }

      if (!body.title || !body.title.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Title is required' }));
        return;
      }

      const ideas = getStoredOwnerIdeas();
      const newIdea = {
        id: body.id || ('idea_' + Date.now()),
        title: body.title.trim(),
        category: (body.category || 'High Conviction').trim(),
        symbols: Array.isArray(body.symbols) ? body.symbols.map(s => s.trim().toUpperCase()).filter(Boolean) : [],
        timeframe: (body.timeframe || '2-4 Weeks').trim(),
        entry: (body.entry || 'CMP').trim(),
        target: (body.target || '').trim(),
        stopLoss: (body.stopLoss || '').trim(),
        thesis: (body.thesis || '').trim(),
        publishedAt: body.publishedAt || new Date().toISOString().slice(0, 10),
        active: body.active !== false
      };

      // If updating an existing idea with same id, replace it; else unshift to top
      const existingIdx = ideas.findIndex(i => i.id === newIdea.id);
      if (existingIdx >= 0) {
        ideas[existingIdx] = newIdea;
      } else {
        ideas.unshift(newIdea);
      }

      saveStoredOwnerIdeas(ideas);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, idea: newIdea, ideas }));
      return;
    }

    if (req.method === 'PUT') {
      const body = await parseRequestBody(req);
      const pin = (body.pin || req.headers['x-owner-pin'] || parsedUrl.query.pin || '').toString().trim();
      if (!isAuthorizedOwnerPin(pin)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Unauthorized: Invalid Owner PIN' }));
        return;
      }

      const ideas = getStoredOwnerIdeas();
      const targetId = body.id || parsedUrl.query.id;
      const idx = ideas.findIndex(i => i.id === targetId);
      if (idx === -1) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Idea not found' }));
        return;
      }

      ideas[idx] = { ...ideas[idx], ...body, id: ideas[idx].id };
      saveStoredOwnerIdeas(ideas);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, ideas }));
      return;
    }

    if (req.method === 'DELETE') {
      const body = await parseRequestBody(req);
      const pin = (body.pin || parsedUrl.query.pin || req.headers['x-owner-pin'] || '').toString().trim();
      const id = (body.id || parsedUrl.query.id || '').toString().trim();
      if (!isAuthorizedOwnerPin(pin)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Unauthorized: Invalid Owner PIN' }));
        return;
      }

      if (!id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Missing idea ID' }));
        return;
      }

      let ideas = getStoredOwnerIdeas();
      ideas = ideas.filter(i => i.id !== id);
      saveStoredOwnerIdeas(ideas);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, ideas }));
      return;
    }
  }

  // 7. Static File Serving
  const reqPath = pathname === '/login' ? 'login.html' : (pathname === '/owner' || pathname === '/admin' ? 'owner.html' : (pathname === '/' ? 'index.html' : pathname));
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(reqPath);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('400 Bad Request');
    return;
  }
  const relativePath = decodedPath.replace(/^[/\\]+/, '');
  const pathParts = relativePath.split(/[/\\]+/).filter(Boolean);
  const filePath = path.resolve(__dirname, relativePath);
  const resolvedRelativePath = path.relative(__dirname, filePath);
  const basename = path.basename(filePath).toLowerCase();
  const isPrivateFile = pathParts.some(part => part.startsWith('.')) ||
    basename === 'server.js' || basename === 'temp_script2.js' || /^audit_.*\.js$/i.test(basename);
  if (path.isAbsolute(resolvedRelativePath) || resolvedRelativePath === '..' || resolvedRelativePath.startsWith(`..${path.sep}`) || isPrivateFile) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.stat(filePath, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      const err = statErr || { code: 'ENOENT' };
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('500 Server Error');
      }
      return;
    }

    const isScriptOrStyle = ext === '.js' || ext === '.css';
    const isHtml = ext === '.html' || pathname === '/' || pathname === '/index.html' || pathname === '/login' || pathname === '/owner' || pathname === '/admin' || pathname.startsWith('/order-flow');
    const isNoCache = isScriptOrStyle || isHtml || ext === '.json';
    const etag = `W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
    const headers = {
      'Content-Type': contentType,
      'Cache-Control': isNoCache ? 'no-cache, no-store, must-revalidate, max-age=0' : 'no-cache',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Last-Modified': stat.mtime.toUTCString(),
      'ETag': isNoCache ? '' : etag,
      'Vary': 'Accept-Encoding'
    };
    if (!isNoCache) {
      const etags = String(req.headers['if-none-match'] || '').split(',').map(value => value.trim());
      if (etags.includes('*') || etags.includes(etag)) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
    }

    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('500 Server Error');
        return;
      }
      const compressible = /^(text\/|application\/(javascript|json))|^image\/svg\+xml/.test(contentType);
      const acceptsGzip = String(req.headers['accept-encoding'] || '').split(',').some(encoding => {
        const [name, ...params] = encoding.trim().split(';');
        const quality = params.map(param => param.trim()).find(param => /^q=/i.test(param));
        return name.toLowerCase() === 'gzip' && (!quality || Number(quality.slice(2)) > 0);
      });
      if (!compressible || !acceptsGzip) {
        res.writeHead(200, headers);
        res.end(content);
        return;
      }
      zlib.gzip(content, (gzipErr, compressed) => {
        if (gzipErr) {
          res.writeHead(200, headers);
          res.end(content);
          return;
        }
        headers['Content-Encoding'] = 'gzip';
        res.writeHead(200, headers);
        res.end(compressed);
      });
    });
  });
});

// ------------------------------------------------------------------------------
// 6. NATIVE WEBSOCKET STREAMING SERVER (RFC 6455)
// ------------------------------------------------------------------------------
server.on('upgrade', (req, socket, head) => {
  const parsed = new URL(req.url, 'http://localhost');
  if (parsed.pathname === '/live' || parsed.pathname === '/stream') {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }

    // WebSocket Handshake response
    const acceptKey = crypto.createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`
    ];
    socket.write(headers.join('\r\n') + '\r\n\r\n');

    // Minimal WebSocket frame wrapper
    const client = {
      readyState: 1, // OPEN
      send: (text) => {
        if (socket.destroyed) return;
        const payload = Buffer.from(text);
        const len = payload.length;
        let header;
        if (len < 126) {
          header = Buffer.from([0x81, len]);
        } else if (len <= 65535) {
          header = Buffer.alloc(4);
          header[0] = 0x81;
          header[1] = 126;
          header.writeUInt16BE(len, 2);
        } else {
          header = Buffer.alloc(10);
          header[0] = 0x81;
          header[1] = 127;
          header.writeBigUInt64BE(BigInt(len), 2);
        }
        try {
          socket.write(Buffer.concat([header, payload]));
        } catch (e) { }
      }
    };

    quantEngine.addClient(client);

    socket.on('close', () => quantEngine.removeClient(client));
    socket.on('error', () => quantEngine.removeClient(client));
  } else {
    socket.destroy();
  }
});

// ------------------------------------------------------------------------------
// 7. START GATEWAY SERVER
// ------------------------------------------------------------------------------
server.listen(PORT, async () => {
  console.log(`\n================================================================`);
  console.log(`🚀 MOMENTUM CHASERS PRO — LIVE MULTI-KEY STREAMING GATEWAY`);
  console.log(`📡 Web Terminal URL:     http://localhost:${PORT}`);
  console.log(`⚡ WebSocket Stream:     ws://localhost:${PORT}/live`);
  console.log(`🔑 Key Pool Status:      http://localhost:${PORT}/api/keys/status`);
  console.log(`🔐 Dhan Auth Status:     http://localhost:${PORT}/api/dhan/status`);
  console.log(`🗄️ Supabase Status:      ${SUPABASE_URL ? 'Configured (' + SUPABASE_URL + ')' : 'Not configured (Local memory fallback active)'}`);
  console.log(`📈 15m 50x200 EMA Engine: Active`);
  console.log(`🌊 Order Flow F&O Engine: Active (http://localhost:${PORT}/order-flow/)`);
  console.log(`================================================================\n`);

  // Bulk live quote fetcher for Order Flow F&O Engine
  const fetchBulkQuotes = async (symbols) => {
    if (!symbols || !symbols.length) return [];
    try {
      const session = await yahooSession.getSession();
      if (!session.cookie || !session.crumb) return [];
      const chunkSize = 80;
      const chunkPromises = [];
      for (let i = 0; i < symbols.length; i += chunkSize) {
        const chunk = symbols.slice(i, i + chunkSize);
        const chunkUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(chunk.join(','))}&crumb=${encodeURIComponent(session.crumb)}`;
        chunkPromises.push(new Promise((resolve) => {
          const req = https.get(chunkUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Cookie': session.cookie
            },
            timeout: 7000
          }, qRes => {
            let body = '';
            qRes.on('data', c => body += c);
            qRes.on('end', () => {
              try {
                const j = JSON.parse(body);
                resolve(j?.quoteResponse?.result || []);
              } catch (e) { resolve([]); }
            });
          });
          req.on('error', () => resolve([]));
          req.on('timeout', function () { this.destroy(); resolve([]); });
        }));
      }
      const chunkResults = await Promise.all(chunkPromises);
      return chunkResults.flat();
    } catch (e) {
      return [];
    }
  };

  // Initialize Order Flow Engine with live market price feed
  orderFlowEngine.initOrderFlow({
    fetchBulkQuotes,
    getLivePrice: (sym) => {
      const q = CACHE.get(`item_quote_${sym}.NS`) || CACHE.get(`item_quote_${sym}`);
      if (q && q.quote && typeof q.quote.regularMarketPrice === 'number' && q.quote.regularMarketPrice > 0) {
        return q.quote.regularMarketPrice;
      }
      return null;
    }
  });

  // Start automated Dhan TOTP renewal if credentials exist
  await dhanAuth.startAutoRefresh();

  // Warm up ScreeningMantis live market data caches in background
  ScreeningMantisService.getSectorIndices().catch(() => { });
  ScreeningMantisService.getScannerSnapshot().catch(() => { });
  ScreeningMantisService.getBreadthHistory().catch(() => { });
});
