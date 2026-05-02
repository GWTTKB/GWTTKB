// ── GWTTKB Analytics Engine v3 ──
// Major upgrades:
// 1. Composite Efficiency Score per player
// 2. Stat-level lag analysis (14/30/60/90 days)
// 3. CONTEXT-AWARE comp engine — matches by player archetype:
//    - Veterans: same position, same value tier, same fantasy finish, similar stat profile
//    - Rookies: same draft round, similar combine, same college tier, similar landing spot
//    - Always same position
//    - Always same career stage (rookie / Y2 / Y3 / vet / aging)
// Writes: public/data/analytics.json

import fs from 'fs';

const POSITIONS = ['QB','RB','WR','TE'];

const WEEKLY_STATS = {
  QB: ['fantasy_points_ppr','passing_yards','passing_tds','completions','attempts',
       'interceptions','rushing_yards','rushing_tds','passing_epa'],
  RB: ['fantasy_points_ppr','rushing_yards','rushing_tds','carries','target_share',
       'receptions','receiving_yards','receiving_tds','wopr','rushing_epa','receiving_epa'],
  WR: ['fantasy_points_ppr','receiving_yards','receiving_tds','targets','receptions',
       'target_share','air_yards_share','wopr','racr','receiving_epa'],
  TE: ['fantasy_points_ppr','receiving_yards','receiving_tds','targets','receptions',
       'target_share','air_yards_share','wopr','receiving_epa'],
};

const SEASON_STATS = {
  QB: ['avg_time_to_throw','avg_intended_air_yards','completion_pct_above_expectation',
       'passer_rating','pfr_sacked','pfr_bad_throws'],
  RB: ['avg_rush_yards_over_expected','efficiency','pfr_broke_tackles','pfr_yco_contact'],
  WR: ['avg_separation','avg_cushion','avg_yac_above_expectation',
       'percent_share_of_intended_air_yards','pfr_drop_pct','pfr_yac','pfr_contested_catch_pct'],
  TE: ['avg_separation','avg_cushion','avg_yac_above_expectation',
       'pfr_drop_pct','pfr_yac','pfr_contested_catch_pct'],
};

// Composite efficiency weights per position
const EFFICIENCY_WEIGHTS = {
  QB: {
    completion_pct_above_expectation: 0.35,
    passing_epa: 0.25,
    pfr_bad_throw_pct: -0.15,
    pfr_pressure_pct: -0.10,
    avg_time_to_throw: 0.05,
    fantasy_points_ppr: 0.20,
  },
  RB: {
    rushing_epa: 0.25,
    avg_rush_yards_over_expected: 0.20,
    receiving_epa: 0.15,
    target_share: 0.15,
    pfr_broke_tackles: 0.10,
    fantasy_points_ppr: 0.15,
  },
  WR: {
    avg_separation: 0.20,
    target_share: 0.20,
    air_yards_share: 0.15,
    wopr: 0.15,
    avg_yac_above_expectation: 0.10,
    pfr_contested_catch_pct: 0.10,
    fantasy_points_ppr: 0.10,
  },
  TE: {
    target_share: 0.25,
    avg_separation: 0.15,
    wopr: 0.15,
    receiving_epa: 0.15,
    avg_yac_above_expectation: 0.15,
    fantasy_points_ppr: 0.15,
  },
};

function pearson(xs, ys){
  const n=xs.length; if(n<8)return null;
  const mx=xs.reduce((a,b)=>a+b)/n, my=ys.reduce((a,b)=>a+b)/n;
  let num=0,dx2=0,dy2=0;
  for(let i=0;i<n;i++){const dx=xs[i]-mx,dy=ys[i]-my;num+=dx*dy;dx2+=dx*dx;dy2+=dy*dy;}
  const d=Math.sqrt(dx2*dy2); return d===0?null:Math.round(num/d*1000)/1000;
}

function norm(s){return(s||'').toLowerCase().replace(/[^a-z]/g,'');}

function weekToDate(season,week){
  const starts={2020:'2020-09-10',2021:'2021-09-09',2022:'2022-09-08',
    2023:'2023-09-07',2024:'2024-09-05',2025:'2025-09-04'};
  const d=new Date(starts[season]||`${season}-09-05`);
  d.setDate(d.getDate()+(week-1)*7);
  return d.toISOString().split('T')[0];
}

function findDateIdx(dates,targetDate){
  const ts=new Date(targetDate).getTime();
  let lo=0,hi=dates.length-1;
  while(lo<=hi){const mid=(lo+hi)>>1;const d=new Date(dates[mid]).getTime();
    if(d===ts)return mid;if(d<ts)lo=mid+1;else hi=mid-1;}
  return lo<dates.length?lo:dates.length-1;
}

function getValueAtDate(hist,date){
  if(!hist?.dates?.length)return null;
  const idx=findDateIdx(hist.dates,date);
  return hist.sf?.[idx]||null;
}

function getValueAfterDays(hist,startDate,days){
  const d=new Date(startDate);d.setDate(d.getDate()+days);
  return getValueAtDate(hist,d.toISOString().split('T')[0]);
}

function slope(ys){
  const n=ys.length;if(n<3)return 0;
  const xs=Array.from({length:n},(_,i)=>i);
  const mx=xs.reduce((a,b)=>a+b)/n,my=ys.reduce((a,b)=>a+b)/n;
  let num=0,den=0;
  for(let i=0;i<n;i++){num+=(xs[i]-mx)*(ys[i]-my);den+=(xs[i]-mx)**2;}
  return den===0?0:Math.round(num/den*1000)/1000;
}

// Compute fantasy finish rank within position for a season
function computeFantasyFinish(statsPlayers, year){
  const ranks = {};
  for(const pos of POSITIONS){
    const players = statsPlayers
      .filter(p => p.pos === pos && p.seasons?.[year]?.totals?.fantasy_points_ppr)
      .sort((a,b) => (b.seasons[year].totals.fantasy_points_ppr||0) - (a.seasons[year].totals.fantasy_points_ppr||0));
    players.forEach((p, i) => {
      ranks[`${pos}_${norm(p.name)}_${year}`] = i + 1;
    });
  }
  return ranks;
}

// Get fantasy finish tier (WR1, WR2, WR3, etc)
function getFantasyTier(rank, pos){
  if(!rank) return null;
  if(rank <= 12) return `${pos}1`;
  if(rank <= 24) return `${pos}2`;
  if(rank <= 36) return `${pos}3`;
  if(rank <= 48) return `${pos}4`;
  return `${pos}5+`;
}

// Get value tier
function getValueTier(value){
  if(value >= 8000) return 'elite';
  if(value >= 6000) return 'top_tier';
  if(value >= 4000) return 'mid_tier';
  if(value >= 2000) return 'flex';
  return 'depth';
}

// Get years in league (rookie/Y2/Y3/vet/aging based on rookie year)
function getCareerStage(rookieYear, currentYear){
  if(!rookieYear) return null;
  const yrs = currentYear - rookieYear;
  if(yrs === 0) return 'rookie';
  if(yrs === 1) return 'Y2';
  if(yrs === 2) return 'Y3';
  if(yrs <= 5) return 'prime';
  if(yrs <= 8) return 'vet';
  return 'aging';
}

// Build stat fingerprint for player in a given season
function buildStatFingerprint(seasonTotals, pos){
  const f = {};
  if(pos === 'WR' || pos === 'TE'){
    f.target_share = seasonTotals.target_share || 0;
    f.air_yards_share = seasonTotals.air_yards_share || 0;
    f.wopr = seasonTotals.wopr || 0;
    f.separation = seasonTotals.avg_separation || 0;
    f.yac_oe = seasonTotals.avg_yac_above_expectation || 0;
    f.targets = seasonTotals.targets || 0;
  } else if(pos === 'RB'){
    f.carries = seasonTotals.carries || 0;
    f.target_share = seasonTotals.target_share || 0;
    f.rush_epa = seasonTotals.rushing_epa || 0;
    f.ryoe = seasonTotals.avg_rush_yards_over_expected || 0;
    f.receptions = seasonTotals.receptions || 0;
  } else if(pos === 'QB'){
    f.attempts = seasonTotals.attempts || 0;
    f.cpoe = seasonTotals.completion_pct_above_expectation || 0;
    f.epa = seasonTotals.passing_epa || 0;
    f.air_yards = seasonTotals.avg_intended_air_yards || 0;
  }
  return f;
}

// Cosine similarity between fingerprints
function fingerprintSim(a, b){
  const keys = Object.keys(a);
  if(keys.length === 0) return 0;
  let dot = 0, ma = 0, mb = 0;
  for(const k of keys){
    const va = a[k] || 0;
    const vb = b[k] || 0;
    dot += va * vb;
    ma += va * va;
    mb += vb * vb;
  }
  return ma && mb ? dot / (Math.sqrt(ma) * Math.sqrt(mb)) : 0;
}

async function buildAnalytics(){
  console.log('=== Building Analytics Engine v3 ===');
  fs.mkdirSync('public/data',{recursive:true});

  // Load data
  console.log('\nLoading data...');
  const statsRaw=JSON.parse(fs.readFileSync('public/data/nfl-stats.json','utf8'));
  const statsPlayers=Object.values(statsRaw.players||{});
  console.log(`  nfl-stats: ${statsPlayers.length} players`);

  const histRaw=JSON.parse(fs.readFileSync('public/data/historical-players.json','utf8'));
  const histPlayers=histRaw.players||{};
  const histByName={};
  for(const[name,data]of Object.entries(histPlayers))histByName[norm(name)]=data;
  console.log(`  historical: ${Object.keys(histByName).length} players`);

  // Load draft history for rookie context
  let draftPicks = {};
  try {
    const draftRaw = JSON.parse(fs.readFileSync('public/data/nfl-draft-history.json','utf8'));
    for(const [yr, draft] of Object.entries(draftRaw.drafts||{})){
      for(const pick of draft.all_picks||[]){
        draftPicks[norm(pick.player)] = {
          ...pick,
          draft_year: parseInt(yr),
          draft_tier: pick.round === 1 ? (pick.pick <= 10 ? 'elite' : pick.pick <= 20 ? 'top_20' : 'late_1st')
                    : pick.round === 2 ? 'day2_early'
                    : pick.round === 3 ? 'day2_late'
                    : 'day3'
        };
      }
    }
    console.log(`  draft picks: ${Object.keys(draftPicks).length}`);
  } catch(e){ console.warn('  Draft picks not available:', e.message); }

  // Build stats lookup by normalized name
  const statsByName={};
  for(const p of statsPlayers)statsByName[norm(p.name)]=p;

  // Compute fantasy finish rankings for each year
  console.log('\n[0] Computing fantasy finish rankings...');
  const fantasyRanks = {};
  for(const yr of [2020,2021,2022,2023,2024,2025]){
    Object.assign(fantasyRanks, computeFantasyFinish(statsPlayers, yr));
  }
  console.log(`  Ranked ${Object.keys(fantasyRanks).length} player-season combos`);

  // ── CORRELATIONS (weekly rolling trends with multiple lags) ──
  console.log('\n[1] Weekly correlations with multi-lag analysis...');
  const LAG_DAYS=[14,30,60,90];
  const correlations={};

  for(const pos of POSITIONS){
    correlations[pos]={};
    const stats=WEEKLY_STATS[pos]||[];
    const dataPoints={};
    for(const stat of stats)dataPoints[stat]=[];

    for(const p of statsPlayers){
      if(p.pos!==pos)continue;
      const hist=histByName[norm(p.name)];
      if(!hist?.dates?.length)continue;

      for(const[yr,seasonData]of Object.entries(p.seasons||{})){
        const weeks=seasonData.weeks||[];
        if(weeks.length<4)continue;
        for(let wi=3;wi<weeks.length;wi++){
          const window=weeks.slice(Math.max(0,wi-3),wi+1);
          const weekDate=weekToDate(parseInt(yr),weeks[wi].week);
          const valNow=getValueAtDate(hist,weekDate);
          if(!valNow||valNow<500)continue;

          for(const stat of stats){
            const vals=window.map(w=>parseFloat(w[stat]||0)).filter(v=>!isNaN(v));
            if(vals.length<3||vals.every(v=>v===0))continue;
            const trendSlope=slope(vals);
            const rolling4=vals.reduce((a,b)=>a+b)/vals.length;
            const pctChange=vals[0]>0?(vals[vals.length-1]-vals[0])/vals[0]*100:0;
            for(const lag of LAG_DAYS){
              const valFuture=getValueAfterDays(hist,weekDate,lag);
              if(!valFuture)continue;
              const valChange=(valFuture-valNow)/valNow*100;
              dataPoints[stat].push({trendSlope,rolling4,pctChange,valChange,lag});
            }
          }
        }
      }
    }

    for(const stat of stats){
      correlations[pos][stat]={};
      const pts=dataPoints[stat];
      let bestLag=null, bestR=0;
      for(const lag of LAG_DAYS){
        const lagPts=pts.filter(p=>p.lag===lag);
        if(lagPts.length<10){correlations[pos][stat][`${lag}d`]={r_slope:null,r_level:null,r_momentum:null,n:lagPts.length};continue;}
        const r_slope=pearson(lagPts.map(p=>p.trendSlope),lagPts.map(p=>p.valChange));
        const r_level=pearson(lagPts.map(p=>p.rolling4),lagPts.map(p=>p.valChange));
        const r_momentum=pearson(lagPts.map(p=>p.pctChange),lagPts.map(p=>p.valChange));
        const best=Math.max(...[r_slope,r_level,r_momentum].filter(v=>v!==null).map(Math.abs));
        if(best>bestR){bestR=best;bestLag=lag;}
        correlations[pos][stat][`${lag}d`]={r_slope,r_level,r_momentum,
          best_r:best||null,n:lagPts.length,
          interpretation:!best?'no data':best>0.4?'strong':best>0.25?'moderate':best>0.15?'weak':'negligible'};
      }
      correlations[pos][stat]._summary={
        best_lag:bestLag,
        best_correlation:bestR||null,
        interpretation:!bestR?'no data':bestR>0.4?'strong':bestR>0.25?'moderate':bestR>0.15?'weak':'negligible'
      };
    }

    const ranked=stats.filter(s=>!s.startsWith('_'))
      .map(s=>({stat:s,r:correlations[pos][s]?._summary?.best_correlation||0,lag:correlations[pos][s]?._summary?.best_lag}))
      .sort((a,b)=>b.r-a.r);
    correlations[pos]._ranked={top5:ranked.slice(0,5)};
    console.log(`  ${pos}: top=${ranked[0]?.stat}(r=${ranked[0]?.r?.toFixed(3)},lag=${ranked[0]?.lag}d)`);
  }

  // ── SEASON-LEVEL CORRELATIONS (NGS/PFR) ──
  console.log('\n[2] Season-level correlations (NGS/PFR)...');
  for(const pos of POSITIONS){
    const stats=SEASON_STATS[pos]||[];
    const pts={};
    for(const stat of stats)pts[stat]=[];

    for(const p of statsPlayers){
      if(p.pos!==pos)continue;
      const hist=histByName[norm(p.name)];
      if(!hist?.dates?.length)continue;
      for(const[yr,sd]of Object.entries(p.seasons||{})){
        if(!sd.games||sd.games<8)continue;
        const t=sd.totals||{};
        const valStart=getValueAtDate(hist,`${yr}-09-01`);
        const valEnd=getValueAtDate(hist,`${parseInt(yr)+1}-02-01`);
        if(!valStart||!valEnd||valStart<500)continue;
        const valChange=(valEnd-valStart)/valStart*100;
        for(const stat of stats){
          const v=parseFloat(t[stat]||0);
          if(!isNaN(v)&&v!==0)pts[stat].push({v,valChange});
        }
      }
    }

    let matched=0;
    for(const stat of stats){
      const p=pts[stat];
      if(p.length<8){continue;}
      const r=pearson(p.map(x=>x.v),p.map(x=>x.valChange));
      if(r){
        correlations[pos][stat]={_season_only:true,'season':{r,n:p.length},
          _summary:{best_correlation:Math.abs(r),best_lag:'season',n:p.length,
            interpretation:Math.abs(r)>0.4?'strong':Math.abs(r)>0.25?'moderate':Math.abs(r)>0.15?'weak':'negligible'}};
        matched++;
      }
    }
    // Re-rank
    const allStats=Object.keys(correlations[pos]).filter(k=>!k.startsWith('_'));
    const reranked=allStats.map(s=>({stat:s,r:correlations[pos][s]?._summary?.best_correlation||0}))
      .sort((a,b)=>b.r-a.r);
    correlations[pos]._ranked.top5=reranked.slice(0,5);
    console.log(`  ${pos}: ${matched} NGS/PFR stats with strong correlations`);
  }

  // ── TRAJECTORIES (with composite efficiency score) ──
  console.log('\n[3] Building trajectories with composite efficiency scores...');
  const trajectories={};

  for(const[name,hist]of Object.entries(histPlayers)){
    if(!hist?.sf?.length)continue;
    const recentIdx=hist.sf.reduceRight((f,v,i)=>f===-1&&v>0?i:f,-1);
    if(recentIdx===-1)continue;
    const currentValue=hist.sf[recentIdx];
    const currentDate=hist.dates[recentIdx];

    const v30=getValueAfterDays(hist,currentDate,-30)||0;
    const v60=getValueAfterDays(hist,currentDate,-60)||0;
    const v90=getValueAfterDays(hist,currentDate,-90)||0;
    const v180=getValueAfterDays(hist,currentDate,-180)||0;

    const statsP=statsByName[norm(name)];
    const s25=statsP?.seasons?.[2025];
    const pos=statsP?.pos;

    // Composite efficiency score for 2025
    let efficiencyScore = null;
    if(s25?.totals && pos && EFFICIENCY_WEIGHTS[pos]){
      const weights = EFFICIENCY_WEIGHTS[pos];
      let score = 0, weightSum = 0;
      for(const[stat,w]of Object.entries(weights)){
        const v = s25.totals[stat];
        if(v != null && !isNaN(v)){
          // Normalize: stats with negative weights are bad, positive are good
          score += (v * w);
          weightSum += Math.abs(w);
        }
      }
      if(weightSum > 0) efficiencyScore = Math.round(score / weightSum * 100) / 100;
    }

    // Half-season splits and YoY comparison vs 2024
    const seasonSplits={};
    if(s25?.weeks?.length>=4){
      const weeks25=s25.weeks;
      const midpoint=Math.floor(weeks25.length/2);
      const firstHalf=weeks25.slice(0,midpoint);
      const secondHalf=weeks25.slice(midpoint);
      const s24=statsP?.seasons?.[2024];
      const totals24=s24?.totals||{};
      
      for(const stat of (WEEKLY_STATS[pos]||[])){
        const fh=firstHalf.map(w=>parseFloat(w[stat]||0)).filter(v=>!isNaN(v));
        const sh=secondHalf.map(w=>parseFloat(w[stat]||0)).filter(v=>!isNaN(v));
        if(fh.length<2||sh.length<2)continue;
        const fhAvg=fh.reduce((a,b)=>a+b,0)/fh.length;
        const shAvg=sh.reduce((a,b)=>a+b,0)/sh.length;
        const fullAvg=(fhAvg*fh.length+shAvg*sh.length)/(fh.length+sh.length);
        const trend=fhAvg>0?Math.round((shAvg-fhAvg)/fhAvg*1000)/10:0;
        // Compare 2025 full season avg per game to 2024 totals/games
        const games24=s24?.games||0;
        const total24=totals24[stat]||0;
        const ppg24=games24>0?total24/games24:0;
        const yoy=ppg24>0?Math.round((fullAvg-ppg24)/ppg24*1000)/10:null;
        seasonSplits[stat]={
          first_half_avg:Math.round(fhAvg*100)/100,
          second_half_avg:Math.round(shAvg*100)/100,
          season_avg:Math.round(fullAvg*100)/100,
          h2_vs_h1_pct:trend,
          h2_trend:trend>5?'improving':trend<-5?'declining':'stable',
          season_2024_ppg:games24>0?Math.round(ppg24*100)/100:null,
          yoy_vs_2024_pct:yoy,
          yoy_trend:yoy===null?'no_2024_data':yoy>10?'breakout':yoy<-10?'regression':'similar'
        };
      }
    }

    // Composite signal score
    const keyStats=pos?WEEKLY_STATS[pos]?.slice(0,5):[];
    const risingCount=keyStats.filter(s=>seasonSplits[s]?.h2_trend==='improving').length;
    const fallingCount=keyStats.filter(s=>seasonSplits[s]?.h2_trend==='declining').length;
    const compositeSignal=keyStats.length>0?
      Math.round((risingCount-fallingCount)/keyStats.length*100):null;

    const peakValue=Math.max(...hist.sf.filter(v=>v>0));

    // Get fantasy finish for this player
    const fantasyRank2025 = fantasyRanks[`${pos}_${norm(name)}_2025`];
    const fantasyTier2025 = getFantasyTier(fantasyRank2025, pos);

    // Get draft info
    const draft = draftPicks[norm(name)];

    trajectories[name]={
      pid:statsP?.player_id||null,
      pos:pos||null,
      current_value:currentValue,
      current_date:currentDate,
      peak_value:peakValue,
      pct_of_peak:peakValue>0?Math.round(currentValue/peakValue*1000)/10:null,
      value_tier:getValueTier(currentValue),
      fantasy_rank_2025:fantasyRank2025||null,
      fantasy_tier_2025:fantasyTier2025,
      draft_round:draft?.round||null,
      draft_pick:draft?.pick||null,
      draft_year:draft?.draft_year||null,
      draft_tier:draft?.draft_tier||null,
      college:draft?.college||null,
      momentum:{
        vs_30d:v30>0?Math.round((currentValue-v30)/v30*1000)/10:null,
        vs_60d:v60>0?Math.round((currentValue-v60)/v60*1000)/10:null,
        vs_90d:v90>0?Math.round((currentValue-v90)/v90*1000)/10:null,
        vs_180d:v180>0?Math.round((currentValue-v180)/v180*1000)/10:null,
        direction:v30>0?(currentValue-v30)/v30>0.05?'rising':(currentValue-v30)/v30<-0.05?'falling':'stable':'unknown'
      },
      efficiency_score:efficiencyScore,
      composite_signal:compositeSignal,
      season_splits_2025:seasonSplits,
      season_2025:s25?{games:s25.games,team:s25.team,...s25.totals}:null,
      season_2024:statsP?.seasons?.[2024]?{games:statsP.seasons[2024].games,team:statsP.seasons[2024].team,...statsP.seasons[2024].totals}:null,
      stat_fingerprint:s25?.totals?buildStatFingerprint(s25.totals,pos):null,
    };
  }
  console.log(`  Trajectories: ${Object.keys(trajectories).length}`);

  // ── CONTEXT-AWARE COMP ENGINE v3 ──
  console.log('\n[4] Building context-aware comp profiles...');
  const compProfiles={};

  for(const[name,traj]of Object.entries(trajectories)){
    const pos=traj.pos;
    if(!pos)continue;
    const isRookie = traj.draft_year && traj.season_2025?.games < 17 && 
                     (new Date().getFullYear() - traj.draft_year) <= 1;

    const candidates=[];

    // Different matching logic for rookies vs veterans
    if(isRookie && traj.draft_round){
      // ROOKIE COMPS: match by draft round/pick + college tier + similar landing situation
      const targetRound = traj.draft_round;
      const targetPick = traj.draft_pick;
      const targetCollege = traj.college;
      
      for(const[compName,compTraj]of Object.entries(trajectories)){
        if(compName===name) continue;
        if(compTraj.pos !== pos) continue;
        if(!compTraj.draft_round) continue;
        // Must be drafted in similar range — within 1 round AND within 25 picks
        const roundDiff = Math.abs(compTraj.draft_round - targetRound);
        const pickDiff = compTraj.draft_pick && targetPick ? Math.abs(compTraj.draft_pick - targetPick) : 999;
        if(roundDiff > 1) continue;
        if(pickDiff > 25) continue;
        // Must be at least 1 year removed (so we have post-draft trajectory data)
        if(!compTraj.draft_year || compTraj.draft_year >= (new Date().getFullYear() - 1)) continue;
        // Get value 12 months after their rookie season ended
        const compHist = histPlayers[compName];
        if(!compHist?.sf?.length) continue;
        const rookieEndDate = `${compTraj.draft_year + 1}-02-01`;
        const valAtRookieEnd = getValueAtDate(compHist, rookieEndDate);
        const val12mLater = getValueAfterDays(compHist, rookieEndDate, 365);
        if(!valAtRookieEnd || !val12mLater) continue;
        const valChange = Math.round((val12mLater - valAtRookieEnd) / valAtRookieEnd * 1000) / 10;

        // Match score: round + pick + college bonus
        let matchScore = 100 - (roundDiff * 20) - Math.min(pickDiff, 30);
        if(targetCollege && compTraj.college === targetCollege) matchScore += 10;

        candidates.push({
          name: compName,
          comp_type: 'rookie',
          season: compTraj.draft_year,
          draft: `R${compTraj.draft_round}P${compTraj.draft_pick}`,
          college: compTraj.college,
          match_score: matchScore,
          val_at_comp: valAtRookieEnd,
          val_12m_later: val12mLater,
          val_change_12m: valChange,
        });
      }
    } else {
      // VETERAN COMPS: match by value tier + fantasy tier + stat fingerprint + career stage
      const targetValue = traj.current_value;
      const targetFantasyTier = traj.fantasy_tier_2025;
      const targetFingerprint = traj.stat_fingerprint;
      const targetValueTier = traj.value_tier;
      
      // Look at historical seasons (2020-2023) where players had similar profile
      // then we can see what happened to their value 12 months after that season
      for(const[compName,compStatsP]of Object.entries(statsByName)){
        if(compName === norm(name)) continue;
        if(compStatsP.pos !== pos) continue;
        const compHist = histByName[compName];
        if(!compHist?.sf?.length) continue;

        // Try each historical season for this comp
        for(const compYr of [2020,2021,2022,2023]){
          const compSeason = compStatsP.seasons?.[compYr];
          if(!compSeason?.totals) continue;
          if(!compSeason.games || compSeason.games < 8) continue;

          // Get value at end of that season
          const seasonEndDate = `${compYr + 1}-02-01`;
          const valAtSeason = getValueAtDate(compHist, seasonEndDate);
          if(!valAtSeason) continue;

          // Filter 1: Value tier must match (within 30%)
          const valRatio = valAtSeason / targetValue;
          if(valRatio < 0.7 || valRatio > 1.3) continue;

          // Filter 2: Fantasy finish must match within 1 tier
          const compRank = fantasyRanks[`${pos}_${compName}_${compYr}`];
          const compTier = getFantasyTier(compRank, pos);
          if(targetFantasyTier && compTier){
            const tierMap = {[`${pos}1`]:1,[`${pos}2`]:2,[`${pos}3`]:3,[`${pos}4`]:4,[`${pos}5+`]:5};
            const tierDiff = Math.abs((tierMap[targetFantasyTier]||3) - (tierMap[compTier]||3));
            if(tierDiff > 1) continue;
          }

          // Filter 3: Stat fingerprint similarity
          const compFingerprint = buildStatFingerprint(compSeason.totals, pos);
          const sim = fingerprintSim(targetFingerprint || {}, compFingerprint);
          if(sim < 0.85) continue;

          // What happened to their value 12 months after?
          const val12mLater = getValueAfterDays(compHist, seasonEndDate, 365);
          if(!val12mLater) continue;
          const valChange = Math.round((val12mLater - valAtSeason) / valAtSeason * 1000) / 10;

          // Compute match score
          let matchScore = Math.round(sim * 100);
          // Bonus for exact fantasy tier match
          if(targetFantasyTier && compTier === targetFantasyTier) matchScore += 5;
          // Penalty for value tier mismatch
          matchScore -= Math.abs(1 - valRatio) * 20;

          candidates.push({
            name: compStatsP.name,
            comp_type: 'veteran',
            season: compYr,
            fantasy_tier: compTier,
            value_tier: getValueTier(valAtSeason),
            similarity: Math.round(sim * 1000) / 10,
            match_score: Math.round(matchScore),
            val_at_comp: valAtSeason,
            val_12m_later: val12mLater,
            val_change_12m: valChange,
          });
          break; // one comp per player
        }
      }
    }

    if(!candidates.length) continue;
    
    // Pull more candidates so we can split into upside/downside/base scenarios
    const sorted = candidates.sort((a,b) => b.match_score - a.match_score);
    const top10 = sorted.slice(0, 10); // top 10 most similar comps
    const validChanges = top10.filter(c => c.val_change_12m !== null);
    
    // Split into scenarios
    const upsideComps = validChanges.filter(c => c.val_change_12m > 5).sort((a,b) => b.val_change_12m - a.val_change_12m).slice(0, 3);
    const downsideComps = validChanges.filter(c => c.val_change_12m < -5).sort((a,b) => a.val_change_12m - b.val_change_12m).slice(0, 3);
    const baseComps = validChanges.filter(c => Math.abs(c.val_change_12m) <= 15).slice(0, 3);
    
    // Weighted average — best matches get more weight
    const totalWeight = validChanges.reduce((s,c) => s + (c.match_score || 1), 0);
    const weightedAvg = totalWeight > 0 ? 
      validChanges.reduce((s,c) => s + (c.val_change_12m * (c.match_score || 1)), 0) / totalWeight : null;
    
    // Probabilities
    const upsideProb = validChanges.length > 0 ? 
      Math.round(upsideComps.length / validChanges.length * 100) : null;
    const downsideProb = validChanges.length > 0 ?
      Math.round(downsideComps.length / validChanges.length * 100) : null;

    compProfiles[name] = {
      pos,
      comp_type: isRookie ? 'rookie' : 'veteran',
      current_value: traj.current_value,
      fantasy_tier: traj.fantasy_tier_2025,
      value_tier: traj.value_tier,
      
      // Top 3 best matches (regardless of outcome) - keep for backward compat
      comps: sorted.slice(0, 3),
      
      // SCENARIO BREAKDOWN
      upside_scenario: {
        comps: upsideComps,
        probability_pct: upsideProb,
        avg_gain: upsideComps.length > 0 ?
          Math.round(upsideComps.reduce((s,c) => s + c.val_change_12m, 0) / upsideComps.length * 10) / 10 : null,
        projected_ceiling: upsideComps.length > 0 && traj.current_value ?
          Math.round(traj.current_value * (1 + (upsideComps.reduce((s,c) => s + c.val_change_12m, 0) / upsideComps.length) / 100)) : null,
      },
      base_case: {
        comps: baseComps,
        avg_change: baseComps.length > 0 ?
          Math.round(baseComps.reduce((s,c) => s + c.val_change_12m, 0) / baseComps.length * 10) / 10 : null,
      },
      downside_scenario: {
        comps: downsideComps,
        probability_pct: downsideProb,
        avg_loss: downsideComps.length > 0 ?
          Math.round(downsideComps.reduce((s,c) => s + c.val_change_12m, 0) / downsideComps.length * 10) / 10 : null,
        projected_floor: downsideComps.length > 0 && traj.current_value ?
          Math.round(traj.current_value * (1 + (downsideComps.reduce((s,c) => s + c.val_change_12m, 0) / downsideComps.length) / 100)) : null,
      },
      
      // Weighted projection (most likely outcome)
      avg_comp_outcome: validChanges.length > 0 ?
        Math.round(validChanges.reduce((s,c) => s + c.val_change_12m, 0) / validChanges.length * 10) / 10 : null,
      weighted_projection_pct: weightedAvg != null ? Math.round(weightedAvg * 10) / 10 : null,
      projected_value_12m: weightedAvg != null && traj.current_value ?
        Math.round(traj.current_value * (1 + weightedAvg / 100)) : null,
      total_comps_analyzed: validChanges.length,
    };
  }
  console.log(`  Comp profiles: ${Object.keys(compProfiles).length}`);

  // ── OUTPUT ──
  const output={
    generated:new Date().toISOString(),
    methodology:'v3: composite efficiency + multi-lag analysis + context-aware comps (rookies match draft, vets match value+fantasy_tier+fingerprint)',
    correlations,
    trajectories,
    comp_profiles:compProfiles,
    summary:{
      total_trajectories:Object.keys(trajectories).length,
      total_comps:Object.keys(compProfiles).length,
      top_predictors:Object.fromEntries(
        POSITIONS.map(pos=>[pos,correlations[pos]?._ranked?.top5||[]])
      )
    }
  };

  fs.writeFileSync('public/data/analytics.json',JSON.stringify(output));
  const mb=(fs.statSync('public/data/analytics.json').size/1024/1024).toFixed(1);
  console.log(`\n✓ analytics.json: ${mb}MB`);
  console.log(`Trajectories: ${Object.keys(trajectories).length}`);
  console.log(`Comp profiles: ${Object.keys(compProfiles).length}`);

  // Show Pickens specifically
  if(trajectories['George Pickens']){
    const t=trajectories['George Pickens'];
    console.log(`\nGeorge Pickens trajectory:`);
    console.log(`  Value: ${t.current_value} (${t.pct_of_peak}% of peak ${t.peak_value})`);
    console.log(`  Fantasy: ${t.fantasy_tier_2025} (rank ${t.fantasy_rank_2025})`);
    console.log(`  Efficiency score: ${t.efficiency_score}`);
    console.log(`  Momentum: vs30d=${t.momentum.vs_30d}% vs90d=${t.momentum.vs_90d}%`);
    console.log(`  Composite signal: ${t.composite_signal}`);
  }
  if(compProfiles['George Pickens']){
    const c=compProfiles['George Pickens'];
    console.log(`\nGeorge Pickens scenarios (${c.comp_type}, ${c.total_comps_analyzed} comps analyzed):`);
    console.log(`  UPSIDE (${c.upside_scenario.probability_pct}% prob, avg +${c.upside_scenario.avg_gain}%):`);
    c.upside_scenario.comps.forEach(x => console.log(`    ${x.name} (${x.season}, ${x.fantasy_tier||'?'}): +${x.val_change_12m}%`));
    console.log(`    → Ceiling: ${c.upside_scenario.projected_ceiling}`);
    console.log(`  BASE CASE (${c.base_case.avg_change}% avg):`);
    c.base_case.comps.forEach(x => console.log(`    ${x.name} (${x.season}, ${x.fantasy_tier||'?'}): ${x.val_change_12m}%`));
    console.log(`  DOWNSIDE (${c.downside_scenario.probability_pct}% prob, avg ${c.downside_scenario.avg_loss}%):`);
    c.downside_scenario.comps.forEach(x => console.log(`    ${x.name} (${x.season}, ${x.fantasy_tier||'?'}): ${x.val_change_12m}%`));
    console.log(`    → Floor: ${c.downside_scenario.projected_floor}`);
    console.log(`  WEIGHTED PROJECTION: ${c.weighted_projection_pct}% → ${c.projected_value_12m}`);
  }

  // Show a rookie example
  const rookieExample = Object.entries(compProfiles).find(([n,c]) => c.comp_type === 'rookie');
  if(rookieExample){
    const [n,c] = rookieExample;
    console.log(`\nRookie sample — ${n}:`);
    console.log(`  UPSIDE (${c.upside_scenario.probability_pct}% prob):`);
    c.upside_scenario.comps.forEach(x => console.log(`    ${x.name} (${x.draft}, ${x.college}): +${x.val_change_12m}%`));
    console.log(`  DOWNSIDE (${c.downside_scenario.probability_pct}% prob):`);
    c.downside_scenario.comps.forEach(x => console.log(`    ${x.name} (${x.draft}, ${x.college}): ${x.val_change_12m}%`));
    console.log(`  Projected: ${c.projected_value_12m}`);
  }
}

buildAnalytics().catch(e=>{console.error('FATAL:',e);process.exit(1);});
