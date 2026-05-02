const BASE = 'https://github.com/nflverse/nflverse-data/releases/download';

const FILES = {
  // Player stats — try both URL formats (nflverse changed format for 2025+)
  player_stats_week:   (season) => parseInt(season) >= 2025
    ? `${BASE}/stats_player/stats_player_week_${season}.csv`
    : `${BASE}/player_stats/player_stats_${season}.csv`,
  player_stats_reg:    (season) => parseInt(season) >= 2025
    ? `${BASE}/stats_player/stats_player_week_${season}.csv`
    : `${BASE}/player_stats/player_stats_${season}.csv`,
  player_stats_post:   (season) => parseInt(season) >= 2025
    ? `${BASE}/stats_player/stats_player_week_post_${season}.csv`
    : `${BASE}/player_stats/player_stats_post_${season}.csv`,
  // Snap counts
  snap_counts:         (season) => `${BASE}/snap_counts/snap_counts_${season}.csv`,
  // Injuries
  injuries:            (season) => `${BASE}/injuries/injuries_${season}.csv`,
  // Depth charts
  depth_charts:        (season) => `${BASE}/depth_charts/depth_charts_${season}.csv`,
  // PFR advanced stats — parquet, filter by season after loading
  pfr_pass:            (season) => `${BASE}/pfr_advstats/advstats_season_pass_${season}.parquet`,
  pfr_rush:            (season) => `${BASE}/pfr_advstats/advstats_season_rush_${season}.parquet`,
  pfr_rec:             (season) => `${BASE}/pfr_advstats/advstats_season_rec_${season}.parquet`,
  // NGS stats — discover actual filenames via GitHub API
  // Release exists at nextgen_stats but exact filenames unknown
  ngs_pass:            (season) => `${BASE}/nextgen_stats/nextgen_stats_passing_${season}.parquet`,
  ngs_rush:            (season) => `${BASE}/nextgen_stats/nextgen_stats_rushing_${season}.parquet`,
  ngs_rec:             (season) => `${BASE}/nextgen_stats/nextgen_stats_receiving_${season}.parquet`,
  // Players
  players:             () => `${BASE}/players/players.csv`,
};

// Parquet files — use hyparquet
const PARQUET_FILES = new Set(['pfr_pass','pfr_rush','pfr_rec','ngs_pass','ngs_rush','ngs_rec']);

// Handles quoted fields with embedded commas and escaped double-quotes ("")
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return { headers: [], rows: [] };

  const parseLine = (line) => {
    const vals = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; continue; } // escaped quote
        inQ = !inQ;
        continue;
      }
      if (ch === ',' && !inQ) { vals.push(cur); cur = ''; continue; }
      cur += ch;
    }
    vals.push(cur);
    return vals.map(v => v.trim());
  };

  const headers = parseLine(lines[0]).map(h => h.replace(/^"|"$/g, ''));
  const rows = lines.slice(1).map(line => {
    const vals = parseLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] !== undefined ? vals[i] : ''; });
    return obj;
  });
  return { headers, rows };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { file, season = '2025', position, position_group, meta, limit } = req.query;

  if (!file || !FILES[file]) {
    return res.status(400).json({
      error: 'Invalid file',
      available: Object.keys(FILES),
      usage: {
        basic: '/api/stats?file=player_stats_week&season=2025&position=QB',
        meta:  '/api/stats?file=player_stats_week&season=2025&meta=1',
        group: '/api/stats?file=player_stats_week&season=2025&position_group=QB',
        limit: '/api/stats?file=player_stats_week&season=2025&limit=5'
      }
    });
  }

  try {
    // Special: discover NGS filenames via GitHub API BEFORE trying the URL
    if (file.startsWith('ngs_')) {
      const statType = file === 'ngs_pass' ? 'passing' : file === 'ngs_rush' ? 'rushing' : 'receiving';
      try {
        const ghRes = await fetch('https://api.github.com/repos/nflverse/nflverse-data/releases/tags/nextgen_stats', {
          headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'GWTTKB/1.0' }
        });
        if (ghRes.ok) {
          const release = await ghRes.json();
          const assets = release.assets || [];
          return res.status(200).json({
            file, season,
            message: 'NGS release asset list - use these filenames',
            release_name: release.name,
            all_assets: assets.map(a => a.name),
            matching_assets: assets.filter(a => a.name.includes(statType)).map(a => ({
              name: a.name,
              download_url: a.browser_download_url
            }))
          });
        }
      } catch(e) {
        console.warn('GitHub API discovery error:', e.message);
      }
    }

    const url = FILES[file](season);
    const response = await fetch(url, {
      headers: { 'User-Agent': 'GWTTKB/1.0' },
      redirect: 'follow'
    });

    if (!response.ok) {
      return res.status(404).json({
        error: `File not found: ${file} ${season}`,
        url_tried: url,
        nflverse_status: response.status,
        url
      });
    }

    let headers, rows;

    if (PARQUET_FILES.has(file)) {
      // Parse parquet binary using hyparquet
      try {
        const { parquetReadObjects } = await import('hyparquet');
        const arrayBuffer = await response.arrayBuffer();
        rows = await parquetReadObjects({ file: arrayBuffer });
        headers = rows.length > 0 ? Object.keys(rows[0]) : [];
        // NGS files contain all years — filter by season
        if (file.startsWith('ngs_') && season) {
          rows = rows.filter(r => String(r.season) === String(season));
        }
      } catch(parquetErr) {
        return res.status(500).json({ error: `Parquet parse failed: ${parquetErr.message}`, url });
      }
    } else {
      const parsed = parseCSV(await response.text());
      headers = parsed.headers;
      rows = parsed.rows;
    }

    // META mode: return only schema + a sample row (super lightweight)
    if (meta) {
      return res.status(200).json({
        file,
        season,
        url,
        columnCount: headers.length,
        rowCount: rows.length,
        columns: headers,
        sample: rows[0] || null
      });
    }

    // Filter: position (legacy field, may be DT/DE/etc in new file)
    let filtered = rows;
    if (position) {
      const positions = position.toUpperCase().split(',');
      filtered = filtered.filter(r =>
        positions.includes((r.position || r.pos || '').toUpperCase())
      );
    }

    // Filter: position_group (new field — QB/RB/WR/TE/OL/DL/LB/DB/SPEC)
    if (position_group) {
      const groups = position_group.toUpperCase().split(',');
      filtered = filtered.filter(r =>
        groups.includes((r.position_group || '').toUpperCase())
      );
    }

    // Optional limit for quick inspection
    if (limit) {
      const n = parseInt(limit, 10);
      if (Number.isFinite(n) && n > 0) filtered = filtered.slice(0, n);
    }

    return res.status(200).json({
      file,
      season,
      count: filtered.length,
      totalRows: rows.length,
      rows: filtered
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
