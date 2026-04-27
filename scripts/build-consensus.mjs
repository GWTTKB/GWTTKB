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
  console.log('Step 2: Computing startup ADP from real Sleeper drafts...');

  const SEED_USER = '605943364277321728'; // trout9
  const TARGET_DRAFTS = 150;
  const FANTASY_POS = ['QB','RB','WR','TE'];

  const draftIds = new Set();
  const leaguesSeen = new Set();
  const usersSeen = new Set();
  const usersToVisit = [SEED_USER];

  // Snowball to find completed dynasty startup drafts
  while (usersToVisit.length > 0 && draftIds.size < TARGET_DRAFTS * 2) {
    const userId = usersToVisit.shift();
    if (usersSeen.has(userId)) continue;
    usersSeen.add(userId);

    const leagues = await get(`${SLEEPER}/user/${userId}/leagues/nfl/2025`);
    if (!Array.isArray(leagues)) continue;

    for (const league of leagues) {
      if (leaguesSeen.has(league.league_id)) continue;
      if (league.settings?.type !== 2) continue; // dynasty only
      leaguesSeen.add(league.league_id);

      const drafts = await get(`${SLEEPER}/league/${league.league_id}/drafts`);
      if (!Array.isArray(drafts)) continue;
      for (const d of drafts) {
        if (d.status==='complete' && (d.type==='snake'||d.type==='linear') && (d.settings?.rounds||0)>=20) {
          draftIds.add(d.draft_id);
        }
      }

      // Fan out through users
      if (draftIds.size < TARGET_DRAFTS) {
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

  console.log(`  Found ${draftIds.size} startup drafts`);

  // Pull picks and compute ADP
  const picks = {}; // playerId -> {total, count}
  let processed = 0;

  for (const draftId of [...draftIds].slice(0, TARGET_DRAFTS)) {
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
    if (processed % 20 === 0) console.log(`  Processed ${processed} drafts...`);
    await sleep(60);
  }

  console.log(`  Processed ${processed} drafts, ${Object.keys(picks).length} players found`);

  // Qualify players with 3+ draft appearances and compute ADP
  const qualified = Object.entries(picks)
    .filter(([,d]) => d.count >= 3)
    .map(([id,d]) => ({
      id, avg_pick: d.total/d.count, draft_count: d.count,
      name: playerMap[id]?.name||id,
      pos: playerMap[id]?.pos||'?',
      team: playerMap[id]?.team||'FA',
      age: playerMap[id]?.age||null
    }))
    .sort((a,b) => a.avg_pick - b.avg_pick);

  console.log(`  ${qualified.length} players with 3+ draft appearances`);

  // Normalize to 0-9999
  const adpData = {};
  qualified.forEach((p,i) => {
    const pct = 1 - (i / qualified.length);
    adpData[p.id] = {
      ...p,
      adp_value: Math.max(100, Math.round(Math.pow(pct, 0.65) * 9999))
    };
  });

  return adpData;
}

// ── STEP 3: FPAR FROM NFLVERSE ──
async function getFPAR(seasons=[2023,2024,2025]) {
  console.log('Step 3: Computing FPAR from NFLverse...');
  const allStats = {};

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
        const pos = (v[idx.pos]||'').toUpperCase();
        if (!['QB','RB','WR','TE'].includes(pos)) continue;
        const pts = parseFloat(v[idx.pts])||0;
        const usage = (parseFloat(v[idx.carries])||0)+(parseFloat(v[idx.targets])||0)+(parseFloat(v[idx.attempts])||0);
        if (pts===0 && usage===0) continue;
        const id = v[idx.id];
        if (!byPlayer[id]) byPlayer[id]={pos,team:v[idx.team]||'FA',hs:v[idx.hs]||'',name:v[idx.name]||'',weeks:[]};
        byPlayer[id].weeks.push(pts);
        byPlayer[id].team=v[idx.team]||byPlayer[id].team;
      }

      for (const [id,pd] of Object.entries(byPlayer)) {
        if (pd.weeks.length<5) continue;
        const totalPts=pd.weeks.reduce((s,v)=>s+v,0);
        if (!allStats[id]) allStats[id]={pos:pd.pos,team:pd.team,hs:pd.hs,name:pd.name,seasons:{}};
        allStats[id].seasons[season]={ppg:totalPts/pd.weeks.length,games:pd.weeks.length,totalPts};
        allStats[id].team=pd.team;
      }
      console.log(`  ${season}: ${Object.keys(byPlayer).length} players`);
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
function blend(adpData, fparData, playerMap) {
  console.log('Step 4: Blending layers...');
  const W = { adp:0.50, fpar:0.30, trade:0.20 };

  // Load existing trade values if available
  let tradeData = {};
  try {
    const existing = JSON.parse(fs.readFileSync('public/data/consensus.json','utf8'));
    const src = existing.formats?.sf_ppr_12?.players || existing.players || [];
    for (const p of src) if (p.id) tradeData[p.id]={value:p.value};
    console.log(`  Loaded ${Object.keys(tradeData).length} existing trade values`);
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

    // Age curve adjustment
    const age = adp.age || pmap?.age;
    if (age && ['QB','RB','WR','TE'].includes(adp.pos)) {
      const cur=ageMult(adp.pos,age), fwd=ageMult(adp.pos,age+1);
      if (cur>0) finalValue=Math.round(finalValue*(1+(fwd/cur-1)*0.4));
    }

    finalValue=Math.max(0,Math.min(9999,finalValue));
    players.push({
      id, name:adp.name, pos:adp.pos, team:adp.team||pmap?.team||'FA',
      age:age||null, value:finalValue, avg_pick:adp.avg_pick, draft_count:adp.draft_count,
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

  const playerMap = await getPlayerMap();
  const adpData   = await getStartupADP(playerMap);
  const fparData  = await getFPAR([2023,2024,2025]);
  const players   = blend(adpData, fparData, playerMap);

  const output = {
    generated: new Date().toISOString(),
    version: '5.0',
    engine: 'Real Startup ADP + FPAR Reality Check + Trade Signal',
    date,
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
    players: players.map(p=>({
      id:p.id, name:p.name, pos:p.pos, team:p.team, age:p.age,
      value:p.value, rank:p.rank, pos_rank:p.pos_rank,
      avg_pick:p.avg_pick, draft_count:p.draft_count,
      headshot_url:p.headshot_url,
      components:p.components
    })),
    formats: {
      sf_ppr_12: {
        players: players.map(p=>({
          id:p.id, name:p.name, pos:p.pos, team:p.team, age:p.age,
          value:p.value, rank:p.rank, pos_rank:p.pos_rank,
          avg_pick:p.avg_pick, draft_count:p.draft_count,
          headshot_url:p.headshot_url
        }))
      }
    }
  };

  // Write consensus
  fs.mkdirSync('public/data/adp-history', { recursive: true });
  fs.writeFileSync('public/data/consensus.json', JSON.stringify(output, null, 2));

  // Write dated snapshot
  fs.writeFileSync(`public/data/adp-history/${date}.json`, JSON.stringify({
    date,
    players: players.map(p=>({id:p.id,name:p.name,pos:p.pos,value:p.value,avg_pick:p.avg_pick,rank:p.rank}))
  }, null, 2));

  console.log(`\n✓ Done! ${players.length} players ranked`);
  console.log(`Top 5: ${players.slice(0,5).map(p=>`${p.name} (${p.value})`).join(', ')}`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
