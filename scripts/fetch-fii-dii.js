/**
 * Momentum Chasers - Automated FII / DII Daily Flow Scraper
 * Fetches latest exchange-published cash market institutional data from Groww
 * and updates data/fii-dii-history.json.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

async function fetchGrowwPage() {
  return new Promise((resolve, reject) => {
    const req = https.get('https://groww.in/fii-dii-data', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      timeout: 15000
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        reject(new Error('Redirected to: ' + res.headers.location));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP status ' + res.statusCode));
        return;
      }
      let html = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { html += chunk; });
      res.on('end', () => resolve(html));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
  });
}

function parseGrowwRows(html) {
  const decode = val => String(val || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();

  const amount = val => {
    const num = Number(decode(val).replace(/[\u20b9,\s]/g, ''));
    return Number.isFinite(num) ? num : null;
  };

  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m =>
    [...m[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell => decode(cell[1]))
  ).filter(cells => cells.length >= 7);

  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const parsed = [];

  for (const cells of rows) {
    const [dateText, fiiBuyText, fiiSellText, fiiNetText, diiBuyText, diiSellText, diiNetText] = cells;
    const dateMatch = dateText.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
    if (!dateMatch) continue;

    const day = dateMatch[1].padStart(2, '0');
    const monthIdx = months.indexOf(dateMatch[2].toLowerCase());
    if (monthIdx < 0) continue;
    const month = String(monthIdx + 1).padStart(2, '0');
    const year = dateMatch[3];
    const isoDate = `${year}-${month}-${day}`;

    const values = [fiiBuyText, fiiSellText, fiiNetText, diiBuyText, diiSellText, diiNetText].map(amount);
    if (values.some(v => v === null)) continue;

    parsed.push({
      date: isoDate,
      fiiBuy: values[0],
      fiiSell: values[1],
      fiiNet: values[2],
      diiBuy: values[3],
      diiSell: values[4],
      diiNet: values[5]
    });
  }

  return parsed;
}

async function main() {
  console.log('Fetching live FII/DII data from Groww...');
  const html = await fetchGrowwPage();
  const newRecords = parseGrowwRows(html);
  if (!newRecords.length) {
    throw new Error('No valid FII/DII records extracted from Groww page');
  }

  console.log(`Successfully parsed ${newRecords.length} sessions from Groww. Latest date: ${newRecords[0].date}`);

  const historyPath = path.join(__dirname, '..', 'data', 'fii-dii-history.json');
  let existing = [];
  try {
    existing = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
  } catch (_) { }

  const byDate = new Map();
  if (Array.isArray(existing)) {
    for (const r of existing) {
      if (r && r.date) byDate.set(r.date, r);
    }
  }

  // Merge new records
  for (const r of newRecords) {
    byDate.set(r.date, r);
  }

  // Keep sorted descending by date
  const merged = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));

  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.writeFileSync(historyPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  console.log(`Updated ${historyPath} with ${merged.length} historical sessions. Latest: ${merged[0].date}`);
  return { latest: merged[0], totalSessions: merged.length, parsedCount: newRecords.length };
}

if (require.main === module) {
  main().catch(err => {
    console.error('Scraper failed:', err.message);
    process.exit(1);
  });
}

module.exports = { fetchGrowwPage, parseGrowwRows, runFiiScraper: main };
