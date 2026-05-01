// ── GWTTKB Analytics Engine ──
// Computes rolling trends from weekly stats
// Cross-references with daily dynasty values
// Finds what TREND CHANGES actually predict dynasty value movement
// Writes: public/data/analytics.json

import fs from 'fs';

const POSITIONS = ['QB','RB','WR','TE'];

// Every available stat by position — weekly for trend analysis, season for comp engine
const TREND_STATS = {
  QB: [
    // Volume
    'passing_yards','passing_tds','interceptions','attempts','completions',
    // Efficiency
    'passing_epa','completion_pct','yards_per_attempt',
    // Pressure/protection
    'sacks','sack_yards',
    // Rushing contribution
    'carries','rushing_yards','rushing_tds','rushing_epa',
    // Fantasy
    'fantasy_points_ppr',
    // NGS (season-level, used in comp engine)
    'avg_time_to_throw','avg_intended_air_yards','avg_completed_air_yards',
    'completion_pct_above_expectation','passer_rating',
    // PFR (season-level)
    'pfr_passing_drops','pfr_bad_throws','pfr_blitzed_pct','pfr_sacked',
  ],
  RB: [
    // Rushing
    'carries','rushing_yards','rushing_tds','rushing_epa',
    'rushing_yards_per_carry',
    // Receiving
    'targets','receptions','receiving_yards','receiving_tds',
    'target_share','receiving_epa','yards_per_reception',
    'catch_rate','yards_per_target',
    // Overall
    'wopr','fantasy_points_ppr',
    // NGS (season-level)
    'avg_rush_yards_over_expected','avg_rush_yards_over_expected_pct',
    'efficiency','percent_attempts_gte_eight_defenders',
    // PFR (season-level)
    'pfr_broke_tackles','pfr_yco_contact','pfr_avoided_tackles',
  ],
  WR: [
    // Volume
    'targets','receptions','receiving_yards','receiving_tds',
    // Share metrics
    'target_share','air_yards_share','wopr','racr',
    // Efficiency
    'receiving_epa','yards_per_reception','yards_per_target','catch_rate',
    // Overall
    'fantasy_points_ppr',
    // NGS (season-level)
    'avg_separation','avg_cushion','avg_yac_above_expectation',
    'percent_share_of_intended_air_yards',
    // PFR (season-level)
    'pfr_drops','pfr_drop_pct','pfr_yac','pfr_broke_tackles',
    'pfr_contested_tgts','pfr_contested_catch_pct',
    // QB rushing contribution (dual threats)
    'carries','rushing_yards',
  ],
  TE: [
    // Volume
    'targets','receptions','receiving_yards','receiving_tds',
    // Share metrics
    'target_share','air_yards_share','wopr','racr',
    // Efficiency
    'receiving_epa','yards_per_reception','yards_per_target','catch_rate',
    // Overall
    'fantasy_points_ppr',
    // NGS (season-level)
    'avg_separation','avg_cushion','avg_yac_above_expectation',
    'percent_share_of_intended_air_yards',
    // PFR (season-level)
    'pfr_drops','pfr_drop_pct','pfr_yac','pfr_broke_tackles',
    'pfr_contested_tgts','pfr_contested_catch_pct',
  ],
};

function pearson(xs, ys){
  const n = xs.length;
  if(n < 8) return null;
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

function norm(s){ return (s||'').toLowerCase().replace(/[^a-z]/g,''); }

function weekToDate(season, week){
  const starts = {
    2020:'2020-09-10',2021:'2021-09-09',2022:'2022-09-08',
    2023:'2023-09-07',2024:'2024-09-05',2025:'2025-09-04'
  };
  const d = new Date(starts[season]||`${season}-09-05`);
  d.setDate(d.getDate()+(week-1)*7);
  return d.toISOString().split('T')[0];
}

function findDateIdx(dates, targetDate){
  const ts = new Date(targetDate).getTime();
  let lo=0,hi=dates.length-1;
  while(lo<=hi){
    const mid=(lo+hi)>>1;
    const d=new Date(dates[mid]).getTime();
    if(d===ts)return mid;
    if(d<ts)lo=mid+1; else hi=mid-1;
  }
  return lo<dates.length?lo:dates.length-1;
}

function getValueAtDate(hist, date){
  if(!hist?.dates?.length)return null;
  const idx=findDateIdx(hist.dates,date);
  return hist.sf?.[idx]||null;
}

function getValueAfterDays(hist, startDate, days){
  const d=new Date(startDate);
  d.setDate(d.getDate()+days);
  return getValueAtDate(hist, d.toISOString().split('T')[0]);
}

// Linear regression slope — tells us if metric is trending up or down
function slope(ys){
  const n=ys.length; if(n<3)return 0;
  const xs=Array.from({length:n},(_,i)=>i);
  const mx=xs.reduce((a,b)=>a+b)/n;
  const my=ys.reduce((a,b)=>a+b)/n;
  let num=0,den=0;
  for(let i=0;i<n;i++){num+=(xs[i]-mx)*(ys[i]-my);den+=(xs[i]-mx)**2;}
  return den===0?0:Math.round(num/den*1000)/1000;
}

// Rolling average over last N values
function rollingAvg(arr, n){
  if(arr.length<n)return arr.reduce((a,b)=>a+b,0)/arr.length;
  return arr.slice(-n).reduce((a,b)=>a+b,0)/n;
}

async function buildAnalytics(){
  console.log('=== Building Analytics Engine (Rolling Trends) ===');
  fs.mkdirSync('public/data',{recursive:true});

  // Load stats
  console.log('\nLoading nfl-stats.json...');
  const statsRaw = JSON.parse(fs.readFileSync('public/data/nfl-stats.json','utf8'));
  const statsPlayers = Object.values(statsRaw.players||{});
  console.log(`  ${statsPlayers.length} players`);

  // Load historical values
  console.log('Loading historical-players.json...');
  const histRaw = JSON.parse(fs.readFileSync('public/data/historical-players.json','utf8'));
  const histPlayers = histRaw.players||{};
  const histByName = {};
  for(const[name,data]of Object.entries(histPlayers)){
    histByName[norm(name)]=data;
  }
  console.log(`  ${Object.keys(histByName).length} historical players`);

  // ── BUILD ROLLING TREND DATASET ──
  // For each player, each week (after week 4):
  // Compute rolling metrics and trend slopes
  // Then look up dynasty value 14, 30, 60 days later
  // Correlate: does rising trend predict rising value?

  const LAG_DAYS = [14, 30, 60];
  
  // dataPoints[pos][stat] = [{trendSlope, rollingAvg, pctChangeFrom4WkAgo, valueChange30d}]
  const dataPoints = {};
  for(const pos of POSITIONS){
    dataPoints[pos]={};
    for(const stat of TREND_STATS[pos]||[]){
      dataPoints[pos][stat]=[];
    }
  }

  let totalPoints=0;
  for(const p of statsPlayers){
    if(!POSITIONS.includes(p.pos))continue;
    const hist=histByName[norm(p.name)];
    if(!hist?.dates?.length)continue;

    for(const[yr,seasonData]of Object.entries(p.seasons||{})){
      const weeks=seasonData.weeks||[];
      if(weeks.length<5)continue;

      for(let wi=4; wi<weeks.length; wi++){
        // Get last 4 weeks of each stat
        const window=weeks.slice(Math.max(0,wi-3),wi+1);
        const weekDate=weekToDate(parseInt(yr),weeks[wi].week);

        // Get current value and future values
        const valNow=getValueAtDate(hist,weekDate);
        if(!valNow||valNow<500)continue;

        // Compute rolling trends for each stat
        for(const stat of TREND_STATS[p.pos]||[]){
          const vals=window.map(w=>parseFloat(w[stat]||0)).filter(v=>!isNaN(v));
          if(vals.length<3)continue;
          if(vals.every(v=>v===0))continue;

          const trendSlope=slope(vals);
          const rolling4=rollingAvg(vals,4);
          const firstVal=vals[0];
          const pctChange=firstVal>0?(vals[vals.length-1]-firstVal)/firstVal*100:0;

          // Value changes at each lag
          for(const lag of LAG_DAYS){
            const valFuture=getValueAfterDays(hist,weekDate,lag);
            if(!valFuture)continue;
            const valChange=(valFuture-valNow)/valNow*100;

            dataPoints[p.pos][stat].push({
              trendSlope,   // is the stat going up or down over last 4 weeks
              rolling4,     // recent level
              pctChange,    // % change from 4 weeks ago to now
              valChange,    // dynasty value change in next N days
              lag,
              player: p.name,
              yr: parseInt(yr),
              week: weeks[wi].week
            });
            totalPoints++;
          }
        }
      }
    }
  }

  console.log(`\nTotal data points: ${totalPoints.toLocaleString()}`);

  // ── COMPUTE CORRELATIONS ──
  // Three correlation types per stat:
  // 1. Trend slope vs value change (is rising stat predictive?)
  // 2. Rolling average level vs value change (does high level predict rise?)
  // 3. Pct change from 4wks ago vs value change (momentum signal)

  const correlations={};
  for(const pos of POSITIONS){
    correlations[pos]={};
    for(const stat of TREND_STATS[pos]||[]){
      correlations[pos][stat]={};
      const pts=dataPoints[pos][stat];

      for(const lag of LAG_DAYS){
        const lagPts=pts.filter(p=>p.lag===lag);
        if(lagPts.length<10){
          correlations[pos][stat][`${lag}d`]={n:lagPts.length,r_slope:null,r_level:null,r_momentum:null};
          continue;
        }

        const r_slope=pearson(lagPts.map(p=>p.trendSlope), lagPts.map(p=>p.valChange));
        const r_level=pearson(lagPts.map(p=>p.rolling4), lagPts.map(p=>p.valChange));
        const r_momentum=pearson(lagPts.map(p=>p.pctChange), lagPts.map(p=>p.valChange));

        correlations[pos][stat][`${lag}d`]={
          n: lagPts.length,
          r_slope,    // trend direction predictor
          r_level,    // absolute level predictor
          r_momentum, // momentum predictor
          best_r: [r_slope,r_level,r_momentum].filter(Boolean)
            .reduce((best,r)=>Math.abs(r)>Math.abs(best)?r:best, 0),
          interpretation: (() => {
            const vals=[r_slope,r_level,r_momentum].filter(v=>v!==null&&!isNaN(v));
            if(!vals.length)return 'no data';
            const best=Math.max(...vals.map(Math.abs));
            if(best>0.4)return 'strong predictor';
            if(best>0.25)return 'moderate predictor';
            if(best>0.15)return 'weak predictor';
            return 'negligible';
          })()
        };
      }

      // Rank: best lag and best correlation type for this stat
      const best30=correlations[pos][stat]['30d'];
      correlations[pos][stat]._summary={
        best_correlation: best30?.best_r||null,
        best_type: best30 ? (['r_slope','r_level','r_momentum']
          .reduce((best,k)=>Math.abs(best30[k]||0)>Math.abs(best30[best]||0)?k:best,'r_slope')) : null,
        n: best30?.n||0,
        interpretation: best30?.interpretation||'no data'
      };
    }

    // Rank stats by 30d correlation strength
    const ranked=Object.entries(correlations[pos])
      .filter(([k])=>!k.startsWith('_'))
      .map(([stat,data])=>({stat, r:Math.abs(data._summary?.best_correlation||0)}))
      .sort((a,b)=>b.r-a.r);
    
    correlations[pos]._ranked={
      by_30d: ranked.map(r=>r.stat),
      top5: ranked.slice(0,5).map(r=>({stat:r.stat, r:r.r, ...correlations[pos][r.stat]._summary}))
    };

    console.log(`\n${pos} top predictors (30d):`);
    for(const item of ranked.slice(0,8)){
      const d=correlations[pos][item.stat]?.['30d']||{};
      const bestType=item.stat.startsWith('_')?null:
        ['r_slope','r_level','r_momentum'].filter(k=>d[k]!==null)
        .reduce((best,k)=>Math.abs(d[k]||0)>Math.abs(d[best]||0)?k:best,'r_slope');
      const bestVal=bestType?d[bestType]:0;
      const typeLabel=bestType==='r_slope'?'trend':bestType==='r_level'?'level':'momentum';
      console.log(`  ${item.stat}: r=${item.r.toFixed(3)} via ${typeLabel} signal (${d.interpretation||'?'}) n=${d.n||0}`);
    }
  }

  // ── PLAYER TRAJECTORIES ──
  console.log('\nBuilding trajectories...');
  const trajectories={};

  for(const p of statsPlayers){
    if(!POSITIONS.includes(p.pos))continue;
    const hist=histByName[norm(p.name)];
    if(!hist?.sf?.length)continue;

    // Current value
    const recentIdx=hist.sf.reduceRight((f,v,i)=>f===-1&&v>0?i:f,-1);
    if(recentIdx===-1)continue;
    const currentValue=hist.sf[recentIdx];
    const currentDate=hist.dates[recentIdx];

    const v30=getValueAfterDays(hist,currentDate,-30)||0;
    const v60=getValueAfterDays(hist,currentDate,-60)||0;
    const v90=getValueAfterDays(hist,currentDate,-90)||0;
    const v180=getValueAfterDays(hist,currentDate,-180)||0;

    // 2025 season rolling stats (last 6 weeks)
    const s25=p.seasons?.[2025];
    const recentWeeks=(s25?.weeks||[]).slice(-6);
    
    const rolling={};
    for(const stat of TREND_STATS[p.pos]||[]){
      const vals=recentWeeks.map(w=>parseFloat(w[stat]||0)).filter(v=>!isNaN(v)&&v>0);
      if(vals.length>=3){
        rolling[stat]={
          avg:Math.round(vals.reduce((a,b)=>a+b)/vals.length*100)/100,
          slope:slope(vals),
          trend:slope(vals)>0.1?'rising':slope(vals)<-0.1?'falling':'stable'
        };
      }
    }

    trajectories[p.name]={
      pid:p.player_id, pos:p.pos,
      current_value:currentValue, current_date:currentDate,
      peak_value:Math.max(...hist.sf.filter(v=>v>0)),
      momentum:{
        vs_30d:v30>0?Math.round((currentValue-v30)/v30*1000)/10:null,
        vs_60d:v60>0?Math.round((currentValue-v60)/v60*1000)/10:null,
        vs_90d:v90>0?Math.round((currentValue-v90)/v90*1000)/10:null,
        vs_180d:v180>0?Math.round((currentValue-v180)/v180*1000)/10:null,
        direction:v30>0?(currentValue-v30)/v30>0.05?'rising':(currentValue-v30)/v30<-0.05?'falling':'stable':'unknown'
      },
      rolling_2025:rolling,
      season_2025:s25?{games:s25.games,team:s25.team,...s25.totals}:null
    };
  }

  // ── COMP ENGINE ──
  console.log('Building comp profiles...');
  const compProfiles={};

  // Build stat vectors using top predictors per position
  const getVector=(p,yr)=>{
    const t=p.seasons?.[yr]?.totals||{};
    const stats=TREND_STATS[p.pos]||[];
    // Normalize by games played
    const games=p.seasons?.[yr]?.games||1;
    return stats.map(s=>(parseFloat(t[s]||0)/games));
  };

  const eligible=statsPlayers.filter(p=>POSITIONS.includes(p.pos)&&p.seasons?.[2025]?.games>=8);
  
  for(const p of eligible){
    const vec25=getVector(p,2025);
    if(vec25.every(v=>v===0))continue;

    const comps=[];
    for(const other of statsPlayers){
      if(other.player_id===p.player_id||other.pos!==p.pos)continue;
      for(const yr of [2020,2021,2022,2023,2024]){
        if(!other.seasons?.[yr]?.games||other.seasons[yr].games<8)continue;
        const vec=getVector(other,yr);
        if(vec.every(v=>v===0))continue;
        
        // Euclidean distance (normalized)
        let dist=0;
        for(let i=0;i<vec25.length;i++) dist+=(vec25[i]-vec[i])**2;
        dist=Math.sqrt(dist);
        
        // What happened to this player's value the following year?
        const hist=histByName[norm(other.name)];
        const valStart=getValueAfterDays(hist,`${yr}-12-01`,30);
        const valEnd=getValueAfterDays(hist,`${yr+1}-10-01`,0);
        const valChange=valStart&&valEnd?Math.round((valEnd-valStart)/valStart*1000)/10:null;
        
        comps.push({name:other.name,season:yr,dist:Math.round(dist*100)/100,val_change_next_yr:valChange});
      }
    }

    // Top 3 closest comps
    const top3=comps.sort((a,b)=>a.dist-b.dist).slice(0,3);
    const validChanges=top3.filter(c=>c.val_change_next_yr!==null);
    
    compProfiles[p.name]={
      pos:p.pos,
      comps:top3,
      projected_val_change:validChanges.length>0
        ?Math.round(validChanges.reduce((s,c)=>s+c.val_change_next_yr,0)/validChanges.length*10)/10
        :null
    };
  }

  // ── OUTPUT ──
  const output={
    generated:new Date().toISOString(),
    methodology:'Rolling 4-week trends correlated against dynasty value changes at 14/30/60 day lags',
    correlations,
    trajectories,
    comp_profiles:compProfiles,
    summary:{
      total_data_points:totalPoints,
      players_with_trajectories:Object.keys(trajectories).length,
      players_with_comps:Object.keys(compProfiles).length,
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
  console.log(`Total data points: ${totalPoints.toLocaleString()}`);
}

buildAnalytics().catch(e=>{console.error('FATAL:',e);process.exit(1);});
