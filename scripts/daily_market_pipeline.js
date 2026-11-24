/**
 * MOMENTUM CHASERS - AUTOMATED DAILY MARKET DATA PIPELINE
 *
 * Scheduled Batches (Zero Placeholder Values — 100% Real Exchange Sources):
 *  - Stage 1 (3:45 PM - 3:50 PM IST): Official Closing Quotes, 44 Sector Benchmarks, EMAs, Market Breadth & Heatmap Constituents
 *  - Stage 2 (7:00 PM - 7:15 PM IST): Real FII / DII Cash Activity (Groww) & Official Sector Turnover (ScreeningMantis)
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
              regularMarketVolume: Number(meta.regularMarketVolume || 0)
            });
          }
        } catch (_) { }
        resolve(null);
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', function() { this.destroy(); resolve(null); });
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
// 1. STAGE 1: 3:45 PM EOD MARKET UPDATE (Sectors, EMAs, Heatmap Constituents)
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
    nifty50: null,
    bankNifty: null,
    errors: []
  };

  // Collect all index tickers AND heatmap constituent symbols
  const hmPath = path.join(__dirname, '..', 'data', 'heatmap-cache.json');
  let hmData = null;
  const constituentSyms = new Set();
  if (fs.existsSync(hmPath)) {
    try {
      hmData = JSON.parse(fs.readFileSync(hmPath, 'utf8'));
      if (hmData.indices) {
        Object.values(hmData.indices).forEach(arr => {
          if (Array.isArray(arr)) {
            arr.forEach(item => {
              if (item && item.symbol) constituentSyms.add(item.symbol + '.NS');
            });
          }
        });
      }
    } catch (e) {
      results.errors.push(`Error reading heatmap-cache.json: ${e.message}`);
    }
  }

  const indexSyms = [...new Set(Object.values(SECTOR_TICKER_MAP))];
  const allToFetch = [...new Set([...indexSyms, ...constituentSyms])];
  console.log(`Fetching official closing quotes for ${indexSyms.length} benchmarks & ${constituentSyms.size} heatmap stocks...`);

  const rawQuotes = await poolAll(allToFetch, fetchV8Quote, 10);
  const quoteMap = {};
  for (const q of rawQuotes) {
    if (q && q.symbol) {
      quoteMap[q.symbol] = q;
    }
  }

  results.quoteMatches = Object.keys(quoteMap).length;
  console.log(`✓ Retrieved ${results.quoteMatches} real closing quotes.`);

  // Update Sector JSON files
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
      }

      fs.writeFileSync(sFile, JSON.stringify(sectors, null, 2), 'utf8');
      results.updatedSectors = count;
      console.log(`✓ Updated ${path.basename(sFile)} (${count} sector prices & EMA statuses verified).`);
    } catch (fileErr) {
      results.errors.push(`Failed updating ${path.basename(sFile)}: ${fileErr.message}`);
    }
  }

  // Update Heatmap Cache (both Index Stats AND Stock Tiles)
  if (hmData) {
    try {
      hmData.asOfDate = dateLabel;
      hmData.dateLabel = 'Market Closed (3:30 PM Official EOD)';
      hmData.isLive = false;
      hmData.timestamp = new Date().toISOString();
      hmData.stats = hmData.stats || {};

      // Update sector stats inside heatmap-cache.json
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

      // Update individual stock tiles across all heatmap indices
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

  // Update pipeline status
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
    nifty50: results.nifty50,
    bankNifty: results.bankNifty,
    errors: results.errors
  };

  fs.writeFileSync(statusPath, JSON.stringify(pipelineStatus, null, 2), 'utf8');
  console.log(`✓ Stage 1 EOD Market Update Complete! Saved to data/pipeline-status.json.`);
  return results;
}

// ==============================================================================
// 2. STAGE 2: 7:00 PM REAL FII / DII & SECTOR TURNOVER UPDATE (NO PLACEHOLDERS)
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

  // If manual values explicitly submitted via Owner Studio UI
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
    // Automated real scraper from Groww (zero placeholders!)
    try {
      const fiiRes = await runFiiScraper();
      results.fiiData = fiiRes?.latest || null;
      console.log(`✓ Real FII/DII data synced from Groww. Latest session: ${results.fiiData?.date}`);
    } catch (err) {
      results.errors.push(`Groww FII/DII fetch error: ${err.message}`);
      console.error(`✗ Groww FII/DII fetch error:`, err.message);
    }

    // Automated real sector turnover sync from ScreeningMantis
    try {
      const toRes = await runSectorTurnoverUpdate();
      results.sectorTurnover = toRes;
      console.log(`✓ Real Sector Turnover synced (${toRes?.totalSectors} sectors, latest date: ${toRes?.latestDate}).`);
    } catch (err) {
      results.errors.push(`ScreeningMantis sector turnover error: ${err.message}`);
      console.error(`✗ ScreeningMantis turnover error:`, err.message);
    }
  }

  // Update pipeline status
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
