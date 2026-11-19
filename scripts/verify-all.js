const http = require('http');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, text: data });
        }
      });
    }).on('error', reject);
  });
}

async function verify() {
  console.log('=== VERIFYING FII / DII ===');
  const fiiRes = await fetchJson('http://localhost:3000/api/fii-dii');
  console.log('Status:', fiiRes.status);
  console.log('Latest Date:', fiiRes.json.latestDate);
  console.log('Day flow:', fiiRes.json.periods?.day);
  if (fiiRes.json.latestDate !== '2026-11-19') throw new Error('FII latest date is not 2026-11-19!');
  if (fiiRes.json.periods?.day?.fiiNet !== 7411.41) throw new Error('FII net is not 7411.41!');
  if (fiiRes.json.periods?.day?.diiNet !== -1356.57) throw new Error('DII net is not -1356.57!');
  console.log('✅ FII/DII verified successfully!\n');

  console.log('=== VERIFYING SECTOR TURNOVER ===');
  const secRes = await fetchJson('http://localhost:3000/api/sector-turnover');
  console.log('Status:', secRes.status);
  console.log('Dates count:', secRes.json.dates?.length, 'Dates:', secRes.json.dates);
  console.log('Sectors count:', secRes.json.sectors?.length);
  if (secRes.json.dates[0] !== '19-11') throw new Error('First date is not 19-11!');

  const sectors = secRes.json.sectors;
  const ipo = sectors.find(s => s.name === 'IPO Universe');
  const midcap = sectors.find(s => s.name === 'MidCap 150');
  const capmkt = sectors.find(s => s.name === 'Capital Markets');

  console.log('\n--- TARGET SECTORS COMPARISON (should be distinct) ---');
  console.log('Capital Markets:', Object.entries(capmkt.days).map(([d, v]) => d + ':' + v.formattedRatio).slice(0, 6).join(' '));
  console.log('MidCap 150:     ', Object.entries(midcap.days).map(([d, v]) => d + ':' + v.formattedRatio).slice(0, 6).join(' '));
  console.log('IPO Universe:   ', Object.entries(ipo.days).map(([d, v]) => d + ':' + v.formattedRatio).slice(0, 6).join(' '));

  const capRatio19 = capmkt.days['19-11'].ratio;
  const midRatio19 = midcap.days['19-11'].ratio;
  const ipoRatio19 = ipo.days['19-11'].ratio;

  if (capRatio19 === midRatio19 && midRatio19 === ipoRatio19) {
    throw new Error('Sectors still have identical ratios!');
  }
  console.log('✅ Sector turnover verified distinct and authentic!\n');

  console.log('=== VERIFYING INDEX.HTML ===');
  const htmlRes = await fetchJson('http://localhost:3000/');
  if (htmlRes.status === 200 && htmlRes.text.includes('script.js?v=6.2.8')) {
    console.log('✅ index.html serves script.js?v=6.2.8 correctly!\n');
  } else {
    throw new Error('index.html did not match expected version');
  }

  console.log('ALL VERIFICATIONS PASSED SUCCESSFULLY!');
}

verify().catch(err => {
  console.error('VERIFICATION FAILED:', err);
  process.exit(1);
});
