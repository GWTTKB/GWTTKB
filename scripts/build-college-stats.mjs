// ── GWTTKB College Stats + Draft Capital + Combine Builder ──
// Sources:
//   1. NFLverse draft_picks.csv — every pick rounds 1-7 since 2020 (PFR)
//   2. NFLverse combine.csv — 40 time, bench, vertical, broad jump, cone, shuttle
//   3. CFBD API — college stats by player/season + recruiting ratings
// Writes:
//   public/data/nfl-draft-history.json — complete accurate draft capital
//   public/data/college-stats.json — college production + combine + recruiting

import fs from 'fs';

const BASE = 'https://github.com/nflverse/nflverse-data/releases/download';
const CFBD = 'https://api.collegefootballdata.com';
const CFBD_KEY = process.env.CFBD_API_KEY;
const SKILL = new Set(['QB','RB','WR','TE']);
const DRAFT_YEARS = [2020,2021,2022,2023,2024,2025,2026];
const sleep = ms => new Promise(r => setTimeout(r, ms));

if(!CFBD_KEY){ console.error('CFBD_API_KEY not set'); process.exit(1); }

function parseCSV(text){
  const lines = text.split('\n').filter(l=>l.trim());
  if(!lines.length) return [];
  const headers = lines[0].split(',').map(h=>h.replace(/"/g,'').trim());
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

async function fetchNFL(url){
  const r = await fetch(url, {
    headers:{'User-Agent':'GWTTKB/1.0'},
    redirect:'follow'
  });
  if(!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  return parseCSV(await r.text());
}

async function fetchCFBD(path, params={}){
  const url = new URL(`${CFBD}${path}`);
  for(const[k,v]of Object.entries(params)) url.searchParams.set(k,v);
  const r = await fetch(url.toString(), {
    headers:{
      'Authorization': `Bearer ${CFBD_KEY}`,
      'Accept': 'application/json'
    }
  });
  if(!r.ok){
    if(r.status===429){ await sleep(2000); return null; }
    return null;
  }
  return r.json();
}

function norm(s){ return (s||'').toLowerCase().replace(/[^a-z]/g,''); }
function num(v){ const n=parseFloat(v); return isNaN(n)?null:Math.round(n*100)/100; }

async function build(){
  console.log('=== Building College Stats + Draft Capital + Combine ===');
  fs.mkdirSync('public/data',{recursive:true});

  // ── STEP 1: NFLverse Draft Picks (all rounds 1-7, 2020-2026) ──
  console.log('\n[1] Fetching NFLverse draft picks...');
  let allDraftRows = [];
  try{
    const rows = await fetchNFL(`${BASE}/draft_picks/draft_picks.csv`);
    allDraftRows = rows.filter(r=>{
      const yr = parseInt(r.season||r.draft_year||0);
      const round = parseInt(r.round||0);
      const pos = (r.position||r.pos||'').toUpperCase();
      return yr >= 2020 && round >= 1 && round <= 4 && SKILL.has(pos);
    });
    console.log(`  ✓ ${allDraftRows.length} skill player picks (rounds 1-7, 2020-2026)`);
  }catch(e){
    console.error('  ✗ Draft picks failed:', e.message);
  }

  // Build draft capital map: norm(name) → draft info
  const draftMap = {};
  const draftByYear = {};
  for(const row of allDraftRows){
    const yr = parseInt(row.season||row.draft_year);
    const name = row.pfr_player_name || row.player_name || row.full_name || '';
    if(!name) continue;
    const entry = {
      name,
      season: yr,
      round: parseInt(row.round),
      pick: parseInt(row.pick),
      overall: parseInt(row.pick_overall||row.pick||0),
      team: row.team||row.draft_team||'',
      pos: (row.position||row.pos||'').toUpperCase(),
      college: row.college||row.school||'',
      pfr_id: row.pfr_player_id||row.pfr_id||'',
      cfb_id: row.cfb_player_id||row.cfb_id||'',
      // Draft value context
      draft_tier: parseInt(row.round)===1?(parseInt(row.pick)<=10?'elite':parseInt(row.pick)<=20?'top_20':'late_1st')
        :parseInt(row.round)===2?'day2_early'
        :parseInt(row.round)===3?'day2_late'
        :'day3',
      // Career AV from PFR if available
      career_av: num(row.career_av||row.av||null),
      w_av: num(row.w_av||null),
      // Pro bowls
      pro_bowls: parseInt(row.pro_bowl||0)||0,
      // All pro
      all_pro: parseInt(row.all_pro||0)||0,
    };
    draftMap[norm(name)] = entry;
    if(!draftByYear[yr]) draftByYear[yr] = [];
    draftByYear[yr].push(entry);
  }

  // ── STEP 2: NFLverse Combine Data ──
  console.log('\n[2] Fetching NFLverse combine data...');
  const combineMap = {}; // norm(name) → combine data
  try{
    const rows = await fetchNFL(`${BASE}/combine/combine.csv`);
    let matched = 0;
    for(const row of rows){
      const yr = parseInt(row.season||row.draft_year||0);
      if(yr < 2020) continue;
      const pos = (row.pos||row.position||'').toUpperCase();
      if(!SKILL.has(pos)) continue;
      const name = row.player_name||row.player||'';
      if(!name) continue;
      const entry = {
        name,
        season: yr,
        pos,
        school: row.school||row.college||'',
        ht: row.ht||null, // height
        wt: num(row.wt),  // weight lbs
        forty: num(row.forty), // 40 yard dash
        bench: num(row.bench), // bench press reps
        vertical: num(row.vertical), // vertical jump inches
        broad_jump: num(row.broad_jump), // broad jump inches
        cone: num(row.cone), // 3 cone drill
        shuttle: num(row.shuttle), // 20 yard shuttle
        // Derived athleticism score (BMI-adjusted speed)
        speed_score: row.forty&&row.wt?Math.round((num(row.wt)*200)/(Math.pow(num(row.forty),4))*10)/10:null,
        burst_score: row.vertical&&row.broad_jump?Math.round((num(row.vertical)+num(row.broad_jump)*0.5)*10)/10:null,
      };
      combineMap[norm(name)] = entry;
      // Also add to draft map
      if(draftMap[norm(name)]){
        draftMap[norm(name)].combine = entry;
        matched++;
      }
    }
    console.log(`  ✓ ${Object.keys(combineMap).length} combine entries, ${matched} matched to draft picks`);
  }catch(e){
    console.warn('  ✗ Combine failed:', e.message);
  }

  // ── STEP 3: CFBD College Stats ──
  console.log('\n[3] Fetching college stats via CFBD API...');
  const collegeStats = {}; // norm(name) → {seasons:[...], career:{...}, recruiting:{}}

  // Get unique players to look up
  const playersToFetch = Object.values(draftMap).filter(p=>p.pos&&SKILL.has(p.pos));
  console.log(`  Fetching stats for ${playersToFetch.length} players...`);

  let fetched = 0;
  let failed = 0;

  // Process in batches of 5 in parallel
  const BATCH = 5;
  for(let bi=0; bi<playersToFetch.length; bi+=BATCH){
    const batch = playersToFetch.slice(bi, bi+BATCH);
    await Promise.all(batch.map(async player => {
    const nameNorm = norm(player.name);
    try{
      // Search for player in CFBD
      const searchRes = await fetchCFBD('/player/search', {
        searchTerm: player.name,
        position: player.pos === 'QB' ? 'QB' : player.pos === 'RB' ? 'RB' : player.pos === 'WR' ? 'WR' : 'TE',
      });
      if(!Array.isArray(searchRes)||!searchRes.length){
        failed++;
        
        return;
      }

      // Find best match
      const match = searchRes.find(p=>norm(p.name)===nameNorm||norm(p.name).includes(nameNorm.slice(0,8)))
        || searchRes[0];
      if(!match){ failed++; return; }

      // Fetch their stats for last 3 seasons before draft
      const draftYr = player.season;
      const seasons = [];
      for(const yr of [draftYr-1, draftYr-2].filter(y=>y>=2017)){
        const stats = await fetchCFBD('/stats/player/season', {
          year: yr,
          athleteId: match.id
        });
        if(Array.isArray(stats)&&stats.length){
          const seasonStats = { year: yr, team: match.team||'', stats:{} };
          for(const s of stats){
            const cat = s.category?.toLowerCase()||'';
            const type = s.statType?.toLowerCase()||'';
            const val = num(s.stat);
            if(val!==null) seasonStats.stats[`${cat}_${type}`] = val;
          }
          // Normalize to standard fields
          const st = seasonStats.stats;
          seasonStats.normalized = {
            // Passing
            pass_yards: st.passing_yds||st.passing_yards||null,
            pass_tds: st.passing_td||st.passing_tds||null,
            pass_attempts: st.passing_att||null,
            completions: st.passing_completions||null,
            interceptions: st.passing_int||null,
            completion_pct: st.passing_att&&st.passing_completions?
              Math.round(st.passing_completions/st.passing_att*1000)/10:null,
            // Rushing
            rush_yards: st.rushing_yds||st.rushing_yards||null,
            rush_tds: st.rushing_td||st.rushing_tds||null,
            rush_attempts: st.rushing_car||st.rushing_att||null,
            ypc: st.rushing_car&&st.rushing_yds?Math.round(st.rushing_yds/st.rushing_car*100)/100:null,
            // Receiving
            rec_yards: st.receiving_yds||st.receiving_yards||null,
            rec_tds: st.receiving_td||st.receiving_tds||null,
            receptions: st.receiving_rec||null,
            rec_ypr: st.receiving_rec&&st.receiving_yds?Math.round(st.receiving_yds/st.receiving_rec*100)/100:null,
          };
          seasons.push(seasonStats);
        }
        await sleep(80);
      }

      // Fetch recruiting info
      const recruiting = await fetchCFBD('/recruiting/players', {
        search: player.name,
        position: player.pos,
      });
      let recruitingData = null;
      if(Array.isArray(recruiting)&&recruiting.length){
        const rec = recruiting.find(r=>norm(r.name)===nameNorm)||recruiting[0];
        if(rec){
          recruitingData = {
            stars: rec.stars||null,
            rating: num(rec.rating),
            ranking: rec.ranking||null,
            position_ranking: rec.positionRanking||null,
            city: rec.city||'',
            state_province: rec.stateProvince||'',
            committed_to: rec.committedTo||'',
          };
        }
      }

      // Compute career college stats
      const career = { seasons_tracked: seasons.length };
      if(seasons.length > 0){
        // Final season (year before draft)
        const finalSeason = seasons[0];
        career.final_season = finalSeason.normalized;
        career.final_season_year = finalSeason.year;
        career.final_season_team = finalSeason.team;

        // Compute breakout age (first season with significant production)
        // Breakout = first season with 700+ rushing/receiving yards or 2000+ passing yards
        const breakoutSeason = [...seasons].reverse().find(s=>{
          const n = s.normalized;
          return (n.rush_yards&&n.rush_yards>=700)
            ||(n.rec_yards&&n.rec_yards>=700)
            ||(n.pass_yards&&n.pass_yards>=2000);
        });
        if(breakoutSeason){
          // Approximate age: draft year - (draft year - breakout year) gives college year
          const yearsBeforeDraft = draftYr - 1 - breakoutSeason.year;
          career.breakout_year = breakoutSeason.year;
          career.breakout_age_proxy = 21 - yearsBeforeDraft; // approx
          career.breakout_season = breakoutSeason.normalized;
        }

        // Multi-year trajectory (was production rising or falling?)
        if(seasons.length >= 2){
          const latest = seasons[0].normalized;
          const prev = seasons[1].normalized;
          const keyMetric = player.pos==='QB'?'pass_yards':
            player.pos==='RB'?'rush_yards':'rec_yards';
          const latestVal = latest[keyMetric]||0;
          const prevVal = prev[keyMetric]||0;
          if(prevVal > 0){
            career.production_trend_pct = Math.round((latestVal-prevVal)/prevVal*1000)/10;
            career.production_trend = career.production_trend_pct > 10 ? 'rising'
              : career.production_trend_pct < -10 ? 'falling' : 'stable';
          }
        }

        // Dominator rating proxy (final season yards vs average for position)
        const avgYards = player.pos==='QB'?3500:player.pos==='RB'?1000:800;
        const finalYards = player.pos==='QB'?career.final_season.pass_yards:
          player.pos==='RB'?career.final_season.rush_yards:career.final_season.rec_yards;
        if(finalYards){
          career.production_vs_avg_pct = Math.round(finalYards/avgYards*1000)/10;
          career.elite_producer = finalYards > avgYards * 1.3;
        }
      }

      collegeStats[nameNorm] = {
        name: player.name,
        pos: player.pos,
        cfbd_id: match.id,
        seasons,
        career,
        recruiting: recruitingData,
      };

      // Add to draft entry
      if(draftMap[nameNorm]){
        draftMap[nameNorm].college_stats = collegeStats[nameNorm].career;
        draftMap[nameNorm].college_seasons = seasons;
        draftMap[nameNorm].recruiting = recruitingData;
      }

      fetched++;
      if(fetched % 20 === 0) console.log(`    ${fetched}/${playersToFetch.length} fetched`);
    }catch(e){
      failed++;
    }
    })); // end batch
    await sleep(300); // rate limit between batches
    if(bi % 50 === 0) console.log(`  Batch ${bi}/${playersToFetch.length}...`);
  }

  console.log(`  ✓ ${fetched} players fetched, ${failed} failed/not found`);

  // ── OUTPUT 1: nfl-draft-history.json ──
  console.log('\n[4] Writing nfl-draft-history.json...');

  // Organize by year
  const draftHistory = { generated: new Date().toISOString(), drafts: {} };
  for(const yr of DRAFT_YEARS){
    const picks = draftByYear[yr]||[];
    draftHistory.drafts[yr] = {
      year: yr,
      total_skill_picks: picks.length,
      by_round: {},
      all_picks: picks.sort((a,b)=>a.overall-b.overall),
    };
    for(const p of picks){
      if(!draftHistory.drafts[yr].by_round[p.round]){
        draftHistory.drafts[yr].by_round[p.round] = [];
      }
      draftHistory.drafts[yr].by_round[p.round].push(p);
    }
  }

  fs.writeFileSync('public/data/nfl-draft-history.json', JSON.stringify(draftHistory));
  const draftKB = (fs.statSync('public/data/nfl-draft-history.json').size/1024).toFixed(0);
  console.log(`  ✓ nfl-draft-history.json: ${draftKB}KB`);

  // Print sample
  const picks2025 = draftHistory.drafts[2025]?.all_picks||[];
  console.log(`  2025 picks: ${picks2025.length}`);
  const henderson = picks2025.find(p=>p.name.includes('Henderson'));
  if(henderson) console.log(`  TreVeyon Henderson: Round ${henderson.round}, Pick ${henderson.pick}, Overall ${henderson.overall}, ${henderson.team}`);

  // ── OUTPUT 2: college-stats.json ──
  console.log('\n[5] Writing college-stats.json...');

  const collegeOutput = {
    generated: new Date().toISOString(),
    source: 'CFBD API (collegefootballdata.com) + NFLverse combine',
    total_players: Object.keys(collegeStats).length,
    by_draft_year: {},
    players: collegeStats,
    combine: combineMap,
  };

  // Organize by draft year
  for(const yr of DRAFT_YEARS){
    const yPicks = draftByYear[yr]||[];
    collegeOutput.by_draft_year[yr] = yPicks
      .filter(p=>collegeStats[norm(p.name)])
      .map(p=>({
        name: p.name,
        pos: p.pos,
        round: p.round,
        pick: p.pick,
        overall: p.overall,
        team: p.team,
        draft_tier: p.draft_tier,
        combine: combineMap[norm(p.name)]||null,
        college: collegeStats[norm(p.name)]?.career||null,
        recruiting: collegeStats[norm(p.name)]?.recruiting||null,
      }));
  }

  fs.writeFileSync('public/data/college-stats.json', JSON.stringify(collegeOutput));
  const collegeKB = (fs.statSync('public/data/college-stats.json').size/1024).toFixed(0);
  console.log(`  ✓ college-stats.json: ${collegeKB}KB, ${Object.keys(collegeStats).length} players`);

  // ── SUMMARY ──
  console.log('\n=== SUMMARY ===');
  for(const yr of DRAFT_YEARS){
    const picks = draftByYear[yr]||[];
    const withCollege = picks.filter(p=>collegeStats[norm(p.name)]);
    const withCombine = picks.filter(p=>combineMap[norm(p.name)]);
    console.log(`${yr}: ${picks.length} picks | ${withCollege.length} w/college stats | ${withCombine.length} w/combine`);
  }

  // Sample output for a notable player
  const testPlayer = Object.values(draftMap).find(p=>p.name.includes('Hampton')&&p.season===2025);
  if(testPlayer){
    console.log('\nSample — Omarion Hampton:');
    console.log(`  Draft: Round ${testPlayer.round}, Pick ${testPlayer.pick}, ${testPlayer.team}`);
    console.log(`  Tier: ${testPlayer.draft_tier}`);
    if(testPlayer.combine) console.log(`  Combine: 40=${testPlayer.combine.forty}, wt=${testPlayer.combine.wt}, vertical=${testPlayer.combine.vertical}`);
    if(testPlayer.college_stats?.final_season) console.log(`  Final college season: rush_yards=${testPlayer.college_stats.final_season.rush_yards}, ypc=${testPlayer.college_stats.final_season.ypc}`);
    if(testPlayer.recruiting) console.log(`  Recruiting: ${testPlayer.recruiting.stars}★, rating=${testPlayer.recruiting.rating}`);
  }
}

build().catch(e=>{ console.error('FATAL:',e); process.exit(1); });
