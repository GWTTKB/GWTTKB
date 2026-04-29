// ── GWTTKB NFL Stats + Contracts Builder ──
// Standalone script - runs independently of consensus builder
// Writes: public/data/nfl-stats.json, public/data/nfl-contracts.json
// node scripts/build-nfl-stats.mjs

import fs from 'fs';
import zlib from 'zlib';
import { promisify } from 'util';

const gunzip = promisify(zlib.gunzip);
const BASE = 'https://github.com/nflverse/nflverse-data/releases/download';
const HEADERS = { 'User-Agent': 'GWTTKB/1.0' };
const YEARS = [2020, 2021, 2022, 2023, 2024, 2025];
const SKILL = new Set(['QB','RB','WR','TE']);

function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (!lines.length) return [];
  const headers = lines[0].split(',').map(h => h.replace(/"/g,'').trim());
  return lines.slice(1).map(line => {
    const cols = [];
    let cur = '', inQ = false;
    for (const c of line) {
      if (c === '"') { inQ = !inQ; }
      else if (c === ',' && !inQ) { cols.push(cur); cur = ''; }
      else cur += c;
    }
    cols.push(cur);
    const row = {};
    headers.forEach((h, i) => row[h] = (cols[i] || '').replace(/"/g,'').trim());
    return row;
  });
}

function num(v) { const n = parseInt(v); return isNaN(n) ? null : n; }
function dec(v) { const n = parseFloat(v); return isNaN(n) ? null : Math.round(n * 100) / 100; }
function pct(v) { const n = parseFloat(v); return isNaN(n) ? null : Math.round(n * 1000) / 10; }
function pct2(v) {
  const n = parseFloat(v);
  if (isNaN(n)) return null;
  return n > 1 ? Math.round(n * 10) / 10 : Math.round(n * 1000) / 10;
}
function normName(s) { return (s||'').toLowerCase().replace(/[^a-z]/g,''); }

async function fetchCSV(url) {
  const res = await fetch(url, { redirect: 'follow', headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function fetchGzipCSV(url) {
  const res = await fetch(url, { redirect: 'follow', headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const decompressed = await gunzip(buf);
  return decompressed.toString('utf8');
}

// ── NFL STATS ──
async function buildStats() {
  console.log('\n=== Building NFL Stats ===');
  fs.mkdirSync('public/data', { recursive: true });

  const allStats = {};

  // Layer 1: Season stats
  for (const yr of YEARS) {
    try {
      // Try new format first, fall back to old
      let csv = null;
      for (const url of [
        `${BASE}/player_stats/player_stats_${yr}.csv`,
        `${BASE}/stats_player/stats_player_week_${yr}.csv`,
      ]) {
        try {
          csv = await fetchCSV(url);
          console.log(`  ✓ Season stats ${yr} from ${url.includes('player_stats/') ? 'new' : 'old'} format`);
          break;
        } catch(e) { /* try next */ }
      }
      if (!csv) { console.warn(`  ✗ Season stats ${yr}: not found`); continue; }

      const rows = parseCSV(csv);
      let added = 0;
      for (const row of rows) {
        const pid = row.player_id || row.gsis_id;
        if (!pid) continue;
        const pos = (row.position || row.fantasy_position || '').toUpperCase();
        if (!SKILL.has(pos)) continue;

        const key = `${pid}_${yr}`;
        allStats[key] = {
          player_id: pid,
          player_name: row.player_display_name || row.player_name || '',
          pos, season: yr,
          team: row.recent_team || row.team || '',
          games: num(row.games),
          // Passing
          passing_yards: num(row.passing_yards),
          passing_tds: num(row.passing_tds),
          interceptions: num(row.interceptions),
          completions: num(row.completions),
          attempts: num(row.attempts),
          passing_epa: dec(row.passing_epa),
          // Rushing
          carries: num(row.carries),
          rushing_yards: num(row.rushing_yards),
          rushing_tds: num(row.rushing_tds),
          rushing_epa: dec(row.rushing_epa),
          // Receiving
          targets: num(row.targets),
          receptions: num(row.receptions),
          receiving_yards: num(row.receiving_yards),
          receiving_tds: num(row.receiving_tds),
          receiving_epa: dec(row.receiving_epa),
          target_share: pct2(row.target_share),
          air_yards_share: pct2(row.air_yards_share),
          wopr: dec(row.wopr),
          racr: dec(row.racr),
          fantasy_points_ppr: dec(row.fantasy_points_ppr),
        };
        if (allStats[key].games > 0 && allStats[key].fantasy_points_ppr) {
          allStats[key].fantasy_ppg = dec(allStats[key].fantasy_points_ppr / allStats[key].games);
        }
        added++;
      }
      console.log(`    ${added} skill players`);
    } catch(e) { console.warn(`  ✗ Season stats ${yr}:`, e.message); }
  }

  // Layer 2: NGS stats
  for (const statType of ['passing', 'rushing', 'receiving']) {
    for (const yr of YEARS) {
      try {
        const url = `${BASE}/nextgen_stats/nextgen_stats_${statType}_${yr}.csv`;
        const csv = await fetchCSV(url);
        const rows = parseCSV(csv);
        let matched = 0;
        for (const row of rows) {
          if (row.week !== '0' && row.week !== '') continue;
          const pid = row.player_gsis_id || row.player_id;
          if (!pid) continue;
          const key = `${pid}_${yr}`;
          if (!allStats[key]) continue;
          if (statType === 'passing') {
            allStats[key].avg_time_to_throw = dec(row.avg_time_to_throw);
            allStats[key].aggressiveness = pct2(row.aggressiveness);
            allStats[key].under_pressure_pct = pct2(row.under_pressure_pct);
            allStats[key].cpoe = dec(row.completion_percentage_above_expectation);
          } else if (statType === 'rushing') {
            allStats[key].rush_yards_oe_att = dec(row.rush_yards_over_expected_per_att);
            allStats[key].rush_pct_oe = pct2(row.rush_pct_over_expected);
            allStats[key].stacked_box_rate = pct2(row.percent_attempts_gte_eight_defenders);
          } else {
            allStats[key].avg_separation = dec(row.avg_separation);
            allStats[key].avg_cushion = dec(row.avg_cushion);
            allStats[key].avg_yac_oe = dec(row.avg_yac_above_expectation);
          }
          matched++;
        }
        console.log(`  ✓ NGS ${statType} ${yr}: ${matched} matched`);
      } catch(e) { console.warn(`  ✗ NGS ${statType} ${yr}:`, e.message); }
    }
  }

  // Layer 3: PFR advanced stats
  for (const statType of ['rec', 'rush']) {
    for (const yr of YEARS) {
      try {
        const url = `${BASE}/pfr_advstats/advstats_season_${statType}_${yr}.csv`;
        const csv = await fetchCSV(url);
        const rows = parseCSV(csv);
        let matched = 0;
        for (const row of rows) {
          const name = (row.player || row.player_name || '').trim();
          if (!name) continue;
          const match = Object.values(allStats).find(p =>
            p.season === yr && normName(p.player_name) === normName(name)
          );
          if (!match) continue;
          if (statType === 'rec') {
            match.adot = dec(row.adot);
            match.yac = num(row.yac);
            match.drop_rate = pct2(row.drop_percent || row.drop_pct);
            match.broken_tackles = num(row.broken_tackles || row.brk_tkl);
          } else {
            match.ybc_att = dec(row.ybc_att);
            match.yac_att = dec(row.yac_att);
            match.broken_tackles = num(row.broken_tackles || row.brk_tkl);
          }
          matched++;
        }
        console.log(`  ✓ PFR ${statType} ${yr}: ${matched} matched`);
      } catch(e) { console.warn(`  ✗ PFR ${statType} ${yr}:`, e.message); }
    }
  }

  // Group by player
  const byPlayer = {};
  for (const stats of Object.values(allStats)) {
    const pid = stats.player_id;
    if (!byPlayer[pid]) byPlayer[pid] = { player_id: pid, name: stats.player_name, pos: stats.pos, seasons: {} };
    byPlayer[pid].seasons[stats.season] = stats;
    byPlayer[pid].name = stats.player_name || byPlayer[pid].name;
    byPlayer[pid].team = stats.team;
  }

  const out = {
    generated: new Date().toISOString(),
    source: 'NFLverse — season stats + NGS + PFR',
    total_players: Object.keys(byPlayer).length,
    total_entries: Object.keys(allStats).length,
    players: byPlayer
  };

  fs.writeFileSync('public/data/nfl-stats.json', JSON.stringify(out));
  const mb = (fs.statSync('public/data/nfl-stats.json').size / 1024 / 1024).toFixed(1);
  console.log(`\n✓ nfl-stats.json: ${out.total_players} players, ${out.total_entries} entries, ${mb}MB`);
}

// ── CONTRACTS ──
async function buildContracts() {
  console.log('\n=== Building NFL Contracts ===');
  fs.mkdirSync('public/data', { recursive: true });

  let csv = null;

  // Try multiple possible nflverse contract URLs
  const contractUrls = [
    [`${BASE}/contracts/contracts.csv`, false],
    [`${BASE}/contracts/contracts.csv.gz`, true],
    [`${BASE}/nflverse_contracts/contracts.csv`, false],
    [`${BASE}/nflverse_contracts/contracts.csv.gz`, true],
    ['https://raw.githubusercontent.com/nflverse/nflverse-data/main/data/contracts/contracts.csv', false],
  ];

  for (const [url, isGzip] of contractUrls) {
    try {
      csv = isGzip ? await fetchGzipCSV(url) : await fetchCSV(url);
      console.log(`  ✓ Contracts fetched from: ${url}`);
      break;
    } catch(e) { console.warn(`  ✗ Tried ${url}: ${e.message}`); }
  }

  if (!csv) {
    console.error('  ✗ Could not fetch contracts');
    return;
  }

  const lines = csv.split('\n').filter(l => l.trim());
  const headers = lines[0].split(',').map(h => h.replace(/"/g,'').trim());

  const contracts = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = [];
    let cur = '', inQ = false;
    for (const c of lines[i]) {
      if (c === '"') { inQ = !inQ; }
      else if (c === ',' && !inQ) { cols.push(cur.trim()); cur = ''; }
      else cur += c;
    }
    cols.push(cur.trim());
    const row = {};
    headers.forEach((h, idx) => row[h] = cols[idx] || '');

    if (row.is_active !== 'TRUE') continue;
    if (!SKILL.has(row.position)) continue;

    const apy = parseFloat(row.apy) || 0;
    const years = parseInt(row.years) || 0;
    const yearSigned = parseInt(row.year_signed) || 0;
    const yearsRemaining = Math.max(0, years - (2026 - yearSigned));

    contracts.push({
      name: row.player,
      pos: row.position,
      team: row.team,
      year_signed: yearSigned,
      years, years_remaining: yearsRemaining,
      total_value: Math.round(parseFloat(row.value) || 0),
      apy: Math.round(apy),
      guaranteed: Math.round(parseFloat(row.guaranteed) || 0),
      status: yearsRemaining <= 1 ? 'expiring' : yearsRemaining <= 2 ? 'short' : 'locked',
    });
  }

  contracts.sort((a, b) => b.apy - a.apy);

  const out = {
    generated: new Date().toISOString(),
    source: 'nflverse/OverTheCap (overthecap.com)',
    credit: 'Contract data via nflverse and OverTheCap.com',
    total_players: contracts.length,
    players: contracts
  };

  fs.writeFileSync('public/data/nfl-contracts.json', JSON.stringify(out));
  console.log(`\n✓ nfl-contracts.json: ${contracts.length} active skill players`);
  if (contracts.length > 0) {
    console.log(`  Top 5 APY: ${contracts.slice(0,5).map(c => `${c.name} $${c.apy}M`).join(', ')}`);
  }
}

// ── RUN ──
async function run() {
  try { await buildStats(); } catch(e) { console.error('Stats FAILED:', e.message, e.stack); }
  try { await buildContracts(); } catch(e) { console.error('Contracts FAILED:', e.message, e.stack); }
  console.log('\n=== Done ===');
}

run().catch(console.error);
