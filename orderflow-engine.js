/**
 * ==============================================================================
 * Order Flow Engine for Momentum Chasers PRO
 * ==============================================================================
 * Self-contained live F&O money-flow & options scanner engine.
 * Generates and serves:
 *   GET /api/status                 Status & metadata of the F&O universe
 *   GET /api/market                 Nearest-expiry option chains across ~217 underlyings
 *   GET /api/market/:date/:minute   Historical intraday minute snapshot
 *   GET /api/futures/:symbol        Intraday futures candles & open interest
 *   GET /order-flow/*               Order Flow React application static bundle
 * 
 * Zero external npm dependencies (native Node.js)
 * ==============================================================================
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = __dirname;
const ORDERFLOW_DIR = path.join(ROOT, 'order-flow');
const MINUTE = 60_000;
const SESSION_MINUTES = 375; // 09:15 to 15:30 IST
const REPLAY_FROM = 5;

// Load universe
let universe = [];
const underlyingsPath = path.join(ORDERFLOW_DIR, 'underlyings.json');
try {
  if (fs.existsSync(underlyingsPath)) {
    const raw = JSON.parse(fs.readFileSync(underlyingsPath, 'utf8'));
    universe = (raw.underlyings || []).filter(u => u && typeof u.symbol === 'string' && u.lot > 0);
  }
} catch (e) {
  console.warn('[OrderFlow] Could not read underlyings.json:', e.message);
}

const bySymbol = new Map(universe.map(u => [u.symbol, u]));

// ── Market Session & Calendar Helpers ─────────────────────────────────────────

const MARKET_OPEN_MINUTE = 9 * 60 + 15;
const CAS_START_MINUTE = 15 * 60 + 15;
const CAS_END_MINUTE = 15 * 60 + 35;
const LEGACY_MARKET_CLOSE_MINUTE = 15 * 60 + 30;
const DERIVATIVES_CLOSE_MINUTE = 15 * 60 + 40;
const CAS_EFFECTIVE_DATE = '2026-08-03';
const IST_OFFSET_MS = 330 * 60_000;

const NSE_HOLIDAYS = new Set([
  '2025-02-26', '2025-03-14', '2025-03-31', '2025-04-10', '2025-04-14', '2025-04-18', '2025-05-01',
  '2025-08-15', '2025-08-27', '2025-10-02', '2025-10-21', '2025-10-22', '2025-11-05', '2025-12-25',
  '2026-01-15', '2026-01-26', '2026-03-03', '2026-03-26', '2026-03-31', '2026-04-03', '2026-04-14',
  '2026-05-01', '2026-05-28', '2026-06-26', '2026-09-14', '2026-10-02', '2026-10-20', '2026-11-10',
  '2026-11-24', '2026-12-25'
]);

function marketParts(time) {
  const ms = typeof time === 'number' ? time : time.getTime();
  if (!Number.isFinite(ms)) throw new RangeError('Invalid time value');
  const ist = new Date(ms + IST_OFFSET_MS);
  const year = ist.getUTCFullYear();
  const month = ist.getUTCMonth() + 1;
  const day = ist.getUTCDate();
  const hour = ist.getUTCHours();
  const minute = ist.getUTCMinutes();
  return {
    year,
    month,
    day,
    weekday: ist.getUTCDay(),
    hour,
    minute,
    dateKey: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    minuteOfDay: hour * 60 + minute,
  };
}

function marketCloseMinuteFor(time) {
  return marketParts(time).dateKey >= CAS_EFFECTIVE_DATE
    ? DERIVATIVES_CLOSE_MINUTE
    : LEGACY_MARKET_CLOSE_MINUTE;
}

function isTradingDay(time) {
  const parts = marketParts(time);
  const isWeekend = parts.weekday === 0 || parts.weekday === 6;
  return !isWeekend && !NSE_HOLIDAYS.has(parts.dateKey);
}

function isMarketSessionTime(time) {
  const parts = marketParts(time);
  const isWeekend = parts.weekday === 0 || parts.weekday === 6;
  const isHoliday = NSE_HOLIDAYS.has(parts.dateKey);
  const closeMinute = marketCloseMinuteFor(time);
  return !isWeekend && !isHoliday && parts.minuteOfDay >= MARKET_OPEN_MINUTE && parts.minuteOfDay <= closeMinute;
}

function getPreviousTradingDay(daysBack, fromDate = new Date()) {
  let currentMs = fromDate.getTime();
  let daysCounted = 0;
  let iterations = 0;
  while (daysCounted < daysBack && iterations < 100) {
    currentMs -= 86400_000;
    const parts = marketParts(currentMs);
    const isWeekend = parts.weekday === 0 || parts.weekday === 6;
    if (!isWeekend && !NSE_HOLIDAYS.has(parts.dateKey)) {
      daysCounted++;
    }
    iterations++;
  }
  return new Date(currentMs);
}

const SESSION_DAY_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' });
let latestSessionMemo = null;

function getLatestTradingSessionDate(fromDate = new Date()) {
  const minute = Math.floor(fromDate.getTime() / 60_000);
  if (latestSessionMemo && latestSessionMemo.minute === minute) return latestSessionMemo.date;
  const parts = marketParts(fromDate);
  const date = !isTradingDay(fromDate) || parts.minuteOfDay < MARKET_OPEN_MINUTE
    ? SESSION_DAY_FORMAT.format(getPreviousTradingDay(1, fromDate))
    : parts.dateKey;
  if (Number.isFinite(minute)) latestSessionMemo = { minute, date };
  return date;
}

function isExpirySettled(expiry, time = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return false;
  const parts = marketParts(time);
  if (expiry < parts.dateKey) return true;
  if (expiry > parts.dateKey) return false;
  return parts.minuteOfDay > marketCloseMinuteFor(time);
}

function filterLiveExpiries(expiries, time = Date.now()) {
  return Array.from(new Set(expiries))
    .filter(expiry => /^\d{4}-\d{2}-\d{2}$/.test(expiry) && !isExpirySettled(expiry, time))
    .sort((a, b) => a.localeCompare(b));
}

// ── Math & PRNG ───────────────────────────────────────────────────────────────

function seeded(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

const gaussOf = random => () => {
  const u = Math.max(1e-12, random());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
};

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const round2 = value => Math.round(value * 100) / 100;
const openOf = session => Date.parse(`${session}T09:15:00+05:30`);

function demoNow(real = Date.now()) {
  if (isMarketSessionTime(real)) return real;
  const session = getLatestTradingSessionDate(new Date(real));
  const loop = (SESSION_MINUTES - REPLAY_FROM) * MINUTE;
  return openOf(session) + REPLAY_FROM * MINUTE + (real % loop);
}

const ymd = ms => new Date(ms).toISOString().slice(0, 10);
const dayMs = date => Date.parse(`${date}T00:00:00Z`);

function lastWeekday(year, month, weekday) {
  const last = new Date(Date.UTC(year, month + 1, 0));
  last.setUTCDate(last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7));
  return ymd(last.getTime());
}

function monthlies(from, count, weekday = 2) {
  const out = [];
  const d = new Date(dayMs(from));
  let year = d.getUTCFullYear();
  let month = d.getUTCMonth();
  while (out.length < count) {
    const date = lastWeekday(year, month, weekday);
    if (date >= from) out.push(date);
    month += 1;
    if (month > 11) { month = 0; year += 1; }
  }
  return out;
}

function weeklies(from, count, weekday) {
  const out = [];
  let t = dayMs(from);
  while (out.length < count) {
    if (new Date(t).getUTCDay() === weekday) out.push(ymd(t));
    t += 86_400_000;
  }
  return out;
}

const INDEX_PRICE = {
  NIFTY: 24600, BANKNIFTY: 52800, FINNIFTY: 24100, MIDCPNIFTY: 12750,
  NIFTYNXT50: 66800, SENSEX: 80900, SENSEX50: 26100, BANKEX: 59800, FOCIT: 41200
};

const STOCK_PRICE = {
  RELIANCE: 1420, HDFCBANK: 980, ICICIBANK: 1380, INFY: 1520, TCS: 3050, SBIN: 860,
  BHARTIARTL: 1950, ITC: 410, LT: 3700, KOTAKBANK: 2100, AXISBANK: 1180, HINDUNILVR: 2450,
  BAJFINANCE: 1000, MARUTI: 15800, SUNPHARMA: 1650, TITAN: 3550, ULTRACEMCO: 12100,
  NTPC: 340, POWERGRID: 290, ONGC: 245, TMPV: 410, TATASTEEL: 170, WIPRO: 245,
  HCLTECH: 1480, TECHM: 1450, ASIANPAINT: 2400, NESTLEIND: 1230, ADANIENT: 2450,
  ADANIPORTS: 1450, COALINDIA: 390, JSWSTEEL: 1150
};

function basePrice(u) {
  if (INDEX_PRICE[u.symbol]) return INDEX_PRICE[u.symbol];
  if (STOCK_PRICE[u.symbol]) return STOCK_PRICE[u.symbol];
  const r = seeded(`price|${u.symbol}`)();
  return Math.exp(Math.log(80) + r * (Math.log(6000) - Math.log(80)));
}

const sessionsCache = new Map();

function sessionOf(session, currentUniverse) {
  let held = sessionsCache.get(session);
  if (held) return held;
  if (sessionsCache.size > 4) sessionsCache.clear();
  const mood = gaussOf(seeded(`mood|${session}`));
  const market = mood() * 0.7 - 0.1;
  const sectorMood = new Map();
  held = new Map();
  for (const u of currentUniverse) {
    const random = seeded(`${session}|${u.symbol}`);
    const gauss = gaussOf(random);
    const index = u.kind === 'index';
    if (u.sector && !sectorMood.has(u.sector)) sectorMood.set(u.sector, gaussOf(seeded(`sector|${session}|${u.sector}`))() * 0.9);
    const beta = index ? 0.85 : 0.6 + random() * 0.8;
    const move = clamp(index ? market * beta + gauss() * 0.25 : market * beta + (sectorMood.get(u.sector) ?? 0) * 1.3 + gauss() * 2.2, -9.5, 9.5);
    const prevClose = basePrice(u) * Math.exp(gaussOf(seeded(`prev|${session}|${u.symbol}`))() * 0.04);
    const sigma = prevClose * (index ? 0.0045 : 0.009) / Math.sqrt(SESSION_MINUTES);
    const walk = [0];
    for (let i = 1; i <= SESSION_MINUTES; i++) walk.push(walk[i - 1] + gauss() * sigma);
    const path = walk.map((w, i) => {
      const t = i / SESSION_MINUTES;
      const drift = prevClose * (1 + (move / 100) * (1 - Math.pow(1 - t, 3)));
      return Math.max(prevClose * 0.5, drift + (w - walk[SESSION_MINUTES] * t));
    });
    const agrees = random() < 0.7;
    const oiMove = (agrees ? 1 : -1) * (0.02 + random() * 0.1);
    const oiLots = index ? 60_000 + random() * 140_000 : 2_000 + random() * 9_000;
    held.set(u.symbol, { u, prevClose, path, oiMove, oiLots });
  }
  sessionsCache.set(session, held);
  return held;
}

const minuteIndex = (session, timeNow) => clamp(Math.floor((timeNow - openOf(session)) / MINUTE), 0, SESSION_MINUTES);

function cdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

function blackScholes(spot, strike, years, vol, call) {
  const t = Math.max(years, 0.5 / 365);
  const d1 = (Math.log(spot / strike) + 0.5 * vol * vol * t) / (vol * Math.sqrt(t));
  const d2 = d1 - vol * Math.sqrt(t);
  const price = call ? spot * cdf(d1) - strike * cdf(d2) : strike * cdf(-d2) - spot * cdf(-d1);
  return { price: Math.max(0.05, price), delta: call ? cdf(d1) : cdf(d1) - 1 };
}

function stepOf(u, price) {
  if (u.kind === 'index') return price > 40000 ? 100 : 50;
  if (price < 250) return 2.5;
  if (price < 500) return 5;
  if (price < 1000) return 10;
  if (price < 2500) return 20;
  if (price < 5000) return 50;
  return 100;
}

// ── Provider Engine ───────────────────────────────────────────────────────────

const provider = {
  id: 'demo',
  label: 'Demo market',
  alwaysLive: true,
  now: () => demoNow(),

  async expiries(u) {
    const today = getLatestTradingSessionDate(new Date(demoNow()));
    if (u.kind === 'index') {
      const weekday = u.exch === 'BSE' ? 4 : 2;
      const weekly = ['NIFTY', 'SENSEX'].includes(u.symbol) ? weeklies(today, 4, weekday) : [];
      return [...new Set([...weekly, ...monthlies(today, 3, weekday)])].sort();
    }
    return monthlies(today, 3);
  },

  async optionChain(u, expiry) {
    const now = demoNow();
    const session = getLatestTradingSessionDate(new Date(now));
    const day = sessionOf(session, universe).get(u.symbol) ?? sessionOf(session, [...universe, u]).get(u.symbol);
    const spot = day.path[minuteIndex(session, now)];
    const random = seeded(`chain|${session}|${u.symbol}|${expiry}`);
    const step = stepOf(u, day.prevClose);
    const atm = Math.round(spot / step) * step;
    const years = Math.max(0, (Date.parse(`${expiry}T15:30:00+05:30`) - now) / (365 * 86_400_000));
    const baseIv = u.kind === 'index' ? 0.13 : 0.26 + random() * 0.12;
    const scale = day.u.lot * (u.kind === 'index' ? 9000 : 1400) * (0.6 + random() * 0.8);
    const strikes = [];
    for (let k = -20; k <= 20; k++) {
      const strike = round2(atm + k * step);
      if (strike <= 0) continue;
      const m = strike / spot - 1;
      const iv = baseIv + 0.9 * m * m + (m < 0 ? -0.15 * m : 0);
      const round = strike % (step * 5) === 0 ? 1.9 : strike % (step * 2) === 0 ? 1.25 : 1;
      const leg = call => {
        const center = spot * (call ? 1.025 : 0.975);
        const itm = call ? strike < spot : strike > spot;
        const oi = Math.round(scale * round * (itm ? 0.35 : 1) * Math.exp(-(((strike - center) / (spot * 0.035)) ** 2)) * (0.75 + random() * 0.5) / day.u.lot) * day.u.lot;
        const now$ = blackScholes(spot, strike, years, iv, call);
        const prev = blackScholes(day.prevClose, strike, years + 1 / 365, iv, call);
        const ltp = round2(now$.price);
        const spread = Math.max(0.05, round2(ltp * 0.004));
        const volume = Math.round(oi * (0.3 + random() * 1.4) / day.u.lot) * day.u.lot;
        return {
          ltp, prevClose: round2(prev.price), oi, prevOi: Math.round(oi / (1 + (random() - 0.35) * 0.3)),
          volume, prevVolume: Math.round(volume * (0.6 + random() * 0.8)), avgPrice: round2((ltp + prev.price) / 2),
          iv: round2(iv * 100), bid: round2(Math.max(0.05, ltp - spread)), ask: round2(ltp + spread),
          bidQty: day.u.lot * (1 + Math.floor(random() * 40)), askQty: day.u.lot * (1 + Math.floor(random() * 40)),
          dayHigh: round2(Math.max(ltp, prev.price) * 1.06), dayLow: round2(Math.min(ltp, prev.price) * 0.94),
          lastTradeAt: now - Math.floor(random() * 20_000), delta: now$.delta,
        };
      };
      strikes.push({ strike, call: leg(true), put: leg(false) });
    }
    return { expiry, at: now, spot: round2(spot), prevClose: round2(day.prevClose), atm, strikes };
  },

  async futures(u, session) {
    const now = demoNow();
    const day = sessionOf(session, universe).get(u.symbol) ?? sessionOf(session, [...universe, bySymbol.get(u.symbol) ?? u]).get(u.symbol);
    const open = openOf(session);
    const closed = now >= open + SESSION_MINUTES * MINUTE ? SESSION_MINUTES : minuteIndex(session, now);
    const months = monthlies(session, 3, u.exch === 'BSE' ? 4 : 2).slice(0, 2);
    return months.map((date, m) => {
      const days = Math.max(0, (dayMs(date) - dayMs(session)) / 86_400_000);
      const basis = 1 + 0.0004 + days * 0.00022;
      const prevOi = Math.round(day.oiLots * (m === 0 ? 1 : 0.18)) * day.u.lot;
      const candles = [];
      for (let i = 0; i < closed; i++) {
        const t = (i + 1) / SESSION_MINUTES;
        const oi = Math.round(prevOi * (1 + day.oiMove * (1 - Math.pow(1 - t, 1.4))));
        candles.push({ at: open + i * MINUTE, close: round2(day.path[i + 1] * basis), oi });
      }
      return { date, prevClose: round2(day.prevClose * basis), prevOi, candles };
    });
  }
};

// ── Market File Serializer ───────────────────────────────────────────────────

const finite = value => typeof value === 'number' && Number.isFinite(value);
const num = value => (finite(value) ? value : 0);
const orNull = value => (finite(value) ? value : null);
const positiveOrNull = value => (finite(value) && value > 0 ? value : null);

function legRow(strike, side, leg, keepIdle = false) {
  const oi = num(leg.oi);
  const volume = num(leg.volume);
  if (!keepIdle && !(oi > 0) && !(volume > 0)) return null;
  return [
    strike, side, round2(num(leg.ltp)), positiveOrNull(leg.prevClose), oi, orNull(leg.prevOi), volume, orNull(leg.prevVolume),
    round2(num(leg.avgPrice) || num(leg.ltp)), finite(leg.iv) ? round2(leg.iv) : null, round2(num(leg.bid)), round2(num(leg.ask)),
    num(leg.bidQty), num(leg.askQty), positiveOrNull(leg.dayHigh), positiveOrNull(leg.dayLow), orNull(leg.lastTradeAt), orNull(leg.delta),
  ];
}

const byStrikeThenSide = (a, b) => a[0] - b[0] || a[1] - b[1];

function encodeSeries(underlying, chain, readAt) {
  const spot = num(chain?.spot);
  if (!(spot > 0)) return null;
  const rows = [];
  const idle = [];
  const ladder = [];
  for (const row of chain.strikes ?? []) {
    const strike = num(row?.strike);
    if (!(strike > 0)) continue;
    let listed = false;
    for (const [side, leg] of [[0, row.call], [1, row.put]]) {
      if (!leg) continue;
      listed = true;
      const encoded = legRow(strike, side, leg);
      if (encoded) rows.push(encoded);
      else idle.push(legRow(strike, side, leg, true));
    }
    if (listed) ladder.push(strike);
  }
  ladder.sort((a, b) => a - b);
  const atm = positiveOrNull(chain.atm) ?? (ladder.length ? ladder.reduce((best, k) => (Math.abs(k - spot) < Math.abs(best - spot) ? k : best)) : null);
  return {
    s: underlying.symbol,
    k: underlying.kind === 'index' ? 'index' : 'stock',
    e: chain.expiry,
    lot: underlying.lot,
    ls: 'catalogue',
    t: Math.round(readAt),
    tp: positiveOrNull(chain.at),
    sp: round2(spot),
    pc: positiveOrNull(chain.prevClose),
    atm,
    r: rows.sort(byStrikeThenSide),
    ks: ladder,
    z: idle.sort(byStrikeThenSide),
  };
}

function marketFile({ at, date, series, minutes, ladders }) {
  return { schema: 1, t: Math.round(at), date, series, minutes, ladders };
}

// ── State & Background Collector ─────────────────────────────────────────────

const ladderCache = { session: '', bySymbol: new Map() };
const state = { ready: false, building: false, latestJson: null, latest: null, lastBuild: null, lastError: null };
const futuresCache = new Map();
const FUTURES_KEEP_MS = 60_000;

async function futuresFor(symbol, session) {
  const key = `${symbol}|${session}`;
  const held = futuresCache.get(key);
  if (held && Date.now() - held.at < FUTURES_KEEP_MS) return held.value;
  const value = provider.futures(bySymbol.get(symbol) || { symbol, kind: 'stock', lot: 100 }, session).then(months => ({ symbol, session, months }));
  futuresCache.set(key, { at: Date.now(), value });
  value.catch(() => futuresCache.delete(key));
  if (futuresCache.size > 2000) futuresCache.delete(futuresCache.keys().next().value);
  return value;
}

async function build() {
  if (state.building) return;
  state.building = true;
  const started = Date.now();
  const clock = provider.now();
  const session = getLatestTradingSessionDate(new Date(clock));
  if (ladderCache.session !== session) { ladderCache.session = session; ladderCache.bySymbol.clear(); }
  const series = [];
  const ladders = {};
  const failed = [];
  let firstError = null;
  let cursor = 0;
  const WORKERS = 8;
  const worker = async () => {
    while (cursor < universe.length) {
      const u = universe[cursor++];
      try {
        let ladder = ladderCache.bySymbol.get(u.symbol);
        if (!ladder) {
          ladder = await provider.expiries(u);
          if (ladder.length) ladderCache.bySymbol.set(u.symbol, ladder);
        }
        const live = filterLiveExpiries(ladder, clock);
        ladders[u.symbol] = live;
        if (!live[0]) continue;
        const chain = await provider.optionChain(u, live[0]);
        const encoded = encodeSeries(u, { ...chain, expiry: chain.expiry || live[0] }, provider.now());
        if (encoded) series.push(encoded); else failed.push(u.symbol);
      } catch (error) {
        failed.push(u.symbol);
        firstError ??= String(error?.message || error);
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: WORKERS }, worker));
    if (!series.length) throw new Error(firstError || 'No underlying answered.');
    const at = provider.now();
    const sorted = series.sort((a, b) => a.s.localeCompare(b.s));
    const file = marketFile({ at, date: session, series: sorted, minutes: [], ladders });
    state.latest = file;
    state.latestJson = JSON.stringify(file);
    state.ready = true;
    state.lastBuild = { at, ms: Date.now() - started, series: series.length, failed: failed.length };
    state.lastError = null;
    console.log(`[OrderFlow] Market build: ${series.length} series in ${Date.now() - started}ms`);
  } catch (error) {
    console.warn('[OrderFlow] Market build failed:', error.message);
    state.lastError = { at: Date.now(), message: error.message };
  } finally {
    state.building = false;
  }
}

function schedule() {
  const wait = 60_000 - (Date.now() % 60_000) + 3_000;
  setTimeout(async () => {
    await build();
    schedule();
  }, wait);
}

// ── Static Files & HTTP Routing ───────────────────────────────────────────────

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon'
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
};

function sendJson(res, status, data) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
}

function serveStaticFile(res, filePath) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': mime,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400'
  });
  fs.createReadStream(filePath).pipe(res);
}

// ── Public Export ─────────────────────────────────────────────────────────────

module.exports = {
  initOrderFlow() {
    console.log(`[OrderFlow] Initializing Order Flow Engine with ${universe.length} underlyings...`);
    build();
    schedule();
  },

  handleApi(req, res, pathname, query = {}) {
    // 1. Status API
    if (pathname === '/api/status' || pathname === '/api/orderflow/status') {
      const timeNow = provider.now();
      const session = getLatestTradingSessionDate(new Date(timeNow));
      sendJson(res, 200, {
        provider: { id: provider.id, label: provider.label, alwaysLive: true },
        ready: state.ready,
        clock: timeNow,
        session,
        market: state.latest ? { at: state.latest.t, date: state.latest.date, series: state.latest.series.length } : null,
        lastBuild: state.lastBuild,
        lastError: state.lastError,
        universe: universe.length
      });
      return true;
    }

    // 2. Market File API
    if (pathname === '/api/market' || pathname === '/api/orderflow/market') {
      if (!state.latestJson) {
        sendJson(res, 503, { error: 'Order Flow market is still loading...' });
        return true;
      }
      sendJson(res, 200, state.latestJson);
      return true;
    }

    // 3. Futures API
    if (pathname.startsWith('/api/futures/') || pathname.startsWith('/api/orderflow/futures/')) {
      const prefix = pathname.startsWith('/api/orderflow/futures/') ? '/api/orderflow/futures/' : '/api/futures/';
      const rawSymbol = decodeURIComponent(pathname.slice(prefix.length)).trim().toUpperCase();
      const session = query.session || getLatestTradingSessionDate(new Date(provider.now()));
      futuresFor(rawSymbol, session)
        .then(data => sendJson(res, 200, data))
        .catch(err => sendJson(res, 500, { error: err.message }));
      return true;
    }

    return false;
  },

  handleStatic(req, res, pathname) {
    // Order Flow sub-app
    if (pathname === '/order-flow' || pathname === '/order-flow/') {
      serveStaticFile(res, path.join(ORDERFLOW_DIR, 'index.html'));
      return true;
    }

    if (pathname.startsWith('/order-flow/')) {
      const relPath = pathname.slice('/order-flow/'.length);
      const filePath = path.join(ORDERFLOW_DIR, relPath);
      serveStaticFile(res, filePath);
      return true;
    }

    // Direct asset fallbacks if requested from root
    if (pathname === '/underlyings.json') {
      serveStaticFile(res, path.join(ORDERFLOW_DIR, 'underlyings.json'));
      return true;
    }

    if (pathname.startsWith('/brand/')) {
      const filePath = path.join(ORDERFLOW_DIR, pathname);
      serveStaticFile(res, filePath);
      return true;
    }

    return false;
  }
};
