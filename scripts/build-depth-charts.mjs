// ── GWTTKB Depth Charts Builder ──
// Pulls current NFL team assignments for all skill players
// Cross-references Sleeper player map (live) + NFLverse rosters
// Writes: public/data/depth-charts.json

import fs from 'fs';

const SLEEPER = 'https://api.sleeper.app/v1';
const NFLVERSE = 'https://github.com/nflverse/nflverse-data/releases/download';
const HEADERS = { 'User-Agent': 'GWTTKB/1.0' };
const SKILL = new Set(['QB','RB','WR','TE']);

const TEAM_NAMES = {
  ARI:'Arizona Cardinals', ATL:'Atlanta Falcons', BAL:'Baltimore Ravens',
  BUF:'Buffalo Bills', CAR:'Carolina Panthers', CHI:'Chicago Bears',
  CIN:'Cincinnati Bengals', CLE:'Cleveland Browns', DAL:'Dallas Cowboys',
  DEN:'Denver Broncos', DET:'Detroit Lions', GB:'Green Bay Packers',
  HOU:'Houston Texans', IND:'Indianapolis Colts', JAX:'Jacksonville Jaguars',
  KC:'Kansas City Chiefs', LAC:'Los Angeles Chargers', LAR:'Los Angeles Rams',
  LV:'Las Vegas Raiders', MIA:'Miami Dolphins', MIN:'Minnesota Vikings',
  NE:'New England Patriots', NO:'New Orleans Saints', NYG:'New York Giants',
  NYJ:'New York Jets', PHI:'Philadelphia Eagles', PIT:'Pittsburgh Steelers',
  SEA:'Seattle Seahawks', SF:'San Francisco 49ers', TB:'Tampa Bay Buccaneers',
  TEN:'Tennessee Titans', WAS:'Washington Commanders'
};

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

function normName(s) {
  return (s||'').toLowerCase()
    .replace(/\s+(jr|sr|ii|iii|iv|v)\.?$/i,'')
    .replace(/[^a-z]/g,'');
}

async function buildDepthCharts() {
  console.log('=== Building NFL Depth Charts ===');
  fs.mkdirSync('public/data', { recursive: true });

  // ── LAYER 1: Sleeper player map (most current — reflects recent transactions) ──
  console.log('\nFetching Sleeper player map...');
  const sleeperRes = await fetch(`${SLEEPER}/players/nfl`, { headers: HEADERS });
  const sleeperPlayers = sleeperRes.ok ? await sleeperRes.json() : {};

  // Build player database from Sleeper
  const players = {}; // sleeper_id → player object
  const byTeam = {}; // team → [players]
  const byName = {}; // normalized name → sleeper_id

  for (const [id, p] of Object.entries(sleeperPlayers)) {
    if (!p?.full_name || !SKILL.has(p.position)) continue;
    if (!p.active && p.status === 'Inactive') continue;

    const team = p.team || 'FA';
    const player = {
      sleeper_id: id,
      name: p.full_name,
      pos: p.position,
      team,
      age: p.age || null,
      years_exp: p.years_exp || 0,
      status: p.status || 'Active',
      injury_status: p.injury_status || null,
      number: p.number || null,
      college: p.college || '',
      height: p.height || null,
      weight: p.weight || null,
      // Dynasty class detection
      draft_year: p.years_exp !== null ? (2026 - p.years_exp) : null,
    };

    players[id] = player;
    byName[normName(p.full_name)] = id;

    if (!byTeam[team]) byTeam[team] = [];
    byTeam[team].push(player);
  }

  console.log(`Sleeper: ${Object.keys(players).length} skill players across ${Object.keys(byTeam).length} teams`);

  // ── LAYER 2: NFLverse rosters (depth order) ──
  console.log('\nFetching NFLverse depth charts...');
  try {
    const dcRes = await fetch(
      `${NFLVERSE}/depth_charts/depth_charts_2025.csv`,
      { redirect: 'follow', headers: HEADERS }
    );
    if (dcRes.ok) {
      const csv = await dcRes.text();
      const rows = parseCSV(csv);
      let matched = 0;

      for (const row of rows) {
        if (!SKILL.has(row.position)) continue;
        const name = row.full_name || row.player_name || '';
        const depth = parseInt(row.depth_chart_position_rank || row.depth_order || 0);
        if (!name || !depth) continue;

        const norm = normName(name);
        const id = byName[norm];
        if (id && players[id]) {
          players[id].depth_order = depth;
          players[id].formation_position = row.depth_chart_position || '';
          matched++;
        }
      }
      console.log(`  Depth chart matched: ${matched} players`);
    }
  } catch(e) {
    console.warn('  Depth chart error:', e.message);
  }

  // ── LAYER 3: Load team context for authoritative 2026 assignments ──
  // Team context is the USER's authoritative file — overrides everything
  let teamContext = {};
  try {
    const tc = JSON.parse(fs.readFileSync('public/data/nfl-team-context.json', 'utf8'));
    teamContext = tc.teams || tc;
    console.log(`\nTeam context loaded: ${Object.keys(teamContext).length} teams`);
  } catch(e) {
    console.warn('Team context not found:', e.message);
  }

  // ── BUILD FINAL DEPTH CHARTS ──
  // For each team, build ordered depth chart from all sources
  const depthCharts = {};

  for (const teamAbbr of Object.keys(TEAM_NAMES)) {
    const ctx = teamContext[teamAbbr] || {};
    const ctx2026 = ctx['2026'] || {};
    const ctx2025 = ctx['2025'] || {};
    const coaching = ctx['coaching'] || {};

    // Get all players on this team from Sleeper
    const teamPlayers = (byTeam[teamAbbr] || []).sort((a, b) => {
      // Sort by: depth_order, then years_exp desc, then name
      if (a.depth_order && b.depth_order) return a.depth_order - b.depth_order;
      if (a.depth_order) return -1;
      if (b.depth_order) return 1;
      return b.years_exp - a.years_exp;
    });

    // Group by position
    const byPos = { QB:[], RB:[], WR:[], TE:[] };
    for (const p of teamPlayers) {
      if (byPos[p.pos]) byPos[p.pos].push(p);
    }

    // Override with team context 2026 where available
    // Team context IS authoritative for the starter-level players
    const starters = {
      QB: ctx2026.qb || null,
      WR1: ctx2026.wr1 || null, WR2: ctx2026.wr2 || null,
      WR3: ctx2026.wr3 || null, WR4: ctx2026.wr4 || null,
      RB1: ctx2026.rb1 || null, RB2: ctx2026.rb2 || null, RB3: ctx2026.rb3 || null,
      TE1: ctx2026.te1 || null, TE2: ctx2026.te2 || null,
    };

    // Compute target share projections based on historical patterns
    // Average team pass attempts ~550/season
    // Typical distribution: WR1 27%, WR2 19%, WR3 11%, RB 14%, TE 16%, other 13%
    const projectedTargetShare = {
      WR: [27, 19, 11, 6],
      RB: [9, 5, 2],
      TE: [14, 5],
      QB: [0]
    };

    depthCharts[teamAbbr] = {
      team: teamAbbr,
      name: TEAM_NAMES[teamAbbr],
      // Authoritative 2026 starters from user's team context
      starters_2026: starters,
      notes_2026: ctx2026.notes || '',
      analyst_notes: ctx2026.analyst_notes || '',
      // HC/OC from coaching staff
      hc: ctx2026.hc || coaching.hc || '',
      oc: ctx2026.oc || coaching.oc || '',
      scheme: ctx2026.scheme || coaching.scheme || '',
      // Full roster from Sleeper (all players, depth ordered)
      full_roster: {
        QB: byPos.QB.slice(0,3).map(p => ({
          name: p.name, id: p.sleeper_id, age: p.age,
          years_exp: p.years_exp, status: p.status,
          depth: p.depth_order || null,
          dynasty_class: p.draft_year
        })),
        WR: byPos.WR.slice(0,6).map((p, i) => ({
          name: p.name, id: p.sleeper_id, age: p.age,
          years_exp: p.years_exp, status: p.status,
          depth: p.depth_order || i+1,
          projected_target_share: projectedTargetShare.WR[i] || null,
          dynasty_class: p.draft_year
        })),
        RB: byPos.RB.slice(0,4).map((p, i) => ({
          name: p.name, id: p.sleeper_id, age: p.age,
          years_exp: p.years_exp, status: p.status,
          depth: p.depth_order || i+1,
          projected_target_share: projectedTargetShare.RB[i] || null,
          dynasty_class: p.draft_year
        })),
        TE: byPos.TE.slice(0,3).map((p, i) => ({
          name: p.name, id: p.sleeper_id, age: p.age,
          years_exp: p.years_exp, status: p.status,
          depth: p.depth_order || i+1,
          projected_target_share: projectedTargetShare.TE[i] || null,
          dynasty_class: p.draft_year
        }))
      },
      // 2025 historical for context
      historical_2025: {
        qb: ctx2025.qb || '',
        wr1: ctx2025.wr1 || '', wr2: ctx2025.wr2 || '',
        rb1: ctx2025.rb1 || '', te1: ctx2025.te1 || '',
        notes: ctx2025.notes || ''
      }
    };
  }

  // ── COMPUTE TARGET SHARE REDISTRIBUTION ──
  // When a player left between 2025 and 2026, compute who inherited their targets
  console.log('\nComputing target share redistribution...');

  // Load 2025 stats for target share data
  let stats2025 = {};
  try {
    const statsRes = await fetch(
      `${NFLVERSE}/player_stats/player_stats_2025.csv`,
      { redirect: 'follow', headers: HEADERS }
    );
    if (statsRes.ok) {
      const csv = await statsRes.text();
      const rows = parseCSV(csv);
      for (const row of rows) {
        const pos = (row.position||'').toUpperCase();
        if (!SKILL.has(pos)) continue;
        const name = row.player_display_name || row.player_name || '';
        if (!name) continue;
        stats2025[normName(name)] = {
          name,
          team: row.recent_team || row.team || '',
          pos,
          targets: parseInt(row.targets) || 0,
          target_share: parseFloat(row.target_share) || 0,
          air_yards_share: parseFloat(row.air_yards_share) || 0,
          games: parseInt(row.games) || 0,
          receptions: parseInt(row.receptions) || 0,
          rec_yards: parseInt(row.receiving_yards) || 0,
          rec_tds: parseInt(row.receiving_tds) || 0,
          fantasy_ppg: parseFloat(row.fantasy_points_ppr) > 0 && parseInt(row.games) > 0
            ? Math.round(parseFloat(row.fantasy_points_ppr)/parseInt(row.games)*100)/100 : 0,
          wopr: parseFloat(row.wopr) || 0,
          racr: parseFloat(row.racr) || 0,
        };
      }
      console.log(`  2025 stats loaded: ${Object.keys(stats2025).length} players`);
    }
  } catch(e) {
    console.warn('  Stats error:', e.message);
  }

  // For each team, find departed players and compute target redistribution
  for (const [teamAbbr, dc] of Object.entries(depthCharts)) {
    const hist = dc.historical_2025;
    const curr = dc.starters_2026;

    // Find players who were on team in 2025 but not 2026
    const departed = [];
    const positions2025 = [
      {role:'WR1', name: hist.wr1}, {role:'WR2', name: hist.wr2},
      {role:'RB1', name: hist.rb1}, {role:'TE1', name: hist.te1}
    ];

    for (const {role, name} of positions2025) {
      if (!name) continue;
      const norm = normName(name);
      const stats = stats2025[norm];
      if (!stats) continue;

      // Check if still on same team in 2026
      const currentTeam2026 = Object.values(depthCharts).find(t =>
        Object.values(t.starters_2026).some(s => s && normName(s) === norm)
      );
      const stillHere = Object.values(curr).some(s => s && normName(s) === norm);

      if (!stillHere && stats.target_share > 0.08) {
        departed.push({
          name, role, norm,
          target_share_2025: Math.round(stats.target_share * 1000)/10,
          targets_2025: stats.targets,
          fantasy_ppg_2025: stats.fantasy_ppg,
          new_team: currentTeam2026?.team || 'Unknown/FA'
        });
      }
    }

    if (departed.length > 0) {
      dc.departed_targets = departed;
      const totalDepartedShare = departed.reduce((s, p) => s + p.target_share_2025, 0);

      // Project redistribution based on historical patterns
      // 60% goes to WR2 stepping up, 25% to WR3, 15% to TE/RB
      dc.target_redistribution = {
        total_departed_share_pct: Math.round(totalDepartedShare * 10) / 10,
        departed_players: departed.map(p => p.name),
        projection_note: `${Math.round(totalDepartedShare)}% target share available from departures. Historical: ~60% absorbed by next WR in depth, ~25% to WR3, ~15% to TE/RB.`,
        likely_beneficiaries: [
          curr.WR2 || curr.WR1,
          curr.WR3,
          curr.TE1
        ].filter(Boolean)
      };
    }
  }

  // ── ADD PLAYER STATS TO THEIR PROFILE ──
  // Attach 2025 stats to each player in depth charts
  for (const dc of Object.values(depthCharts)) {
    for (const posPlayers of Object.values(dc.full_roster)) {
      for (const p of posPlayers) {
        const norm = normName(p.name);
        const stats = stats2025[norm];
        if (stats) {
          p.stats_2025 = {
            targets: stats.targets,
            target_share_pct: Math.round(stats.target_share * 1000)/10,
            air_yards_share_pct: Math.round(stats.air_yards_share * 1000)/10,
            receptions: stats.receptions,
            rec_yards: stats.rec_yards,
            rec_tds: stats.rec_tds,
            fantasy_ppg: stats.fantasy_ppg,
            wopr: Math.round(stats.wopr * 100)/100,
            games: stats.games
          };
        }
      }
    }
  }

  // ── OUTPUT ──
  const output = {
    generated: new Date().toISOString(),
    source: 'Sleeper player map (live) + NFLverse depth charts + User team context (authoritative)',
    note: 'Team context 2026 is authoritative for starters. Sleeper provides full roster. 2025 stats from NFLverse.',
    total_players: Object.keys(players).length,
    teams: depthCharts,
    // Flat player lookup by name
    by_player: Object.fromEntries(
      Object.values(players).map(p => [normName(p.name), {
        name: p.name,
        team: p.team,
        pos: p.pos,
        age: p.age,
        years_exp: p.years_exp,
        dynasty_class: p.draft_year,
        stats_2025: stats2025[normName(p.name)] || null
      }])
    )
  };

  fs.writeFileSync('public/data/depth-charts.json', JSON.stringify(output));
  const mb = (fs.statSync('public/data/depth-charts.json').size / 1024 / 1024).toFixed(1);
  console.log(`\n✓ depth-charts.json: ${Object.keys(depthCharts).length} teams, ${output.total_players} players, ${mb}MB`);

  // Sample output
  const chi = depthCharts['CHI'];
  if (chi) {
    console.log('\nSample — CHI 2026:');
    console.log('  Starters:', JSON.stringify(chi.starters_2026));
    console.log('  WRs:', chi.full_roster.WR.slice(0,3).map(p=>p.name+'('+p.stats_2025?.target_share_pct+'%tgt)').join(', '));
    if (chi.target_redistribution) {
      console.log('  Target redistribution:', chi.target_redistribution.projection_note);
    }
  }
}

buildDepthCharts().catch(e => { console.error('FATAL:', e); process.exit(1); });
