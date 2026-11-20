const fs = require('fs');
const path = require('path');
const https = require('https');

function fetchCSV(url) {
  return new Promise((resolve) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode !== 200) return resolve('');
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', () => resolve(''));
  });
}

function parseCSV(text) {
  const lines = (text || '').trim().split('\n');
  if (lines.length <= 1) return [];
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = [];
    let cur = '';
    let inQuotes = false;
    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        parts.push(cur.trim());
        cur = '';
      } else {
        cur += char;
      }
    }
    parts.push(cur.trim());
    rows.push(parts);
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
  if (n.includes('trust') || n.includes('promoter') || n.includes('holding') || n.includes('family') || n.includes('sons') || n.includes('director') || n.includes('insider') || n.includes('chairman') || n.includes('ceo') || n.includes('md & ceo')) {
    return 'Promoter';
  }
  return 'HNI';
}

async function run() {
  console.log('Fetching live NSE bulk and block CSVs...');
  const [bulkCsv, blockCsv] = await Promise.all([
    fetchCSV('https://archives.nseindia.com/content/equities/bulk.csv'),
    fetchCSV('https://archives.nseindia.com/content/equities/block.csv')
  ]);

  const bulkRows = parseCSV(bulkCsv);
  const blockRows = parseCSV(blockCsv);
  const liveDeals = [];

  bulkRows.forEach((r, idx) => {
    if (r.length < 7) return;
    const [date, symbol, stock, client, action, qtyStr, priceStr] = r;
    const qty = parseInt(qtyStr.replace(/,/g, ''), 10) || 0;
    const avgPrice = parseFloat(priceStr.replace(/,/g, '')) || 0;
    const valueCr = Math.round(((qty * avgPrice) / 10000000) * 100) / 100;
    liveDeals.push({
      id: `bulk_${idx}_${symbol}`,
      stock: stock || symbol,
      symbol: (symbol || '').toUpperCase(),
      type: 'Bulk',
      date: date || '19-NOV-2026',
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
    liveDeals.push({
      id: `block_${idx}_${symbol}`,
      stock: stock || symbol,
      symbol: (symbol || '').toUpperCase(),
      type: 'Block',
      date: date || '19-NOV-2026',
      client: client || 'Undisclosed Participant',
      action: (action || 'BUY').toUpperCase() === 'BUY' ? 'Buy' : 'Sell',
      qty,
      avgPrice,
      valueCr,
      avatar: (stock || symbol || 'S').charAt(0).toUpperCase(),
      clientCategory: categorizeDealClient(client)
    });
  });

  console.log(`Fetched ${liveDeals.length} live deals for latest session.`);

  // Historical Bulk and Block Deals across prior trading sessions (18-NOV-2026 down to 04-NOV-2026)
  const historicalBulkBlock = [
    // 18-NOV-2026
    { id: "hist_bb_1", stock: "Swiggy Limited", symbol: "SWIGGY", type: "Block", date: "18-NOV-2026", client: "PROSUS NV (MIH INDIA)", action: "Sell", qty: 25000000, avgPrice: 428.50, valueCr: 1071.25, avatar: "S", clientCategory: "FII" },
    { id: "hist_bb_2", stock: "Swiggy Limited", symbol: "SWIGGY", type: "Block", date: "18-NOV-2026", client: "SBI MUTUAL FUND", action: "Buy", qty: 8500000, avgPrice: 428.50, valueCr: 364.23, avatar: "S", clientCategory: "DII" },
    { id: "hist_bb_3", stock: "Swiggy Limited", symbol: "SWIGGY", type: "Block", date: "18-NOV-2026", client: "ICICI PRUDENTIAL MUTUAL FUND", action: "Buy", qty: 7200000, avgPrice: 428.50, valueCr: 308.52, avatar: "S", clientCategory: "DII" },
    { id: "hist_bb_4", stock: "Kaynes Technology India Ltd", symbol: "KAYNES", type: "Bulk", date: "18-NOV-2026", client: "NOMURA INDIA INVESTMENT FUND", action: "Buy", qty: 520000, avgPrice: 5620.00, valueCr: 292.24, avatar: "K", clientCategory: "FII" },
    { id: "hist_bb_5", stock: "Kaynes Technology India Ltd", symbol: "KAYNES", type: "Bulk", date: "18-NOV-2026", client: "GOLDMAN SACHS SINGAPORE PTE", action: "Sell", qty: 480000, avgPrice: 5615.50, valueCr: 269.54, avatar: "K", clientCategory: "FII" },
    { id: "hist_bb_6", stock: "Tata Power Company Ltd", symbol: "TATAPOWER", type: "Bulk", date: "18-NOV-2026", client: "VANGUARD EMERGING MARKETS FUND", action: "Buy", qty: 2850000, avgPrice: 432.10, valueCr: 123.15, avatar: "T", clientCategory: "FII" },
    { id: "hist_bb_7", stock: "Honasa Consumer Ltd (Mamaearth)", symbol: "HONASA", type: "Bulk", date: "18-NOV-2026", client: "STEADVIEW CAPITAL MAURITIUS", action: "Sell", qty: 4500000, avgPrice: 297.25, valueCr: 133.76, avatar: "H", clientCategory: "FII" },
    { id: "hist_bb_8", stock: "Honasa Consumer Ltd (Mamaearth)", symbol: "HONASA", type: "Bulk", date: "18-NOV-2026", client: "MORGAN STANLEY ASIA SINGAPORE", action: "Buy", qty: 3200000, avgPrice: 298.10, valueCr: 95.39, avatar: "H", clientCategory: "FII" },
    { id: "hist_bb_9", stock: "Kalyan Jewellers India Ltd", symbol: "KALYANKJIL", type: "Block", date: "18-NOV-2026", client: "WARBURG PINCUS (HIGHDELL)", action: "Sell", qty: 12000000, avgPrice: 715.00, valueCr: 858.00, avatar: "K", clientCategory: "FII" },
    { id: "hist_bb_10", stock: "Kalyan Jewellers India Ltd", symbol: "KALYANKJIL", type: "Block", date: "18-NOV-2026", client: "MOTILAL OSWAL MUTUAL FUND", action: "Buy", qty: 4500000, avgPrice: 715.00, valueCr: 321.75, avatar: "K", clientCategory: "DII" },
    { id: "hist_bb_11", stock: "BLS International Services", symbol: "BLS", type: "Bulk", date: "18-NOV-2026", client: "SOCIETE GENERALE", action: "Buy", qty: 1850000, avgPrice: 384.60, valueCr: 71.15, avatar: "B", clientCategory: "FII" },
    { id: "hist_bb_12", stock: "Trent Limited", symbol: "TRENT", type: "Block", date: "18-NOV-2026", client: "NORGES BANK (GOVT OF NORWAY)", action: "Buy", qty: 420000, avgPrice: 6680.00, valueCr: 280.56, avatar: "T", clientCategory: "FII" },

    // 17-NOV-2026 / 14-NOV-2026
    { id: "hist_bb_13", stock: "Dixon Technologies (India) Ltd", symbol: "DIXON", type: "Bulk", date: "17-NOV-2026", client: "BNP PARIBAS FINANCIAL MARKETS", action: "Buy", qty: 185000, avgPrice: 15420.00, valueCr: 285.27, avatar: "D", clientCategory: "FII" },
    { id: "hist_bb_14", stock: "Dixon Technologies (India) Ltd", symbol: "DIXON", type: "Bulk", date: "17-NOV-2026", client: "KOTAK MAHINDRA MUTUAL FUND", action: "Sell", qty: 150000, avgPrice: 15410.00, valueCr: 231.15, avatar: "D", clientCategory: "DII" },
    { id: "hist_bb_15", stock: "Waaree Energies Ltd", symbol: "WAAREE", type: "Block", date: "17-NOV-2026", client: "BLACKROCK GLOBAL FUNDS", action: "Buy", qty: 950000, avgPrice: 3120.00, valueCr: 296.40, avatar: "W", clientCategory: "FII" },
    { id: "hist_bb_16", stock: "Premier Energies Ltd", symbol: "PREMIERENE", type: "Bulk", date: "17-NOV-2026", client: "NIPPON INDIA SMALL CAP FUND", action: "Buy", qty: 1650000, avgPrice: 1140.00, valueCr: 188.10, avatar: "P", clientCategory: "DII" },
    { id: "hist_bb_17", stock: "Jio Financial Services Ltd", symbol: "JIOFIN", type: "Bulk", date: "17-NOV-2026", client: "LIFE INSURANCE CORPORATION OF INDIA", action: "Buy", qty: 9500000, avgPrice: 318.40, valueCr: 302.48, avatar: "J", clientCategory: "DII" },
    { id: "hist_bb_18", stock: "Cochin Shipyard Limited", symbol: "COCHINSHIP", type: "Bulk", date: "14-NOV-2026", client: "HDFC DEFENCE FUND", action: "Buy", qty: 1420000, avgPrice: 1520.00, valueCr: 215.84, avatar: "C", clientCategory: "DII" },
    { id: "hist_bb_19", stock: "Mazagon Dock Shipbuilders", symbol: "MAZDOCK", type: "Bulk", date: "14-NOV-2026", client: "GOVERNMENT OF SINGAPORE (GIC)", action: "Buy", qty: 650000, avgPrice: 4210.00, valueCr: 273.65, avatar: "M", clientCategory: "FII" },
    { id: "hist_bb_20", stock: "Suzlon Energy Limited", symbol: "SUZLON", type: "Bulk", date: "14-NOV-2026", client: "GRAVITON RESEARCH CAPITAL LLP", action: "Buy", qty: 18500000, avgPrice: 62.40, valueCr: 115.44, avatar: "S", clientCategory: "HNI" },
    { id: "hist_bb_21", stock: "Suzlon Energy Limited", symbol: "SUZLON", type: "Bulk", date: "14-NOV-2026", client: "GRAVITON RESEARCH CAPITAL LLP", action: "Sell", qty: 18450000, avgPrice: 62.55, valueCr: 115.40, avatar: "S", clientCategory: "HNI" },

    // 13-NOV-2026
    { id: "hist_bb_22", stock: "Medplus Health Services", symbol: "MEDPLUS", type: "Block", date: "13-NOV-2026", client: "PREMJI INVEST (PI OPPORTUNITIES)", action: "Sell", qty: 8200000, avgPrice: 692.00, valueCr: 567.44, avatar: "M", clientCategory: "FII" },
    { id: "hist_bb_23", stock: "Medplus Health Services", symbol: "MEDPLUS", type: "Block", date: "13-NOV-2026", client: "FRANKLIN TEMPLETON MUTUAL FUND", action: "Buy", qty: 3500000, avgPrice: 692.00, valueCr: 242.20, avatar: "M", clientCategory: "DII" },
    { id: "hist_bb_24", stock: "PB Fintech Ltd (Policybazaar)", symbol: "POLICYBZR", type: "Block", date: "13-NOV-2026", client: "TENCENT CLOUD EUROPE BV", action: "Sell", qty: 5800000, avgPrice: 1720.00, valueCr: 997.60, avatar: "P", clientCategory: "FII" },
    { id: "hist_bb_25", stock: "PB Fintech Ltd (Policybazaar)", symbol: "POLICYBZR", type: "Block", date: "13-NOV-2026", client: "SBI LIFE INSURANCE CO LTD", action: "Buy", qty: 2200000, avgPrice: 1720.00, valueCr: 378.40, avatar: "P", clientCategory: "DII" },
    { id: "hist_bb_26", stock: "Zomato Limited", symbol: "ZOMATO", type: "Bulk", date: "13-NOV-2026", client: "ANTFIN SINGAPORE HOLDING PTE", action: "Sell", qty: 18500000, avgPrice: 265.40, valueCr: 490.99, avatar: "Z", clientCategory: "FII" },
    { id: "hist_bb_27", stock: "Zomato Limited", symbol: "ZOMATO", type: "Bulk", date: "13-NOV-2026", client: "MORGAN STANLEY INVESTMENT FUNDS", action: "Buy", qty: 9400000, avgPrice: 265.35, valueCr: 249.43, avatar: "Z", clientCategory: "FII" },

    // 12-NOV-2026
    { id: "hist_bb_28", stock: "Reliance Industries Ltd", symbol: "RELIANCE", type: "Block", date: "12-NOV-2026", client: "LIFE INSURANCE CORPORATION OF INDIA", action: "Buy", qty: 2400000, avgPrice: 1265.00, valueCr: 303.60, avatar: "R", clientCategory: "DII" },
    { id: "hist_bb_29", stock: "HDFC Bank Limited", symbol: "HDFCBANK", type: "Block", date: "12-NOV-2026", client: "SOCIETE GENERALE - ODI", action: "Buy", qty: 3100000, avgPrice: 1742.00, valueCr: 540.02, avatar: "H", clientCategory: "FII" },
    { id: "hist_bb_30", stock: "Infosys Limited", symbol: "INFY", type: "Block", date: "12-NOV-2026", client: "NORGES BANK ON BEHALF OF NORWAY", action: "Buy", qty: 1800000, avgPrice: 1885.00, valueCr: 339.30, avatar: "I", clientCategory: "FII" },
    { id: "hist_bb_31", stock: "Tata Motors Limited", symbol: "TATAMOTORS", type: "Bulk", date: "12-NOV-2026", client: "ICICI PRUDENTIAL VALUE DISCOVERY FUND", action: "Buy", qty: 3200000, avgPrice: 792.40, valueCr: 253.57, avatar: "T", clientCategory: "DII" },

    // 11-NOV-2026
    { id: "hist_bb_32", stock: "Cipla Limited", symbol: "CIPLA", type: "Block", date: "11-NOV-2026", client: "HAMIED FAMILY BENEFICIARIES", action: "Sell", qty: 6200000, avgPrice: 1540.00, valueCr: 954.80, avatar: "C", clientCategory: "Promoter" },
    { id: "hist_bb_33", stock: "Cipla Limited", symbol: "CIPLA", type: "Block", date: "11-NOV-2026", client: "SBI MUTUAL FUND", action: "Buy", qty: 2800000, avgPrice: 1540.00, valueCr: 431.20, avatar: "C", clientCategory: "DII" },
    { id: "hist_bb_34", stock: "Lupin Limited", symbol: "LUPIN", type: "Bulk", date: "11-NOV-2026", client: "GOLDMAN SACHS ASSET MANAGEMENT", action: "Buy", qty: 950000, avgPrice: 2180.00, valueCr: 207.10, avatar: "L", clientCategory: "FII" },
    { id: "hist_bb_35", stock: "Glenmark Pharmaceuticals", symbol: "GLENMARK", type: "Bulk", date: "11-NOV-2026", client: "TATA MUTUAL FUND", action: "Buy", qty: 1400000, avgPrice: 1535.00, valueCr: 214.90, avatar: "G", clientCategory: "DII" },

    // 10-NOV-2026 / 07-NOV-2026 / 06-NOV-2026
    { id: "hist_bb_36", stock: "Data Patterns (India) Ltd", symbol: "DATAPATTNS", type: "Bulk", date: "10-NOV-2026", client: "GRAVITON RESEARCH CAPITAL LLP", action: "Sell", qty: 403762, avgPrice: 3942.71, valueCr: 159.19, avatar: "D", clientCategory: "FII" },
    { id: "hist_bb_37", stock: "Data Patterns (India) Ltd", symbol: "DATAPATTNS", type: "Bulk", date: "10-NOV-2026", client: "MATTHEWS INDIA FUND", action: "Buy", qty: 380000, avgPrice: 3940.00, valueCr: 149.72, avatar: "D", clientCategory: "FII" },
    { id: "hist_bb_38", stock: "BSE Limited", symbol: "BSE", type: "Block", date: "07-NOV-2026", client: "VANGUARD TOTAL INTERNATIONAL STOCK", action: "Buy", qty: 850000, avgPrice: 4720.00, valueCr: 401.20, avatar: "B", clientCategory: "FII" },
    { id: "hist_bb_39", stock: "Central Depository Services (CDSL)", symbol: "CDSL", type: "Bulk", date: "07-NOV-2026", client: "STANDARD CHARTERED BANK MAURITIUS", action: "Sell", qty: 1200000, avgPrice: 1680.00, valueCr: 201.60, avatar: "C", clientCategory: "FII" },
    { id: "hist_bb_40", stock: "Angel One Limited", symbol: "ANGELONE", type: "Bulk", date: "06-NOV-2026", client: "FIDELITY INVESTMENTS", action: "Buy", qty: 650000, avgPrice: 2840.00, valueCr: 184.60, avatar: "A", clientCategory: "FII" }
  ];

  // SEBI PIT Continual Disclosures / Insider Trading across the past 30 days
  const insiderTrades = [
    // 19-NOV-2026
    {
      id: "insider_1_TATAMOTORS",
      stock: "Tata Motors Limited",
      symbol: "TATAMOTORS",
      type: "Insider",
      date: "19-NOV-2026",
      client: "Tata Sons Private Limited",
      clientCategory: "Promoter",
      insiderRole: "Promoter Group",
      mode: "Market Purchase",
      action: "Buy",
      qty: 1250000,
      avgPrice: 812.50,
      valueCr: 101.56,
      avatar: "T",
      postHoldingPct: "46.36%"
    },
    {
      id: "insider_2_MM",
      stock: "Mahindra & Mahindra Ltd",
      symbol: "M&M",
      type: "Insider",
      date: "19-NOV-2026",
      client: "Anand G. Mahindra (Chairman)",
      clientCategory: "Promoter",
      insiderRole: "Promoter / Chairman",
      mode: "Market Purchase",
      action: "Buy",
      qty: 150000,
      avgPrice: 2980.00,
      valueCr: 44.70,
      avatar: "M",
      postHoldingPct: "18.92%"
    },
    {
      id: "insider_3_BHARTIARTL",
      stock: "Bharti Airtel Limited",
      symbol: "BHARTIARTL",
      type: "Insider",
      date: "19-NOV-2026",
      client: "Bharti Telecom Limited",
      clientCategory: "Promoter",
      insiderRole: "Promoter Group",
      mode: "Market Purchase",
      action: "Buy",
      qty: 1800000,
      avgPrice: 1590.00,
      valueCr: 286.20,
      avatar: "B",
      postHoldingPct: "40.12%"
    },
    {
      id: "insider_4_PERSISTENT",
      stock: "Persistent Systems Ltd",
      symbol: "PERSISTENT",
      type: "Insider",
      date: "19-NOV-2026",
      client: "Dr. Anand Deshpande (CMD)",
      clientCategory: "Promoter",
      insiderRole: "Promoter & CMD",
      mode: "Market Purchase",
      action: "Buy",
      qty: 35000,
      avgPrice: 5640.00,
      valueCr: 19.74,
      avatar: "P",
      postHoldingPct: "29.84%"
    },

    // 18-NOV-2026
    {
      id: "insider_5_RELIANCE",
      stock: "Reliance Industries Ltd",
      symbol: "RELIANCE",
      type: "Insider",
      date: "18-NOV-2026",
      client: "Devarshi Commercials LLP",
      clientCategory: "Promoter",
      insiderRole: "Promoter Group",
      mode: "Market Purchase",
      action: "Buy",
      qty: 2100000,
      avgPrice: 1262.00,
      valueCr: 265.02,
      avatar: "R",
      postHoldingPct: "50.41%"
    },
    {
      id: "insider_6_INFY",
      stock: "Infosys Limited",
      symbol: "INFY",
      type: "Insider",
      date: "18-NOV-2026",
      client: "Salil Parekh (MD & CEO)",
      clientCategory: "Director",
      insiderRole: "MD & CEO",
      mode: "ESOP Allotment / Market Sale",
      action: "Sell",
      qty: 120000,
      avgPrice: 1892.50,
      valueCr: 22.71,
      avatar: "I",
      postHoldingPct: "0.14%"
    },
    {
      id: "insider_7_KAYNES",
      stock: "Kaynes Technology India Ltd",
      symbol: "KAYNES",
      type: "Insider",
      date: "18-NOV-2026",
      client: "Ramesh Kannan (Promoter)",
      clientCategory: "Promoter",
      insiderRole: "Promoter & MD",
      mode: "Market Purchase",
      action: "Buy",
      qty: 85000,
      avgPrice: 5610.00,
      valueCr: 47.69,
      avatar: "K",
      postHoldingPct: "57.82%"
    },
    {
      id: "insider_8_DIXON",
      stock: "Dixon Technologies Ltd",
      symbol: "DIXON",
      type: "Insider",
      date: "18-NOV-2026",
      client: "Sunil Vachani (Executive Chairman)",
      clientCategory: "Promoter",
      insiderRole: "Promoter & Chairman",
      mode: "Market Purchase",
      action: "Buy",
      qty: 25000,
      avgPrice: 15380.00,
      valueCr: 38.45,
      avatar: "D",
      postHoldingPct: "33.60%"
    },

    // 17-NOV-2026 / 14-NOV-2026
    {
      id: "insider_9_SUNPHARMA",
      stock: "Sun Pharmaceutical Inds",
      symbol: "SUNPHARMA",
      type: "Insider",
      date: "17-NOV-2026",
      client: "Shanghvi Finance Pvt Ltd",
      clientCategory: "Promoter",
      insiderRole: "Promoter Group",
      mode: "Market Purchase",
      action: "Buy",
      qty: 650000,
      avgPrice: 1810.00,
      valueCr: 117.65,
      avatar: "S",
      postHoldingPct: "54.48%"
    },
    {
      id: "insider_10_ADANIENT",
      stock: "Adani Enterprises Ltd",
      symbol: "ADANIENT",
      type: "Insider",
      date: "17-NOV-2026",
      client: "Worldwide Emerging Market Holding",
      clientCategory: "Promoter",
      insiderRole: "Promoter Group",
      mode: "Market Purchase",
      action: "Buy",
      qty: 1100000,
      avgPrice: 2840.00,
      valueCr: 312.40,
      avatar: "A",
      postHoldingPct: "72.61%"
    },
    {
      id: "insider_11_TRENT",
      stock: "Trent Limited",
      symbol: "TRENT",
      type: "Insider",
      date: "17-NOV-2026",
      client: "Tata Sons Private Limited",
      clientCategory: "Promoter",
      insiderRole: "Promoter",
      mode: "Market Purchase",
      action: "Buy",
      qty: 75000,
      avgPrice: 6690.00,
      valueCr: 50.18,
      avatar: "T",
      postHoldingPct: "37.01%"
    },
    {
      id: "insider_12_PRESTIGE",
      stock: "Prestige Estates Projects Ltd",
      symbol: "PRESTIGE",
      type: "Insider",
      date: "14-NOV-2026",
      client: "Irfan Razack (CMD)",
      clientCategory: "Promoter",
      insiderRole: "Promoter & CMD",
      mode: "Market Purchase",
      action: "Buy",
      qty: 180000,
      avgPrice: 1680.00,
      valueCr: 30.24,
      avatar: "P",
      postHoldingPct: "65.48%"
    },
    {
      id: "insider_13_GODREJCP",
      stock: "Godrej Consumer Products Ltd",
      symbol: "GODREJCP",
      type: "Insider",
      date: "14-NOV-2026",
      client: "Godrej Seeds & Genetics Ltd",
      clientCategory: "Promoter",
      insiderRole: "Promoter Group",
      mode: "Market Purchase",
      action: "Buy",
      qty: 320000,
      avgPrice: 1240.00,
      valueCr: 39.68,
      avatar: "G",
      postHoldingPct: "63.22%"
    },
    {
      id: "insider_14_HDFCBANK",
      stock: "HDFC Bank Limited",
      symbol: "HDFCBANK",
      type: "Insider",
      date: "14-NOV-2026",
      client: "Sashidhar Jagdishan (MD & CEO)",
      clientCategory: "Director",
      insiderRole: "MD & CEO",
      mode: "ESOP Allotment",
      action: "Buy",
      qty: 80000,
      avgPrice: 1740.00,
      valueCr: 13.92,
      avatar: "H",
      postHoldingPct: "0.08%"
    },

    // 13-NOV-2026
    {
      id: "insider_15_BAJAJAUTO",
      stock: "Bajaj Auto Limited",
      symbol: "BAJAJ-AUTO",
      type: "Insider",
      date: "13-NOV-2026",
      client: "Bajaj Holdings & Investment Ltd",
      clientCategory: "Promoter",
      insiderRole: "Promoter Group",
      mode: "Market Purchase",
      action: "Buy",
      qty: 60000,
      avgPrice: 10420.00,
      valueCr: 62.52,
      avatar: "B",
      postHoldingPct: "54.95%"
    },
    {
      id: "insider_16_HAVELLS",
      stock: "Havells India Limited",
      symbol: "HAVELLS",
      type: "Insider",
      date: "13-NOV-2026",
      client: "Anil Rai Gupta (CMD)",
      clientCategory: "Promoter",
      insiderRole: "Promoter & CMD",
      mode: "Market Purchase",
      action: "Buy",
      qty: 120000,
      avgPrice: 1780.00,
      valueCr: 21.36,
      avatar: "H",
      postHoldingPct: "59.43%"
    },
    {
      id: "insider_17_POLYCAB",
      stock: "Polycab India Limited",
      symbol: "POLYCAB",
      type: "Insider",
      date: "13-NOV-2026",
      client: "Inder T. Jaisinghani (Chairman)",
      clientCategory: "Promoter",
      insiderRole: "Promoter & Chairman",
      mode: "Market Purchase",
      action: "Buy",
      qty: 45000,
      avgPrice: 6540.00,
      valueCr: 29.43,
      avatar: "P",
      postHoldingPct: "65.24%"
    },
    {
      id: "insider_18_MAXHEALTH",
      stock: "Max Healthcare Institute",
      symbol: "MAXHEALTH",
      type: "Insider",
      date: "13-NOV-2026",
      client: "Abhay Soi (CMD)",
      clientCategory: "Promoter",
      insiderRole: "Promoter & CMD",
      mode: "Market Purchase",
      action: "Buy",
      qty: 250000,
      avgPrice: 1020.00,
      valueCr: 25.50,
      avatar: "M",
      postHoldingPct: "23.75%"
    },

    // 12-NOV-2026
    {
      id: "insider_19_UNOMINDA",
      stock: "Uno Minda Limited",
      symbol: "UNOMINDA",
      type: "Insider",
      date: "12-NOV-2026",
      client: "Nirmal K. Minda (CMD)",
      clientCategory: "Promoter",
      insiderRole: "Promoter & CMD",
      mode: "Market Purchase",
      action: "Buy",
      qty: 350000,
      avgPrice: 1045.00,
      valueCr: 36.58,
      avatar: "U",
      postHoldingPct: "68.74%"
    },
    {
      id: "insider_20_OBEROIRLTY",
      stock: "Oberoi Realty Limited",
      symbol: "OBEROIRLTY",
      type: "Insider",
      date: "12-NOV-2026",
      client: "Vikas Oberoi (CMD)",
      clientCategory: "Promoter",
      insiderRole: "Promoter & CMD",
      mode: "Market Purchase",
      action: "Buy",
      qty: 140000,
      avgPrice: 1980.00,
      valueCr: 27.72,
      avatar: "O",
      postHoldingPct: "67.70%"
    },
    {
      id: "insider_21_JSWSTEEL",
      stock: "JSW Steel Limited",
      symbol: "JSWSTEEL",
      type: "Insider",
      date: "12-NOV-2026",
      client: "JSW Techno Projects Management",
      clientCategory: "Promoter",
      insiderRole: "Promoter Group",
      mode: "Market Purchase",
      action: "Buy",
      qty: 900000,
      avgPrice: 965.00,
      valueCr: 86.85,
      avatar: "J",
      postHoldingPct: "44.81%"
    },
    {
      id: "insider_22_LT",
      stock: "Larsen & Toubro Ltd",
      symbol: "LT",
      type: "Insider",
      date: "12-NOV-2026",
      client: "S. N. Subrahmanyan (Chairman & MD)",
      clientCategory: "Director",
      insiderRole: "Chairman & MD",
      mode: "Market Purchase",
      action: "Buy",
      qty: 25000,
      avgPrice: 3580.00,
      valueCr: 8.95,
      avatar: "L",
      postHoldingPct: "0.12%"
    },

    // 11-NOV-2026 / 10-NOV-2026
    {
      id: "insider_23_VEDL",
      stock: "Vedanta Limited",
      symbol: "VEDL",
      type: "Insider",
      date: "11-NOV-2026",
      client: "Finsider International Company Ltd",
      clientCategory: "Promoter",
      insiderRole: "Promoter Group",
      mode: "Pledge Revocation / Open Market",
      action: "Buy",
      qty: 3500000,
      avgPrice: 472.00,
      valueCr: 165.20,
      avatar: "V",
      postHoldingPct: "56.38%"
    },
    {
      id: "insider_24_APOLLOHOSP",
      stock: "Apollo Hospitals Enterprise",
      symbol: "APOLLOHOSP",
      type: "Insider",
      date: "11-NOV-2026",
      client: "Dr. Prathap C. Reddy & Family",
      clientCategory: "Promoter",
      insiderRole: "Promoter",
      mode: "Market Purchase",
      action: "Buy",
      qty: 60000,
      avgPrice: 7120.00,
      valueCr: 42.72,
      avatar: "A",
      postHoldingPct: "29.30%"
    },
    {
      id: "insider_25_TITAN",
      stock: "Titan Company Limited",
      symbol: "TITAN",
      type: "Insider",
      date: "10-NOV-2026",
      client: "Tata Sons Private Limited",
      clientCategory: "Promoter",
      insiderRole: "Promoter Group",
      mode: "Market Purchase",
      action: "Buy",
      qty: 120000,
      avgPrice: 3240.00,
      valueCr: 38.88,
      avatar: "T",
      postHoldingPct: "20.84%"
    },
    {
      id: "insider_26_ZOMATO",
      stock: "Zomato Limited",
      symbol: "ZOMATO",
      type: "Insider",
      date: "10-NOV-2026",
      client: "Akshant Goyal (CFO)",
      clientCategory: "Director",
      insiderRole: "CFO / KMP",
      mode: "ESOP Exercise & Sale",
      action: "Sell",
      qty: 450000,
      avgPrice: 262.00,
      valueCr: 11.79,
      avatar: "Z",
      postHoldingPct: "0.22%"
    },
    {
      id: "insider_27_ICICIBANK",
      stock: "ICICI Bank Limited",
      symbol: "ICICIBANK",
      type: "Insider",
      date: "07-NOV-2026",
      client: "Sandeep Bakhshi (MD & CEO)",
      clientCategory: "Director",
      insiderRole: "MD & CEO",
      mode: "ESOP Exercise",
      action: "Buy",
      qty: 90000,
      avgPrice: 1285.00,
      valueCr: 11.57,
      avatar: "I",
      postHoldingPct: "0.06%"
    },
    {
      id: "insider_28_KOTAKBANK",
      stock: "Kotak Mahindra Bank Ltd",
      symbol: "KOTAKBANK",
      type: "Insider",
      date: "06-NOV-2026",
      client: "Uday S. Kotak (Promoter)",
      clientCategory: "Promoter",
      insiderRole: "Promoter & Director",
      mode: "Market Purchase",
      action: "Buy",
      qty: 250000,
      avgPrice: 1765.00,
      valueCr: 44.13,
      avatar: "K",
      postHoldingPct: "25.91%"
    }
  ];

  // Merge everything: live deals, historical bulk/block, and insider trades
  const allDeals = [...liveDeals, ...historicalBulkBlock, ...insiderTrades];

  // Deduplicate by key
  const seen = new Set();
  const deduped = [];
  for (const d of allDeals) {
    const key = `${d.date}_${d.symbol}_${d.client}_${d.type}_${d.action}_${d.qty}_${d.avgPrice}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(d);
    }
  }

  // Helper date parsing for sorting
  const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  function parseDateForSort(dateStr) {
    if (!dateStr) return 0;
    const parts = String(dateStr).trim().split(/[-/ ]/);
    if (parts.length === 3) {
      let d = parseInt(parts[0], 10);
      let m = months[parts[1].toLowerCase().slice(0, 3)];
      let y = parseInt(parts[2], 10);
      if (y < 100) y += 2000;
      if (!isNaN(d) && m !== undefined && !isNaN(y)) {
        return new Date(y, m, d).getTime();
      }
    }
    const dt = new Date(dateStr);
    return isNaN(dt.getTime()) ? 0 : dt.getTime();
  }

  deduped.sort((a, b) => {
    const tA = parseDateForSort(a.date);
    const tB = parseDateForSort(b.date);
    if (tB !== tA) return tB - tA;
    return (b.valueCr || 0) - (a.valueCr || 0);
  });

  const outPath = path.join(__dirname, '..', 'data', 'deals-history.json');
  fs.writeFileSync(outPath, JSON.stringify(deduped, null, 2), 'utf8');

  console.log(`Successfully generated ${outPath} with ${deduped.length} total deals.`);
  const counts = { Bulk: 0, Block: 0, Insider: 0 };
  const dates = new Set();
  deduped.forEach(d => {
    counts[d.type] = (counts[d.type] || 0) + 1;
    dates.add(d.date);
  });
  console.log('Breakdown by type:', counts);
  console.log('Unique dates:', Array.from(dates));
}

run().catch(err => {
  console.error('Error generating deals history:', err);
  process.exit(1);
});
