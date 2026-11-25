/**
 * MOMENTUM CHASERS - LIVE NSE BULK, BLOCK & INSIDER (SEBI PIT) DEALS FETCHER
 *
 * Fetches:
 *  1. NSE Official Bulk Deals CSV (archives.nseindia.com/content/equities/bulk.csv)
 *  2. NSE Official Block Deals CSV (archives.nseindia.com/content/equities/block.csv)
 *  3. NSE Official SEBI PIT Insider Trading Disclosures:
 *     - Cookie handshake on nseindia.in/companies-listing/corporate-filings-insider-trading
 *     - JSON index from /api/corporates-pit-gg?index=equities&from_date=...&to_date=...
 *     - Individual XBRL XML filings from nsearchives.nseindia.com/corporate/xbrl/...
 *
 * Merges and deduplicates with data/deals-history.json, sorted newest-first.
 */

const fs = require('fs');
const path = require('path');

const MONTHS_UPPER = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const MONTHS_MAP = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9'
};

function decodeXmlEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

function smartTitleCase(name) {
  const s = decodeXmlEntities(name);
  if (!s) return '';
  const hasLower = /[a-z]/.test(s);
  if (hasLower) return s;
  const keepUpper = new Set(['LTD', 'LLP', 'PVT', 'IT', 'HDFC', 'ICICI', 'SBI', 'NCL', 'A&S', 'BSE', 'NSE', 'PSU', 'M&M', 'L&T', 'CO']);
  return s.split(' ').map(word => {
    if (!word) return '';
    if (keepUpper.has(word.toUpperCase()) || word.length <= 2 && /^[A-Z&]+$/.test(word)) {
      return word.toUpperCase();
    }
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }).join(' ');
}

function parseCSVLineRows(csvText) {
  const rows = [];
  if (!csvText) return rows;
  const lines = csvText.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return rows;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const cols = [];
    let cur = '';
    let inQuotes = false;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
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
  if (n.includes('fund') || n.includes('mutual') || n.includes('insurance') || n.includes('lic') || n.includes('sbi ') || n.includes('icici') || n.includes('kotak') || n.includes('hdfc') || n.includes('nippon') || n.includes('uti') || n.includes('dsp') || n.includes('tata amc') || n.includes('mirae') || n.includes('bandhan') || n.includes('axis amc') || n.includes('canara')) {
    return 'DII';
  }
  if (n.includes('capital') || n.includes('securities') || n.includes('singapore') || n.includes('morgan') || n.includes('goldman') || n.includes('blackrock') || n.includes('societe') || n.includes('vanguard') || n.includes('norway') || n.includes('norges') || n.includes('mauritius') || n.includes('cayman') || n.includes('fih') || n.includes('fpi') || n.includes('citigroup') || n.includes('bnp') || n.includes('ubs') || n.includes('nomura') || n.includes('clsa') || n.includes('jefferies') || n.includes('macquarie') || n.includes('hsbc') || n.includes('fidelity')) {
    return 'FII';
  }
  if (n.includes('trust') || n.includes('promoter') || n.includes('holding') || n.includes('family') || n.includes('sons') || n.includes('director') || n.includes('insider') || n.includes('chairman') || n.includes('ceo') || n.includes('cmd') || n.includes('md & ceo')) {
    return 'Promoter';
  }
  return 'HNI';
}

function categorizeInsiderRole(roleStr) {
  const r = (roleStr || '').toLowerCase();
  if (r.includes('promoter')) return 'Promoter';
  if (r.includes('director') || r.includes('kmp') || r.includes('key managerial')) return 'Director / KMP';
  if (r.includes('employee') || r.includes('designated')) return 'Employee';
  return 'Insider';
}

function formatISTDateDdMmYyyy(date) {
  const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  const dd = String(ist.getUTCDate()).padStart(2, '0');
  const mm = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = ist.getUTCFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

function formatToDealDate(rawDateStr, fallbackDateStr) {
  const nowIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const maxDayEndMs = Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate(), 23, 59, 59);

  const tryParse = (str) => {
    if (!str) return null;
    const s = String(str).trim().split(' ')[0];
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const [y, m, d] = s.split('-').map(Number);
      const ms = Date.UTC(y, m - 1, d);
      if (!isNaN(ms) && ms <= maxDayEndMs) {
        return `${String(d).padStart(2, '0')}-${MONTHS_UPPER[m - 1]}-${y}`;
      }
    }
    const parts = s.split(/[-/]/);
    if (parts.length === 3) {
      const d = parseInt(parts[0], 10);
      const m = MONTHS_MAP[parts[1].toLowerCase().slice(0, 3)];
      let y = parseInt(parts[2], 10);
      if (y < 100) y += 2000;
      if (!isNaN(d) && m !== undefined && !isNaN(y)) {
        const ms = Date.UTC(y, m, d);
        if (ms <= maxDayEndMs) {
          return `${String(d).padStart(2, '0')}-${MONTHS_UPPER[m]}-${y}`;
        }
      }
    }
    return null;
  };

  return tryParse(rawDateStr) || tryParse(fallbackDateStr) || null;
}

function parseDateForSort(dateStr) {
  if (!dateStr) return 0;
  const parts = String(dateStr).trim().split(/[-/ ]/);
  if (parts.length === 3) {
    const d = parseInt(parts[0], 10);
    const m = MONTHS_MAP[parts[1].toLowerCase().slice(0, 3)];
    let y = parseInt(parts[2], 10);
    if (y < 100) y += 2000;
    if (!isNaN(d) && m !== undefined && !isNaN(y)) {
      return Date.UTC(y, m, d);
    }
  }
  const dt = new Date(dateStr);
  return isNaN(dt.getTime()) ? 0 : dt.getTime();
}

function mapInsiderAction(txType, mode) {
  const t = (txType || '').toLowerCase();
  const m = (mode || '').toLowerCase();
  if (t.includes('buy') || t.includes('acqui') || t.includes('allot') || t.includes('revoke') || t.includes('release')) {
    return 'Buy';
  }
  if (t.includes('sell') || t.includes('dispos') || t.includes('pledge') || t.includes('invoke')) {
    return 'Sell';
  }
  if (m.includes('purchase') || m.includes('esop') || m.includes('allot') || m.includes('inherit') || m.includes('revocation')) {
    return 'Buy';
  }
  return 'Sell';
}

function extractXmlTag(xml, tagName, contextRef) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = contextRef
    ? new RegExp(`<[^>]*:${escaped}[^>]*contextRef="${contextRef}"[^>]*>([\\s\\S]*?)<\\/[^>]*:${escaped}>`, 'i')
    : new RegExp(`<[^>]*:${escaped}[^>]*>([\\s\\S]*?)<\\/[^>]*:${escaped}>`, 'i');
  const m = xml.match(re);
  return m ? decodeXmlEntities(m[1]) : '';
}

async function fetchXmlTextWithFallback(rawUrl) {
  if (!rawUrl) return null;
  const primary = rawUrl.replace('nsearchives.nseindia.in', 'nsearchives.nseindia.com');
  try {
    const r = await fetch(primary, { signal: AbortSignal.timeout(6500), headers: { 'User-Agent': NSE_HEADERS['User-Agent'] } });
    if (r.ok) return await r.text();
  } catch (_) { }
  if (primary !== rawUrl) {
    try {
      const r2 = await fetch(rawUrl, { signal: AbortSignal.timeout(6500), headers: { 'User-Agent': NSE_HEADERS['User-Agent'] } });
      if (r2.ok) return await r2.text();
    } catch (_) { }
  }
  return null;
}

async function fetchLiveBulkAndBlockDeals() {
  const [bulkCsv, blockCsv] = await Promise.all([
    fetch('https://archives.nseindia.com/content/equities/bulk.csv', { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': NSE_HEADERS['User-Agent'] } }).then(r => r.ok ? r.text() : '').catch(() => ''),
    fetch('https://archives.nseindia.com/content/equities/block.csv', { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': NSE_HEADERS['User-Agent'] } }).then(r => r.ok ? r.text() : '').catch(() => '')
  ]);

  const liveDeals = [];
  const pushRows = (csvText, typeLabel) => {
    const prefix = typeLabel.toLowerCase();
    parseCSVLineRows(csvText).forEach((r, idx) => {
      if (r.length < 7) return;
      const [date, symbol, stock, client, action, qtyStr, priceStr] = r;
      const qty = parseInt((qtyStr || '').replace(/,/g, ''), 10) || 0;
      const avgPrice = parseFloat((priceStr || '').replace(/,/g, '')) || 0;
      if (!symbol || qty <= 0) return;
      const valueCr = Math.round(((qty * avgPrice) / 10000000) * 100) / 100;
      const cleanDate = formatToDealDate(date) || date;
      if (!cleanDate) return;
      liveDeals.push({
        id: `${prefix}_${idx}_${symbol.toUpperCase()}`,
        stock: smartTitleCase(stock || symbol),
        symbol: symbol.toUpperCase(),
        type: typeLabel,
        date: cleanDate,
        client: smartTitleCase(client) || 'Undisclosed Participant',
        action: (action || 'BUY').toUpperCase() === 'BUY' ? 'Buy' : 'Sell',
        qty,
        avgPrice,
        valueCr,
        avatar: (stock || symbol || 'S').trim().charAt(0).toUpperCase(),
        clientCategory: categorizeDealClient(client)
      });
    });
  };

  pushRows(bulkCsv, 'Bulk');
  pushRows(blockCsv, 'Block');
  return liveDeals;
}

async function fetchLiveInsiderDeals(maxFilings = 75) {
  const deals = [];
  try {
    const homeRes = await fetch('https://www.nseindia.in/companies-listing/corporate-filings-insider-trading', {
      signal: AbortSignal.timeout(8000),
      headers: {
        'User-Agent': NSE_HEADERS['User-Agent'],
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    const cookies = (homeRes.headers.getSetCookie ? homeRes.headers.getSetCookie() : [])
      .map(c => c.split(';')[0])
      .join('; ');

    const now = new Date();
    const from = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const toStr = formatISTDateDdMmYyyy(now);
    const fromStr = formatISTDateDdMmYyyy(from);

    const apiUrl = `https://www.nseindia.in/api/corporates-pit-gg?index=equities&from_date=${fromStr}&to_date=${toStr}`;
    const listRes = await fetch(apiUrl, {
      signal: AbortSignal.timeout(9000),
      headers: {
        ...NSE_HEADERS,
        'Cookie': cookies,
        'Referer': 'https://www.nseindia.in/companies-listing/corporate-filings-insider-trading'
      }
    });
    if (!listRes.ok) return deals;

    const json = await listRes.json();
    const rawList = (Array.isArray(json.data) ? json.data : [])
      .filter(item => item && item.xmlFileName)
      .slice(0, maxFilings);

    const BATCH_SIZE = 15;
    for (let i = 0; i < rawList.length; i += BATCH_SIZE) {
      const batch = rawList.slice(i, i + BATCH_SIZE);
      const parsedBatch = await Promise.all(batch.map(async (item) => {
        const xml = await fetchXmlTextWithFallback(item.xmlFileName);
        if (!xml) return [];

        const sym = (extractXmlTag(xml, 'Symbol') || item.symbol || '').toUpperCase().trim();
        const company = smartTitleCase(extractXmlTag(xml, 'NameOfTheCompany') || item.companyName || sym);
        const filingDate = extractXmlTag(xml, 'DateOfFiling');

        const ctxMatches = [...xml.matchAll(/contextRef="(Disclosure\d+)"/gi)].map(m => m[1]);
        const contexts = ctxMatches.length > 0 ? [...new Set(ctxMatches)] : [null];
        const rows = [];

        contexts.forEach((ctx, cIdx) => {
          const person = smartTitleCase(extractXmlTag(xml, 'NameOfThePerson', ctx));
          const role = extractXmlTag(xml, 'CategoryOfPerson', ctx) || 'Insider';
          const qtyRaw = extractXmlTag(xml, 'SecuritiesAcquiredOrDisposedNumberOfSecurity', ctx);
          const qty = Math.round(parseFloat(qtyRaw) || 0);
          if (!sym || !person || qty <= 0) return;

          const valRaw = extractXmlTag(xml, 'SecuritiesAcquiredOrDisposedValueOfSecurity', ctx);
          const val = parseFloat(valRaw) || 0;
          const txType = extractXmlTag(xml, 'SecuritiesAcquiredOrDisposedTransactionType', ctx);
          const mode = extractXmlTag(xml, 'ModeOfAcquisitionOrDisposal', ctx) || item.regulation || 'SEBI PIT Disclosure';
          const toDate = extractXmlTag(xml, 'DateOfAllotmentAdviceOrAcquisitionOfSharesOrSaleOfSharesSpecifyToDate', ctx);
          const intimationDate = extractXmlTag(xml, 'DateOfIntimationToCompany', ctx);

          const dealDate = formatToDealDate(toDate, intimationDate || filingDate || item.broadcastDateTime);
          if (!dealDate) return;

          // Ignore tiny nominal statutory values like Rs 5 for Inheritance/Gift
          const meaningfulVal = val >= 100 ? val : 0;
          const avgPrice = meaningfulVal > 0 ? Math.round((meaningfulVal / qty) * 100) / 100 : 0;
          const valueCr = meaningfulVal > 0 ? Math.round((meaningfulVal / 10000000) * 100) / 100 : 0;

          const postPctNum = parseFloat(extractXmlTag(xml, 'SecuritiesHeldPostAcquistionOrDisposalPercentageOfShareholding', ctx));
          let postHoldingPct = '';
          if (Number.isFinite(postPctNum) && postPctNum >= 0) {
            const pct = postPctNum <= 1 ? (postPctNum * 100) : postPctNum;
            postHoldingPct = `${pct.toFixed(2)}%`;
          }

          const action = mapInsiderAction(txType, mode);

          rows.push({
            id: `insider_pit_${item.appId || sym}_${cIdx}`,
            stock: company,
            symbol: sym,
            type: 'Insider',
            date: dealDate,
            client: person,
            clientCategory: categorizeInsiderRole(role),
            insiderRole: role,
            mode: mode,
            action: action,
            qty: qty,
            avgPrice: avgPrice,
            valueCr: valueCr,
            avatar: (company || sym).charAt(0).toUpperCase(),
            postHoldingPct: postHoldingPct
          });
        });

        return rows;
      }));

      for (const arr of parsedBatch) {
        if (Array.isArray(arr) && arr.length > 0) deals.push(...arr);
      }
    }
  } catch (err) {
    console.warn('NSE live insider fetch warning:', err.message);
  }
  return deals;
}

async function syncLiveDealsData() {
  const historyPath = path.join(__dirname, '..', 'data', 'deals-history.json');
  let accumulatedDeals = [];
  try {
    if (fs.existsSync(historyPath)) {
      accumulatedDeals = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    }
  } catch (err) {
    console.warn('Deals history load warning:', err.message);
  }
  if (!Array.isArray(accumulatedDeals)) accumulatedDeals = [];

  const [bulkBlockDeals, insiderDeals] = await Promise.all([
    fetchLiveBulkAndBlockDeals().catch(() => []),
    fetchLiveInsiderDeals(75).catch(() => [])
  ]);

  const liveDeals = [...bulkBlockDeals, ...insiderDeals];

  if (liveDeals.length > 0) {
    const seen = new Set();
    const merged = [];
    const buildKey = (d) => `${(d.date || '').toUpperCase()}_${(d.symbol || '').toUpperCase()}_${(d.client || '').toLowerCase()}_${(d.type || '').toLowerCase()}_${(d.action || '').toLowerCase()}_${d.qty || 0}`;

    for (const d of liveDeals) {
      const key = buildKey(d);
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(d);
      }
    }
    for (const d of accumulatedDeals) {
      const key = buildKey(d);
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(d);
      }
    }

    merged.sort((a, b) => {
      const tA = parseDateForSort(a.date);
      const tB = parseDateForSort(b.date);
      if (tB !== tA) return tB - tA;
      return (b.valueCr || 0) - (a.valueCr || 0);
    });

    // Cap rolling archive cleanly at 600 newest entries
    accumulatedDeals = merged.slice(0, 600);
    try {
      fs.writeFileSync(historyPath, JSON.stringify(accumulatedDeals, null, 2) + '\n', 'utf8');
    } catch (err) {
      console.warn('Deals history write warning:', err.message);
    }
  } else {
    accumulatedDeals.sort((a, b) => {
      const tA = parseDateForSort(a.date);
      const tB = parseDateForSort(b.date);
      if (tB !== tA) return tB - tA;
      return (b.valueCr || 0) - (a.valueCr || 0);
    });
  }

  return accumulatedDeals;
}

if (require.main === module) {
  (async () => {
    const t0 = Date.now();
    const all = await syncLiveDealsData();
    const counts = {
      total: all.length,
      bulk: all.filter(d => d.type === 'Bulk').length,
      block: all.filter(d => d.type === 'Block').length,
      insider: all.filter(d => d.type === 'Insider').length,
      latestInsiderDates: [...new Set(all.filter(d => d.type === 'Insider').map(d => d.date))].slice(0, 6)
    };
    console.log('✓ Synced Deals & Insider PIT in', Date.now() - t0, 'ms:', JSON.stringify(counts));
  })();
}

module.exports = {
  syncLiveDealsData,
  fetchLiveBulkAndBlockDeals,
  fetchLiveInsiderDeals
};
