const https = require('https');
const http = require('http');

function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map(line => {
    const values = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim());
    const obj = {};
    headers.forEach((header, index) => {
      obj[header] = values[index] !== undefined ? values[index] : '';
    });
    return obj;
  });
}

function fetchURL(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const request = protocol.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        return fetchURL(response.headers.location).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        return reject(new Error(`HTTP ${response.statusCode} for ${url}`));
      }
      let data = '';
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => resolve(data));
    });
    request.on('error', reject);
    request.setTimeout(30000, () => {
      request.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const {
      season = '2025',
      season_type,        // optional: 'reg', 'post', 'week' — defaults to reg
      position,
      player_id,
      player_name,
      week,
      limit,
    } = req.query;

    // Determine which file to fetch
    // Files available: stats_player_week_2025.csv, stats_player_reg_2025.csv, stats_player_post_2025.csv
    const fileType = season_type === 'post' ? 'post' : season_type === 'week' ? 'week' : 'reg';
    const BASE = 'https://github.com/nflverse/nflverse-data/releases/download/stats_player';
    const url = `${BASE}/stats_player_${fileType}_${season}.csv`;

    console.log(`Fetching stats from: ${url}`);
    const csvText = await fetchURL(url);
    let data = parseCSV(csvText);

    // Filter by position
    if (position) {
      const positions = position.toUpperCase().split(',').map(p => p.trim());
      data = data.filter(row => {
        const pos = (row.position || row.pos || '').toUpperCase();
        return positions.includes(pos);
      });
    }

    // Filter by player_id
    if (player_id) {
      data = data.filter(row =>
        row.player_id === player_id || row.gsis_id === player_id
      );
    }

    // Filter by player name (partial, case-insensitive)
    if (player_name) {
      const nameLower = player_name.toLowerCase();
      data = data.filter(row =>
        (row.player_name || row.player_display_name || '').toLowerCase().includes(nameLower)
      );
    }

    // Filter by week
    if (week) {
      data = data.filter(row => String(row.week) === String(week));
    }

    // Apply limit
    if (limit) {
      const n = parseInt(limit, 10);
      if (!isNaN(n) && n > 0) {
        data = data.slice(0, n);
      }
    }

    return res.status(200).json({
      success: true,
      season,
      season_type: fileType,
      count: data.length,
      data,
    });
  } catch (error) {
    console.error('Stats API error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to fetch player stats from nflverse',
    });
  }
};
