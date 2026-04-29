// ── GWTTKB Startup + Rookie ADP Builder ──
// Pulls live Sleeper dynasty drafts and computes current ADP for both formats
// Writes: public/data/startup-adp.json (includes both startup and rookie ADP)

import fs from 'fs';

const SLEEPER = 'https://api.sleeper.app/v1';
const SEED_USER = '605943364277321728';
const TARGET_STARTUP = 150;
const TARGET_ROOKIE = 200;
const YEAR = 2026;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, retries=3) {
  for(let i=0; i<retries; i++){
    try{
      const r = await fetch(url, { headers:{'User-Agent':'GWTTKB/1.0'} });
      if(r.ok) return r.json();
      if(r.status===429){ await sleep(3000*(i+1)); continue; }
      return null;
    }catch{ await sleep(500); }
  }
  return null;
}

async function buildADP() {
  console.log('=== Building Startup + Rookie ADP ===');

  // Load player map for names
  console.log('Loading player map...');
  const playerMap = await get(`${SLEEPER}/players/nfl`) || {};
  const getName = id => playerMap[id]?.full_name || null;
  const getPos = id => playerMap[id]?.position || '?';
  const getExp = id => playerMap[id]?.years_exp ?? null;

  // ── SNOWBALL LEAGUES ──
  const startupDraftIds = new Set();
  const rookieDraftIds = new Set();
  const leaguesSeen = new Set();
  const usersSeen = new Set();
  const usersToVisit = [SEED_USER];

  console.log('\nSnowballing leagues...');
  while(usersToVisit.length > 0 &&
       (startupDraftIds.size < TARGET_STARTUP * 2 || rookieDraftIds.size < TARGET_ROOKIE * 2)) {
    const userId = usersToVisit.shift();
    if(usersSeen.has(userId)) continue;
    usersSeen.add(userId);

    const leagues = await get(`${SLEEPER}/user/${userId}/leagues/nfl/${YEAR}`);
    if(!Array.isArray(leagues)) continue;

    for(const league of leagues) {
      if(leaguesSeen.has(league.league_id)) continue;
      if(league.settings?.type !== 2) continue;
      leaguesSeen.add(league.league_id);

      const isSF = (league.roster_positions||[]).includes('SUPER_FLEX');
      const drafts = await get(`${SLEEPER}/league/${league.league_id}/drafts`);
      if(!Array.isArray(drafts)) continue;

      for(const d of drafts) {
        const rounds = d.settings?.rounds || 0;
        // Startup: 20+ rounds, complete
        if(d.status==='complete' && rounds>=20) {
          startupDraftIds.add({id:d.draft_id, isSF, teams:d.settings?.teams||10});
        }
        // Rookie: 3-7 rounds, complete or in progress
        if(rounds>=3 && rounds<=7 &&
           parseInt(d.season||0)===YEAR &&
           (d.status==='complete'||d.status==='drafting'||d.status==='in_progress')) {
          rookieDraftIds.add({id:d.draft_id, isSF, teams:d.settings?.teams||10});
        }
      }

      if(startupDraftIds.size < TARGET_STARTUP || rookieDraftIds.size < TARGET_ROOKIE) {
        const users = await get(`${SLEEPER}/league/${league.league_id}/users`);
        if(Array.isArray(users)) {
          for(const u of users) {
            if(!usersSeen.has(u.user_id)) usersToVisit.push(u.user_id);
          }
        }
      }
      await sleep(80);
    }
  }

  console.log(`Found: ${startupDraftIds.size} startup drafts, ${rookieDraftIds.size} rookie drafts`);

  // ── COMPUTE ADP FROM DRAFTS ──
  async function computeADP(draftSet, label, maxDrafts, filterFn) {
    const picks = {}; // player_id → {name, pos, pickNos[], teams[]}
    let processed = 0;

    for(const {id, isSF, teams} of [...draftSet].slice(0, maxDrafts)) {
      try {
        const draftPicks = await get(`${SLEEPER}/draft/${id}/picks`);
        if(!Array.isArray(draftPicks) || draftPicks.length < 10) continue;

        for(const pick of draftPicks) {
          if(!pick.player_id || !pick.pick_no) continue;
          const pos = getPos(pick.player_id);
          if(!['QB','RB','WR','TE'].includes(pos)) continue;

          // Apply filter (e.g. rookies only for rookie ADP)
          if(filterFn && !filterFn(pick.player_id)) continue;

          const name = getName(pick.player_id);
          if(!name) continue;

          if(!picks[pick.player_id]) picks[pick.player_id] = {
            pid: pick.player_id, name, pos, isSF,
            pickNos:[], teams:[]
          };
          picks[pick.player_id].pickNos.push(pick.pick_no);
          picks[pick.player_id].teams.push(teams);
        }

        processed++;
        if(processed % 25 === 0) console.log(`  [${label}] ${processed} drafts processed`);
        await sleep(60);
      } catch(e) {}
    }

    console.log(`[${label}] ${processed} drafts, ${Object.keys(picks).length} players`);

    // Compute ADP — normalize to 12-team equivalent
    return Object.values(picks)
      .filter(p => p.pickNos.length >= 3)
      .map(p => {
        const avgTeams = p.teams.reduce((a,b)=>a+b,0)/p.teams.length;
        const avgPick = p.pickNos.reduce((a,b)=>a+b,0)/p.pickNos.length;
        const normalized = avgPick * (12/avgTeams);
        const round = Math.ceil(normalized/12);
        const slot = Math.round(normalized%12)||12;
        return {
          pid: p.pid,
          name: p.name,
          pos: p.pos,
          adp: Math.round(avgPick*10)/10,
          adp_12team: Math.round(normalized*10)/10,
          adp_slot: `${round}.${String(slot).padStart(2,'0')}`,
          draft_count: p.pickNos.length,
          min_pick: Math.min(...p.pickNos),
          max_pick: Math.max(...p.pickNos),
        };
      })
      .sort((a,b) => a.adp_12team - b.adp_12team);
  }

  // Startup ADP — all players
  console.log('\nComputing startup ADP...');
  const startupADP = await computeADP(startupDraftIds, 'STARTUP', TARGET_STARTUP, null);

  // Rookie ADP — only players with years_exp=0 (current rookies)
  console.log('\nComputing rookie ADP...');
  const rookieADP = await computeADP(
    rookieDraftIds, 'ROOKIE', TARGET_ROOKIE,
    (pid) => getExp(pid) === 0 // only current rookies
  );

  // ── OUTPUT ──
  const output = {
    generated: new Date().toISOString(),
    source: `Sleeper live dynasty drafts — ${YEAR} season`,
    startup: {
      drafts_sampled: Math.min([...startupDraftIds].length, TARGET_STARTUP),
      total_players: startupADP.length,
      players: startupADP,
      by_name: Object.fromEntries(startupADP.map(p=>[p.name, p]))
    },
    rookie: {
      drafts_sampled: Math.min([...rookieDraftIds].length, TARGET_ROOKIE),
      total_players: rookieADP.length,
      players: rookieADP,
      by_name: Object.fromEntries(rookieADP.map(p=>[p.name, p]))
    }
  };

  fs.mkdirSync('public/data', { recursive: true });
  fs.writeFileSync('public/data/startup-adp.json', JSON.stringify(output));
  const kb = (fs.statSync('public/data/startup-adp.json').size/1024).toFixed(0);
  console.log(`\n✓ startup-adp.json: ${kb}KB`);

  console.log('\nTop 15 Startup ADP:');
  for(const p of startupADP.slice(0,15)) {
    console.log(`  ${p.adp_slot} ${p.name}(${p.pos}) ADP:${p.adp_12team} n=${p.draft_count}`);
  }
  console.log('\nTop 15 Rookie ADP:');
  for(const p of rookieADP.slice(0,15)) {
    console.log(`  ${p.adp_slot} ${p.name}(${p.pos}) ADP:${p.adp_12team} n=${p.draft_count}`);
  }
}

buildADP().catch(e => { console.error('FATAL:', e); process.exit(1); });
