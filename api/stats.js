const BASE = 'https://github.com/nflverse/nflverse-data/releases/download';

const FILES = {
  // Per-season player stats (MUCH smaller than the all-time file)
  player_stats: (season) => `${BASE}/player_stats/player_stats_${season}.csv`,
  // Fallback: all-time file (large, slower)
  player_stats_all: () => `${BASE}/player_stats/player_stats.csv`,
  snap_counts:  (season) => `${BASE}/snap_counts/snap_counts_${season}.csv`,
  injuries:     (season) => `${BASE}/injuries/injuries_${season}.csv`,
  depth_charts: (season) => `${BASE}/depth_charts/depth_charts_${season}.csv`,
  pfr_pass:     (season) => `${BASE}/pfr_advstats/advstats_season_pass_${season}.csv`,
  pfr_rush:     (season) => `${BASE}/pfr_advstats/advstats_season_rush_${season}.csv`,
  pfr_rec:      (season) => `${BASE}/pfr_advstats/advstats_season_rec_${season}.csv`,
  ngs_pass:     (season) => `${BASE}/nextgen_stats/ngs_${season}_passing.csv`,
  ngs_rush:     (season) => `${BASE}/nextgen_stats/ngs_${season}_rushing.csv`,
  ngs_rec:      (season) => `${BASE}/nextgen_stats/ngs_${season}_receiving.csv`,
  players:      () => `${BASE}/players/players.csv`,
};

function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim());
  return lines.slice(1).map(line => {
    const vals = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') { inQ = !inQ; continue; }
      if (line[i] === ',' && !inQ) { vals.push(cur.trim()); cur = ''; continue; }
      cur += line[i];
    }
    vals.push(cur.trim());
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] !== undefined ? vals[i] : ''; });
    return obj;
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { file, season = '2025', position, season_type } = req.query;

  if (!file || !FILES[file]) {
    return res.status(400).json({
      error: 'Invalid file',
      available: Object.keys(FILES)
    });
  }

  try {
    const url = FILES[file](season);
    const response = await fetch(url, {
      headers: { 'User-Agent': 'GWTTKB/1.0' },
      redirect: 'follow'
    });

    if (!response.ok) {
      // If per-season file not found, try fallback for player_stats
      if (file === 'player_stats') {
        const fallbackUrl = FILES['player_stats_all']();
        const fallback = await fetch(fallbackUrl, {
          headers: { 'User-Agent': 'GWTTKB/1.0' },
          redirect: 'follow'
        });
        if (!fallback.ok) {
          return res.status(404).json({ error: `File not found: ${file} ${season}`, url });
        }
        let rows = parseCSV(await fallback.text());
        rows = rows.filter(r => r.season === String(season) && r.season_type === 'REG');
        if (position) {
          const positions = position.toUpperCase().split(',');
          rows = rows.filter(r => positions.includes((r.position || '').toUpperCase()));
        }
        return res.status(200).json({ file, season, count: rows.length, rows, source: 'fallback' });
      }
      return res.status(404).json({ error: `File not found: ${file} ${season}`, url });
    }

    let rows = parseCSV(await response.text());

    // For per-season player_stats files, filter by season_type only (season is already in filename)
    if (file === 'player_stats') {
      const st = season_type || 'REG';
      rows = rows.filter(r => (r.season_type || 'REG') === st);
    }

    // Position filter - supports comma-separated e.g. position=QB,RB,WR,TE
    if (position) {
      const positions = position.toUpperCase().split(',');
      rows = rows.filter(r => positions.includes((r.position || r.pos || '').toUpperCase()));
    }

    return res.status(200).json({
      file,
      season,
      count: rows.length,
      rows
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
