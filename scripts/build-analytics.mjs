// ── GWTTKB Analytics Engine v2 ──
// Fixes:
// 1. Trajectories built for ALL 533 historical players, not just those with 2025 stats
// 2. Comp pool uses historical-players.json value trajectories as primary signal
// 3. Season-level NGS/PFR correlations added
// 4. Composite multi-stat signal score added
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

async function buildAnalytics(){
  console.log('=== Building Analytics Engine v2 ===');
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

  // Build stats lookup by normalized name
  const statsByName={};
  for(const p of statsPlayers)statsByName[norm(p.name)]=p;

  // ── CORRELATIONS (weekly rolling trends) ──
  console.log('\n[1] Weekly correlations...');
  const LAG_DAYS=[14,30,60];
  const correlations={};

  for(const pos of POSITIONS){
    correlations[pos]={};
    const stats=WEEKLY_STATS[pos]||[];
    const dataPoints={};
    for(const stat of stats)dataPoints[stat]=[];

    let playerCount=0;
    for(const p of statsPlayers){
      if(p.pos!==pos)continue;
      const hist=histByName[norm(p.name)];
      if(!hist?.dates?.length)continue;
      playerCount++;

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
      for(const lag of LAG_DAYS){
        const lagPts=pts.filter(p=>p.lag===lag);
        if(lagPts.length<10){correlations[pos][stat][`${lag}d`]={r_slope:null,r_level:null,r_momentum:null,n:lagPts.length};continue;}
        const r_slope=pearson(lagPts.map(p=>p.trendSlope),lagPts.map(p=>p.valChange));
        const r_level=pearson(lagPts.map(p=>p.rolling4),lagPts.map(p=>p.valChange));
        const r_momentum=pearson(lagPts.map(p=>p.pctChange),lagPts.map(p=>p.valChange));
        const best=Math.max(...[r_slope,r_level,r_momentum].filter(v=>v!==null).map(Math.abs));
        correlations[pos][stat][`${lag}d`]={r_slope,r_level,r_momentum,
          best_r:best||null,n:lagPts.length,
          interpretation:!best?'no data':best>0.4?'strong':best>0.25?'moderate':best>0.15?'weak':'negligible'};
      }
      const b30=correlations[pos][stat]['30d'];
      correlations[pos][stat]._summary={
        best_correlation:b30?.best_r||null,
        best_type:b30?['r_slope','r_level','r_momentum'].reduce((best,k)=>Math.abs(b30[k]||0)>Math.abs(b30[best]||0)?k:best,'r_slope'):null,
        n:b30?.n||0,interpretation:b30?.interpretation||'no data'
      };
    }

    const ranked=stats.filter(s=>!s.startsWith('_'))
      .map(s=>({stat:s,r:Math.abs(correlations[pos][s]?._summary?.best_correlation||0)}))
      .sort((a,b)=>b.r-a.r);
    correlations[pos]._ranked={by_30d:ranked.map(r=>r.stat),top5:ranked.slice(0,5)};
    console.log(`  ${pos}: top=${ranked[0]?.stat}(r=${ranked[0]?.r?.toFixed(3)})`);
  }

  // ── SEASON-LEVEL CORRELATIONS (NGS/PFR) ──
  console.log('\n[2] Season-level correlations (NGS/PFR)...');
  const seasonCorr={};
  for(const pos of POSITIONS){
    seasonCorr[pos]={};
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
      if(p.length<8){seasonCorr[pos][stat]={r:null,n:p.length};continue;}
      const r=pearson(p.map(x=>x.v),p.map(x=>x.valChange));
      const best=Math.abs(r||0);
      seasonCorr[pos][stat]={r,n:p.length,
        interpretation:!r?'no data':best>0.4?'strong':best>0.25?'moderate':best>0.15?'weak':'negligible'};
      if(r)matched++;
    }
    // Merge into correlations
    for(const[stat,data]of Object.entries(seasonCorr[pos])){
      if(data.r){
        correlations[pos][stat]={_season_only:true,'30d':{r_slope:data.r,best_r:Math.abs(data.r),n:data.n,interpretation:data.interpretation},
          _summary:{best_correlation:Math.abs(data.r),best_type:'season_level',n:data.n,interpretation:data.interpretation}};
      }
    }
    // Re-rank including season stats
    const allStats=Object.keys(correlations[pos]).filter(k=>!k.startsWith('_'));
    const reranked=allStats.map(s=>({stat:s,r:Math.abs(correlations[pos][s]?._summary?.best_correlation||0)}))
      .sort((a,b)=>b.r-a.r);
    correlations[pos]._ranked={by_30d:reranked.map(r=>r.stat),top5:reranked.slice(0,5)};
    console.log(`  ${pos}: ${matched} NGS/PFR stats with data`);
  }

  // ── TRAJECTORIES (ALL historical players) ──
  console.log('\n[3] Building trajectories for ALL historical players...');
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

    // Get stats if available
    const statsP=statsByName[norm(name)];
    const s25=statsP?.seasons?.[2025];

    // Rolling 2025 stats last 6 weeks
    const rolling={};
    if(s25?.weeks?.length>=3){
      const recentWeeks=s25.weeks.slice(-6);
      const pos=statsP.pos||'WR';
      for(const stat of (WEEKLY_STATS[pos]||[])){
        const vals=recentWeeks.map(w=>parseFloat(w[stat]||0)).filter(v=>!isNaN(v)&&v>0);
        if(vals.length>=3){
          rolling[stat]={avg:Math.round(vals.reduce((a,b)=>a+b)/vals.length*100)/100,
            slope:slope(vals),trend:slope(vals)>0.1?'rising':slope(vals)<-0.1?'falling':'stable'};
        }
      }
    }

    // Composite signal score — how many key stats are rising?
    const pos=statsP?.pos;
    const keyStats=pos?WEEKLY_STATS[pos]?.slice(0,5):[];
    const risingCount=keyStats.filter(s=>rolling[s]?.trend==='rising').length;
    const fallingCount=keyStats.filter(s=>rolling[s]?.trend==='falling').length;
    const compositeSignal=keyStats.length>0?
      Math.round((risingCount-fallingCount)/keyStats.length*100):null;

    const peakValue=Math.max(...hist.sf.filter(v=>v>0));

    trajectories[name]={
      pid:statsP?.player_id||null,
      pos:pos||null,
      current_value:currentValue,
      current_date:currentDate,
      peak_value:peakValue,
      pct_of_peak:peakValue>0?Math.round(currentValue/peakValue*1000)/10:null,
      momentum:{
        vs_30d:v30>0?Math.round((currentValue-v30)/v30*1000)/10:null,
        vs_60d:v60>0?Math.round((currentValue-v60)/v60*1000)/10:null,
        vs_90d:v90>0?Math.round((currentValue-v90)/v90*1000)/10:null,
        vs_180d:v180>0?Math.round((currentValue-v180)/v180*1000)/10:null,
        direction:v30>0?(currentValue-v30)/v30>0.05?'rising':(currentValue-v30)/v30<-0.05?'falling':'stable':'unknown'
      },
      composite_signal:compositeSignal,
      rolling_2025:rolling,
      season_2025:s25?{games:s25.games,team:s25.team,...s25.totals}:null
    };
  }
  console.log(`  Trajectories: ${Object.keys(trajectories).length}`);

  // ── COMP ENGINE (trajectory shape matching) ──
  console.log('\n[4] Building comp profiles...');
  const compProfiles={};

  // For each current player, find historical players with similar:
  // 1. Value trajectory shape (rise/fall pattern over last 2 years)
  // 2. Stat profile (if available)
  // 3. Age/position/tier

  const getValueShape=(name)=>{
    const hist=histPlayers[name];
    if(!hist?.sf?.length)return null;
    // Get monthly values over last 24 months
    const recentIdx=hist.sf.reduceRight((f,v,i)=>f===-1&&v>0?i:f,-1);
    if(recentIdx<12)return null;
    // Sample 12 evenly spaced points over last 24 months
    const window=hist.sf.slice(Math.max(0,recentIdx-24),recentIdx+1);
    if(window.length<12)return null;
    const step=Math.floor(window.length/12);
    return Array.from({length:12},(_,i)=>window[i*step]||0);
  };

  const cosineSim=(a,b)=>{
    if(!a||!b||a.length!==b.length)return 0;
    const dot=a.reduce((s,v,i)=>s+v*b[i],0);
    const ma=Math.sqrt(a.reduce((s,v)=>s+v*v,0));
    const mb=Math.sqrt(b.reduce((s,v)=>s+v*v,0));
    return ma&&mb?dot/(ma*mb):0;
  };

  // Build shapes for all historical players
  const shapes={};
  for(const name of Object.keys(histPlayers)){
    const shape=getValueShape(name);
    if(shape)shapes[name]=shape;
  }
  console.log(`  Shape profiles: ${Object.keys(shapes).length}`);

  // For each player with current trajectory, find top 3 comps from EARLIER periods
  for(const[name,traj]of Object.entries(trajectories)){
    const currentShape=shapes[name];
    if(!currentShape)continue;
    const pos=traj.pos;
    const currentVal=traj.current_value;

    // Find players whose HISTORICAL trajectory shape matches
    // Use players from 2020-2023 data range (so we can see what happened AFTER)
    const candidates=[];
    for(const[compName,hist]of Object.entries(histPlayers)){
      if(compName===name)continue;
      // Get shape from 2-4 years ago for this comp player
      // then check what happened to them in the following year
      const compSf=hist.sf||[];
      const compDates=hist.dates||[];
      if(compSf.length<30)continue;

      // Try to find a 12-point window from 1-3 years ago
      for(const lookbackYr of [2023,2022,2021,2020]){
        const targetDate=`${lookbackYr}-09-01`;
        const idx=findDateIdx(compDates,targetDate);
        if(idx<12||idx>compSf.length-30)continue;
        const window=compSf.slice(idx-12,idx);
        if(window.filter(v=>v>0).length<8)continue;

        const sim=cosineSim(currentShape,window);
        if(sim<0.7)continue; // only strong matches

        // What happened to this comp player 12 months after this point?
        const valAt=compSf[idx]||0;
        const val12m=getValueAfterDays(hist,compDates[idx],365)||0;
        const valChange=valAt>0&&val12m>0?Math.round((val12m-valAt)/valAt*1000)/10:null;

        candidates.push({
          name:compName,
          season:lookbackYr,
          similarity:Math.round(sim*1000)/10,
          val_at_comp:valAt,
          val_12m_later:val12m,
          val_change_12m:valChange
        });
        break; // one window per comp player
      }
    }

    if(!candidates.length)continue;
    const top3=candidates.sort((a,b)=>b.similarity-a.similarity).slice(0,3);
    const validChanges=top3.filter(c=>c.val_change_12m!==null);

    compProfiles[name]={
      pos,
      current_value:currentVal,
      comps:top3,
      avg_comp_outcome:validChanges.length>0?
        Math.round(validChanges.reduce((s,c)=>s+c.val_change_12m,0)/validChanges.length*10)/10:null,
      projected_value_12m:validChanges.length>0&&currentVal?
        Math.round(currentVal*(1+(validChanges.reduce((s,c)=>s+c.val_change_12m,0)/validChanges.length)/100)):null
    };
  }
  console.log(`  Comp profiles: ${Object.keys(compProfiles).length}`);

  // ── OUTPUT ──
  const output={
    generated:new Date().toISOString(),
    methodology:'v2: trajectory shape matching + weekly rolling correlations + season NGS/PFR + composite signal',
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
    console.log(`  Momentum: vs30d=${t.momentum.vs_30d}% vs90d=${t.momentum.vs_90d}%`);
    console.log(`  Composite signal: ${t.composite_signal}`);
  }
  if(compProfiles['George Pickens']){
    const c=compProfiles['George Pickens'];
    console.log(`\nGeorge Pickens comps:`);
    c.comps.forEach(x=>console.log(`  ${x.name}(${x.season}): sim=${x.similarity} → ${x.val_change_12m}% 12m later`));
    console.log(`  Avg outcome: ${c.avg_comp_outcome}% | Projected: ${c.projected_value_12m}`);
  }
}

buildAnalytics().catch(e=>{console.error('FATAL:',e);process.exit(1);});
