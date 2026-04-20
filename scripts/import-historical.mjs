// ============================================================================
// GWTTKB Historical Value Importer
// Converts your 1QB + SF CSV spreadsheets into the unified historical database
// Run once: node scripts/import-historical.mjs
// Requires both CSVs in: source-data/1qb-historical.csv + sf-historical.csv
// Outputs: public/data/historical-values.json
// ============================================================================

import fs from 'fs';
import path from 'path';

const SLEEPER = 'https://api.sleeper.app/v1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── NAME NORMALIZER ──
function norm(name) {
  return String(name).toLowerCase()
    .replace(/\s+(jr\.?|sr\.?|ii|iii|iv|v)\.?$/i, '')
    .replace(/[^a-z]/g, '');
}

// ── CSV PARSER ──
function parseCSV(filepath) {
  const text = fs.readFileSync(filepath, 'utf8');
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const rows = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const vals = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { vals.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    vals.push(cur.trim());
    const row = {};
    headers.forEach((h, i) => { row[h] = vals[i] ?? ''; });
    rows.push(row);
  }
  return { headers, rows };
}

// ── IDENTIFY COLUMN TYPES ──
function classifyColumns(headers) {
  const picks = headers.filter(h => h !== 'Date' && /early|late|mid/i.test(h));
  const players = headers.filter(h => h !== 'Date' && !picks.includes(h));
  return { picks, players };
}

// ── FETCH SLEEPER PLAYER MAP ──
async function fetchSleeperMap() {
  console.log('Fetching Sleeper player map...');
  const r = await fetch(`${SLEEPER}/players/nfl`, {
    headers: { 'User-Agent': 'GWTTKB/1.0' }
  });
  if (!r.ok) throw new Error('Failed to fetch Sleeper players');
  const data = await r.json();

  const byName = {}; // normalized name → player data
  const byId = {};   // sleeper_id → player data
  for (const [id, p] of Object.entries(data)) {
    if (!p?.full_name) continue;
    if (!['QB','RB','WR','TE'].includes(p.position)) continue;
    const key = norm(p.full_name);
    const pd = { sleeper_id: id, name: p.full_name, pos: p.position,
                  team: p.team || 'FA', age: p.age || null,
                  years_exp: p.years_exp || 0 };
    byName[key] = pd;
    byId[id] = pd;
  }
  console.log(`  ${Object.keys(byName).length} Sleeper fantasy players loaded`);
  return { byName, byId };
}

// ── NAME MATCHING ──
function matchPlayers(playerCols, sleeperMap) {
  const matched = {};
  const unmatched = [];

  for (const csvName of playerCols) {
    const key = norm(csvName);
    if (sleeperMap[key]) {
      matched[csvName] = sleeperMap[key];
      continue;
    }
    // Try without Jr/Sr/suffix variations
    const alt1 = key.replace(/(jr|sr|ii|iii|iv)$/, '');
    if (sleeperMap[alt1]) { matched[csvName] = sleeperMap[alt1]; continue; }
    // Try with period variants (A.J. -> aj)
    const alt2 = key.replace(/\./g, '');
    if (sleeperMap[alt2]) { matched[csvName] = sleeperMap[alt2]; continue; }
    unmatched.push(csvName);
  }

  const pct = Math.round(Object.keys(matched).length / playerCols.length * 100);
  console.log(`  Matched: ${Object.keys(matched).length}/${playerCols.length} players (${pct}%)`);
  if (unmatched.length) {
    console.log(`  Unmatched (${unmatched.length}): ${unmatched.slice(0, 20).join(', ')}`);
  }
  return matched;
}

// ── PROCESS PICK NAME → STANDARD FORMAT ──
function normalizePick(pickName) {
  // "2026 Early 1st" → { year: 2026, tier: 'early', round: 1 }
  const m = pickName.match(/(\d{4})\s+(Early|Mid|Late)\s+(\d+)/i);
  if (!m) return null;
  return {
    id: `pick_${m[1]}_${m[2].toLowerCase()}_${m[3]}`,
    year: parseInt(m[1]),
    tier: m[2].toLowerCase(),
    round: parseInt(m[3]),
    label: pickName
  };
}

// ── MAIN ──
async function main() {
  console.log('=== GWTTKB Historical Value Importer ===\n');

  // Check source files exist
  const f1qb = 'source-data/1qb-historical.csv';
  const fSF  = 'source-data/sf-historical.csv';
  if (!fs.existsSync(f1qb)) throw new Error(`Missing: ${f1qb}`);
  if (!fs.existsSync(fSF))  throw new Error(`Missing: ${fSF}`);

  // Parse CSVs
  console.log('Parsing 1QB CSV...');
  const { headers, rows: rows1QB } = parseCSV(f1qb);
  console.log(`  ${rows1QB.length} dates loaded`);

  console.log('Parsing SF CSV...');
  const { rows: rowsSF } = parseCSV(fSF);
  console.log(`  ${rowsSF.length} dates loaded`);

  // Classify columns
  const { picks: pickCols, players: playerCols } = classifyColumns(headers);
  console.log(`  ${playerCols.length} players, ${pickCols.length} pick slots\n`);

  // Fetch Sleeper IDs
  const { byName: sleeperMap } = await fetchSleeperMap();

  // Match player names to Sleeper IDs
  console.log('\nMatching player names to Sleeper IDs...');
  const playerMatches = matchPlayers(playerCols, sleeperMap);

  // Build date-indexed lookup for both formats
  const sfByDate = {};
  for (const row of rowsSF) {
    if (row.Date) sfByDate[row.Date.trim()] = row;
  }

  // Build unified output
  console.log('\nBuilding historical database...');

  // player_history: { sleeper_id → { name, pos, team, values: { date → { v1qb, vsf } } } }
  const playerHistory = {};
  // pick_history: { pick_id → { label, values: { date → { v1qb, vsf } } } }
  const pickHistory = {};

  let dateCount = 0;
  for (const row of rows1QB) {
    const date = row.Date?.trim();
    if (!date || date === 'NaT') continue;
    const sfRow = sfByDate[date] || {};
    dateCount++;

    // Process players
    for (const [csvName, playerData] of Object.entries(playerMatches)) {
      const v1 = parseFloat(row[csvName]);
      const vs = parseFloat(sfRow[csvName] || '');
      if (isNaN(v1) && isNaN(vs)) continue;

      const sid = playerData.sleeper_id;
      if (!playerHistory[sid]) {
        playerHistory[sid] = {
          sleeper_id: sid,
          name: playerData.name,
          csv_name: csvName,
          pos: playerData.pos,
          team: playerData.team,
          age: playerData.age,
          values: {}
        };
      }
      playerHistory[sid].values[date] = {
        v1qb: isNaN(v1) ? null : Math.round(v1),
        vsf:  isNaN(vs) ? null : Math.round(vs)
      };
    }

    // Process picks
    for (const pickCol of pickCols) {
      const v1 = parseFloat(row[pickCol]);
      const vs = parseFloat(sfRow[pickCol] || '');
      if (isNaN(v1) && isNaN(vs)) continue;

      const pickInfo = normalizePick(pickCol);
      if (!pickInfo) continue;

      if (!pickHistory[pickInfo.id]) {
        pickHistory[pickInfo.id] = { ...pickInfo, values: {} };
      }
      pickHistory[pickInfo.id].values[date] = {
        v1qb: isNaN(v1) ? null : Math.round(v1),
        vsf:  isNaN(vs) ? null : Math.round(vs)
      };
    }
  }

  console.log(`  Processed ${dateCount} dates`);
  console.log(`  ${Object.keys(playerHistory).length} players with history`);
  console.log(`  ${Object.keys(pickHistory).length} pick slots with history`);

  // Get date range
  const allDates = rows1QB.map(r => r.Date?.trim()).filter(d => d && d !== 'NaT').sort();
  const earliest = allDates[0];
  const latest   = allDates[allDates.length - 1];

  // Build final output
  const output = {
    generated: new Date().toISOString(),
    version: '1.0',
    source: 'GWTTKB Community Trade Value Data',
    date_range: { earliest, latest, days: allDates.length },
    formats: ['1qb_ppr', 'sf_ppr'],
    summary: {
      players: Object.keys(playerHistory).length,
      picks: Object.keys(pickHistory).length,
      dates: allDates.length
    },
    players: playerHistory,
    picks: pickHistory
  };

  // Write output
  fs.mkdirSync('public/data', { recursive: true });
  const outPath = 'public/data/historical-values.json';
  fs.writeFileSync(outPath, JSON.stringify(output));

  // Also write a compact index for fast lookups
  const index = {
    generated: output.generated,
    date_range: output.date_range,
    player_ids: Object.keys(playerHistory),
    pick_ids: Object.keys(pickHistory),
    dates: allDates
  };
  fs.writeFileSync('public/data/historical-index.json', JSON.stringify(index));

  const sizeKB = Math.round(fs.statSync(outPath).size / 1024);
  console.log(`\n✓ Done!`);
  console.log(`  Output: ${outPath} (${sizeKB}KB)`);
  console.log(`  Date range: ${earliest} → ${latest}`);
  console.log(`  Players: ${Object.keys(playerHistory).length}`);
  console.log(`  Picks: ${Object.keys(pickHistory).length}`);

  // Spot check
  const allenEntry = Object.values(playerHistory).find(p => p.name === 'Josh Allen');
  if (allenEntry) {
    const dates = Object.keys(allenEntry.values).sort();
    const first = allenEntry.values[dates[0]];
    const last  = allenEntry.values[dates[dates.length-1]];
    console.log(`\n  Josh Allen check:`);
    console.log(`    ${dates[0]}: 1QB=${first.v1qb} SF=${first.vsf}`);
    console.log(`    ${dates[dates.length-1]}: 1QB=${last.v1qb} SF=${last.vsf}`);
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
