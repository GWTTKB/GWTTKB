// ── GWTTKB Analytics Engine ──
// Cross-references weekly stats with daily dynasty values
// Computes real correlations — no assumptions, data speaks
// Writes: public/data/analytics.json

import fs from 'fs';

const POSITIONS = ['QB','RB','WR','TE'];
const POSITIONS_STATS = {
  QB: ['passing_yards','passing_tds','interceptions','attempts','completions',
       'passing_epa','rushing_yards','carries','fantasy_points_ppr',
       'completion_pct_above_expectation','avg_time_to_throw','passer_rating'],
  RB: ['carries','rushing_yards','rushing_tds','rushing_epa','targets',
       'receptions','receiving_yards','receiving_tds','fantasy_points_ppr',
       'target_share','wopr','avg_rush_yards_over_expected',
       'pfr_broke_tackles','pfr_yco_contact'],
  WR: ['targets','receptions','receiving_yards','receiving_tds','target_share',
       'air_yards_share','wopr','racr','receiving_epa','fantasy_points_ppr',
       'avg_separation','avg_cushion','avg_yac_above_expectation',
       'pfr_contested_catch_pct','pfr_yac','pfr_broke_tackles'],
  TE: ['targets','receptions','receiving_yards','receiving_tds','target_share',
       'air_yards_share','wopr','racr','receiving_epa','fantasy_points_ppr',
       'avg_separation','pfr_contested_catch_pct','pfr_yac'],
};

// Pearson correlation coefficient
function pearson(xs, ys){
  const n = xs.length;
  if(n < 5) return null;
  const mx = xs.reduce((a,b)=>a+b)/n;
  const my = ys.reduce((a,b)=>a+b)/n;
  let num=0, dx2=0, dy2=0;
  for(let i=0;i<n;i++){
    const dx=xs[i]-mx, dy=ys[i]-my;
    num+=dx*dy; dx2+=dx*dx; dy2+=dy*dy;
  }
  const denom=Math.sqrt(dx2*dy2);
  return denom===0?null:Math.round(num/denom*1000)/1000;
}

// Find date index in sorted dates array
function findDateIdx(dates, targetDate){
  const ts = new Date(targetDate).getTime();
  let lo=0, hi=dates.length-1;
  while(lo<=hi){
    const mid=(lo+hi)>>1;
    const d=new Date(dates[mid]).getTime();
    if(d===ts)return mid;
    if(d<ts)lo=mid+1; else hi=mid-1;
  }
  return lo < dates.length ? lo : dates.length-1;
}

// Get dynasty value at a specific date
function getValueAtDate(histPlayer, targetDate){
  if(!histPlayer?.dates?.length)return null;
  const idx = findDateIdx(histPlayer.dates, targetDate);
  return histPlayer.sf?.[idx]||null;
}

// Get dynasty value N days after a date
function getValueAfterDays(histPlayer, startDate, days){
  const target = new Date(startDate);
  target.setDate(target.getDate()+days);
  return getValueAtDate(histPlayer, target.toISOString().split('T')[0]);
}

// Map NFL week to approximate date
function weekToDate(season, week){
  // NFL season starts first Thursday of September
  const seasonStart = {
    2020:'2020-09-10', 2021:'2021-09-09', 2022:'2022-09-08',
    2023:'2023-09-07', 2024:'2024-09-05', 2025:'2025-09-04'
  };
  const start = new Date(seasonStart[season]||`${season}-09-05`);
  start.setDate(start.getDate() + (week-1)*7);
  return start.toISOString().split('T')[0];
}

function norm(s){ return (s||'').toLowerCase().replace(/[^a-z]/g,''); }

async function buildAnalytics(){
  console.log('=== Building Analytics Engine ===');
  fs.mkdirSync('public/data',{recursive:true});

  // Load stats
  console.log('\nLoading nfl-stats.json...');
  const statsRaw = JSON.parse(fs.readFileSync('public/data/nfl-stats.json','utf8'));
  const statsPlayers = Object.values(statsRaw.players||{});
  console.log(`  ${statsPlayers.length} players loaded`);

  // Load historical values
  console.log('Loading historical-players.json...');
  const histRaw = JSON.parse(fs.readFileSync('public/data/historical-players.json','utf8'));
  const histPlayers = histRaw.players||{};
  // Build name→hist lookup
  const histByName = {};
  for(const[name,data]of Object.entries(histPlayers)){
    histByName[norm(name)] = data;
  }
  console.log(`  ${Object.keys(histByName).length} historical players`);

  // ── CORRELATION ANALYSIS ──
  // For each stat category, for each position:
  // Collect (stat_value, value_change_N_days_later) pairs
  // Compute correlation coefficient

  const LAG_DAYS = [7, 14, 21, 30, 60];
  const correlations = {}; // pos → stat → lag → {r, n, interpretation}

  console.log('\nRunning correlations...');

  for(const pos of POSITIONS){
    correlations[pos] = {};
    const stats = POSITIONS_STATS[pos];

    // Collect all data points for this position
    // dataPoints[stat] = [{statVal, valueChanges:{7days:%, 14days:%,...}}]
    const dataPoints = {};
    for(const stat of stats) dataPoints[stat] = [];

    let playerCount = 0;

    for(const p of statsPlayers){
      if(p.pos !== pos) continue;
      const hist = histByName[norm(p.name)];
      if(!hist?.dates?.length) continue;

      playerCount++;

      // Go through each season's weekly data
      for(const [yr, seasonData] of Object.entries(p.seasons||{})){
        const weeks = seasonData.weeks||[];
        if(weeks.length < 4) continue;

        for(let wi=0; wi<weeks.length; wi++){
          const week = weeks[wi];
          const weekDate = weekToDate(parseInt(yr), week.week);
          const valueAtWeek = getValueAtDate(hist, weekDate);
          if(!valueAtWeek || valueAtWeek < 500) continue; // skip low-value players

          // Compute value changes at each lag
          const valueChanges = {};
          let hasAnyChange = false;
          for(const lag of LAG_DAYS){
            const futureVal = getValueAfterDays(hist, weekDate, lag);
            if(futureVal && valueAtWeek > 0){
              valueChanges[lag] = (futureVal - valueAtWeek) / valueAtWeek * 100;
              hasAnyChange = true;
            }
          }
          if(!hasAnyChange) continue;

          // For each stat, record (stat_value, value_changes)
          for(const stat of stats){
            const statVal = week[stat] ?? seasonData.totals?.[stat];
            if(statVal === undefined || statVal === null || isNaN(statVal)) continue;
            dataPoints[stat].push({statVal, valueChanges});
          }
        }
      }
    }

    console.log(`  ${pos}: ${playerCount} players, computing correlations...`);

    // Compute correlations for each stat × lag
    for(const stat of stats){
      correlations[pos][stat] = {};
      const pts = dataPoints[stat];
      if(pts.length < 10){ 
        for(const lag of LAG_DAYS) correlations[pos][stat][lag] = {r:null, n:pts.length};
        continue;
      }

      for(const lag of LAG_DAYS){
        const validPts = pts.filter(p=>p.valueChanges[lag]!==undefined);
        if(validPts.length < 5){
          correlations[pos][stat][lag] = {r:null, n:validPts.length};
          continue;
        }
        const xs = validPts.map(p=>p.statVal);
        const ys = validPts.map(p=>p.valueChanges[lag]);
        const r = pearson(xs, ys);
        correlations[pos][stat][lag] = {
          r, n: validPts.length,
          strength: !r?'no data':Math.abs(r)>0.5?'strong':Math.abs(r)>0.3?'moderate':Math.abs(r)>0.15?'weak':'negligible',
          direction: !r?'none':r>0?'positive':'negative'
        };
      }
    }

    // Rank stats by correlation at 30-day lag
    const ranked = stats
      .filter(s=>correlations[pos][s]?.[30]?.r!==null)
      .sort((a,b)=>Math.abs(correlations[pos][b]?.[30]?.r||0)-Math.abs(correlations[pos][a]?.[30]?.r||0));
    
    correlations[pos]._ranked_30day = ranked.slice(0,8);
    correlations[pos]._top_predictor = ranked[0]||null;
    
    console.log(`    Top predictor at 30d: ${ranked[0]} (r=${correlations[pos][ranked[0]]?.[30]?.r})`);
  }

  // ── PLAYER TRAJECTORIES ──
  // For every player compute their current momentum
  console.log('\nBuilding player trajectories...');
  const trajectories = {};

  for(const p of statsPlayers){
    const hist = histByName[norm(p.name)];
    if(!hist?.dates?.length||!hist?.sf?.length) continue;

    // Current value (most recent)
    const recentIdx = hist.sf.reduceRight((found,v,i)=>found===-1&&v>0?i:found,-1);
    if(recentIdx===-1) continue;
    const currentValue = hist.sf[recentIdx];
    const currentDate = hist.dates[recentIdx];

    // Value 30, 60, 90 days ago
    const v30 = getValueAfterDays(hist, currentDate, -30)||0;
    const v60 = getValueAfterDays(hist, currentDate, -60)||0;
    const v90 = getValueAfterDays(hist, currentDate, -90)||0;

    const change30 = v30>0?Math.round((currentValue-v30)/v30*1000)/10:null;
    const change60 = v60>0?Math.round((currentValue-v60)/v60*1000)/10:null;
    const change90 = v90>0?Math.round((currentValue-v90)/v90*1000)/10:null;

    // Get 2025 season stats
    const season2025 = p.seasons?.[2025];

    // Peak value ever
    const peakValue = Math.max(...(hist.sf||[]).filter(v=>v>0));
    const peakPct = peakValue>0?Math.round(currentValue/peakValue*1000)/10:null;

    trajectories[p.name] = {
      pid: p.player_id,
      pos: p.pos,
      currentValue,
      currentDate,
      momentum: {
        change_30d: change30,
        change_60d: change60,
        change_90d: change90,
        direction: change30===null?'unknown':change30>5?'rising':change30<-5?'falling':'stable'
      },
      peak: { value: peakValue, pct_of_peak: peakPct },
      season_2025: season2025 ? {
        games: season2025.games,
        team: season2025.team,
        ...season2025.totals
      } : null
    };
  }

  // ── HISTORICAL COMP ENGINE ──
  // For each player find their 3 closest historical comps based on stat profiles
  console.log('\nBuilding comp profiles...');
  const compProfiles = {};

  // Build stat vectors for all players with 2025 data
  const vectorPlayers = statsPlayers.filter(p=>p.seasons?.[2025]?.totals && POSITIONS.includes(p.pos));
  
  const getVector = (p, yr) => {
    const t = p.seasons?.[yr]?.totals||{};
    const pos = p.pos;
    const stats = POSITIONS_STATS[pos]||[];
    return stats.map(s=>parseFloat(t[s]||0));
  };

  // Euclidean distance between vectors (normalized)
  const distance = (v1, v2) => {
    if(v1.length !== v2.length) return Infinity;
    let sum=0;
    for(let i=0;i<v1.length;i++){
      const diff = v1[i]-v2[i];
      sum += diff*diff;
    }
    return Math.sqrt(sum);
  };

  // For each 2025 player find closest matches from 2020-2024
  const histVectors = {};
  for(const p of vectorPlayers){
    for(const yr of [2020,2021,2022,2023,2024]){
      if(!p.seasons?.[yr]?.totals) continue;
      const vec = getVector(p, yr);
      if(vec.every(v=>v===0)) continue;
      histVectors[`${p.player_id}_${yr}`] = {pid:p.player_id, name:p.name, pos:p.pos, yr, vec};
    }
  }

  for(const p of vectorPlayers){
    const vec2025 = getVector(p, 2025);
    if(vec2025.every(v=>v===0)) continue;

    // Find 3 closest historical seasons (excluding same player)
    const candidates = Object.values(histVectors)
      .filter(h=>h.pid!==p.player_id && h.pos===p.pos)
      .map(h=>({...h, dist:distance(vec2025, h.vec)}))
      .sort((a,b)=>a.dist-b.dist)
      .slice(0,3);

    if(!candidates.length) continue;

    // For each comp, what happened to their dynasty value the following year?
    const compOutcomes = candidates.map(c=>{
      const hist = histByName[norm(c.name)];
      const nextYrStart = `${c.yr+1}-03-01`;
      const nextYrEnd = `${c.yr+1}-11-01`;
      const valStart = getValueAtDate(hist, nextYrStart);
      const valEnd = getValueAtDate(hist, nextYrEnd);
      const pctChange = valStart&&valEnd?Math.round((valEnd-valStart)/valStart*1000)/10:null;
      return {
        name: c.name,
        season: c.yr,
        dist: Math.round(c.dist*100)/100,
        value_change_next_year: pctChange
      };
    });

    compProfiles[p.name] = {
      pos: p.pos,
      comps: compOutcomes,
      avg_comp_value_change: compOutcomes.filter(c=>c.value_change_next_year!==null).length>0
        ? Math.round(compOutcomes.filter(c=>c.value_change_next_year!==null)
            .reduce((s,c)=>s+c.value_change_next_year,0)/
            compOutcomes.filter(c=>c.value_change_next_year!==null).length*10)/10
        : null
    };
  }

  // ── OUTPUT ──
  const output = {
    generated: new Date().toISOString(),
    note: 'All correlations computed from actual data — no assumptions',
    correlations,
    trajectories,
    comp_profiles: compProfiles,
    // Summary: top predictors per position
    summary: Object.fromEntries(
      POSITIONS.map(pos=>[pos,{
        top_predictors: correlations[pos]?._ranked_30day||[],
        top_predictor: correlations[pos]?._top_predictor||null,
      }])
    )
  };

  fs.writeFileSync('public/data/analytics.json', JSON.stringify(output));
  const mb = (fs.statSync('public/data/analytics.json').size/1024/1024).toFixed(1);
  console.log(`\n✓ analytics.json: ${mb}MB`);
  console.log('\nTop predictors by position:');
  for(const pos of POSITIONS){
    const top = output.summary[pos].top_predictors.slice(0,3);
    console.log(`  ${pos}: ${top.join(', ')}`);
  }
  console.log(`\nComp profiles built: ${Object.keys(compProfiles).length}`);
  console.log(`Trajectories built: ${Object.keys(trajectories).length}`);
}

buildAnalytics().catch(e=>{ console.error('FATAL:',e); process.exit(1); });
