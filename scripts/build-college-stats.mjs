// ── BUILD COLLEGE STATS ──
// Pulls from NFLverse draft_picks (has college production for all drafted players)
// + supplements with CFB Reference data via nflreadr
// Runs nightly via GitHub Actions, writes public/data/college-stats.json

import fs from 'fs';

const BASE = 'https://github.com/nflverse/nflverse-data/releases/download';

// ── CSV PARSER ──
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
    headers.forEach((h, i) => row[h] = (cols[i]||'').replace(/"/g,'').trim());
    return row;
  });
}

function num(v) { const n = parseInt(v); return isNaN(n) ? null : n; }
function dec(v) { const n = parseFloat(v); return isNaN(n) ? null : Math.round(n*100)/100; }
function pct(v) {
  const n = parseFloat(v);
  if (isNaN(n)) return null;
  return n > 1 ? Math.round(n*10)/10 : Math.round(n*1000)/10;
}

const SKILL = new Set(['QB','RB','WR','TE']);

async function buildCollegeStats() {
  console.log('\n=== Building College Stats Database ===');

  const allPlayers = {}; // name → stats

  // ── LAYER 1: NFLverse draft_picks ──
  // Has: player, pos, college, round, pick, season (draft year)
  // + cfb stats: college_rec_yds, college_rush_yds, college_pass_yds, etc.
  try {
    console.log('Fetching NFLverse draft picks...');
    const res = await fetch(`${BASE}/draft_picks/draft_picks.csv`, { redirect:'follow', headers:{'User-Agent':'GWTTKB/1.0'} });
    if (res.ok) {
      const csv = await res.text();
      const rows = parseCSV(csv);
      const YEARS = [2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017, 2016, 2015];

      for (const row of rows) {
        const season = parseInt(row.season || row.draft_year || 0);
        if (!YEARS.includes(season)) continue;
        const pos = (row.position || row.pos || '').toUpperCase();
        if (!SKILL.has(pos)) continue;

        const name = row.player_name || row.full_name || row.player || '';
        if (!name) continue;

        const key = `${name}_${season}`;
        allPlayers[key] = {
          name,
          pos,
          draft_year: season,
          draft_round: num(row.round),
          draft_pick: num(row.pick),
          draft_pick_label: row.round && row.pick ? `${row.round}.${String(row.pick).padStart(2,'0')}` : null,
          team: row.team || row.nfl_team || '',
          college: row.college || row.school || '',
          // NFLverse college production fields
          college_rec_yds: num(row.college_rec_yds || row.receiving_yards_college),
          college_rush_yds: num(row.college_rush_yds || row.rushing_yards_college),
          college_pass_yds: num(row.college_pass_yds || row.passing_yards_college),
          college_rec_tds: num(row.college_rec_tds),
          college_rush_tds: num(row.college_rush_tds),
          college_pass_tds: num(row.college_pass_tds),
          // Physical traits from combine
          height: num(row.ht || row.height),
          weight: num(row.wt || row.weight),
          forty: dec(row.forty || row.forty_yard || row.X40yd),
          vertical: dec(row.vertical || row.vert),
          broad_jump: num(row.broad_jump || row.broad),
          cone: dec(row.cone),
          shuttle: dec(row.shuttle),
          // PFF college grade if available
          pff_college_grade: dec(row.pff_college_grade || row.college_grade),
          // Dominator rating if available
          dominator_rating: dec(row.dominator_rating),
          // BMI/athleticism
          bmi: row.ht && row.wt ? dec(parseInt(row.wt) / Math.pow(parseInt(row.ht)/100, 2)) : null,
          // Draft capital score
          draft_capital: row.round && row.pick ? 
            Math.round(1000 / (parseInt(row.round) * parseInt(row.pick))) : null,
        };
      }
      console.log(`✓ Draft picks loaded: ${Object.keys(allPlayers).length} skill players`);
    }
  } catch(e) {
    console.warn('Draft picks error:', e.message);
  }

  // ── LAYER 2: NFLverse combine data (more combine fields) ──
  try {
    console.log('Fetching combine data...');
    const res = await fetch(`${BASE}/combine/combine.csv`, { redirect:'follow', headers:{'User-Agent':'GWTTKB/1.0'} });
    if (res.ok) {
      const csv = await res.text();
      const rows = parseCSV(csv);
      let matched = 0;

      for (const row of rows) {
        const pos = (row.pos || row.position || '').toUpperCase();
        if (!SKILL.has(pos)) continue;
        const name = row.player_name || row.player || '';
        const year = parseInt(row.draft_year || row.season || 0);
        if (!name || !year) continue;

        const key = `${name}_${year}`;
        if (allPlayers[key]) {
          // Augment with combine data
          if (!allPlayers[key].forty && row.forty) allPlayers[key].forty = dec(row.forty);
          if (!allPlayers[key].vertical && row.vertical) allPlayers[key].vertical = dec(row.vertical);
          if (!allPlayers[key].broad_jump && row.broad_jump) allPlayers[key].broad_jump = num(row.broad_jump);
          if (!allPlayers[key].cone && row.cone) allPlayers[key].cone = dec(row.cone);
          if (!allPlayers[key].shuttle && row.shuttle) allPlayers[key].shuttle = dec(row.shuttle);
          if (!allPlayers[key].weight && row.wt) allPlayers[key].weight = num(row.wt);
          if (!allPlayers[key].height && row.ht) allPlayers[key].height = num(row.ht);
          matched++;
        }
      }
      console.log(`✓ Combine data matched: ${matched} players`);
    }
  } catch(e) {
    console.warn('Combine error:', e.message);
  }

  // ── LAYER 3: NFLverse PFR college stats (advanced) ──
  // PFR has per-year college stats including career totals
  try {
    console.log('Fetching PFR college stats...');
    // nflreadr expose college stats through a separate endpoint
    const urls = [
      `${BASE}/pfr_advstats/college_stats.csv`,
      `https://raw.githubusercontent.com/nflverse/nflverse-data/main/data/college_stats.csv`,
    ];

    for (const url of urls) {
      try {
        const res = await fetch(url, { redirect:'follow', headers:{'User-Agent':'GWTTKB/1.0'} });
        if (!res.ok) continue;
        const csv = await res.text();
        const rows = parseCSV(csv);
        console.log(`  PFR college rows: ${rows.length}`);

        for (const row of rows) {
          const pos = (row.pos || row.position || '').toUpperCase();
          if (!SKILL.has(pos)) continue;
          const name = row.player || row.player_name || '';
          const draftYear = parseInt(row.draft_year || 0);
          if (!name) continue;

          // Find matching player in our dataset
          const key = `${name}_${draftYear}`;
          if (allPlayers[key]) {
            allPlayers[key].college_career_games = num(row.g || row.games);
            allPlayers[key].college_career_rec = num(row.rec || row.receptions);
            allPlayers[key].college_career_rec_yds = num(row.rec_yds || row.receiving_yards);
            allPlayers[key].college_career_rec_tds = num(row.rec_td || row.receiving_tds);
            allPlayers[key].college_career_rush_att = num(row.rush_att || row.rush_attempts);
            allPlayers[key].college_career_rush_yds = num(row.rush_yds || row.rushing_yards);
            allPlayers[key].college_career_rush_tds = num(row.rush_td);
            allPlayers[key].college_career_pass_cmp = num(row.pass_cmp || row.completions);
            allPlayers[key].college_career_pass_att = num(row.pass_att || row.pass_attempts);
            allPlayers[key].college_career_pass_yds = num(row.pass_yds || row.passing_yards);
            allPlayers[key].college_career_pass_tds = num(row.pass_td);
          }
        }
        console.log(`✓ PFR college stats matched`);
        break;
      } catch(e2) {}
    }
  } catch(e) {
    console.warn('PFR college error:', e.message);
  }

  // ── COMPUTE DERIVED METRICS ──
  for (const player of Object.values(allPlayers)) {
    // Yards per carry (college)
    if (player.college_rush_yds && player.college_career_rush_att) {
      player.college_ypc = dec(player.college_rush_yds / player.college_career_rush_att);
    }
    // Catch rate (college)
    if (player.college_rec_tds != null && player.college_career_rec != null) {
      // TDs per reception
      player.college_td_per_rec = player.college_career_rec > 0 ?
        dec(player.college_rec_tds / player.college_career_rec) : null;
    }
    // Completion % (college QBs)
    if (player.college_career_pass_cmp && player.college_career_pass_att && player.college_career_pass_att > 0) {
      player.college_completion_pct = pct(player.college_career_pass_cmp / player.college_career_pass_att);
    }
    // Dominator rating approximation
    // (player production / team production) - simplified
    if (!player.dominator_rating && player.college_rec_yds && player.draft_round) {
      // Proxy: round-adjusted production score
      player.production_score = Math.round(
        (player.college_rec_yds || 0) * 0.4 +
        (player.college_rec_tds || 0) * 100 +
        (player.college_rush_yds || 0) * 0.3
      );
    }
    // Athleticism score (RAS-like, 1-10)
    if (player.forty && player.weight) {
      const w = player.weight;
      const spd = player.forty;
      // Simple score: faster and heavier = better
      const speedScore = Math.max(0, Math.min(10, (4.9 - spd) * 20));
      player.speed_score = dec(speedScore);
      // Weight-adjusted speed score
      player.weight_adj_speed = dec((w * Math.pow((4.6 - spd), 2)) / 100);
    }
  }

  // ── GROUP BY DRAFT YEAR ──
  const byYear = {};
  for (const [key, player] of Object.entries(allPlayers)) {
    const yr = player.draft_year;
    if (!byYear[yr]) byYear[yr] = {};
    byYear[yr][player.name] = player;
  }

  // ── BREAKOUT CORRELATION (from historical data if available) ──
  // For players where we have both college stats AND NFL value history,
  // compute which college metrics correlated with dynasty breakouts
  let correlationData = null;
  try {
    const histData = JSON.parse(fs.readFileSync('public/data/historical-players.json', 'utf8'));
    const patternsData = JSON.parse(fs.readFileSync('public/data/nfl-patterns.json', 'utf8'));
    
    const correlations = {
      wr: { high_rec_yds: {broke_out: 0, total: 0}, high_forty: {broke_out: 0, total: 0} },
      rb: { high_rush_yds: {broke_out: 0, total: 0}, high_ypc: {broke_out: 0, total: 0} },
    };

    // For each player with college stats AND historical dynasty value
    for (const [key, player] of Object.entries(allPlayers)) {
      const histPlayer = histData.players[player.name];
      if (!histPlayer) continue;

      // Did they break out? (value above 5000 within 3 years of draft)
      const draftYr = player.draft_year;
      let brokeOut = false;
      for (let yr = draftYr; yr <= draftYr + 3; yr++) {
        const targetDate = `${yr}-12-01`;
        let maxVal = 0;
        for (let i = 0; i < histPlayer.dates.length; i++) {
          if (histPlayer.dates[i] <= targetDate && histPlayer.sf[i] > maxVal) {
            maxVal = histPlayer.sf[i];
          }
        }
        if (maxVal >= 5000) { brokeOut = true; break; }
      }

      // WR correlations
      if (player.pos === 'WR') {
        correlations.wr.high_rec_yds.total++;
        if (brokeOut) correlations.wr.high_rec_yds.broke_out++;
        if (player.college_rec_yds >= 1000) {
          if (!correlations.wr.high_rec_yds_1k) correlations.wr.high_rec_yds_1k = {broke_out:0,total:0};
          correlations.wr.high_rec_yds_1k.total++;
          if (brokeOut) correlations.wr.high_rec_yds_1k.broke_out++;
        }
        if (player.forty && player.forty <= 4.40) {
          if (!correlations.wr.sub440_speed) correlations.wr.sub440_speed = {broke_out:0,total:0};
          correlations.wr.sub440_speed.total++;
          if (brokeOut) correlations.wr.sub440_speed.broke_out++;
        }
      }
      // RB correlations
      if (player.pos === 'RB') {
        if (player.college_rush_yds >= 1000) {
          if (!correlations.rb.rush_1k) correlations.rb.rush_1k = {broke_out:0,total:0};
          correlations.rb.rush_1k.total++;
          if (brokeOut) correlations.rb.rush_1k.broke_out++;
        }
      }
    }

    // Compute rates
    const corrInsights = [];
    for (const [pos, metrics] of Object.entries(correlations)) {
      for (const [metric, data] of Object.entries(metrics)) {
        if (data.total >= 5) {
          const rate = Math.round(data.broke_out / data.total * 100);
          corrInsights.push({
            pos: pos.toUpperCase(), metric, 
            breakout_rate: rate, sample: data.total,
            insight: `${pos.toUpperCase()} with ${metric}: ${rate}% breakout rate within 3 yrs (n=${data.total})`
          });
        }
      }
    }
    correlationData = corrInsights.sort((a,b) => b.breakout_rate - a.breakout_rate);
    console.log(`✓ Breakout correlations: ${correlationData.length} metrics computed`);
  } catch(e) {
    console.warn('Correlation error:', e.message);
  }

  // ── OUTPUT ──
  const output = {
    generated: new Date().toISOString(),
    source: 'NFLverse draft_picks + combine + PFR college stats',
    years_covered: Object.keys(byYear).sort(),
    total_players: Object.keys(allPlayers).length,
    breakout_correlations: correlationData,
    by_year: byYear,
    // Flat lookup by name for quick Coach access
    by_name: Object.fromEntries(
      Object.values(allPlayers).map(p => [p.name, p])
    )
  };

  fs.writeFileSync('public/data/college-stats.json', JSON.stringify(output));
  const sizeMB = (fs.statSync('public/data/college-stats.json').size / 1024 / 1024).toFixed(1);
  console.log(`\n✓ College stats: ${output.total_players} players across ${output.years_covered.length} draft classes, ${sizeMB}MB`);

  // Summary by year
  for (const yr of output.years_covered.sort().reverse().slice(0, 7)) {
    const cnt = Object.keys(byYear[yr] || {}).length;
    console.log(`  ${yr}: ${cnt} skill players`);
  }

  return output;
}

buildCollegeStats().catch(console.error);
