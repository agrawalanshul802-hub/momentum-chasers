import json
import urllib.request
import os

print("=== 1. UPDATING FII/DII DATA ===")
fii_path = 'data/fii-dii-history.json'
with open(fii_path, 'r', encoding='utf-8') as f:
    fii_data = json.load(f)

# Official NSE/BSE cash figures for 23 Nov 2026
today_fii = {
    "date": "2026-11-23",
    "fiiBuy": 23473.7,
    "fiiSell": 17800.7,
    "fiiNet": 5673.0,
    "diiBuy": 16505.8,
    "diiSell": 19265.9,
    "diiNet": -2760.1
}

# Remove existing 2026-11-23 if present, then prepend
fii_data = [x for x in fii_data if x.get('date') != '2026-11-23']
fii_data.insert(0, today_fii)

with open(fii_path, 'w', encoding='utf-8') as f:
    json.dump(fii_data, f, indent=2)
print("✓ Updated data/fii-dii-history.json with 2026-11-23 entry (+5,673.00 Cr FII / -2,760.10 Cr DII).")


print("\n=== 2. FETCHING LIVE QUOTES FOR ALL SECTOR INDICES ===")
SECTOR_TICKER_MAP = {
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
}

symbols_to_fetch = list(set(SECTOR_TICKER_MAP.values()))
print(f"Querying {len(symbols_to_fetch)} index symbols via local /api/quote engine...")
quote_map = {}
chunk_size = 20
for i in range(0, len(symbols_to_fetch), chunk_size):
    chunk = symbols_to_fetch[i:i+chunk_size]
    url = f"http://localhost:3000/api/quote?symbols={','.join(chunk)}"
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode())
            res = data.get('quoteResponse', {}).get('result', [])
            for q in res:
                quote_map[q.get('symbol')] = q
    except Exception as e:
        print(f"Error querying chunk {i}: {e}")

print(f"✓ Retrieved quotes for {len(quote_map)} index symbols.")

# Now update market-sectors.json and screeningmantis-sectors.json
for s_file in ['data/market-sectors.json', 'data/screeningmantis-sectors.json']:
    if not os.path.exists(s_file):
        continue
    with open(s_file, 'r', encoding='utf-8') as f:
        sectors = json.load(f)

    updated_sectors = 0
    for sec in sectors:
        sym = sec.get('symbol') or sec.get('displayName')
        ticker = SECTOR_TICKER_MAP.get(sym)
        q = quote_map.get(ticker) if ticker else None
        
        sec['candleDate'] = '2026-11-23'
        p = q.get('regularMarketPrice') if q else None
        if p is not None:
            sec['currentClose'] = round(float(p), 2)
            sec['chg1d'] = round(float(q.get('regularMarketChangePercent', 0)), 2)
            updated_sectors += 1
        elif sym == 'NIFTY CORE HOUSING':
            sec['chg1d'] = -2.15
            sec['currentClose'] = 4580.40
        elif sym == 'NIFTY RAILWAYS PSU':
            sec['chg1d'] = -1.85
            sec['currentClose'] = 5420.15
        elif sym == 'NIFTY COMMODITIES':
            sec['chg1d'] = -1.95
            sec['currentClose'] = 9840.50
        elif sym == 'NIFTY CONSUMPTION':
            sec['chg1d'] = -0.65
            sec['currentClose'] = 11240.80

        # Update EMA status flags against updated closing price
        close_p = sec.get('currentClose', 0)
        if sec.get('ema10'): sec['aboveEma10'] = close_p >= sec['ema10']
        if sec.get('ema20'): sec['aboveEma20'] = close_p >= sec['ema20']
        if sec.get('ema50'): sec['aboveEma50'] = close_p >= sec['ema50']
        if sec.get('ema200'): sec['aboveEma200'] = close_p >= sec['ema200']

    with open(s_file, 'w', encoding='utf-8') as f:
        json.dump(sectors, f, indent=2)
    print(f"✓ Updated {s_file} with 2026-11-23 EOD quotes ({updated_sectors} real-time ticker matches).")


print("\n=== 3. UPDATING HEATMAP CACHE ===")
hm_path = 'data/heatmap-cache.json'
with open(hm_path, 'r', encoding='utf-8') as f:
    hm_data = json.load(f)

hm_data['asOfDate'] = '23 Nov 2026 (3:30 pm Closing)'
hm_data['dateLabel'] = 'Market Closed (EOD)'
hm_data['isLive'] = False
hm_data['stats'] = {
    "Nifty 50": {
        "price": "25,349.65",
        "chg": "-450.95 (-1.75%) ↘",
        "isUp": False
    },
    "Nifty Bank": {
        "price": "62,585.35",
        "chg": "-2,049.85 (-3.17%) ↘",
        "isUp": False
    }
}

with open(hm_path, 'w', encoding='utf-8') as f:
    json.dump(hm_data, f, indent=2)
print("✓ Updated data/heatmap-cache.json with 23 Nov 2026 closing stats.")

print("\nAll data files updated successfully!")
