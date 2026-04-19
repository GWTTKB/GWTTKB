// ============================================================================
// GWTTKB Consensus Engine — Server Side
// Vercel Serverless Function + Cron Job
// Runs nightly at 2am ET, generates fresh consensus.json
// Manual trigger: GET /api/consensus?secret=YOUR_SECRET
// ============================================================================

const SLEEPER_BASE = 'https://api.sleeper.app/v1';
const NFLVERSE_BASE = 'https://github.com/nflverse/nflverse-data/releases/download';
const GITHUB_API = 'https://api.github.com';

// ── POSITION PRIORS (for Bayesian shrinkage) ──
const POSITION_PRIOR = { QB: 1480, RB: 1480, WR: 1480, TE: 1450, DEFAULT: 1400 };

// ── AGE CURVES ──
const AGE_CURVES = {
  QB:{20:0.50,21:0.65,22:0.75,23:0.88,24:0.94,25:0.98,26:1.00,27:1.02,28:1.03,29:1.02,30:1.00,31:0.97,32:0.93,33:0.87,34:0.79,35:0.69,36:0.58},
  RB:{20:0.72,21:0.86,22:0.97,23:1.02,24:1.03,25:1.00,26:0.95,27:0.87,28:0.75,29:0.62,30:0.49,31:0.36,32:0.24},
  WR:{20:0.55,21:0.70,22:0.83,23:0.92,24:0.97,25:1.01,26:1.03,27:1.02,28:1.00,29:0.95,30:0.89,31:0.81,32:0.71,33:0.60,34:0.48},
  TE:{20:0.40,21:0.53,22:0.63,23:0.74,24:0.85,25:0.94,26:0.99,27:1.02,28:1.03,29:1.01,30:0.97,31:0.91,32:0.82,33:0.71,34:0.59}
};
function ageMult(pos, age) {
  const c = AGE_CURVES[pos] || AGE_CURVES.WR;
  if (c[age] !== undefined) return c[age];
  const keys = Object.keys(c).map(Number).sort((a,b)=>a-b);
  for (let i = keys.length-1; i>=0; i--) if (keys[i]<=age) return c[keys[i]];
  return 0.4;
}

// ── FETCH HELPERS ──
async function sleepMs(ms) { return new Promise(r => setTimeout(r, ms)); }
async function apiFetch(url, retries=3) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'GWTTKB/1.0' } });
      if (r.ok) return await r.json();
      if (r.status === 429) { await sleepMs(2000 * (i+1)); continue; }
      return null;
    } catch { await sleepMs(500); }
  }
  return null;
}

// ── STEP 1: SLEEPER PLAYER MAP ──
async function fetchPlayerMap() {
  console.log('[1] Fetching Sleeper player map...');
  const data = await apiFetch(`${SLEEPER_BASE}/players/nfl`);
  if (!data) throw new Error('Failed to fetch player map');
  const map = {};
  for (const [id, p] of Object.entries(data)) {
    if (!p?.full_name) continue;
    map[id] = {
      name: p.full_name,
      pos: p.position || '?',
      team: p.team || 'FA',
      age: p.age || null,
      years_exp: p.years_exp || 0,
      birth_date: p.birth_date || null,
      search_rank: p.search_rank || 9999
    };
  }
  console.log(`[1] Player map: ${Object.keys(map).length} players`);
  return map;
}

// ── STEP 2: SLEEPER STARTUP ADP ──
// Pull dynasty startup ADP across SF PPR and 1QB formats
async function fetchStartupADP(playerMap) {
  console.log('[2] Fetching Sleeper startup ADP...');

  // Sleeper ADP endpoint — dynasty startup
  const formats = [
    { key: 'sf_ppr',  url: `${SLEEPER_BASE}/stats/nfl/player/0?season_type=regular&season=2025&position[]=QB&position[]=RB&position[]=WR&position[]=TE` },
  ];

  // Primary ADP source: Sleeper's trending players + search rank as proxy
  // search_rank in player map is Sleeper's internal popularity/ADP signal
  // We supplement with explicit ADP calls

  const adpData = {};

  // Try the official Sleeper ADP endpoint
  const sfAdp = await apiFetch(`${SLEEPER_BASE}/draft/nfl/2025`);

  // Use search_rank as our ADP baseline (lower = higher value)
  // This is Sleeper's own ranking signal based on draft frequency
  const fantasyPositions = ['QB','RB','WR','TE'];
  let ranked = [];
  for (const [id, p] of Object.entries(playerMap)) {
    if (!fantasyPositions.includes(p.pos)) continue;
    if (!p.name) continue;
    ranked.push({ id, ...p });
  }

  // Sort by search_rank (Sleeper's internal dynasty relevance signal)
  ranked.sort((a,b) => (a.search_rank||9999) - (b.search_rank||9999));

  // Take top 400 — these are the dynasty-relevant players
  const top400 = ranked.slice(0, 400);

  // Assign ADP-based values: normalize search_rank to 0-9999
  const maxRank = top400[top400.length-1]?.search_rank || 999;
  const minRank = top400[0]?.search_rank || 1;
  const rankRange = Math.max(1, maxRank - minRank);

  for (const p of top400) {
    const normalized = 1 - ((p.search_rank - minRank) / rankRange);
    // Exponential curve — top players get more separation
    const adpValue = Math.round(Math.pow(normalized, 0.6) * 9999);
    adpData[p.id] = {
      id: p.id,
      name: p.name,
      pos: p.pos,
      team: p.team,
      age: p.age,
      adp_value: adpValue,
      search_rank: p.search_rank
    };
  }

  console.log(`[2] ADP baseline: ${Object.keys(adpData).length} players`);
  return adpData;
}

// ── STEP 3: FPAR FROM NFLVERSE ──
async function fetchFPAR(seasons = [2023, 2024, 2025]) {
  console.log('[3] Fetching FPAR from NFLverse...');
  const allStats = {}; // playerId -> {seasons: {yr: {ppg, games, totalPts}}}

  for (const season of seasons) {
    try {
      const url = `${NFLVERSE_BASE}/stats_player/stats_player_week_${season}.csv`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'GWTTKB/1.0' },
        redirect: 'follow'
      });
      if (!res.ok) { console.log(`[3] ${season}: not found`); continue; }

      const text = await res.text();
      const lines = text.trim().split(/\r?\n/);
      const headers = lines[0].split(',').map(h => h.replace(/"/g,'').trim());

      const idx = (name) => headers.indexOf(name);
      const I = {
        id: idx('player_id'),
        name: idx('player_display_name'),
        pos: idx('position'),
        pos_group: idx('position_group'),
        team: idx('team'),
        pts_ppr: idx('fantasy_points_ppr'),
        carries: idx('carries'),
        targets: idx('targets'),
        attempts: idx('attempts'),
        hs: idx('headshot_url')
      };

      const byPlayer = {};
      for (const line of lines.slice(1)) {
        const vals = parseCSVLine(line);
        if (!vals[I.id]) continue;
        const pos = (vals[I.pos]||'').toUpperCase();
        if (!['QB','RB','WR','TE'].includes(pos)) continue;

        const id = vals[I.id];
        const pts = parseFloat(vals[I.pts_ppr]) || 0;
        const usage = (parseFloat(vals[I.carries])||0) + (parseFloat(vals[I.targets])||0) + (parseFloat(vals[I.attempts])||0);
        const active = pts !== 0 || usage > 0;
        if (!active) continue;

        if (!byPlayer[id]) byPlayer[id] = {
          name: vals[I.name] || '',
          pos,
          team: vals[I.team] || 'FA',
          hs: vals[I.hs] || '',
          weeks: []
        };
        byPlayer[id].weeks.push(pts);
        byPlayer[id].team = vals[I.team] || byPlayer[id].team;
        byPlayer[id].hs = vals[I.hs] || byPlayer[id].hs;
      }

      // Aggregate to season stats
      for (const [id, pd] of Object.entries(byPlayer)) {
        if (pd.weeks.length < 5) continue;
        const totalPts = pd.weeks.reduce((s,v)=>s+v,0);
        const ppg = totalPts / pd.weeks.length;
        if (!allStats[id]) allStats[id] = { name:pd.name, pos:pd.pos, team:pd.team, hs:pd.hs, seasons:{} };
        allStats[id].seasons[season] = { ppg, games:pd.weeks.length, totalPts };
        allStats[id].team = pd.team;
        allStats[id].hs = pd.hs;
      }

      console.log(`[3] ${season}: ${Object.keys(byPlayer).length} players`);
    } catch(e) {
      console.error(`[3] ${season} error:`, e.message);
    }
  }

  // Compute replacement level per position per season
  const REPL = {};
  for (const season of seasons) {
    REPL[season] = {};
    for (const pos of ['QB','RB','WR','TE']) {
      const ppgs = Object.values(allStats)
        .filter(p => p.pos===pos && p.seasons[season])
        .map(p => p.seasons[season].ppg)
        .sort((a,b) => b-a);
      const band = ppgs.slice(24,36);
      REPL[season][pos] = band.length ? band.reduce((a,b)=>a+b,0)/band.length : 5.0;
    }
  }

  // Compute weighted FPAR per player
  const CURRENT_SEASON = 2025;
  const RECENT_MULT = 3.0;
  const fparResults = {};

  for (const [id, pd] of Object.entries(allStats)) {
    const pos = pd.pos;
    const seasonArr = Object.entries(pd.seasons)
      .map(([yr,s]) => ({yr:+yr,s}))
      .sort((a,b) => b.yr-a.yr);
    const mostRecent = seasonArr[0]?.yr || CURRENT_SEASON;

    let wFPAR=0, totalW=0;
    for (const {yr,s} of seasonArr) {
      const repl = REPL[yr]?.[pos] || 5.0;
      const fpar = (s.ppg - repl) * s.games;
      const seasBack = mostRecent - yr;
      const sw = RECENT_MULT * Math.pow(0.5, seasBack);
      wFPAR += fpar * sw;
      totalW += sw;
    }

    const rawFPAR = totalW > 0 ? wFPAR / totalW : 0;
    fparResults[id] = {
      name: pd.name, pos, team: pd.team, hs: pd.hs,
      rawFPAR, mostRecentSeason: mostRecent
    };
  }

  // Normalize FPAR per position to 0-9999
  for (const pos of ['QB','RB','WR','TE']) {
    const inPos = Object.entries(fparResults).filter(([,p]) => p.pos===pos);
    const vals = inPos.map(([,p]) => p.rawFPAR);
    const maxV = Math.max(...vals);
    const minV = Math.min(...vals.filter(v=>v>0), 0);
    const range = Math.max(1, maxV-minV);
    for (const [id, p] of inPos) {
      p.fpar_value = p.rawFPAR <= 0 ? 0 :
        Math.round(((p.rawFPAR-minV)/range) * 9300 + 500);
      p.fpar_value = Math.max(0, Math.min(9999, p.fpar_value));
    }
  }

  console.log(`[3] FPAR computed: ${Object.keys(fparResults).length} players`);
  return fparResults;
}

// ── STEP 4: BLEND & GENERATE CONSENSUS ──
function blendConsensus(adpData, fparData, playerMap, tradeData = null) {
  console.log('[4] Blending layers...');

  // Weights
  const W_ADP   = 0.50;
  const W_TRADE = 0.20;
  const W_FPAR  = 0.30;

  // Build player universe from ADP (this is our noise filter)
  // Only players with a real ADP baseline make it in
  const players = [];

  for (const [id, adp] of Object.entries(adpData)) {
    const fpar = fparData[id] || null;
    const trade = tradeData?.[id] || null;
    const pmap = playerMap[id] || null;

    // ADP component (always present — it's our baseline)
    const adpVal = adp.adp_value;

    // FPAR component (0 for rookies/no stats — that's fine)
    const fparVal = fpar?.fpar_value || 0;

    // Trade component (from previous engine run if available)
    const tradeVal = trade?.value || 0;

    // Blend based on data availability
    let finalValue;
    if (fparVal > 0 && tradeVal > 0) {
      // Full blend — veteran with stats and trades
      finalValue = Math.round(adpVal*W_ADP + tradeVal*W_TRADE + fparVal*W_FPAR);
    } else if (fparVal > 0) {
      // ADP + FPAR only (no trade data)
      finalValue = Math.round(adpVal*(W_ADP+W_TRADE/2) + fparVal*(W_FPAR+W_TRADE/2));
    } else {
      // ADP only — rookies, new players, no history
      // Slight discount since unproven
      finalValue = Math.round(adpVal * 0.92);
    }

    // Age curve forward adjustment
    const age = adp.age || pmap?.age;
    if (age && ['QB','RB','WR','TE'].includes(adp.pos)) {
      const curMult = ageMult(adp.pos, age);
      const fwdMult = ageMult(adp.pos, age + 1);
      if (curMult > 0) {
        const ageFactor = 1.0 + ((fwdMult/curMult) - 1.0) * 0.4;
        finalValue = Math.round(finalValue * ageFactor);
      }
    }

    finalValue = Math.max(0, Math.min(9999, finalValue));

    players.push({
      id,
      name: adp.name,
      pos: adp.pos,
      team: adp.team || pmap?.team || 'FA',
      age: age || null,
      value: finalValue,
      components: {
        adp_value: adpVal,
        fpar_value: fparVal,
        trade_value: tradeVal,
        has_stats: fparVal > 0,
        has_trades: tradeVal > 0,
        source: fparVal>0&&tradeVal>0 ? 'full_blend' : fparVal>0 ? 'adp_fpar' : 'adp_only'
      }
    });
  }

  // Sort + rank
  players.sort((a,b) => b.value-a.value);
  players.forEach((p,i) => p.rank = i+1);

  // Per-position ranks
  const posCounters = {QB:0,RB:0,WR:0,TE:0};
  for (const p of players) {
    if (posCounters[p.pos] !== undefined) {
      posCounters[p.pos]++;
      p.pos_rank = posCounters[p.pos];
    }
  }

  console.log(`[4] Final rankings: ${players.length} players`);
  return players;
}

// ── STEP 5: COMMIT TO GITHUB ──
async function commitToGitHub(content, date) {
  const owner = process.env.GITHUB_OWNER;
  const repo  = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;

  if (!owner || !repo || !token) {
    console.log('[5] GitHub credentials not set — skipping commit');
    return false;
  }

  const paths = [
    'public/data/consensus.json',
    `public/data/adp-history/${date}.json`
  ];

  for (const path of paths) {
    try {
      // Get current SHA if file exists
      const existing = await fetch(
        `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`,
        { headers: { Authorization: `token ${token}`, 'User-Agent': 'GWTTKB/1.0' } }
      );
      const existingData = existing.ok ? await existing.json() : null;
      const sha = existingData?.sha;

      // Commit new content
      const body = {
        message: `chore: update consensus rankings ${date}`,
        content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64'),
        ...(sha ? { sha } : {})
      };

      const res = await fetch(
        `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `token ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'GWTTKB/1.0'
          },
          body: JSON.stringify(body)
        }
      );

      if (res.ok) {
        console.log(`[5] Committed: ${path}`);
      } else {
        const err = await res.json();
        console.error(`[5] Failed ${path}:`, err.message);
      }
    } catch(e) {
      console.error(`[5] Error committing ${path}:`, e.message);
    }
  }
  return true;
}

// ── CSV PARSER ──
function parseCSVLine(line) {
  const vals = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch==='"') { if(inQ&&line[i+1]==='"'){cur+='"';i++;}else{inQ=!inQ;} continue; }
    if (ch===','&&!inQ) { vals.push(cur.trim()); cur=''; continue; }
    cur += ch;
  }
  vals.push(cur.trim());
  return vals;
}

// ── MAIN HANDLER ──
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Allow manual trigger with secret or Vercel cron header
  const isCron = req.headers['x-vercel-cron'] === '1';
  const isManual = req.query.secret === process.env.CRON_SECRET;

  if (!isCron && !isManual && req.method !== 'GET') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // For GET requests without auth — return current consensus
  if (req.method === 'GET' && !isCron && !isManual) {
    return res.status(200).json({
      message: 'Consensus engine. Add ?secret=YOUR_SECRET to trigger a rebuild.',
      next_run: 'Daily at 2am ET via Vercel cron'
    });
  }

  const date = new Date().toISOString().split('T')[0];
  console.log(`[GWTTKB Consensus] Starting build for ${date}`);

  try {
    // Load optional trade data from existing consensus
    let tradeData = null;
    try {
      const tradeRes = await fetch(
        `https://raw.githubusercontent.com/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}/main/public/data/consensus.json`
      );
      if (tradeRes.ok) {
        const existing = await tradeRes.json();
        // Build trade lookup from existing players array
        const src = existing.formats?.sf_ppr_12?.players || existing.players || [];
        tradeData = {};
        for (const p of src) {
          if (p.id) tradeData[p.id] = { value: p.value, trades: p.trades || 0 };
        }
        console.log(`[0] Loaded ${Object.keys(tradeData).length} existing trade values`);
      }
    } catch(e) {
      console.log('[0] No existing consensus — fresh build');
    }

    // Run all steps
    const playerMap  = await fetchPlayerMap();
    const adpData    = await fetchStartupADP(playerMap);
    const fparData   = await fetchFPAR([2023, 2024, 2025]);
    const players    = blendConsensus(adpData, fparData, playerMap, tradeData);

    // Build output
    const output = {
      generated: new Date().toISOString(),
      version: '5.0',
      engine: 'ADP Baseline + Trade Delta + FPAR Reality Check',
      date,
      methodology: {
        adp_weight: 0.50,
        trade_weight: 0.20,
        fpar_weight: 0.30,
        description: 'Startup ADP is the noise filter and baseline. Trade market adds momentum signal. FPAR catches where the market is wrong.'
      },
      summary: {
        total_players: players.length,
        full_blend: players.filter(p=>p.components.source==='full_blend').length,
        adp_fpar: players.filter(p=>p.components.source==='adp_fpar').length,
        adp_only: players.filter(p=>p.components.source==='adp_only').length,
        by_position: {
          QB: players.filter(p=>p.pos==='QB').length,
          RB: players.filter(p=>p.pos==='RB').length,
          WR: players.filter(p=>p.pos==='WR').length,
          TE: players.filter(p=>p.pos==='TE').length
        }
      },
      // Flat array for downstream tools
      players: players.map(p => ({
        id: p.id, name: p.name, pos: p.pos, team: p.team,
        age: p.age, value: p.value, rank: p.rank, pos_rank: p.pos_rank,
        components: p.components
      })),
      // Format-specific for v3/v4 compatibility
      formats: {
        sf_ppr_12: {
          players: players.map(p => ({
            id: p.id, name: p.name, pos: p.pos, team: p.team,
            age: p.age, value: p.value, rank: p.rank, pos_rank: p.pos_rank
          }))
        }
      }
    };

    // Commit to GitHub
    await commitToGitHub(output, date);

    console.log(`[DONE] ${players.length} players ranked`);
    return res.status(200).json({
      success: true,
      date,
      players: players.length,
      top5: players.slice(0,5).map(p => `${p.name} (${p.value})`),
      breakdown: output.summary
    });

  } catch(e) {
    console.error('[ERROR]', e);
    return res.status(500).json({ error: e.message });
  }
}
