// ── GWTTKB Rookie Draft ADP Builder ──
// Runs nightly via GitHub Actions
// Pulls live Sleeper rookie drafts, computes ADP for 2026 class
// Writes: public/data/rookie-adp.json

import fs from 'fs';

const SLEEPER = 'https://api.sleeper.app/v1';
const SEED_USER = '605943364277321728'; // trout9/lelandh
const TARGET_DRAFTS = 200;
const CURRENT_YEAR = 2026;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, retries=3) {
  for(let i=0; i<retries; i++){
    try{
      const r = await fetch(url, { headers: {'User-Agent':'GWTTKB/1.0'} });
      if(r.ok) return r.json();
      if(r.status===429){ await sleep(3000*(i+1)); continue; }
      return null;
    }catch{ await sleep(500); }
  }
  return null;
}

async function buildRookieADP() {
  console.log('=== Building 2026 Rookie Draft ADP ===');
  console.log(`Target: ${TARGET_DRAFTS} completed rookie drafts`);

  // ── STEP 1: Find completed 2026 rookie drafts ──
  const draftIds = new Set();
  const leaguesSeen = new Set();
  const usersSeen = new Set();
  const usersToVisit = [SEED_USER];

  while(usersToVisit.length > 0 && draftIds.size < TARGET_DRAFTS * 2){
    const userId = usersToVisit.shift();
    if(usersSeen.has(userId)) continue;
    usersSeen.add(userId);

    const leagues = await get(`${SLEEPER}/user/${userId}/leagues/nfl/${CURRENT_YEAR}`);
    if(!Array.isArray(leagues)) continue;

    for(const league of leagues){
      if(leaguesSeen.has(league.league_id)) continue;
      if(league.settings?.type !== 2) continue; // dynasty only
      leaguesSeen.add(league.league_id);

      const drafts = await get(`${SLEEPER}/league/${league.league_id}/drafts`);
      if(!Array.isArray(drafts)) continue;

      for(const d of drafts){
        // Rookie drafts: 4-6 rounds, not startup (startup = 20+ rounds)
        if(
          parseInt(d.season||0) === CURRENT_YEAR &&
          (d.settings?.rounds||0) >= 3 &&
          (d.settings?.rounds||0) <= 7 &&
          (d.status === 'complete' || d.status === 'in_progress')
        ){
          draftIds.add(d.draft_id);
        }
      }

      // Fan out
      if(draftIds.size < TARGET_DRAFTS){
        const users = await get(`${SLEEPER}/league/${league.league_id}/users`);
        if(Array.isArray(users)){
          for(const u of users){
            if(!usersSeen.has(u.user_id)) usersToVisit.push(u.user_id);
          }
        }
      }
      await sleep(80);
    }
  }

  console.log(`Found ${draftIds.size} rookie drafts`);

  // ── STEP 2: Pull picks from each draft ──
  const playerPicks = {}; // player_id → {name, pos, picks:[pick_no,...], teams}
  const playerMap = await get(`${SLEEPER}/players/nfl`);
  let processed = 0;

  for(const draftId of [...draftIds].slice(0, TARGET_DRAFTS)){
    try{
      const picks = await get(`${SLEEPER}/draft/${draftId}/picks`);
      if(!Array.isArray(picks) || picks.length < 5) continue;

      const teams = picks.reduce((max, p) => Math.max(max, p.draft_slot||0), 0);

      for(const pick of picks){
        if(!pick.player_id || !pick.pick_no) continue;

        const pid = pick.player_id;
        const pInfo = playerMap?.[pid];
        const name = pInfo?.full_name ||
          (pick.metadata?.first_name && pick.metadata?.last_name
            ? pick.metadata.first_name + ' ' + pick.metadata.last_name
            : null);
        const pos = pInfo?.position || pick.metadata?.position || '?';

        if(!name || !['QB','RB','WR','TE'].includes(pos)) continue;

        // Only track 2026 class — exclude known 2025/earlier players
        // If player has years_exp > 0 or was drafted before 2026, skip
        const yearsExp = pInfo?.years_exp ?? null;
        if(yearsExp !== null && yearsExp > 0) continue; // already a veteran

        if(!playerPicks[pid]){
          playerPicks[pid] = { pid, name, pos, picks:[], teams:[] };
        }
        playerPicks[pid].picks.push(pick.pick_no);
        playerPicks[pid].teams.push(teams||10);
      }

      processed++;
      if(processed % 25 === 0) console.log(`  Processed ${processed} drafts, ${Object.keys(playerPicks).length} players tracked`);
      await sleep(60);
    }catch(e){
      console.warn(`Draft ${draftId} error:`, e.message);
    }
  }

  console.log(`Processed ${processed} drafts`);

  // ── STEP 3: Compute ADP ──
  const adpResults = Object.values(playerPicks)
    .filter(p => p.picks.length >= 3) // need at least 3 appearances
    .map(p => {
      const avgPick = p.picks.reduce((a,b)=>a+b,0) / p.picks.length;
      const avgTeams = p.teams.reduce((a,b)=>a+b,0) / p.teams.length;
      // Normalize to 10-team league equivalent
      const normalizedAdp = avgPick * (10 / avgTeams);
      
      // Compute round/pick from normalized ADP
      const round = Math.ceil(normalizedAdp / 10);
      const pickInRound = Math.round(normalizedAdp % 10) || 10;
      
      return {
        pid: p.pid,
        name: p.name,
        pos: p.pos,
        adp: Math.round(avgPick * 10) / 10,
        adp_normalized: Math.round(normalizedAdp * 10) / 10,
        adp_slot: `${round}.${String(pickInRound).padStart(2,'0')}`,
        draft_count: p.picks.length,
        min_pick: Math.min(...p.picks),
        max_pick: Math.max(...p.picks),
        pct_round1: Math.round(p.picks.filter(pk=>pk<=avgTeams).length / p.picks.length * 100)
      };
    })
    .sort((a, b) => a.adp_normalized - b.adp_normalized);

  // ── STEP 4: Position rankings ──
  const byPos = { QB:[], RB:[], WR:[], TE:[] };
  for(const p of adpResults){
    if(byPos[p.pos]) byPos[p.pos].push(p);
  }

  const output = {
    generated: new Date().toISOString(),
    source: `${processed} completed Sleeper 2026 dynasty rookie drafts`,
    draft_class: CURRENT_YEAR,
    total_players: adpResults.length,
    overall: adpResults,
    by_position: byPos,
    // Quick lookup by name
    by_name: Object.fromEntries(adpResults.map(p => [p.name, p]))
  };

  fs.mkdirSync('public/data', { recursive: true });
  fs.writeFileSync('public/data/rookie-adp.json', JSON.stringify(output));

  const kb = (fs.statSync('public/data/rookie-adp.json').size / 1024).toFixed(0);
  console.log(`\n✓ rookie-adp.json: ${adpResults.length} players, ${processed} drafts, ${kb}KB`);
  console.log('\nTop 15 ADP:');
  for(const p of adpResults.slice(0,15)){
    console.log(`  ${p.adp_slot} ${p.name} (${p.pos}) ADP:${p.adp_normalized} n=${p.draft_count}`);
  }
}

buildRookieADP().catch(e => { console.error('FATAL:', e); process.exit(1); });
