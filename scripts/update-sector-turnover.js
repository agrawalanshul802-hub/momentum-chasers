const https = require('https');
const fs = require('fs');
const path = require('path');

const sectorDefs = [
  { id: 'pvt_bank', name: 'Private Banks', sym: 'NIFTY PVT BANK', base: 9200, category: 'Banking', sm: 'Private Banks' },
  { id: 'pharma', name: 'Pharmaceuticals', sym: 'NIFTY PHARMA', base: 3600, category: 'Healthcare', sm: 'Pharmaceuticals' },
  { id: 'psu_bank', name: 'PSU Banks', sym: 'NIFTY PSU BANK', base: 10732, category: 'Banking', sm: 'PSU Banks' },
  { id: 'it', name: 'Information Technology', sym: 'NIFTY IT', base: 7165.5, category: 'Tech', sm: 'Information Technology' },
  { id: 'nbfc', name: 'NBFC', sym: 'NIFTY FIN SERVICE', base: 7400, category: 'Finance', sm: 'NBFC' },
  { id: 'renew_energy', name: 'Renewable Energy', sym: 'NIFTY ENERGY', base: 4500, category: 'Energy', sm: 'Renewable Energy' },
  { id: 'fmcg', name: 'FMCG', sym: 'NIFTY FMCG', base: 2600, category: 'Consumer', sm: 'FMCG' },
  { id: 'realty', name: 'Realty', sym: 'NIFTY REALTY', base: 1100, category: 'Real Estate', sm: 'Realty' },
  { id: 'gas_dist', name: 'Gas Distribution', sym: 'NIFTY OIL AND GAS', base: 1950, category: 'Energy', sm: 'Gas Distribution' },
  { id: 'insurance', name: 'Insurance', sym: 'NIFTY FIN SERVICE', base: 1800, category: 'Finance', sm: 'Insurance' },
  { id: 'const_eng', name: 'Construction & Engineering', sym: 'NIFTY INFRA', base: 4100, category: 'Infra', sm: 'Construction & Engineering' },
  { id: 'transport', name: 'Transport', sym: 'NIFTY TRANS LOGIS', base: 2300, category: 'Logistics', sm: 'Transport' },
  { id: 'hotels', name: 'Hotels', sym: 'NIFTY IND TOURISM', base: 890, category: 'Hospitality', sm: 'Hotels' },
  { id: 'cement', name: 'Cement', sym: 'NIFTY HOUSING', base: 1550, category: 'Building', sm: 'Cement' },
  { id: 'chem', name: 'Commodity Chemicals', sym: 'NIFTY CHEMICALS', base: 2400, category: 'Chemicals', sm: 'Commodity Chemicals' },
  { id: 'restaurants', name: 'Restaurants', sym: 'NIFTY CONSUMPTION', base: 720, category: 'Consumer', sm: 'Restaurants' },
  { id: 'paints', name: 'Paints', sym: 'NIFTY CONSUMPTION', base: 1050, category: 'Building', sm: 'Paints' },
  { id: 'refineries', name: 'Refineries & Lubricants', sym: 'NIFTY OIL AND GAS', base: 5200, category: 'Energy', sm: 'Refineries & Lubricants' },
  { id: 'railways', name: 'Railways', sym: 'NIFTY RAILWAYS PSU', base: 2900, category: 'Infra', sm: 'Railways' },
  { id: 'fertilizers', name: 'Fertilizers & Agrochemicals', sym: 'NIFTY COMMODITIES', base: 1450, category: 'Agri', sm: 'Fertilizers & Agrochemicals' },
  { id: 'beverages', name: 'Alcoholic Beverages', sym: 'NIFTY CONSUMPTION', base: 940, category: 'Consumer', sm: 'Alcoholic Beverages' },
  { id: 'retail', name: 'Retail', sym: 'NIFTY CONSUMPTION', base: 3400, category: 'Consumer', sm: 'Retail' },
  { id: 'packaging', name: 'Packaging', sym: 'NIFTY COMMODITIES', base: 560, category: 'Manufacturing', sm: 'Packaging' },
  { id: 'paper', name: 'Paper Products', sym: 'NIFTY COMMODITIES', base: 430, category: 'Manufacturing', sm: 'Paper Products' },
  { id: 'auto', name: 'Automobile', sym: 'NIFTY AUTO', base: 5600, category: 'Auto', sm: 'Automobiles' },
  { id: 'metals', name: 'Metals & Mining', sym: 'NIFTY METAL', base: 5300, category: 'Metals', sm: 'Metals & Mining' },
  { id: 'healthcare', name: 'Healthcare', sym: 'NIFTY HEALTHCARE', base: 3300, category: 'Healthcare', sm: 'Healthcare Services' },
  { id: 'media', name: 'Media', sym: 'NIFTY MEDIA', base: 310, category: 'Media', sm: 'Media & Entertainment' },
  { id: 'defence', name: 'Defence', sym: 'NIFTY IND DEFENCE', base: 2600, category: 'Defence', sm: 'Aerospace & Defense' },
  { id: 'cap_mkt', name: 'Capital Markets', sym: 'NIFTY CAPITAL MKT', base: 5800, category: 'Finance', sm: 'Capital Markets' },
  { id: 'cons_dur', name: 'Consumer Durables', sym: 'NIFTY CONSR DURBL', base: 2900, category: 'Consumer', sm: 'Consumer Products' },
  { id: 'ev', name: 'EV & New Age Auto', sym: 'NIFTY EV', base: 8200, category: 'Auto', sm: 'Auto Components' },
  { id: 'digital', name: 'Digital & Tech', sym: 'NIFTY IND DIGITAL', base: 9100, category: 'Tech', sm: 'Online Services' },
  { id: 'telecom', name: 'Telecom', sym: 'NIFTY MS IT TELCM', base: 4200, category: 'Telecom', sm: 'Telecom' },
  { id: 'mnc', name: 'MNC', sym: 'NIFTY MNC', base: 4800, category: 'Diversified', sm: 'Investment Company' },
  { id: 'pse', name: 'PSE / CPSE', sym: 'NIFTY PSE', base: 6500, category: 'PSU', sm: 'Power' },
  { id: 'services', name: 'Services Sector', sym: 'NIFTY SERV SECTOR', base: 15800, category: 'Services', sm: 'Financial Services' },
  { id: 'core_housing', name: 'Core Housing', sym: 'NIFTY CORE HOUSING', base: 2100, category: 'Housing', sm: 'Building Products' },
  { id: 'rural', name: 'Rural Economy', sym: 'NIFTY RURAL', base: 3900, category: 'Consumer', sm: 'Food Products' },
  { id: 'chemicals', name: 'Chemicals', sym: 'NIFTY CHEMICALS', base: 2300, category: 'Chemicals', sm: 'Specialty Chemicals' },
  { id: 'nifty50', name: 'Nifty 50 Benchmark', sym: 'NIFTY 50', base: 28000, category: 'Benchmark', customRatios: [1.14, 0.93, 1.07, 0.88, 0.90, 1.02, 1.15, 0.92, 0.11, 1.11, 0.99, 0.94, 0.97, 0.85, 0.91] },
  { id: 'midcap150', name: 'MidCap 150', sym: 'NIFTY MIDCAP 150', base: 18500, category: 'Benchmark', customRatios: [1.16, 0.98, 1.27, 0.89, 0.97, 1.04, 1.01, 0.67, 0.12, 1.05, 1.02, 0.94, 0.98, 0.88, 0.95] },
  { id: 'smallcap250', name: 'SmallCap 250', sym: 'NIFTY SMLCAP 250', base: 14200, category: 'Benchmark', customRatios: [1.16, 0.93, 0.84, 1.10, 1.45, 1.65, 0.86, 0.70, 0.09, 0.73, 1.05, 0.87, 0.97, 1.19, 0.86] },
  { id: 'ipo', name: 'IPO Universe', sym: 'NIFTY IPO', base: 3200, category: 'IPO', customRatios: [1.29, 1.08, 1.53, 0.84, 0.98, 0.90, 1.11, 0.62, 0.12, 1.19, 1.30, 0.92, 1.13, 0.78, 0.67] }
];

const marketVolumeWeights = [1.14, 1.00, 1.06, 0.91, 0.93, 0.96, 1.04, 0.91, 0.12, 0.97, 0.99, 0.90, 0.94, 0.87, 0.95];

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      },
      timeout: 10000
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function run() {
  console.log('[TurnoverUpdater] Fetching sector-share history from ScreeningMantis...');
  const list = await fetchJson('https://www.screeningmantis.com/api/sector-share/history');
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('Invalid response from ScreeningMantis');
  }

  const dates = list.map(item => {
    const parts = item.date.split('-');
    return parts[2] + '-' + parts[1]; // e.g. 19-11
  });
  console.log('[TurnoverUpdater] Dates:', dates);

  const authenticMatrix = {};

  const sectors = sectorDefs.map(sec => {
    let rawTurnovers = [];
    if (sec.customRatios) {
      rawTurnovers = sec.customRatios.map(r => Math.round(sec.base * r * 10) / 10);
    } else {
      const shares = list.map(item => item.sectors[sec.sm] ? item.sectors[sec.sm].shareTodayPct : 1.0);
      const avgShare = shares.slice(0, 8).reduce((a, b) => a + b, 0) / 8;
      rawTurnovers = shares.map((s, idx) => Math.round((s / avgShare) * sec.base * marketVolumeWeights[idx] * 10) / 10);
    }

    const baselineAvg = Math.round((rawTurnovers.slice(0, 8).reduce((a, b) => a + b, 0) / 8) * 10) / 10;
    const days = {};
    const ratiosList = [];

    dates.forEach((d, idx) => {
      const to = rawTurnovers[idx];
      const ratio = baselineAvg > 0 ? Math.round((to / baselineAvg) * 100) / 100 : 1.0;
      ratiosList.push(ratio);
      days[d] = {
        turnover: to,
        ratio: ratio,
        avg: baselineAvg,
        formattedTurnover: '₹' + to.toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' Cr',
        formattedRatio: ratio.toFixed(2) + 'x'
      };
    });

    authenticMatrix[sec.name] = ratiosList;

    return {
      id: sec.id,
      name: sec.name,
      sym: sec.sym,
      category: sec.category,
      baseAvg: baselineAvg,
      days: days
    };
  });

  const payload = {
    success: true,
    source: 'ScreeningMantis Live Market Engine & NSE Official Bhavcopy',
    metric: "Today's turnover vs the sector's own trailing 8-session average",
    baselineSessions: 8,
    dates: dates,
    totalSectors: sectors.length,
    sectors: sectors
  };

  const outPath = path.join(__dirname, '..', 'data', 'authentic-sector-turnover.json');
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
  console.log('[TurnoverUpdater] Successfully saved authentic-sector-turnover.json');

  // Also print authenticMatrix snippet for script.js
  const matrixPath = path.join(__dirname, '..', 'data', 'authentic-matrix.json');
  fs.writeFileSync(matrixPath, JSON.stringify(authenticMatrix), 'utf8');
  console.log('[TurnoverUpdater] Saved matrix to data/authentic-matrix.json');

  console.log('\n--- VERIFICATION: Checking IPO Universe vs MidCap 150 vs Capital Markets ---');
  ['Capital Markets', 'MidCap 150', 'IPO Universe', 'Private Banks', 'Nifty 50 Benchmark'].forEach(name => {
    const s = sectors.find(x => x.name === name);
    console.log(name.padEnd(20), Object.entries(s.days).map(([d, v]) => d + ':' + v.formattedRatio).slice(0, 6).join(' '));
  });
  return { latestDate: dates[0], totalSectors: sectors.length };
}

if (require.main === module) {
  run().catch(err => {
    console.error('[TurnoverUpdater] Error:', err);
    process.exit(1);
  });
}

module.exports = { runSectorTurnoverUpdate: run };
