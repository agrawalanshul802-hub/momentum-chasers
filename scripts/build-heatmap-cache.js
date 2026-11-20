const http = require('http');
const fs = require('fs');
const path = require('path');

const NIFTY_50_STOCKS = [
  { symbol: "RELIANCE", name: "Reliance Industries", sector: "Oil & Gas & Energy", logoBg: "radial-gradient(circle, #fde047 30%, #d97706 90%)", logoColor: "#ffffff", logoText: "R" },
  { symbol: "TCS", name: "Tata Consultancy Services", sector: "Information Technology", logoBg: "linear-gradient(135deg, #1e3a8a, #3b82f6)", logoColor: "#ffffff", logoText: "TCS" },
  { symbol: "HDFCBANK", name: "HDFC Bank", sector: "Banking & Finance", logoBg: "#004c8f", logoColor: "#ffffff", logoText: "HDFC" },
  { symbol: "BHARTIARTL", name: "Bharti Airtel", sector: "Telecommunication", logoBg: "#dc2626", logoColor: "#ffffff", logoText: "airtel" },
  { symbol: "ICICIBANK", name: "ICICI Bank", sector: "Banking & Finance", logoBg: "linear-gradient(135deg, #b91c1c, #ea580c)", logoColor: "#ffffff", logoText: "i" },
  { symbol: "INFY", name: "Infosys", sector: "Information Technology", logoBg: "#007cc3", logoColor: "#ffffff", logoText: "Infy" },
  { symbol: "SBIN", name: "State Bank of India", sector: "Banking & Finance", logoBg: "#00a1e0", logoColor: "#ffffff", logoText: "SBI" },
  { symbol: "ITC", name: "ITC Ltd", sector: "FMCG & Consumer", logoBg: "linear-gradient(135deg, #1e3a8a, #dc2626)", logoColor: "#ffffff", logoText: "ITC" },
  { symbol: "LT", name: "Larsen & Toubro", sector: "Construction & Infra", logoBg: "linear-gradient(135deg, #1e293b, #0284c7)", logoColor: "#ffffff", logoText: "L&T" },
  { symbol: "BAJFINANCE", name: "Bajaj Finance", sector: "Banking & Finance", logoBg: "#005a9c", logoColor: "#ffffff", logoText: "B" },
  { symbol: "HCLTECH", name: "HCL Technologies", sector: "Information Technology", logoBg: "#0072c6", logoColor: "#ffffff", logoText: "HCL" },
  { symbol: "MARUTI", name: "Maruti Suzuki India", sector: "Automobile & Auto Ancil", logoBg: "#00205b", logoColor: "#ffffff", logoText: "MS" },
  { symbol: "SUNPHARMA", name: "Sun Pharmaceutical", sector: "Pharma & Healthcare", logoBg: "linear-gradient(135deg, #ea580c, #f59e0b)", logoColor: "#ffffff", logoText: "SUN" },
  { symbol: "M&M", name: "Mahindra & Mahindra", sector: "Automobile & Auto Ancil", logoBg: "#dc2626", logoColor: "#ffffff", logoText: "M&M" },
  { symbol: "KOTAKBANK", name: "Kotak Mahindra Bank", sector: "Banking & Finance", logoBg: "#ed1c24", logoColor: "#ffffff", logoText: "kotak" },
  { symbol: "AXISBANK", name: "Axis Bank", sector: "Banking & Finance", logoBg: "#97144d", logoColor: "#ffffff", logoText: "AXIS" },
  { symbol: "TITAN", name: "Titan Company", sector: "FMCG & Consumer", logoBg: "#000000", logoColor: "#ffffff", logoText: "TITAN" },
  { symbol: "ULTRACEMCO", name: "UltraTech Cement", sector: "Commodities & Materials", logoBg: "#f59e0b", logoColor: "#000000", logoText: "UT" },
  { symbol: "NTPC", name: "NTPC Ltd", sector: "Power & Utilities", logoBg: "#005596", logoColor: "#ffffff", logoText: "NTPC" },
  { symbol: "ONGC", name: "ONGC Ltd", sector: "Oil & Gas & Energy", logoBg: "#8b0000", logoColor: "#ffffff", logoText: "ONGC" },
  { symbol: "ADANIENT", name: "Adani Enterprises", sector: "Metals & Mining", logoBg: "linear-gradient(135deg, #1e3a8a, #0d9488)", logoColor: "#ffffff", logoText: "ADANI" },
  { symbol: "POWERGRID", name: "Power Grid Corp", sector: "Power & Utilities", logoBg: "#00529b", logoColor: "#ffffff", logoText: "PGC" },
  { symbol: "TATASTEEL", name: "Tata Steel", sector: "Metals & Mining", logoBg: "#00487c", logoColor: "#ffffff", logoText: "TATA" },
  { symbol: "COALINDIA", name: "Coal India", sector: "Metals & Mining", logoBg: "#f59e0b", logoColor: "#000000", logoText: "CIL" },
  { symbol: "BAJAJFINSV", name: "Bajaj Finserv", sector: "Banking & Finance", logoBg: "#005a9c", logoColor: "#ffffff", logoText: "BFS" },
  { symbol: "JSWSTEEL", name: "JSW Steel", sector: "Metals & Mining", logoBg: "#c4122f", logoColor: "#ffffff", logoText: "JSW" },
  { symbol: "HINDUNILVR", name: "Hindustan Unilever", sector: "FMCG & Consumer", logoBg: "#005a9c", logoColor: "#ffffff", logoText: "HUL" },
  { symbol: "ADANIPORTS", name: "Adani Ports & SEZ", sector: "Services & Logistics", logoBg: "linear-gradient(135deg, #1e3a8a, #0d9488)", logoColor: "#ffffff", logoText: "APSEZ" },
  { symbol: "ASIANPAINT", name: "Asian Paints", sector: "FMCG & Consumer", logoBg: "#dc2626", logoColor: "#ffffff", logoText: "AP" },
  { symbol: "GRASIM", name: "Grasim Industries", sector: "Commodities & Materials", logoBg: "#c4122f", logoColor: "#ffffff", logoText: "GRASIM" },
  { symbol: "BEL", name: "Bharat Electronics", sector: "Capital Goods & Engineering", logoBg: "#004b87", logoColor: "#ffffff", logoText: "BEL" },
  { symbol: "TECHM", name: "Tech Mahindra", sector: "Information Technology", logoBg: "#e31837", logoColor: "#ffffff", logoText: "TM" },
  { symbol: "EICHERMOT", name: "Eicher Motors", sector: "Automobile & Auto Ancil", logoBg: "#dc2626", logoColor: "#ffffff", logoText: "RE" },
  { symbol: "HINDALCO", name: "Hindalco Industries", sector: "Metals & Mining", logoBg: "#c4122f", logoColor: "#ffffff", logoText: "HIND" },
  { symbol: "CIPLA", name: "Cipla Ltd", sector: "Pharma & Healthcare", logoBg: "#003865", logoColor: "#ffffff", logoText: "CIPLA" },
  { symbol: "TRENT", name: "Trent Ltd", sector: "FMCG & Consumer", logoBg: "#000000", logoColor: "#ffffff", logoText: "TRENT" },
  { symbol: "NESTLEIND", name: "Nestle India", sector: "FMCG & Consumer", logoBg: "#005a9c", logoColor: "#ffffff", logoText: "NESTLE" },
  { symbol: "DRREDDY", name: "Dr Reddy's Labs", sector: "Pharma & Healthcare", logoBg: "#6a1b9a", logoColor: "#ffffff", logoText: "RDY" },
  { symbol: "WIPRO", name: "Wipro Ltd", sector: "Information Technology", logoBg: "#e91e63", logoColor: "#ffffff", logoText: "WIPRO" },
  { symbol: "BAJAJ-AUTO", name: "Bajaj Auto", sector: "Automobile & Auto Ancil", logoBg: "#005a9c", logoColor: "#ffffff", logoText: "BAJAJ" },
  { symbol: "APOLLOHOSP", name: "Apollo Hospitals", sector: "Pharma & Healthcare", logoBg: "#00838f", logoColor: "#ffffff", logoText: "APOLLO" },
  { symbol: "TATACONSUM", name: "Tata Consumer Products", sector: "FMCG & Consumer", logoBg: "#00487c", logoColor: "#ffffff", logoText: "TCP" },
  { symbol: "SHRIRAMFIN", name: "Shriram Finance", sector: "Banking & Finance", logoBg: "#f59e0b", logoColor: "#000000", logoText: "SFL" },
  { symbol: "BPCL", name: "Bharat Petroleum", sector: "Oil & Gas & Energy", logoBg: "#005a9c", logoColor: "#ffffff", logoText: "BPCL" },
  { symbol: "DIVISLAB", name: "Divi's Laboratories", sector: "Pharma & Healthcare", logoBg: "#00695c", logoColor: "#ffffff", logoText: "DIVIS" },
  { symbol: "HEROMOTOCO", name: "Hero MotoCorp", sector: "Automobile & Auto Ancil", logoBg: "#dc2626", logoColor: "#ffffff", logoText: "HERO" },
  { symbol: "INDUSINDBK", name: "IndusInd Bank", sector: "Banking & Finance", logoBg: "#8b0000", logoColor: "#ffffff", logoText: "IIB" },
  { symbol: "SBILIFE", name: "SBI Life Insurance", sector: "Banking & Finance", logoBg: "#00a1e0", logoColor: "#ffffff", logoText: "SBIL" },
  { symbol: "HDFCLIFE", name: "HDFC Life Insurance", sector: "Banking & Finance", logoBg: "#004c8f", logoColor: "#ffffff", logoText: "HDFCL" },
  { symbol: "BRITANNIA", name: "Britannia Industries", sector: "FMCG & Consumer", logoBg: "#dc2626", logoColor: "#ffffff", logoText: "BRIT" }
];

const NIFTY_BANK_STOCKS = [
  { symbol: "HDFCBANK", name: "HDFC Bank", sector: "Banking", logoBg: "#004c8f", logoColor: "#ffffff", logoText: "HDFC" },
  { symbol: "ICICIBANK", name: "ICICI Bank", sector: "Banking", logoBg: "linear-gradient(135deg, #b91c1c, #ea580c)", logoColor: "#ffffff", logoText: "i" },
  { symbol: "SBIN", name: "State Bank of India", sector: "Banking", logoBg: "#00a1e0", logoColor: "#ffffff", logoText: "SBI" },
  { symbol: "KOTAKBANK", name: "Kotak Mahindra Bank", sector: "Banking", logoBg: "#ed1c24", logoColor: "#ffffff", logoText: "kotak" },
  { symbol: "AXISBANK", name: "Axis Bank", sector: "Banking", logoBg: "#97144d", logoColor: "#ffffff", logoText: "AXIS" },
  { symbol: "INDUSINDBK", name: "IndusInd Bank", sector: "Banking", logoBg: "#8b0000", logoColor: "#ffffff", logoText: "IIB" },
  { symbol: "BANKBARODA", name: "Bank of Baroda", sector: "Banking", logoBg: "#f26522", logoColor: "#ffffff", logoText: "BOB" },
  { symbol: "PNB", name: "Punjab National Bank", sector: "Banking", logoBg: "#a02040", logoColor: "#ffffff", logoText: "PNB" },
  { symbol: "AUBANK", name: "AU Small Finance Bank", sector: "Banking", logoBg: "#6c1d45", logoColor: "#ffffff", logoText: "AU" },
  { symbol: "FEDERALBNK", name: "Federal Bank", sector: "Banking", logoBg: "#004080", logoColor: "#ffffff", logoText: "FED" },
  { symbol: "IDFCFIRSTB", name: "IDFC FIRST Bank", sector: "Banking", logoBg: "#9e1b32", logoColor: "#ffffff", logoText: "IDFC" },
  { symbol: "CANBK", name: "Canara Bank", sector: "Banking", logoBg: "#0055a5", logoColor: "#ffffff", logoText: "CAN" }
];

async function run() {
  console.log('Fetching live / EOD quotes for Heatmap constituents...');
  const allSymbols = [...new Set([
    ...NIFTY_50_STOCKS.map(s => s.symbol),
    ...NIFTY_BANK_STOCKS.map(s => s.symbol)
  ])];

  const ySymbols = allSymbols.map(s => s + '.NS').join(',') + ',^NSEI,^NSEBANK';

  const rawJson = await new Promise((resolve, reject) => {
    http.get('http://localhost:3000/api/quote?symbols=' + encodeURIComponent(ySymbols), res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });

  const quotes = rawJson?.quoteResponse?.result || [];
  console.log('Received quotes for', quotes.length, 'symbols');

  const quoteMap = {};
  quotes.forEach(q => {
    const sym = q.symbol.replace('.NS', '');
    quoteMap[sym] = q;
  });

  const idxNifty = quoteMap['^NSEI'] || {};
  const idxBank = quoteMap['^NSEBANK'] || {};

  const now = new Date();
  const istDateStr = now.toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata'
  });
  const istTimeStr = now.toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata'
  });

  // Build Nifty 50 formatted dataset
  const n50Formatted = NIFTY_50_STOCKS.map(s => {
    const q = quoteMap[s.symbol] || {};
    const price = q.regularMarketPrice || 0;
    const chg = +(q.regularMarketChangePercent || 0).toFixed(2);
    const mcapCr = q.marketCap ? Math.round(q.marketCap / 10000000) : 50000;
    const vol = q.regularMarketVolume
      ? (q.regularMarketVolume > 10000000 ? (q.regularMarketVolume / 10000000).toFixed(2) + ' Cr' : (q.regularMarketVolume / 100000).toFixed(1) + ' L')
      : '—';
    return {
      symbol: s.symbol,
      name: s.name,
      sector: s.sector,
      price,
      chg,
      mcap: mcapCr,
      volume: vol,
      logoBg: s.logoBg,
      logoColor: s.logoColor,
      logoText: s.logoText
    };
  });

  // Build Nifty Bank formatted dataset
  const bankFormatted = NIFTY_BANK_STOCKS.map(s => {
    const q = quoteMap[s.symbol] || {};
    const price = q.regularMarketPrice || 0;
    const chg = +(q.regularMarketChangePercent || 0).toFixed(2);
    const mcapCr = q.marketCap ? Math.round(q.marketCap / 10000000) : 30000;
    const vol = q.regularMarketVolume
      ? (q.regularMarketVolume > 10000000 ? (q.regularMarketVolume / 10000000).toFixed(2) + ' Cr' : (q.regularMarketVolume / 100000).toFixed(1) + ' L')
      : '—';
    return {
      symbol: s.symbol,
      name: s.name,
      sector: s.sector,
      price,
      chg,
      mcap: mcapCr,
      volume: vol,
      logoBg: s.logoBg,
      logoColor: s.logoColor,
      logoText: s.logoText
    };
  });

  const payload = {
    status: "success",
    timestamp: now.toISOString(),
    asOfDate: `${istDateStr} (${idxNifty.marketState === 'REGULAR' ? 'Live ' + istTimeStr : 'EOD Close'})`,
    isLive: idxNifty.marketState === 'REGULAR',
    dateLabel: idxNifty.marketState === 'REGULAR' ? "Live Market Feed" : "EOD Market Close",
    stats: {
      "Nifty 50": {
        price: Number(idxNifty.regularMarketPrice || 25753.45).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        chg: `${(idxNifty.regularMarketChange || 0) >= 0 ? '+' : ''}${Number(idxNifty.regularMarketChange || 0).toFixed(2)} (${(idxNifty.regularMarketChangePercent || 0) >= 0 ? '+' : ''}${Number(idxNifty.regularMarketChangePercent || 0).toFixed(2)}%) ${idxNifty.regularMarketChange >= 0 ? '↗' : '↘'}`,
        isUp: (idxNifty.regularMarketChange || 0) >= 0
      },
      "Nifty Bank": {
        price: Number(idxBank.regularMarketPrice || 64447.95).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        chg: `${(idxBank.regularMarketChange || 0) >= 0 ? '+' : ''}${Number(idxBank.regularMarketChange || 0).toFixed(2)} (${(idxBank.regularMarketChangePercent || 0) >= 0 ? '+' : ''}${Number(idxBank.regularMarketChangePercent || 0).toFixed(2)}%) ${idxBank.regularMarketChange >= 0 ? '↗' : '↘'}`,
        isUp: (idxBank.regularMarketChange || 0) >= 0
      }
    },
    indices: {
      "Nifty 50": n50Formatted,
      "Nifty Bank": bankFormatted
    }
  };

  const outPath = path.join(__dirname, '..', 'data', 'heatmap-cache.json');
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
  console.log('Saved heatmap cache to:', outPath);
  console.log('Nifty 50 stats:', payload.stats["Nifty 50"]);
  console.log('Nifty Bank stats:', payload.stats["Nifty Bank"]);
  console.log('As of Date:', payload.asOfDate);
}

run().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
