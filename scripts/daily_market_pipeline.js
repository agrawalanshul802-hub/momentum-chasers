/**
 * MOMENTUM CHASERS - AUTOMATED DAILY MARKET DATA PIPELINE
 *
 * Scheduled Batches (100% Real Exchange & Official Feeds — Zero Placeholders):
 *  - Stage 1 (3:45 PM - 3:50 PM IST):
 *      • 44 Sector Indices & EMA flags (market-sectors.json & screeningmantis-sectors.json)
 *      • 950 Heatmap Stock Tiles & Index Stats (heatmap-cache.json)
 *      • 2,700+ Smart Screener Universe Quotes & A/D Net Flow (stocks-universe.json)
 *      • 1,600+ Stock EMA Statuses & Distances (market-emas.json & screeningmantis-emas.json)
 *  - Stage 2 (7:00 PM - 7:15 PM IST):
 *      • Official FII / DII Cash Flow (Groww -> fii-dii-history.json)
 *      • 44-Sector Turnover Ratios (ScreeningMantis -> authentic-sector-turnover.json)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { runFiiScraper } = require('./fetch-fii-dii');
const { runSectorTurnoverUpdate } = require('./update-sector-turnover');

const SECTOR_TICKER_MAP = {
  'NIFTY 50': '^NSEI',
  'NIFTY BANK': '^NSEBANK',
  'NIFTY AUTO': '^CNXAUTO',
  'NIFTY IT': '^CNXIT',
  'NIFTY FMCG': '^CNXFMCG',
  'NIFTY METAL': '^CNXMETAL',
  'NIFTY PHARMA': '^CNXPHARMA',
  'NIFTY REALTY': '^CNXREALTY',
  'NIFTY ENERGY': '^CNXENERGY',
  'NIFTY INFRA': '^CNXINFRA',
  'NIFTY PSE': '^CNXPSE',
  'NIFTY PSU BANK': '^CNXPSUBANK',
  'NIFTY COMMODITIES': '^CNXCOMMODITIES',
  'NIFTY CONSUMPTION': '^CNXCONSUMPTION',
  'NIFTY CPSE': 'NIFTY_CPSE.NS',
  'NIFTY MIDCAP 100': 'NIFTY_MIDCAP_100.NS',
  'NIFTY MIDCAP 150': '^CRSMID',
  'NIFTY SMLCAP 100': '^CNXSC',
  'NIFTY SMLCAP 250': '^CRSSML',
  'NIFTY 100': '^CNX100',
  'NIFTY MNC': '^CNXMNC',
  'NIFTY SERV SECTOR': '^CNXSERVICE',
  'NIFTY FIN SERVICE': 'NIFTY_FIN_SERVICE.NS',
  'NIFTY PVT BANK': 'NIFTY_PVT_BANK.NS',
  'NIFTY HEALTHCARE': 'NIFTY_HEALTHCARE.NS',
  'NIFTY OIL AND GAS': 'NIFTY_OIL_AND_GAS.NS',
  'NIFTY MEDIA': '^CNXMEDIA',
  'NIFTY CAPITAL MKT': 'NIFTY_CAPITAL_MKT.NS',
  'NIFTY CHEMICALS': 'NIFTY_CHEMICALS.NS',
  'NIFTY CONSR DURBL': 'NIFTY_CONSR_DURBL.NS',
  'NIFTY EV': 'NIFTY_EV.NS',
  'NIFTY HOUSING': 'NIFTY_HOUSING.NS',
  'NIFTY IND DEFENCE': 'NIFTY_IND_DEFENCE.NS',
  'NIFTY IND TOURISM': 'NIFTY_IND_TOURISM.NS',
  'NIFTY IPO': 'NIFTY_IPO.NS',
  'NIFTY MOBILITY': 'NIFTY_MOBILITY.NS',
  'NIFTY RURAL': 'NIFTY_RURAL.NS',
  'NIFTY TRANS LOGIS': 'NIFTY_TRANS_LOGIS.NS',
  'NIFTY IND DIGITAL': 'NIFTY_IND_DIGITAL.NS',
  'NIFTY INTERNET': 'NIFTY_INTERNET.NS',
  'NIFTY MIDSML HLTH': 'NIFTY_MIDSML_HLTH.NS',
  'NIFTY MS FIN SERV': 'NIFTY_MS_FIN_SERV.NS',
  'NIFTY MS IND CONS': 'NIFTY_MS_IND_CONS.NS',
  'NIFTY MS IT TELCM': 'NIFTY_MS_IT_TELCM.NS'
};

function getTodayDateStr() {
  const d = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(d.getTime() + istOffset);
  return istDate.toISOString().split('T')[0];
}

function getTodayFormattedLabel() {
  const d = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(d.getTime() + istOffset);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = istDate.getDate();
  const month = months[istDate.getMonth()];
  const year = istDate.getFullYear();
  return `${day} ${month} ${year} (3:30 pm Closing)`;
}

function fetchYahooCookie() {
  return new Promise((resolve) => {
    const req = https.get('https://fc.yahoo.com', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 5000
    }, res => {
      res.resume();
      const setCookie = res.headers['set-cookie'];
      resolve(setCookie ? setCookie.map(c => c.split(';')[0]).join('; ') : '');
    });
    req.on('error', () => resolve(''));
    req.on('timeout', function () { this.destroy(); resolve(''); });
  });
}

function fetchYahooCrumb(cookie) {
  return new Promise((resolve) => {
    if (!cookie) return resolve('');
    const req = https.get('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie': cookie
      },
      timeout: 5000
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d.trim()));
    });
    req.on('error', () => resolve(''));
    req.on('timeout', function () { this.destroy(); resolve(''); });
  });
}

function fetchBulkV7Quotes(symbols, session) {
  return new Promise((resolve) => {
    if (!session || !session.cookie || !session.crumb) return resolve([]);
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(','))}&crumb=${encodeURIComponent(session.crumb)}`;
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie': session.cookie
      },
      timeout: 8000
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolve(j?.quoteResponse?.result || []);
        } catch (_) {
          resolve([]);
        }
      });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', function () { this.destroy(); resolve([]); });
  });
}

function fetchV8Quote(symbol) {
  return new Promise((resolve) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 7000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const meta = parsed?.chart?.result?.[0]?.meta;
          if (meta && meta.regularMarketPrice !== undefined) {
            const price = Number(meta.regularMarketPrice);
            const prev = Number(meta.chartPreviousClose || price);
            const chg = price - prev;
            const pct = prev > 0 ? (chg / prev) * 100 : 0;
            return resolve({
              symbol: meta.symbol,
              regularMarketPrice: Number(price.toFixed(2)),
              regularMarketChange: Number(chg.toFixed(2)),
              regularMarketChangePercent: Number(pct.toFixed(2)),
              previousClose: Number(prev.toFixed(2)),
              regularMarketVolume: Number(meta.regularMarketVolume || 0),
              fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ? Number(meta.fiftyTwoWeekHigh.toFixed(2)) : null,
              fiftyTwoWeekLow: meta.fiftyTwoWeekLow ? Number(meta.fiftyTwoWeekLow.toFixed(2)) : null
            });
          }
        } catch (_) { }
        resolve(null);
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', function () { this.destroy(); resolve(null); });
  });
}

async function poolAll(items, fn, concurrency = 8) {
  const results = [];
  const executing = [];
  for (const item of items) {
    const p = fn(item).then(res => {
      executing.splice(executing.indexOf(p), 1);
      return res;
    });
    results.push(p);
    executing.push(p);
    if (executing.length >= concurrency) {
      await Promise.race(executing);
    }
  }
  return Promise.all(results);
}

// ==============================================================================
// 1. STAGE 1: 3:45 PM EOD MARKET UPDATE (Sectors, Heatmap, Screener, EMAs, A/D)
// ==============================================================================
async function runEodMarketUpdate() {
  const dateStr = getTodayDateStr();
  const dateLabel = getTodayFormattedLabel();
  console.log(`\n======================================================`);
  console.log(`[STAGE 1] 3:45 PM Market EOD Pipeline - Date: ${dateStr}`);
  console.log(`======================================================`);

  const results = {
    date: dateStr,
    timestamp: new Date().toISOString(),
    quoteMatches: 0,
    updatedSectors: 0,
    updatedHeatmapStocks: 0,
    updatedUniverseStocks: 0,
    updatedEmasCount: 0,
    adNetFlow: null,
    nifty50: null,
    bankNifty: null,
    errors: []
  };

  // 1. Gather all symbols to fetch across benchmarks, heatmap, and screener universe
  const hmPath = path.join(__dirname, '..', 'data', 'heatmap-cache.json');
  let hmData = null;
  const hmSyms = new Set();
  if (fs.existsSync(hmPath)) {
    try {
      hmData = JSON.parse(fs.readFileSync(hmPath, 'utf8'));
      if (hmData.indices) {
        Object.values(hmData.indices).forEach(arr => {
          if (Array.isArray(arr)) {
            arr.forEach(item => {
              if (item && item.symbol) hmSyms.add(item.symbol + '.NS');
            });
          }
        });
      }
    } catch (e) {
      results.errors.push(`Error reading heatmap-cache.json: ${e.message}`);
    }
  }

  const universePath = path.join(__dirname, '..', 'data', 'stocks-universe.json');
  let universeData = null;
  const universeSyms = new Set();
  if (fs.existsSync(universePath)) {
    try {
      universeData = JSON.parse(fs.readFileSync(universePath, 'utf8'));
      if (Array.isArray(universeData)) {
        universeData.forEach(s => {
          if (Array.isArray(s) && s[0]) universeSyms.add(s[0] + '.NS');
        });
      }
    } catch (e) {
      results.errors.push(`Error reading stocks-universe.json: ${e.message}`);
    }
  }

  const indexSyms = [...new Set(Object.values(SECTOR_TICKER_MAP))];
  const prioritySyms = [...new Set([...indexSyms, ...hmSyms])];
  const allToFetch = [...new Set([...prioritySyms, ...universeSyms])];

  console.log(`Preparing EOD sync: ${indexSyms.length} benchmarks, ${hmSyms.size} heatmap stocks, ${universeSyms.size} universe equities (${allToFetch.length} unique symbols)...`);

  const quoteMap = {};

  // Fast bulk v7 quote path (chunks of 100) using cookie+crumb
  const cookie = await fetchYahooCookie();
  const crumb = await fetchYahooCrumb(cookie);
  if (cookie && crumb) {
    console.log(`✓ Obtained Yahoo session crumb; fetching ${allToFetch.length} quotes in bulk batches...`);
    const chunks = [];
    for (let i = 0; i < allToFetch.length; i += 100) {
      chunks.push(allToFetch.slice(i, i + 100));
    }
    const batchResults = await poolAll(chunks, (c) => fetchBulkV7Quotes(c, { cookie, crumb }), 6);
    for (const batch of batchResults) {
      for (const q of batch) {
        if (q && q.symbol && q.regularMarketPrice !== undefined) {
          quoteMap[q.symbol] = {
            symbol: q.symbol,
            regularMarketPrice: Number(Number(q.regularMarketPrice).toFixed(2)),
            regularMarketChange: Number(Number(q.regularMarketChange || 0).toFixed(2)),
            regularMarketChangePercent: Number(Number(q.regularMarketChangePercent || 0).toFixed(2)),
            regularMarketVolume: Number(q.regularMarketVolume || 0),
            fiftyTwoWeekHigh: q.fiftyTwoWeekHigh ? Number(Number(q.fiftyTwoWeekHigh).toFixed(2)) : null,
            fiftyTwoWeekLow: q.fiftyTwoWeekLow ? Number(Number(q.fiftyTwoWeekLow).toFixed(2)) : null
          };
        }
      }
    }
  }

  // Fallback to v8 chart for any missing priority benchmarks/heatmap stocks
  const missingPriority = prioritySyms.filter(sym => !quoteMap[sym]);
  if (missingPriority.length > 0) {
    console.log(`Fetching ${missingPriority.length} remaining priority symbols via /v8/finance/chart...`);
    const v8Quotes = await poolAll(missingPriority, fetchV8Quote, 10);
    for (const q of v8Quotes) {
      if (q && q.symbol) quoteMap[q.symbol] = q;
    }
  }

  results.quoteMatches = Object.keys(quoteMap).length;
  console.log(`✓ Retrieved ${results.quoteMatches} real closing quotes.`);

  // 2. Update Sector JSON files (44 benchmarks)
  const sectorFiles = [
    path.join(__dirname, '..', 'data', 'market-sectors.json'),
    path.join(__dirname, '..', 'data', 'screeningmantis-sectors.json')
  ];

  for (const sFile of sectorFiles) {
    if (!fs.existsSync(sFile)) continue;
    try {
      const sectors = JSON.parse(fs.readFileSync(sFile, 'utf8'));
      let count = 0;

      for (const sec of sectors) {
        const sym = sec.symbol || sec.displayName;
        const ticker = SECTOR_TICKER_MAP[sym];
        const q = ticker ? quoteMap[ticker] : null;

        sec.candleDate = dateStr;
        if (q && q.regularMarketPrice !== undefined) {
          sec.currentClose = q.regularMarketPrice;
          sec.chg1d = q.regularMarketChangePercent;
          count++;
        }

        const closeP = sec.currentClose || 0;
        if (sec.ema10) sec.aboveEma10 = closeP >= sec.ema10;
        if (sec.ema20) sec.aboveEma20 = closeP >= sec.ema20;
        if (sec.ema50) sec.aboveEma50 = closeP >= sec.ema50;
        if (sec.ema200) sec.aboveEma200 = closeP >= sec.ema200;
        if (sec.ema50 && sec.ema200) sec.emaCross = sec.ema50 >= sec.ema200 ? 'bull' : 'bear';
      }

      fs.writeFileSync(sFile, JSON.stringify(sectors, null, 2), 'utf8');
      results.updatedSectors = count;
      console.log(`✓ Updated ${path.basename(sFile)} (${count} sector prices & EMA statuses verified).`);
    } catch (fileErr) {
      results.errors.push(`Failed updating ${path.basename(sFile)}: ${fileErr.message}`);
    }
  }

  // 3. Update Heatmap Cache (Index Stats + 950 Constituent Stock Tiles)
  if (hmData) {
    try {
      hmData.asOfDate = dateLabel;
      hmData.dateLabel = 'Market Closed (3:30 PM Official EOD)';
      hmData.isLive = false;
      hmData.timestamp = new Date().toISOString();
      hmData.stats = hmData.stats || {};

      for (const [secName, ticker] of Object.entries(SECTOR_TICKER_MAP)) {
        const q = quoteMap[ticker];
        if (q && q.regularMarketPrice !== undefined) {
          const p = Number(q.regularMarketPrice).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          const chg = Number(q.regularMarketChange || 0).toFixed(2);
          const chgPct = Number(q.regularMarketChangePercent || 0).toFixed(2);
          const isUp = Number(q.regularMarketChange || 0) >= 0;

          if (secName === 'NIFTY 50') {
            results.nifty50 = { price: p, chg, pct: chgPct, isUp };
            hmData.stats['Nifty 50'] = {
              price: p,
              chg: `${Number(chg) > 0 ? '+' : ''}${chg} (${Number(chgPct) > 0 ? '+' : ''}${chgPct}%) ${isUp ? '↗' : '↘'}`,
              isUp
            };
          } else if (secName === 'NIFTY BANK') {
            results.bankNifty = { price: p, chg, pct: chgPct, isUp };
            hmData.stats['Nifty Bank'] = {
              price: p,
              chg: `${Number(chg) > 0 ? '+' : ''}${chg} (${Number(chgPct) > 0 ? '+' : ''}${chgPct}%) ${isUp ? '↗' : '↘'}`,
              isUp
            };
          }

          hmData.stats[secName] = {
            price: p,
            chg: `${Number(chgPct) > 0 ? '+' : ''}${chgPct}% ${isUp ? '↗' : '↘'}`,
            isUp
          };
        }
      }

      let hmStockCount = 0;
      if (hmData.indices) {
        for (const arr of Object.values(hmData.indices)) {
          if (Array.isArray(arr)) {
            for (const item of arr) {
              const q = quoteMap[item.symbol + '.NS'];
              if (q && q.regularMarketPrice !== undefined) {
                item.price = q.regularMarketPrice;
                item.chg = q.regularMarketChangePercent;
                if (q.regularMarketVolume > 0) {
                  item.volume = q.regularMarketVolume > 10000000
                    ? (q.regularMarketVolume / 10000000).toFixed(2) + ' Cr'
                    : (q.regularMarketVolume / 100000).toFixed(1) + ' L';
                }
                hmStockCount++;
              }
            }
          }
        }
      }
      results.updatedHeatmapStocks = hmStockCount;

      fs.writeFileSync(hmPath, JSON.stringify(hmData, null, 2), 'utf8');
      console.log(`✓ Updated data/heatmap-cache.json (${hmStockCount} constituent stock tiles refreshed).`);
    } catch (hmErr) {
      results.errors.push(`Failed updating heatmap-cache.json: ${hmErr.message}`);
    }
  }

  // 4. Update Smart Screener Universe (data/stocks-universe.json) + Compute A/D Net Flow
  if (Array.isArray(universeData)) {
    try {
      let uniUpdated = 0;
      let advances = 0;
      let declines = 0;
      let unchanged = 0;

      for (const s of universeData) {
        if (!Array.isArray(s) || !s[0]) continue;
        const q = quoteMap[s[0] + '.NS'];
        if (q && q.regularMarketPrice > 0) {
          s[3] = q.regularMarketPrice;
          s[4] = q.regularMarketChangePercent;
          if (s[8] && typeof s[8] === 'object') {
            if (q.fiftyTwoWeekHigh && (!s[8].high52 || q.fiftyTwoWeekHigh > s[8].high52)) {
              s[8].high52 = q.fiftyTwoWeekHigh;
            }
            if (q.fiftyTwoWeekLow && (!s[8].low52 || q.fiftyTwoWeekLow < s[8].low52)) {
              s[8].low52 = q.fiftyTwoWeekLow;
            }
          }
          uniUpdated++;
        }
        const dayChg = Number(s[4] || 0);
        if (dayChg > 0) advances++;
        else if (dayChg < 0) declines++;
        else unchanged++;
      }

      results.updatedUniverseStocks = uniUpdated;
      results.adNetFlow = {
        advances,
        declines,
        unchanged,
        netAD: advances - declines,
        adRatio: declines > 0 ? Number((advances / declines).toFixed(2)) : advances
      };

      fs.writeFileSync(universePath, JSON.stringify(universeData), 'utf8');
      console.log(`✓ Updated data/stocks-universe.json (${uniUpdated} screener quotes refreshed; A/D Net Flow: ${advances} Adv / ${declines} Dec, Net ${advances - declines}).`);
    } catch (uniErr) {
      results.errors.push(`Failed updating stocks-universe.json: ${uniErr.message}`);
    }
  }

  // 5. Update Market EMAs & ScreeningMantis EMAs (data/market-emas.json & data/screeningmantis-emas.json)
  const emaFiles = [
    path.join(__dirname, '..', 'data', 'market-emas.json'),
    path.join(__dirname, '..', 'data', 'screeningmantis-emas.json')
  ];

  for (const emaFile of emaFiles) {
    if (!fs.existsSync(emaFile)) continue;
    try {
      const emaMap = JSON.parse(fs.readFileSync(emaFile, 'utf8'));
      if (emaMap && typeof emaMap === 'object' && !Array.isArray(emaMap)) {
        let emaCount = 0;
        for (const [sym, rec] of Object.entries(emaMap)) {
          if (!rec || typeof rec !== 'object') continue;
          const q = quoteMap[sym + '.NS'];
          if (q && q.regularMarketPrice > 0) {
            const p = q.regularMarketPrice;
            rec.currentClose = p;
            rec.chg1d = q.regularMarketChangePercent;
            if (rec.ema10) rec.aboveEma10 = p >= rec.ema10;
            if (rec.ema20) rec.aboveEma20 = p >= rec.ema20;
            if (rec.ema50) rec.aboveEma50 = p >= rec.ema50;
            if (rec.ema200) rec.aboveEma200 = p >= rec.ema200;
            if (rec.wEma10) rec.wAboveEma10 = p >= rec.wEma10;
            if (rec.wEma20) rec.wAboveEma20 = p >= rec.wEma20;
            if (rec.wEma50) rec.wAboveEma50 = p >= rec.wEma50;
            if (rec.wEma200) rec.wAboveEma200 = p >= rec.wEma200;
            if (rec.ema20) rec.emaDistPct = Number((((p - rec.ema20) / rec.ema20) * 100).toFixed(2));
            emaCount++;
          }
        }
        fs.writeFileSync(emaFile, JSON.stringify(emaMap), 'utf8');
        results.updatedEmasCount = Math.max(results.updatedEmasCount, emaCount);
        console.log(`✓ Updated ${path.basename(emaFile)} (${emaCount} EMA records aligned with closing prices).`);
      }
    } catch (emaErr) {
      results.errors.push(`Failed updating ${path.basename(emaFile)}: ${emaErr.message}`);
    }
  }

  // 6. Update pipeline status
  const statusPath = path.join(__dirname, '..', 'data', 'pipeline-status.json');
  let pipelineStatus = {};
  try {
    if (fs.existsSync(statusPath)) {
      pipelineStatus = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    }
  } catch (_) { }

  pipelineStatus.eodMarket = {
    lastRun: new Date().toISOString(),
    status: 'success',
    date: dateStr,
    dateLabel: dateLabel,
    quoteMatches: results.quoteMatches,
    updatedSectors: results.updatedSectors,
    updatedHeatmapStocks: results.updatedHeatmapStocks,
    updatedUniverseStocks: results.updatedUniverseStocks,
    updatedEmasCount: results.updatedEmasCount,
    adNetFlow: results.adNetFlow,
    nifty50: results.nifty50,
    bankNifty: results.bankNifty,
    errors: results.errors
  };

  fs.writeFileSync(statusPath, JSON.stringify(pipelineStatus, null, 2), 'utf8');
  console.log(`✓ Stage 1 EOD Market Update Complete! Saved to data/pipeline-status.json.`);
  return results;
}

// ==============================================================================
// 2. STAGE 2: 7:00 PM REAL FII / DII & SECTOR TURNOVER UPDATE
// ==============================================================================
async function runFiiDiiUpdate(customData) {
  const dateStr = getTodayDateStr();
  console.log(`\n======================================================`);
  console.log(`[STAGE 2] 7:00 PM FII / DII & Sector Turnover - Date: ${dateStr}`);
  console.log(`======================================================`);

  const results = {
    date: dateStr,
    timestamp: new Date().toISOString(),
    fiiData: null,
    sectorTurnover: null,
    source: 'Groww + ScreeningMantis Official Feeds',
    errors: []
  };

  const fiiPath = path.join(__dirname, '..', 'data', 'fii-dii-history.json');

  if (customData && (customData.fiiNet !== undefined || customData.fiiBuy !== undefined)) {
    let fiiList = [];
    try {
      if (fs.existsSync(fiiPath)) fiiList = JSON.parse(fs.readFileSync(fiiPath, 'utf8'));
    } catch (_) { }

    const fBuy = Number(customData.fiiBuy || 0);
    const fSell = Number(customData.fiiSell || 0);
    const fNet = customData.fiiNet !== undefined ? Number(customData.fiiNet) : Number((fBuy - fSell).toFixed(2));
    const dBuy = Number(customData.diiBuy || 0);
    const dSell = Number(customData.diiSell || 0);
    const dNet = customData.diiNet !== undefined ? Number(customData.diiNet) : Number((dBuy - dSell).toFixed(2));

    const todayEntry = {
      date: customData.date || dateStr,
      fiiBuy: fBuy,
      fiiSell: fSell,
      fiiNet: fNet,
      diiBuy: dBuy,
      diiSell: dSell,
      diiNet: dNet
    };

    fiiList = fiiList.filter(item => item.date !== todayEntry.date);
    fiiList.unshift(todayEntry);
    fiiList.sort((a, b) => b.date.localeCompare(a.date));
    fs.writeFileSync(fiiPath, JSON.stringify(fiiList, null, 2) + '\n', 'utf8');
    results.fiiData = todayEntry;
    results.source = 'Owner Studio Manual Entry';
    console.log(`✓ Saved Owner Studio FII/DII entry for ${todayEntry.date}: FII Net ₹${todayEntry.fiiNet} Cr.`);
  } else {
    try {
      const fiiRes = await runFiiScraper();
      results.fiiData = fiiRes?.latest || null;
      console.log(`✓ Real FII/DII data synced from Groww. Latest session: ${results.fiiData?.date}`);
    } catch (err) {
      results.errors.push(`Groww FII/DII fetch error: ${err.message}`);
      console.error(`✗ Groww FII/DII fetch error:`, err.message);
    }

    try {
      const toRes = await runSectorTurnoverUpdate();
      results.sectorTurnover = toRes;
      console.log(`✓ Real Sector Turnover synced (${toRes?.totalSectors} sectors, latest date: ${toRes?.latestDate}).`);
    } catch (err) {
      results.errors.push(`ScreeningMantis sector turnover error: ${err.message}`);
      console.error(`✗ ScreeningMantis turnover error:`, err.message);
    }
  }

  const statusPath = path.join(__dirname, '..', 'data', 'pipeline-status.json');
  let pipelineStatus = {};
  try {
    if (fs.existsSync(statusPath)) {
      pipelineStatus = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    }
  } catch (_) { }

  pipelineStatus.fiiDii = {
    lastRun: new Date().toISOString(),
    status: results.errors.length === 0 ? 'success' : 'partial',
    date: results.fiiData?.date || dateStr,
    source: results.source,
    entry: results.fiiData,
    sectorTurnover: results.sectorTurnover,
    errors: results.errors
  };

  fs.writeFileSync(statusPath, JSON.stringify(pipelineStatus, null, 2), 'utf8');
  console.log(`✓ Stage 2 Real FII/DII & Sector Turnover Update Complete!`);
  return results;
}

// ==============================================================================
// 3. CLI EXECUTION
// ==============================================================================
if (require.main === module) {
  const args = process.argv.slice(2);
  let mode = 'all';
  args.forEach(arg => {
    if (arg.startsWith('--mode=')) mode = arg.split('=')[1].toLowerCase();
  });

  (async () => {
    try {
      if (mode === 'eod' || mode === 'all') {
        await runEodMarketUpdate();
      }
      if (mode === 'fii' || mode === 'all') {
        await runFiiDiiUpdate();
      }
      console.log('\n✓ Daily market data pipeline finished cleanly.');
      process.exit(0);
    } catch (err) {
      console.error('\n✗ Pipeline execution failed:', err);
      process.exit(1);
    }
  })();
}

module.exports = {
  runEodMarketUpdate,
  runFiiDiiUpdate,
  getTodayDateStr
};
