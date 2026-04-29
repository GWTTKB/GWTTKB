// ── GWTTKB Market Intelligence Builder ──
// Runs nightly — aggregates trade data, waiver trends, and market moves
// across hundreds of Sleeper dynasty leagues
// Writes: public/data/market-intel.json

import fs from 'fs';

const SLEEPER = 'https://api.sleeper.app/v1';
const SEED_USER = '605943364277321728';
const TARGET_LEAGUES = 300;
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

async function buildMarketIntel() {
  console.log('=== Building Market Intelligence ===');

  // ── STEP 1: Trending adds/drops (Sleeper global endpoint) ──
  console.log('\nFetching global trending players...');
  const [trending24Add, trending48Add, trending24Drop] = await Promise.all([
    get(`${SLEEPER}/players/nfl/trending/add?lookback_hours=24&limit=50`),
    get(`${SLEEPER}/players/nfl/trending/add?lookback_hours=48&limit=50`),
    get(`${SLEEPER}/players/nfl/trending/drop?lookback_hours=24&limit=50`),
  ]);

  // Load player map for name lookups
  console.log('Loading player map...');
  const playerMap = await get(`${SLEEPER}/players/nfl`) || {};

  const getName = id => playerMap[id]?.full_name || id;
  const getPos = id => playerMap[id]?.position || '?';
  const getTeam = id => playerMap[id]?.team || 'FA';

  const trendingAdds = (trending48Add||[]).map(p=>({
    player_id: p.player_id,
    name: getName(p.player_id),
    pos: getPos(p.player_id),
    team: getTeam(p.player_id),
    adds_24hr: (trending24Add||[]).find(x=>x.player_id===p.player_id)?.count||0,
    adds_48hr: p.count||0,
  })).filter(p=>['QB','RB','WR','TE'].includes(p.pos));

  const trendingDrops = (trending24Drop||[]).map(p=>({
    player_id: p.player_id,
    name: getName(p.player_id),
    pos: getPos(p.player_id),
    team: getTeam(p.player_id),
    drops_24hr: p.count||0,
  })).filter(p=>['QB','RB','WR','TE'].includes(p.pos));

  console.log(`Trending adds: ${trendingAdds.length}, drops: ${trendingDrops.length}`);

  // ── STEP 2: Find dynasty leagues via snowball ──
  console.log('\nSnowballing dynasty leagues...');
  const leagueIds = new Set();
  const usersSeen = new Set();
  const usersToVisit = [SEED_USER];

  while(usersToVisit.length > 0 && leagueIds.size < TARGET_LEAGUES) {
    const userId = usersToVisit.shift();
    if(usersSeen.has(userId)) continue;
    usersSeen.add(userId);

    const leagues = await get(`${SLEEPER}/user/${userId}/leagues/nfl/${CURRENT_YEAR}`);
    if(!Array.isArray(leagues)) continue;

    for(const league of leagues) {
      if(league.settings?.type !== 2) continue; // dynasty only
      leagueIds.add(league.league_id);

      if(leagueIds.size < TARGET_LEAGUES) {
        const users = await get(`${SLEEPER}/league/${league.league_id}/users`);
        if(Array.isArray(users)) {
          for(const u of users) {
            if(!usersSeen.has(u.user_id)) usersToVisit.push(u.user_id);
          }
        }
      }
      await sleep(60);
    }
  }

  console.log(`Found ${leagueIds.size} dynasty leagues`);

  // ── STEP 3: Pull transactions from all leagues ──
  // Track: trade values, most traded players, waiver trends
  const tradeCounts = {}; // player_id → {name, pos, team, trades, adds, drops}
  const tradeValues = {}; // normalized trade values from real transactions
  const recentTrades = []; // last 500 trades for pattern analysis

  let processed = 0;

  for(const leagueId of [...leagueIds]) {
    try {
      // Pull transactions from weeks 1-3 (covers recent activity)
      const txBatches = await Promise.all(
        [1,2,3].map(w => get(`${SLEEPER}/league/${leagueId}/transactions/${w}`).catch(()=>[]))
      );
      const txs = txBatches.flat().filter(Boolean);

      for(const tx of txs) {
        const type = tx.type; // 'trade', 'free_agent', 'waiver'

        // Track adds
        for(const [pid] of Object.entries(tx.adds||{})) {
          if(!tradeCounts[pid]) tradeCounts[pid] = {
            player_id:pid, name:getName(pid), pos:getPos(pid),
            team:getTeam(pid), trades:0, adds:0, drops:0
          };
          if(type==='trade') tradeCounts[pid].trades++;
          else tradeCounts[pid].adds++;
        }

        // Track drops
        for(const [pid] of Object.entries(tx.drops||{})) {
          if(!tradeCounts[pid]) tradeCounts[pid] = {
            player_id:pid, name:getName(pid), pos:getPos(pid),
            team:getTeam(pid), trades:0, adds:0, drops:0
          };
          tradeCounts[pid].drops++;
        }

        // Store trade details for value analysis
        if(type==='trade' && recentTrades.length < 1000) {
          const sides = (tx.roster_ids||[]).map(rid => ({
            roster_id: rid,
            gets_players: Object.entries(tx.adds||{})
              .filter(([,r])=>r===rid)
              .map(([id])=>({id, name:getName(id), pos:getPos(id)})),
            gets_picks: (tx.draft_picks||[])
              .filter(pk=>pk.owner_id===rid)
              .map(pk=>({season:pk.season, round:pk.round}))
          }));

          if(sides.some(s=>s.gets_players.length>0)) {
            recentTrades.push({
              league_id: leagueId,
              week: tx.leg,
              sides
            });
          }
        }
      }

      processed++;
      if(processed % 50 === 0) {
        console.log(`  Processed ${processed}/${leagueIds.size} leagues, ${Object.keys(tradeCounts).length} players tracked`);
      }
      await sleep(40);
    } catch(e) {
      // Silent fail per league
    }
  }

  console.log(`\nProcessed ${processed} leagues`);
  console.log(`Players with transaction data: ${Object.keys(tradeCounts).length}`);

  // ── STEP 4: Compute market signals ──
  const skillPlayers = Object.values(tradeCounts)
    .filter(p => ['QB','RB','WR','TE'].includes(p.pos));

  // Most traded (buy/sell activity)
  const mostTraded = [...skillPlayers]
    .sort((a,b) => b.trades - a.trades)
    .slice(0, 30);

  // Most added (waiver/free agent demand)
  const mostAdded = [...skillPlayers]
    .sort((a,b) => b.adds - a.adds)
    .slice(0, 30);

  // Most dropped (market selling)
  const mostDropped = [...skillPlayers]
    .sort((a,b) => b.drops - a.drops)
    .slice(0, 30);

  // Buy signal: high adds, low drops = market buying
  const buySignals = skillPlayers
    .filter(p => p.adds > 3 && p.adds > p.drops * 2)
    .sort((a,b) => (b.adds-b.drops) - (a.adds-a.drops))
    .slice(0, 20);

  // Sell signal: high drops, low adds = market dumping
  const sellSignals = skillPlayers
    .filter(p => p.drops > 3 && p.drops > p.adds * 2)
    .sort((a,b) => (b.drops-b.adds) - (a.drops-a.adds))
    .slice(0, 20);

  // ── STEP 5: Trade value analysis ──
  // Find players who appear together in trades to infer relative value
  const coTrades = {}; // player combos that trade together
  for(const trade of recentTrades) {
    for(const side of trade.sides) {
      if(side.gets_players.length === 1 && trade.sides.length === 2) {
        const otherSide = trade.sides.find(s=>s!==side);
        const myPlayer = side.gets_players[0];
        const theirAssets = [
          ...otherSide.gets_players.map(p=>p.name),
          ...otherSide.gets_picks.map(pk=>pk.season+' R'+pk.round)
        ];
        const key = myPlayer.name;
        if(!coTrades[key]) coTrades[key] = {name:myPlayer.name, pos:myPlayer.pos, tradedFor:{}};
        for(const asset of theirAssets) {
          coTrades[key].tradedFor[asset] = (coTrades[key].tradedFor[asset]||0) + 1;
        }
      }
    }
  }

  // ── OUTPUT ──
  const output = {
    generated: new Date().toISOString(),
    source: `${processed} Sleeper dynasty leagues, ${recentTrades.length} trades analyzed`,
    leagues_sampled: processed,
    trades_analyzed: recentTrades.length,

    // Global trending (Sleeper's own endpoint)
    trending_adds_48hr: trendingAdds.slice(0,25),
    trending_drops_24hr: trendingDrops.slice(0,20),

    // From league transaction aggregation
    most_traded: mostTraded,
    most_added: mostAdded,
    most_dropped: mostDropped,

    // Market signals
    buy_signals: buySignals,
    sell_signals: sellSignals,

    // Trade value context
    trade_context: Object.values(coTrades)
      .filter(p => Object.keys(p.tradedFor).length >= 2)
      .sort((a,b) => Object.values(b.tradedFor).reduce((s,v)=>s+v,0) - Object.values(a.tradedFor).reduce((s,v)=>s+v,0))
      .slice(0, 50),

    // Quick lookup
    by_player: Object.fromEntries(
      skillPlayers.map(p => [p.name, {trades:p.trades, adds:p.adds, drops:p.drops}])
    )
  };

  fs.mkdirSync('public/data', { recursive: true });
  fs.writeFileSync('public/data/market-intel.json', JSON.stringify(output));

  const kb = (fs.statSync('public/data/market-intel.json').size / 1024).toFixed(0);
  console.log(`\n✓ market-intel.json: ${kb}KB`);
  console.log(`\nTop 10 most traded:`);
  for(const p of mostTraded.slice(0,10)) {
    console.log(`  ${p.name} (${p.pos},${p.team}): ${p.trades} trades, ${p.adds} adds, ${p.drops} drops`);
  }
  console.log(`\nTop buy signals:`);
  for(const p of buySignals.slice(0,5)) {
    console.log(`  ${p.name} (${p.pos}): +${p.adds} adds vs -${p.drops} drops`);
  }
}

buildMarketIntel().catch(e => { console.error('FATAL:', e); process.exit(1); });
