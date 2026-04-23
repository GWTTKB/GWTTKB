// ============================================================================
// GWTTKB Consensus Builder
// Runs via GitHub Actions — no timeout limit
// node scripts/build-consensus.mjs
// ============================================================================

import fs from 'fs';
import path from 'path';

const SLEEPER = 'https://api.sleeper.app/v1';
const NFLVERSE = 'https://github.com/nflverse/nflverse-data/releases/download';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'GWTTKB/1.0' } });
      if (r.ok) return r.json();
      if (r.status === 429) { await sleep(3000 * (i + 1)); continue; }
      return null;
    } catch { await sleep(500); }
  }
  return null;
}

// ── AGE CURVES ──
const AC = {
  QB:{20:0.50,21:0.65,22:0.75,23:0.88,24:0.94,25:0.98,26:1.00,27:1.02,28:1.03,29:1.02,30:1.00,31:0.97,32:0.93,33:0.87,34:0.79,35:0.69,36:0.58},
  RB:{20:0.72,21:0.86,22:0.97,23:1.02,24:1.03,25:1.00,26:0.95,27:0.87,28:0.75,29:0.62,30:0.49,31:0.36,32:0.24},
  WR:{20:0.55,21:0.70,22:0.83,23:0.92,24:0.97,25:1.01,26:1.03,27:1.02,28:1.00,29:0.95,30:0.89,31:0.81,32:0.71,33:0.60,34:0.48},
  TE:{20:0.40,21:0.53,22:0.63,23:0.74,24:0.85,25:0.94,26:0.99,27:1.02,28:1.03,29:1.01,30:0.97,31:0.91,32:0.82,33:0.71,34:0.59}
};
function ageMult(pos, age) {
  const c = AC[pos] || AC.WR;
  if (c[age] !== undefined) return c[age];
  const keys = Object.keys(c).map(Number).sort((a,b)=>a-b);
  for (let i = keys.length-1; i>=0; i--) if (keys[i]<=age) return c[keys[i]];
  return 0.4;
}

function parseCSVLine(line) {
  const vals = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch==='"') { if(inQ&&line[i+1]==='"'){cur+='"';i++;}else{inQ=!inQ;} continue; }
    if (ch===','&&!inQ){vals.push(cur.trim());cur='';continue;}
    cur+=ch;
  }
  vals.push(cur.trim()); return vals;
}

// ── STEP 1: PLAYER MAP ──
async function getPlayerMap() {
  console.log('Step 1: Loading Sleeper player map...');
  const data = await get(`${SLEEPER}/players/nfl`);
  if (!data) throw new Error('Failed to load player map');
  const map = {};
  for (const [id, p] of Object.entries(data)) {
    if (!p?.full_name) continue;
    map[id] = { name:p.full_name, pos:p.position||'?', team:p.team||'FA',
                age:p.age||null, years_exp:p.years_exp||0, search_rank:p.search_rank||9999 };
  }
  console.log(`  ${Object.keys(map).length} players loaded`);
  return map;
}

// ── STEP 2: REAL STARTUP ADP FROM ACTUAL DRAFTS ──
async function getStartupADP(playerMap) {
  console.log('Step 2: Computing startup ADP from real Sleeper drafts (SF + 1QB)...');

  const SEED_USER = '605943364277321728'; // trout9
  const TARGET_DRAFTS = 150;
  const FANTASY_POS = ['QB','RB','WR','TE'];

  const draftMeta = new Map(); // draftId → { isSF: bool }
  const leaguesSeen = new Set();
  const usersSeen = new Set();
  const usersToVisit = [SEED_USER];

  // Snowball to find completed dynasty startup drafts
  while (usersToVisit.length > 0 && draftMeta.size < TARGET_DRAFTS * 2) {
    const userId = usersToVisit.shift();
    if (usersSeen.has(userId)) continue;
    usersSeen.add(userId);

    const leagues = await get(`${SLEEPER}/user/${userId}/leagues/nfl/2026`);
    if (!Array.isArray(leagues)) continue;

    for (const league of leagues) {
      if (leaguesSeen.has(league.league_id)) continue;
      if (league.settings?.type !== 2) continue; // dynasty only
      leaguesSeen.add(league.league_id);

      // Detect SF vs 1QB from roster positions
      const positions = league.roster_positions || [];
      const isSF = positions.includes('SUPER_FLEX');

      const drafts = await get(`${SLEEPER}/league/${league.league_id}/drafts`);
      if (!Array.isArray(drafts)) continue;
      for (const d of drafts) {
        if (d.status==='complete' && (d.type==='snake'||d.type==='linear') && (d.settings?.rounds||0)>=20) {
          draftMeta.set(d.draft_id, { isSF });
        }
      }

      // Fan out through users
      if (draftMeta.size < TARGET_DRAFTS) {
        const users = await get(`${SLEEPER}/league/${league.league_id}/users`);
        if (Array.isArray(users)) {
          for (const u of users) {
            if (!usersSeen.has(u.user_id)) usersToVisit.push(u.user_id);
          }
        }
      }
      await sleep(80);
    }
  }

  const sfDraftIds  = [...draftMeta.entries()].filter(([,m]) =>  m.isSF).map(([id]) => id);
  const qbDraftIds  = [...draftMeta.entries()].filter(([,m]) => !m.isSF).map(([id]) => id);
  console.log(`  Found ${sfDraftIds.length} SF drafts, ${qbDraftIds.length} 1QB drafts`);

  // Pull picks and compute ADP for each format
  async function computeADP(draftIds, label) {
    const picks = {};
    let processed = 0;
    for (const draftId of draftIds.slice(0, TARGET_DRAFTS)) {
      const draftPicks = await get(`${SLEEPER}/draft/${draftId}/picks`);
      if (!Array.isArray(draftPicks) || draftPicks.length < 20) continue;
      for (const pick of draftPicks) {
        const pid = pick.player_id;
        if (!pid || pid.length > 8) continue;
        const pos = playerMap[pid]?.pos || pick.metadata?.position || '?';
        if (!FANTASY_POS.includes(pos)) continue;
        if (!picks[pid]) picks[pid] = { total:0, count:0 };
        picks[pid].total += pick.pick_no;
        picks[pid].count++;
      }
      processed++;
      if (processed % 20 === 0) console.log(`  [${label}] Processed ${processed} drafts...`);
      await sleep(60);
    }

    const qualified = Object.entries(picks)
      .filter(([id, d]) => {
        const isRookie = (playerMap[id]?.years_exp || 0) === 0;
        return isRookie ? d.count >= 10 : d.count >= 3;
      })
      .map(([id,d]) => ({
        id, avg_pick: d.total/d.count, draft_count: d.count,
        name: playerMap[id]?.name||id,
        pos: playerMap[id]?.pos||'?',
        team: playerMap[id]?.team||'FA',
        age: playerMap[id]?.age||null,
        years_exp: playerMap[id]?.years_exp||0
      }))
      .sort((a,b) => a.avg_pick - b.avg_pick);

    const rookiesIn = qualified.filter(p => p.years_exp === 0).length;
    console.log(`  [${label}] ${qualified.length} players qualified (${rookiesIn} rookies)`);

    // Value curves calibrated to GWTTKB scale (from historical spreadsheet data)
    // This ensures consensus values match the same scale as GWTTKB rankings
    const SF_CURVE  = {1:9729,2:9681,3:9657,4:9633,5:9487,6:8903,7:8879,8:8489,9:8455,10:8416,11:8407,12:8387,13:7920,14:7609,15:7507,16:7492,17:7298,18:7249,19:7225,20:6908,21:6811,22:6714,23:6665,24:6592,25:6568,26:6324,27:6300,28:6286,29:6276,30:6252,31:6227,32:6179,33:6154,34:6130,35:6081,36:6072,37:6033,38:5984,39:5960,40:5935,41:5692,42:5668,43:5643,44:5546,45:5497,46:5449,47:5400,48:5352,49:5254,50:5235,55:5147,60:5079,65:5030,70:4914,75:4758,80:4719,85:4602,90:4476,95:4252,100:4087,110:3814,120:3590,130:3347,140:3250,150:3133,160:3016,170:2934,180:2846,190:2754,200:2671,220:2617,240:2520,260:2355,280:2175,300:2034,320:1878,340:1712,360:1557,380:1419,400:1387,420:1275,440:1172,460:1075,480:978,500:788};
    const QB1_CURVE = {1:9609,2:9600,3:9596,4:9591,5:8764,6:8755,7:8553,8:8438,9:7996,10:7880,11:7688,12:7544,13:7496,14:7400,15:7256,16:7111,17:7102,18:7092,19:6823,20:6775,21:6727,22:6487,23:6343,24:6246,25:6198,26:6170,27:6160,28:6150,29:6141,30:6131,31:6122,32:6074,33:6054,34:6006,35:5958,36:5920,37:5901,38:5881,39:5862,40:5833,41:5814,42:5776,43:5737,44:5641,45:5622,46:5593,47:5574,48:5555,49:5545,50:5516,55:5401,60:5343,65:5257,70:5170,75:5103,80:4901,85:4709,90:4449,95:4344,100:4267,110:4161,120:3979,130:3844,140:3681,150:3575,160:3431,170:3306,180:3191,190:3075,200:3008,220:2806,240:2585,260:2258,280:2085,300:1965,320:1792,340:1629,360:1480,380:1391,400:1350,420:1220,440:1124,460:1028,480:913};
    const CURVE = label === 'SF' ? SF_CURVE : QB1_CURVE;

    // Interpolate value from curve for any rank
    function valueFromCurve(rank) {
      const keys = Object.keys(CURVE).map(Number).sort((a,b)=>a-b);
      if (rank <= keys[0]) return CURVE[keys[0]];
      if (rank >= keys[keys.length-1]) return Math.max(100, CURVE[keys[keys.length-1]] - (rank - keys[keys.length-1]) * 3);
      // Find surrounding keys and interpolate
      let lo = keys[0], hi = keys[keys.length-1];
      for (let i=0; i<keys.length-1; i++) {
        if (keys[i] <= rank && keys[i+1] >= rank) { lo=keys[i]; hi=keys[i+1]; break; }
      }
      const t = (rank-lo)/(hi-lo);
      return Math.round(CURVE[lo] + t*(CURVE[hi]-CURVE[lo]));
    }

    const adpData = {};
    qualified.forEach((p,i) => {
      const rank = i + 1;
      adpData[p.id] = { ...p, adp_value: valueFromCurve(rank) };
    });
    return adpData;
  }

  const adpSF  = await computeADP(sfDraftIds,  'SF');
  const adp1QB = await computeADP(qbDraftIds, '1QB');
  return { adpSF, adp1QB };
}

// ── ID BRIDGE: GSIS → SLEEPER via name matching ──
// NFLverse v2 players.csv doesn't have sleeper_id column
// We match on player name between NFLverse and Sleeper player map
async function buildIDMap(playerMap) {
  console.log('Step 2b: Building GSIS → Sleeper ID bridge via name matching...');
  try {
    const url = 'https://github.com/nflverse/nflverse-data/releases/download/players/players.csv';
    const res = await fetch(url, { headers:{'User-Agent':'GWTTKB/1.0'}, redirect:'follow' });
    if (!res.ok) { console.log('  players.csv not available — using name fallback'); return buildNameBridge(playerMap); }

    const text = await res.text();
    const lines = text.trim().split(/\r?\n/);
    const hdrs = lines[0].split(',').map(h=>h.replace(/"/g,'').trim());
    const I = n => hdrs.indexOf(n);

    const gsisIdx = I('gsis_id');
    // Try multiple possible name columns
    const nameIdx = ['display_name','football_name','common_first_name'].map(I).find(i=>i>=0) ?? -1;

    if (gsisIdx < 0) { console.log('  No gsis_id column — using name bridge'); return buildNameBridge(playerMap); }

    // Build name → gsis_id lookup from NFLverse
    const nflverseNames = {}; // normalized name → gsis_id
    for (const line of lines.slice(1)) {
      const v = parseCSVLine(line);
      const gsis = v[gsisIdx]?.trim();
      if (!gsis) continue;
      // Try to get full name from available columns
      const firstName = v[I('first_name')]?.trim() || '';
      const lastName  = v[I('last_name')]?.trim()  || '';
      const dispName  = nameIdx >= 0 ? v[nameIdx]?.trim() : '';
      const fullName  = dispName || `${firstName} ${lastName}`.trim();
      if (fullName) nflverseNames[normName(fullName)] = gsis;
    }

    // Now match against Sleeper player map
    const bridge = {}; // gsis_id → sleeper_id
    let matched = 0;
    for (const [sleeperId, p] of Object.entries(playerMap)) {
      const key = normName(p.name);
      const gsis = nflverseNames[key];
      if (gsis) { bridge[gsis] = sleeperId; matched++; }
    }
    console.log(`  Bridge built: ${matched} matches via name`);
    return bridge;
  } catch(e) {
    console.log('  Bridge error:', e.message, '— using name bridge');
    return buildNameBridge(playerMap);
  }
}

// Fallback: build bridge purely from Sleeper player map names
// Maps normalized name → sleeper_id, then NFLverse matches by name
function buildNameBridge(playerMap) {
  const bridge = {}; // normalized name → sleeper_id (used differently in getFPAR)
  for (const [id, p] of Object.entries(playerMap)) {
    bridge[normName(p.name)] = id;
  }
  console.log(`  Name bridge built: ${Object.keys(bridge).length} players`);
  return bridge;
}

function normName(name) {
  return (name||'').toLowerCase()
    .replace(/\s+(jr|sr|ii|iii|iv|v)\.?$/i,'')
    .replace(/[^a-z]/g,'');
}
async function getFPAR(seasons=[2023,2024,2025], idBridge={}) {
  console.log('Step 3: Computing FPAR from NFLverse...');
  const allStats = {}; // keyed by SLEEPER ID after bridge

  for (const season of seasons) {
    try {
      const url = `${NFLVERSE}/stats_player/stats_player_week_${season}.csv`;
      const res = await fetch(url, { headers:{'User-Agent':'GWTTKB/1.0'}, redirect:'follow' });
      if (!res.ok) { console.log(`  ${season}: not found`); continue; }

      const text = await res.text();
      const lines = text.trim().split(/\r?\n/);
      const hdrs = lines[0].split(',').map(h=>h.replace(/"/g,'').trim());
      const I = n => hdrs.indexOf(n);

      const idx = {
        id:I('player_id'), name:I('player_display_name'), pos:I('position'),
        team:I('team'), pts:I('fantasy_points_ppr'),
        carries:I('carries'), targets:I('targets'), attempts:I('attempts'),
        hs:I('headshot_url')
      };

      const byPlayer = {};
      for (const line of lines.slice(1)) {
        const v = parseCSVLine(line);
        if (!v[idx.id]) continue;

        // Bridge GSIS ID → Sleeper ID via name matching
        // Build a normalized name from the stat row and look up Sleeper ID
        const playerName = v[idx.name] || '';
        const sleeperId = idBridge[normName(playerName)];
        if (!sleeperId) continue; // skip players not matched

        const pos = (v[idx.pos]||'').toUpperCase();
        if (!['QB','RB','WR','TE'].includes(pos)) continue;
        const pts = parseFloat(v[idx.pts])||0;
        const usage = (parseFloat(v[idx.carries])||0)+(parseFloat(v[idx.targets])||0)+(parseFloat(v[idx.attempts])||0);
        if (pts===0 && usage===0) continue;

        if (!byPlayer[sleeperId]) byPlayer[sleeperId]={pos,team:v[idx.team]||'FA',hs:v[idx.hs]||'',name:v[idx.name]||'',weeks:[]};
        byPlayer[sleeperId].weeks.push(pts);
        byPlayer[sleeperId].team=v[idx.team]||byPlayer[sleeperId].team;
      }

      let bridged = 0;
      for (const [id,pd] of Object.entries(byPlayer)) {
        if (pd.weeks.length<5) continue;
        const totalPts=pd.weeks.reduce((s,v)=>s+v,0);
        if (!allStats[id]) allStats[id]={pos:pd.pos,team:pd.team,hs:pd.hs,name:pd.name,seasons:{}};
        allStats[id].seasons[season]={ppg:totalPts/pd.weeks.length,games:pd.weeks.length,totalPts};
        allStats[id].team=pd.team;
        bridged++;
      }
      console.log(`  ${season}: ${bridged} players with Sleeper ID match`);
    } catch(e) { console.error(`  ${season} error:`, e.message); }
  }

  // Replacement level
  const REPL = {};
  for (const season of seasons) {
    REPL[season]={};
    for (const pos of ['QB','RB','WR','TE']) {
      const ppgs=Object.values(allStats).filter(p=>p.pos===pos&&p.seasons[season]).map(p=>p.seasons[season].ppg).sort((a,b)=>b-a);
      const band=ppgs.slice(24,36);
      REPL[season][pos]=band.length?band.reduce((a,b)=>a+b,0)/band.length:5.0;
    }
  }

  // Weighted FPAR per player
  const results = {};
  for (const [id,pd] of Object.entries(allStats)) {
    const seasonArr=Object.entries(pd.seasons).map(([yr,s])=>({yr:+yr,s})).sort((a,b)=>b.yr-a.yr);
    const mostRecent=seasonArr[0]?.yr||2025;
    let wFPAR=0,totalW=0;
    for (const {yr,s} of seasonArr) {
      const repl=REPL[yr]?.[pd.pos]||5.0;
      const fpar=(s.ppg-repl)*s.games;
      const sw=3.0*Math.pow(0.5,mostRecent-yr);
      wFPAR+=fpar*sw; totalW+=sw;
    }
    results[id]={pos:pd.pos,team:pd.team,hs:pd.hs,name:pd.name,rawFPAR:totalW>0?wFPAR/totalW:0,mostRecentSeason:mostRecent};
  }

  // Normalize per position
  for (const pos of ['QB','RB','WR','TE']) {
    const inPos=Object.entries(results).filter(([,p])=>p.pos===pos);
    const vals=inPos.map(([,p])=>p.rawFPAR);
    const maxV=Math.max(...vals), minV=Math.min(...vals.filter(v=>v>0),0);
    const range=Math.max(1,maxV-minV);
    for (const [id,p] of inPos) {
      p.fpar_value=p.rawFPAR<=0?0:Math.max(0,Math.min(9999,Math.round(((p.rawFPAR-minV)/range)*9300+500)));
    }
  }

  console.log(`  ${Object.keys(results).length} players with FPAR data`);
  return results;
}

// ── STEP 4: BLEND ──
function blend(adpData, fparData, playerMap, format='SF') {
  console.log(`Step 4: Blending ${format} layers...`);
  const W = { adp:0.50, fpar:0.30, trade:0.20 };

  // Load existing trade values — use format-specific if available
  let tradeData = {};
  try {
    const existing = JSON.parse(fs.readFileSync('public/data/consensus.json','utf8'));
    const formatKey = format === 'SF' ? 'sf_ppr' : 'qb1_ppr';
    const src = existing.formats?.[formatKey]?.players || existing.formats?.sf_ppr_12?.players || existing.players || [];
    for (const p of src) if (p.id) tradeData[p.id]={value:p.value};
    console.log(`  Loaded ${Object.keys(tradeData).length} existing ${format} trade values`);
  } catch { console.log('  No existing consensus — fresh build'); }

  const players = [];
  for (const [id, adp] of Object.entries(adpData)) {
    const fpar = fparData[id];
    const trade = tradeData[id];
    const pmap = playerMap[id];
    const adpVal = adp.adp_value;
    const fparVal = fpar?.fpar_value || 0;
    const tradeVal = trade?.value || 0;

    let finalValue;
    if (fparVal>0 && tradeVal>0) {
      finalValue = Math.round(adpVal*W.adp + tradeVal*W.trade + fparVal*W.fpar);
    } else if (fparVal>0) {
      finalValue = Math.round(adpVal*(W.adp+W.trade/2) + fparVal*(W.fpar+W.trade/2));
    } else {
      finalValue = Math.round(adpVal*0.92); // rookies/no stats — slight discount
    }

    // NO age curve adjustment here — ADP already prices in age implicitly
    // Dynasty managers naturally draft young players higher in startups
    // Applying age curve on top double-counts and distorts prime veterans

    finalValue=Math.max(0,Math.min(9999,finalValue));
    const age = adp.age || pmap?.age || null;
    players.push({
      id, name:adp.name, pos:adp.pos, team:adp.team||pmap?.team||'FA',
      age, value:finalValue, avg_pick:adp.avg_pick, draft_count:adp.draft_count,
      headshot_url: fpar?.hs || `https://sleepercdn.com/content/nfl/players/${id}.jpg`,
      components:{
        adp_value:adpVal, fpar_value:fparVal, trade_value:tradeVal,
        source: fparVal>0&&tradeVal>0?'full_blend':fparVal>0?'adp_fpar':'adp_only'
      }
    });
  }

  players.sort((a,b)=>b.value-a.value);
  players.forEach((p,i)=>p.rank=i+1);
  const pc={QB:0,RB:0,WR:0,TE:0};
  for (const p of players) if(pc[p.pos]!==undefined){pc[p.pos]++;p.pos_rank=pc[p.pos];}

  console.log(`  ${players.length} players ranked`);
  console.log(`  full_blend: ${players.filter(p=>p.components.source==='full_blend').length}`);
  console.log(`  adp_fpar: ${players.filter(p=>p.components.source==='adp_fpar').length}`);
  console.log(`  adp_only: ${players.filter(p=>p.components.source==='adp_only').length}`);
  return players;
}

// ── MAIN ──
async function main() {
  console.log('=== GWTTKB Consensus Builder ===');
  const date = new Date().toISOString().split('T')[0];
  console.log(`Date: ${date}\n`);

  const playerMap       = await getPlayerMap();
  const idBridge        = await buildIDMap(playerMap);
  const { adpSF, adp1QB } = await getStartupADP(playerMap);
  const fparData        = await getFPAR([2023,2024,2025], idBridge);

  console.log('\nBlending SF rankings...');
  const playersSF  = blend(adpSF,  fparData, playerMap, 'SF');
  console.log('Blending 1QB rankings...');
  const players1QB = blend(adp1QB, fparData, playerMap, '1QB');

  const summarize = (players) => ({
    total_players: players.length,
    full_blend: players.filter(p=>p.components.source==='full_blend').length,
    adp_fpar:   players.filter(p=>p.components.source==='adp_fpar').length,
    adp_only:   players.filter(p=>p.components.source==='adp_only').length,
    by_position: {
      QB: players.filter(p=>p.pos==='QB').length,
      RB: players.filter(p=>p.pos==='RB').length,
      WR: players.filter(p=>p.pos==='WR').length,
      TE: players.filter(p=>p.pos==='TE').length
    }
  });

  const slim = players => players.map(p=>({
    id:p.id, name:p.name, pos:p.pos, team:p.team, age:p.age,
    value:p.value, rank:p.rank, pos_rank:p.pos_rank,
    avg_pick:p.avg_pick, draft_count:p.draft_count,
    headshot_url:p.headshot_url, components:p.components
  }));

  const output = {
    generated: new Date().toISOString(),
    version: '5.2',
    engine: 'Real Startup ADP (SF + 1QB split) + FPAR + Trade Signal',
    date,
    formats: {
      sf_ppr: {
        summary: summarize(playersSF),
        players: slim(playersSF)
      },
      qb1_ppr: {
        summary: summarize(players1QB),
        players: slim(players1QB)
      }
    }
  };

  // Write consensus
  fs.mkdirSync('public/data/adp-history', { recursive: true });
  fs.writeFileSync('public/data/consensus.json', JSON.stringify(output, null, 2));

  // Write dated snapshots for both formats
  fs.writeFileSync(`public/data/adp-history/${date}.json`, JSON.stringify({
    date,
    sf:  playersSF.map(p=>({id:p.id,name:p.name,pos:p.pos,value:p.value,avg_pick:p.avg_pick,rank:p.rank})),
    qb1: players1QB.map(p=>({id:p.id,name:p.name,pos:p.pos,value:p.value,avg_pick:p.avg_pick,rank:p.rank}))
  }, null, 2));

  console.log(`\n✓ Done!`);
  console.log(`SF  Top 5: ${playersSF.slice(0,5).map(p=>`${p.name}(${p.value})`).join(', ')}`);
  console.log(`1QB Top 5: ${players1QB.slice(0,5).map(p=>`${p.name}(${p.value})`).join(', ')}`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
