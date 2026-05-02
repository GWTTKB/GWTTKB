// ── GWTTKB NFL Stats Builder ──
// Pulls NFLverse season + weekly stats, NGS, PFR advanced metrics
// Preserves weekly data for correlation analysis
// Writes: public/data/nfl-stats.json

import fs from 'fs';

const BASE = 'https://github.com/nflverse/nflverse-data/releases/download';
const SKILL = new Set(['QB','RB','WR','TE']);
const YEARS = [2020,2021,2022,2023,2024,2025];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function num(v){ const n=parseFloat(v); return isNaN(n)?0:Math.round(n); }
function dec(v){ const n=parseFloat(v); return isNaN(n)?0:Math.round(n*100)/100; }
function pct(v){ const n=parseFloat(v); return isNaN(n)?0:Math.round(n*1000)/10; }

function parseCSV(text){
  const lines=text.split('\n').filter(l=>l.trim());
  if(!lines.length)return [];
  const headers=lines[0].split(',').map(h=>h.replace(/"/g,'').trim());
  return lines.slice(1).map(line=>{
    const cols=[]; let cur='',inQ=false;
    for(const c of line){
      if(c==='"'){inQ=!inQ;}
      else if(c===','&&!inQ){cols.push(cur);cur='';}
      else cur+=c;
    }
    cols.push(cur);
    const row={};
    headers.forEach((h,i)=>row[h]=(cols[i]||'').replace(/"/g,'').trim());
    return row;
  });
}

async function fetchCSV(url){
  const r=await fetch(url,{headers:{'User-Agent':'GWTTKB/1.0'},redirect:'follow'});
  if(!r.ok)throw new Error(`HTTP ${r.status}: ${url}`);
  return parseCSV(await r.text());
}

async function tryFetch(urls){
  for(const url of urls){
    try{ return await fetchCSV(url); }
    catch(e){ 
      if(url===urls[urls.length-1]) console.warn(`  tryFetch error: ${e.message?.slice(0,80)}`);
      continue; 
    }
  }
  return null;
}

async function buildStats(){
  console.log('=== Building NFL Stats (Season + Weekly) ===');
  fs.mkdirSync('public/data',{recursive:true});

  // players[pid] = {
  //   name, pos, seasons: {2025: {season_totals:{...}, weeks:[{week,stats},...]}},
  //   career: {computed from all seasons}
  // }
  const players = {};

  const getPlayer = (pid, name, pos) => {
    if(!players[pid]) players[pid] = {
      player_id: pid, name, pos,
      seasons: {}, career: {}
    };
    if(name && !players[pid].name) players[pid].name = name;
    return players[pid];
  };

  const getSeason = (pid, yr) => {
    if(!players[pid]) return null;
    if(!players[pid].seasons[yr]) players[pid].seasons[yr] = {
      season: yr, team: '', games: 0,
      totals: {}, weeks: []
    };
    return players[pid].seasons[yr];
  };

  // ── SEASON TOTALS ──
  console.log('\n[1] Season totals...');
  for(const yr of YEARS){
    const rows = await tryFetch([
      `${BASE}/player_stats/player_stats_${yr}.csv`,
      `${BASE}/stats_player/stats_player_week_${yr}.csv`,
    ]);
    if(!rows){ console.log(`  ✗ ${yr}: not found`); continue; }

    // If this is weekly data we need to aggregate it
    const isWeekly = rows[0]?.week !== undefined || rows[0]?.game_id !== undefined;
    
    if(isWeekly){
      // Aggregate weekly rows into season totals
      const seasonMap = {};
      for(const row of rows){
        const pid = row.player_id || row.gsis_id; if(!pid) continue;
        const pos = (row.position||row.fantasy_position||'').toUpperCase();
        if(!SKILL.has(pos)) continue;
        if(!seasonMap[pid]){
          seasonMap[pid] = {
            player_id:pid,
            player_name:row.player_display_name||row.player_name||'',
            pos, season:yr, team:row.recent_team||row.team||'',
            games:0, passing_yards:0, passing_tds:0, interceptions:0,
            completions:0, attempts:0, passing_epa:0,
            carries:0, rushing_yards:0, rushing_tds:0, rushing_epa:0,
            targets:0, receptions:0, receiving_yards:0, receiving_tds:0,
            receiving_epa:0, fantasy_points_ppr:0,
            target_share_sum:0, air_yards_share_sum:0, wopr_sum:0, week_count:0
          };
        }
        const s = seasonMap[pid];
        s.games++;
        s.passing_yards += num(row.passing_yards);
        s.passing_tds += num(row.passing_tds);
        s.interceptions += num(row.interceptions);
        s.completions += num(row.completions);
        s.attempts += num(row.attempts);
        s.passing_epa += dec(row.passing_epa);
        s.carries += num(row.carries);
        s.rushing_yards += num(row.rushing_yards);
        s.rushing_tds += num(row.rushing_tds);
        s.rushing_epa += dec(row.rushing_epa);
        s.targets += num(row.targets);
        s.receptions += num(row.receptions);
        s.receiving_yards += num(row.receiving_yards);
        s.receiving_tds += num(row.receiving_tds);
        s.receiving_epa += dec(row.receiving_epa);
        s.fantasy_points_ppr += dec(row.fantasy_points_ppr);
        if(parseFloat(row.target_share)>0){
          s.target_share_sum += parseFloat(row.target_share);
          s.air_yards_share_sum += parseFloat(row.air_yards_share||0);
          s.wopr_sum += parseFloat(row.wopr||0);
          s.week_count++;
        }
      }
      // Store aggregated season totals
      for(const [pid, s] of Object.entries(seasonMap)){
        const p = getPlayer(pid, s.player_name, s.pos);
        const season = getSeason(pid, yr);
        season.team = s.team;
        season.games = s.games;
        season.totals = {
          passing_yards:s.passing_yards, passing_tds:s.passing_tds,
          interceptions:s.interceptions, completions:s.completions,
          attempts:s.attempts, passing_epa:dec(s.passing_epa),
          carries:s.carries, rushing_yards:s.rushing_yards,
          rushing_tds:s.rushing_tds, rushing_epa:dec(s.rushing_epa),
          targets:s.targets, receptions:s.receptions,
          receiving_yards:s.receiving_yards, receiving_tds:s.receiving_tds,
          receiving_epa:dec(s.receiving_epa),
          fantasy_points_ppr:dec(s.fantasy_points_ppr),
          fantasy_ppg:s.games>0?dec(s.fantasy_points_ppr/s.games):0,
          target_share:s.week_count>0?pct(s.target_share_sum/s.week_count):0,
          air_yards_share:s.week_count>0?pct(s.air_yards_share_sum/s.week_count):0,
          wopr:s.week_count>0?dec(s.wopr_sum/s.week_count):0,
        };
      }
    } else {
      // Season-level data
      for(const row of rows){
        const pid = row.player_id||row.gsis_id; if(!pid) continue;
        const pos = (row.position||row.fantasy_position||'').toUpperCase();
        if(!SKILL.has(pos)) continue;
        const p = getPlayer(pid, row.player_display_name||row.player_name||'', pos);
        const season = getSeason(pid, yr);
        season.team = row.recent_team||row.team||'';
        season.games = num(row.games);
        season.totals = {
          passing_yards:num(row.passing_yards), passing_tds:num(row.passing_tds),
          interceptions:num(row.interceptions), completions:num(row.completions),
          attempts:num(row.attempts), passing_epa:dec(row.passing_epa),
          carries:num(row.carries), rushing_yards:num(row.rushing_yards),
          rushing_tds:num(row.rushing_tds), rushing_epa:dec(row.rushing_epa),
          targets:num(row.targets), receptions:num(row.receptions),
          receiving_yards:num(row.receiving_yards), receiving_tds:num(row.receiving_tds),
          receiving_epa:dec(row.receiving_epa),
          fantasy_points_ppr:dec(row.fantasy_points_ppr),
          fantasy_ppg:num(row.games)>0?dec(parseFloat(row.fantasy_points_ppr)/num(row.games)):0,
          target_share:pct(row.target_share),
          air_yards_share:pct(row.air_yards_share),
          wopr:dec(row.wopr), racr:dec(row.racr),
        };
      }
    }
    console.log(`  ✓ ${yr}: ${Object.keys(players).length} players`);
    await sleep(300);
  }

  // ── WEEKLY DATA ──
  console.log('\n[2] Weekly data...');
  for(const yr of YEARS){
    const rows = await tryFetch([
      `${BASE}/stats_player/stats_player_week_${yr}.csv`,
      `${BASE}/player_stats/player_stats_${yr}.csv`,
    ]);
    if(!rows){ console.log(`  ✗ ${yr} weekly: not found`); continue; }

    // Check if this is actually weekly (has week column)
    const hasWeek = rows.length > 0 && (rows[0].week !== undefined || rows[0].season_type !== undefined);
    if(!hasWeek){ console.log(`  ~ ${yr}: no week column, skipping weekly`); continue; }

    let weekCount = 0;
    for(const row of rows){
      const pid = row.player_id||row.gsis_id; if(!pid) continue;
      if(!players[pid]) continue; // only players we already have season data for
      const week = parseInt(row.week||0); if(!week) continue;
      const seasonType = row.season_type||'REG';
      if(seasonType !== 'REG') continue; // regular season only

      const season = getSeason(pid, yr);
      if(!season) continue;

      season.weeks.push({
        week,
        team: row.recent_team||row.team||'',
        // Passing
        passing_yards: num(row.passing_yards),
        passing_tds: num(row.passing_tds),
        interceptions: num(row.interceptions),
        attempts: num(row.attempts),
        completions: num(row.completions),
        passing_epa: dec(row.passing_epa),
        completion_pct: row.attempts>0?dec(num(row.completions)/num(row.attempts)*100):0,
        yards_per_attempt: row.attempts>0?dec(num(row.passing_yards)/num(row.attempts)):0,
        sacks: num(row.sacks),
        sack_yards: num(row.sack_yards),
        // Rushing
        carries: num(row.carries),
        rushing_yards: num(row.rushing_yards),
        rushing_tds: num(row.rushing_tds),
        rushing_epa: dec(row.rushing_epa),
        rushing_yards_per_carry: row.carries>0?dec(num(row.rushing_yards)/num(row.carries)):0,
        // Receiving
        targets: num(row.targets),
        receptions: num(row.receptions),
        receiving_yards: num(row.receiving_yards),
        receiving_tds: num(row.receiving_tds),
        receiving_epa: dec(row.receiving_epa),
        target_share: pct(row.target_share),
        air_yards_share: pct(row.air_yards_share),
        wopr: dec(row.wopr),
        racr: dec(row.racr),
        yards_per_reception: row.receptions>0?dec(num(row.receiving_yards)/num(row.receptions)):0,
        yards_per_target: row.targets>0?dec(num(row.receiving_yards)/num(row.targets)):0,
        catch_rate: row.targets>0?dec(num(row.receptions)/num(row.targets)*100):0,
        // Fantasy
        fantasy_points_ppr: dec(row.fantasy_points_ppr),
        fantasy_points_half_ppr: dec(row.fantasy_points_half_ppr||row.fantasy_points),
        // Special teams / misc
        special_teams_tds: num(row.special_teams_tds),
      });
      weekCount++;
    }
    // Sort weeks
    for(const p of Object.values(players)){
      if(p.seasons[yr]?.weeks){
        p.seasons[yr].weeks.sort((a,b)=>a.week-b.week);
      }
    }
    console.log(`  ✓ ${yr}: ${weekCount} weekly rows stored`);
    await sleep(300);
  }

  // ── NGS STATS (season level) ──
  // Fetched via our own Vercel API which handles NFLverse URL routing
  const VERCEL_API = process.env.VERCEL_URL 
    ? `https://${process.env.VERCEL_URL}/api/stats`
    : 'https://gwttkb.vercel.app/api/stats';
  console.log('\n[3] NGS advanced stats (via Vercel API)...');
  for(const yr of YEARS){
    for(const [statType, posGroup] of [['passing','QB'],['rushing','RB'],['receiving','WR_TE']]){
      const apiUrl = `${VERCEL_API}?file=ngs_${statType.replace('receiving','rec').replace('passing','pass').replace('rushing','rush')}&season=${yr}`;
      let rows = null;
      try{
        const r = await fetch(apiUrl, {headers:{'User-Agent':'GWTTKB/1.0'}});
        if(r.ok){
          const data = await r.json();
          rows = data.rows || [];
        } else {
          console.warn(`  ✗ NGS ${yr} ${statType}: API returned ${r.status}`);
          continue;
        }
      }catch(e){
        console.warn(`  ✗ NGS ${yr} ${statType}: ${e.message?.slice(0,60)}`);
        continue;
      }
      if(!rows?.length){console.log(`  - NGS ${yr} ${statType}: 0 rows`);continue;}
      let matched = 0;
      for(const row of rows){
        const pid = row.player_gsis_id||row.player_id; if(!pid) continue;
        if(!players[pid]?.seasons[yr]) continue;
        const t = players[pid].seasons[yr].totals;
        if(statType==='passing'){
          t.avg_time_to_throw = dec(row.avg_time_to_throw);
          t.avg_intended_air_yards = dec(row.avg_intended_air_yards);
          t.avg_completed_air_yards = dec(row.avg_completed_air_yards);
          t.completion_pct_above_expectation = dec(row.completion_pct_above_expectation);
          t.passer_rating = dec(row.passer_rating);
        } else if(statType==='rushing'){
          t.avg_rush_yards_over_expected = dec(row.avg_rush_yards_over_expected);
          t.avg_rush_yards_over_expected_pct = pct(row.avg_rush_yards_over_expected_per_att);
          t.efficiency = dec(row.efficiency);
          t.percent_attempts_gte_eight_defenders = pct(row.percent_attempts_gte_eight_defenders);
        } else {
          t.avg_separation = dec(row.avg_separation);
          t.avg_cushion = dec(row.avg_cushion);
          t.avg_yac_above_expectation = dec(row.avg_yac_above_expectation);
          t.percent_share_of_intended_air_yards = pct(row.percent_share_of_intended_air_yards);
        }
        matched++;
      }
      console.log(`  ✓ NGS ${yr} ${statType}: ${matched} matched`);
      await sleep(200);
    }
  }

  // ── PFR ADVANCED STATS (season level) ──
  console.log('\n[4] PFR advanced stats (via Vercel API)...');
  for(const yr of YEARS){
    for(const statType of ['pass','rush','rec']){
      const apiUrl = `${VERCEL_API}?file=pfr_${statType}&season=${yr}`;
      let rows = null;
      try{
        const r = await fetch(apiUrl, {headers:{'User-Agent':'GWTTKB/1.0'}});
        if(r.ok){
          const data = await r.json();
          rows = data.rows || [];
        } else {
          console.warn(`  ✗ PFR ${yr} ${statType}: API returned ${r.status}`);
          continue;
        }
      }catch(e){
        console.warn(`  ✗ PFR ${yr} ${statType}: ${e.message?.slice(0,60)}`);
        continue;
      }
      if(!rows?.length){console.log(`  - PFR ${yr} ${statType}: 0 rows`);continue;}
      let matched = 0;
      for(const row of rows){
        // PFR uses pfr_id, not gsis_id — match by player name
        const name = (row.player||row.player_display_name||row.player_name||'').toLowerCase().replace(/[^a-z]/g,'');
        if(!name) continue;
        const p = Object.values(players).find(pl=>pl.name?.toLowerCase().replace(/[^a-z]/g,'') === name);
        if(!p?.seasons[yr]) continue;
        const t = p.seasons[yr].totals;
        if(statType==='pass'){
          t.pfr_passing_drops = num(row.drops); t.pfr_bad_throws = num(row.bad_throws);
          t.pfr_blitzed_pct = pct(row.blitz); t.pfr_sacked = num(row.times_sacked);
        } else if(statType==='rush'){
          t.pfr_broke_tackles = num(row.broke_tackles); t.pfr_yco_contact = dec(row.yards_after_contact);
          t.pfr_avoided_tackles = num(row.avoided_tackles);
        } else {
          t.pfr_drops = num(row.drops); t.pfr_drop_pct = pct(row.drop_pct);
          t.pfr_int_tgt = num(row.interceptions); t.pfr_yac = num(row.yards_after_catch);
          t.pfr_broke_tackles = num(row.broken_tackles);
          t.pfr_contested_tgts = num(row.contested_targets);
          t.pfr_contested_catch_pct = pct(row.contested_catch_pct);
        }
        matched++;
      }
      console.log(`  ✓ PFR ${yr} ${statType}: ${matched} matched`);
      await sleep(200);
    }
  }

  // ── COMPUTE CAREER TRENDS ──
  console.log('\n[5] Computing career trends...');
  for(const p of Object.values(players)){
    const yrs = Object.keys(p.seasons).map(Number).sort();
    if(yrs.length < 2) continue;
    const pos = p.pos;
    
    // Key metric by position for trend
    const getMetric = (season) => {
      const t = season?.totals||{};
      if(pos==='QB') return t.passing_yards||0;
      if(pos==='RB') return t.fantasy_ppg||0;
      if(pos==='WR'||pos==='TE') return t.target_share||0;
      return 0;
    };

    const metricsByYear = yrs.map(yr=>({yr, val:getMetric(p.seasons[yr])}));
    const recent = metricsByYear.slice(-2);
    if(recent.length>=2 && recent[0].val>0){
      p.career.trend_pct = Math.round((recent[1].val-recent[0].val)/recent[0].val*1000)/10;
      p.career.trend_dir = p.career.trend_pct>5?'rising':p.career.trend_pct<-5?'falling':'stable';
    }
    p.career.seasons_played = yrs.length;
    p.career.years = yrs;
  }

  // ── OUTPUT ──
  const skillPlayers = Object.values(players).filter(p=>SKILL.has(p.pos)&&p.name);
  const output = {
    generated: new Date().toISOString(),
    source: 'NFLverse (season totals + weekly splits + NGS + PFR)',
    seasons_covered: YEARS,
    total_players: skillPlayers.length,
    players: Object.fromEntries(skillPlayers.map(p=>[p.player_id, p]))
  };

  fs.writeFileSync('public/data/nfl-stats.json', JSON.stringify(output));
  const mb = (fs.statSync('public/data/nfl-stats.json').size/1024/1024).toFixed(1);
  console.log(`\n✓ nfl-stats.json: ${skillPlayers.length} players, ${mb}MB`);

  // Sample output
  const sampleWR = skillPlayers.find(p=>p.pos==='WR'&&p.seasons[2025]?.weeks?.length>5);
  if(sampleWR){
    console.log(`\nSample WR: ${sampleWR.name}`);
    console.log(`  2025 totals: targets=${sampleWR.seasons[2025].totals.targets} target_share=${sampleWR.seasons[2025].totals.target_share}%`);
    console.log(`  Weekly weeks: ${sampleWR.seasons[2025].weeks.length}`);
    console.log(`  Week 1: targets=${sampleWR.seasons[2025].weeks[0]?.targets} ts=${sampleWR.seasons[2025].weeks[0]?.target_share}%`);
    console.log(`  Trend: ${sampleWR.career.trend_dir} (${sampleWR.career.trend_pct}%)`);
  }
}

buildStats().catch(e=>{ console.error('FATAL:',e); process.exit(1); });
