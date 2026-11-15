const fs = require('fs');
const path = require('path');

const scriptPath = path.join(__dirname, '..', 'script.js');
const dataPath = path.join(__dirname, '..', 'data', 'stocks-nifty500.json');

const stocks = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
let scriptContent = fs.readFileSync(scriptPath, 'utf8');

console.log(`Read ${stocks.length} stocks from ${dataPath}`);

// Locate ST definition: from "const ST = [" up to "];\r?\n\r?\n  // Comprehensive stock symbol"
const stStartRegex = /const ST = \[\r?\n/;
const matchStart = scriptContent.match(stStartRegex);
if (!matchStart) {
  console.error('Could not find "const ST = [" in script.js');
  process.exit(1);
}

const startIndex = matchStart.index;
// Find the closing "];" for ST
const closingPattern = /\r?\n  \];\r?\n\r?\n  \/\/ Comprehensive stock symbol/;
const matchEnd = scriptContent.slice(startIndex).match(closingPattern);
if (!matchEnd) {
  console.error('Could not find closing pattern for ST in script.js');
  process.exit(1);
}

const endIndex = startIndex + matchEnd.index + matchEnd[0].indexOf(';');

// Format stocks cleanly
const formattedStocks = stocks.map(s => '    ' + JSON.stringify(s)).join(',\n');
const replacementST = `let ST = [\n${formattedStocks}\n  ]`;

scriptContent = scriptContent.slice(0, startIndex) + replacementST + scriptContent.slice(endIndex);

// Also fix line 9728 if needed: const meta = s[7] || {}; -> const meta = (s[8] && s[8].name) ? s[8] : (s[7] && s[7].name ? s[7] : {});
scriptContent = scriptContent.replace(
  'const meta = s[7] || {};',
  'const meta = (s[8] && s[8].name) ? s[8] : (s[7] && s[7].name ? s[7] : {});'
);

// Add dynamic catalog sync function if not already present
if (!scriptContent.includes('syncNifty500Catalog')) {
  const syncFunction = `
  // Dynamic fetch of repository-synced Nifty 500 catalog for GitHub Pages and static deployments
  async function syncNifty500Catalog() {
    try {
      const jsonResp = await fetch('./data/stocks-nifty500.json', { cache: 'no-store' });
      if (jsonResp.ok) {
        const history = await jsonResp.json();
        if (Array.isArray(history) && history.length >= 400) {
          ST.splice(0, ST.length, ...history);
          for (const s of ST) {
            ST_MAP[s[0]] = {
              symbol: s[0],
              cap: s[1],
              sector: s[2],
              price: s[3],
              chg: s[4],
              pat: s[5],
              tech: s[6],
              stars: s[7],
              name: (s[8] && s[8].name) ? s[8].name : s[2],
              ...(s[8] || {})
            };
          }
          if (typeof State !== 'undefined' && State.view === 'screener') {
            render();
          }
        }
      }
    } catch (e) {
      // Graceful fallback to embedded catalog
    }
  }
`;

  // Insert before init() or in bootstrap
  const initAppMatch = scriptContent.match(/function initApp\(\) \{/);
  if (initAppMatch) {
    scriptContent = scriptContent.replace(
      'function initApp() {',
      `${syncFunction}\n  function initApp() {\n    syncNifty500Catalog();`
    );
  }
}

fs.writeFileSync(scriptPath, scriptContent, 'utf8');
console.log('✅ Successfully updated script.js with full Nifty 500 universe and sync routine!');
