// ── GWTTKB Coaching Staff Builder ──
// Scrapes Wikipedia for NFL HC + OC history 2015-2026
// Writes: public/data/coaching-staff.json

import fs from 'fs';

const HEADERS = { 'User-Agent': 'GWTTKB/1.0 (dynasty fantasy football research)' };
const START_YEAR = 2015;
const END_YEAR = 2026;

// Wikipedia pages for each team's coaching staff history
const TEAM_WIKI_PAGES = {
  ARI: 'Arizona_Cardinals_head_coaches',
  ATL: 'Atlanta_Falcons_head_coaches',
  BAL: 'Baltimore_Ravens_head_coaches',
  BUF: 'Buffalo_Bills_head_coaches',
  CAR: 'Carolina_Panthers_head_coaches',
  CHI: 'Chicago_Bears_head_coaches',
  CIN: 'Cincinnati_Bengals_head_coaches',
  CLE: 'Cleveland_Browns_head_coaches',
  DAL: 'Dallas_Cowboys_head_coaches',
  DEN: 'Denver_Broncos_head_coaches',
  DET: 'Detroit_Lions_head_coaches',
  GB:  'Green_Bay_Packers_head_coaches',
  HOU: 'Houston_Texans_head_coaches',
  IND: 'Indianapolis_Colts_head_coaches',
  JAX: 'Jacksonville_Jaguars_head_coaches',
  KC:  'Kansas_City_Chiefs_head_coaches',
  LAC: 'Los_Angeles_Chargers_head_coaches',
  LAR: 'Los_Angeles_Rams_head_coaches',
  LV:  'Las_Vegas_Raiders_head_coaches',
  MIA: 'Miami_Dolphins_head_coaches',
  MIN: 'Minnesota_Vikings_head_coaches',
  NE:  'New_England_Patriots_head_coaches',
  NO:  'New_Orleans_Saints_head_coaches',
  NYG: 'New_York_Giants_head_coaches',
  NYJ: 'New_York_Jets_head_coaches',
  PHI: 'Philadelphia_Eagles_head_coaches',
  PIT: 'Pittsburgh_Steelers_head_coaches',
  SEA: 'Seattle_Seahawks_head_coaches',
  SF:  'San_Francisco_49ers_head_coaches',
  TB:  'Tampa_Bay_Buccaneers_head_coaches',
  TEN: 'Tennessee_Titans_head_coaches',
  WAS: 'Washington_Commanders_head_coaches',
};

// Wikipedia REST API - returns page content as JSON
async function fetchWikiPage(title) {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) return null;
    return res.json();
  } catch(e) { return null; }
}

// Wikipedia search to find correct page title
async function searchWiki(query) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=3`;
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) return null;
    const data = await res.json();
    return data.query?.search?.[0]?.title || null;
  } catch(e) { return null; }
}

// Fetch full Wikipedia page HTML and extract coaching tables
async function fetchWikiPageContent(title) {
  const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&format=json`;
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) return null;
    const data = await res.json();
    return data.parse?.wikitext?.['*'] || null;
  } catch(e) { return null; }
}

// Parse wikitext to extract coaching staff by year
function parseCoachingHistory(wikitext, team) {
  const byYear = {};

  if (!wikitext) return byYear;

  // Look for year patterns in the wikitext
  // Wikipedia coaching tables often have: | 2020 || Coach Name
  const lines = wikitext.split('\n');

  let currentCoach = null;
  let coachYears = [];

  for (const line of lines) {
    // Match year ranges like "2020–2023" or "2020–present" or just "2020"
    const yearRangeMatch = line.match(/(\d{4})[–\-](\d{4}|present|current)/i);
    const singleYearMatch = line.match(/\|\s*(\d{4})\s*\|/);

    // Match coach names
    const coachMatch = line.match(/\[\[([^\]]+)\]\]/) || line.match(/\|\s*([A-Z][a-z]+ [A-Z][a-z]+)/);

    if (yearRangeMatch) {
      const startYr = parseInt(yearRangeMatch[1]);
      const endYr = yearRangeMatch[2].toLowerCase().includes('present') ||
                    yearRangeMatch[2].toLowerCase().includes('current')
                    ? END_YEAR
                    : parseInt(yearRangeMatch[2]);

      for (let yr = Math.max(startYr, START_YEAR); yr <= Math.min(endYr, END_YEAR); yr++) {
        if (!byYear[yr]) byYear[yr] = {};
        coachYears.push(yr);
      }
    }
  }

  return byYear;
}

// Since Wikipedia parsing is complex, use the Wikipedia API's structured data
// Better approach: use Wikipedia's action=query with prop=revisions to get structured content
// Then parse the coaching tables

// Most reliable: hardcode from known authoritative data for 2015-2026
// Wikipedia IS the source - we'll fetch each team's page and parse HC rows

async function fetchTeamCoachingData(team) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Try direct Wikipedia API query for the team's season articles
  // Each NFL team has a season article like "2024 Dallas Cowboys season"
  // which lists HC and OC

  const byYear = {};

  for (let yr = START_YEAR; yr <= END_YEAR; yr++) {
    await sleep(100); // rate limit Wikipedia

    // Team name mapping for Wikipedia article titles
    const teamNames = {
      ARI: 'Arizona Cardinals', ATL: 'Atlanta Falcons', BAL: 'Baltimore Ravens',
      BUF: 'Buffalo Bills', CAR: 'Carolina Panthers', CHI: 'Chicago Bears',
      CIN: 'Cincinnati Bengals', CLE: 'Cleveland Browns', DAL: 'Dallas Cowboys',
      DEN: 'Denver Broncos', DET: 'Detroit Lions', GB: 'Green Bay Packers',
      HOU: 'Houston Texans', IND: 'Indianapolis Colts', JAX: 'Jacksonville Jaguars',
      KC: 'Kansas City Chiefs', LAC: 'Los Angeles Chargers', LAR: 'Los Angeles Rams',
      LV: 'Las Vegas Raiders', MIA: 'Miami Dolphins', MIN: 'Minnesota Vikings',
      NE: 'New England Patriots', NO: 'New Orleans Saints', NYG: 'New York Giants',
      NYJ: 'New York Jets', PHI: 'Philadelphia Eagles', PIT: 'Pittsburgh Steelers',
      SEA: 'Seattle Seahawks', SF: 'San Francisco 49ers', TB: 'Tampa Bay Buccaneers',
      TEN: 'Tennessee Titans', WAS: 'Washington Commanders'
    };

    const teamName = teamNames[team];
    const pageTitle = `${yr} ${teamName} season`;

    const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(pageTitle)}&prop=wikitext&format=json&redirects=1`;

    try {
      const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
      if (!res.ok) continue;
      const data = await res.json();
      const wikitext = data.parse?.wikitext?.['*'] || '';

      if (!wikitext) continue;

      // Extract HC from infobox - pattern: | head_coach = [[Name]]
      const hcMatch = wikitext.match(/\|\s*head_coach\s*=\s*\[\[([^\]|]+)/i) ||
                      wikitext.match(/\|\s*head coach\s*=\s*\[\[([^\]|]+)/i) ||
                      wikitext.match(/\|\s*head_coach\s*=\s*([A-Z][a-z]+\s[A-Z][a-z]+)/i);

      // Extract OC - pattern: | offensive_coordinator = [[Name]]
      const ocMatch = wikitext.match(/\|\s*offensive_coordinator\s*=\s*\[\[([^\]|]+)/i) ||
                      wikitext.match(/\|\s*offensive coordinator\s*=\s*\[\[([^\]|]+)/i) ||
                      wikitext.match(/\|\s*offensive_coordinator\s*=\s*([A-Z][a-z]+\s[A-Z][a-z]+)/i);

      // Extract scheme
      const schemeMatch = wikitext.match(/\|\s*offense\s*=\s*([^\n\|]+)/i) ||
                          wikitext.match(/\|\s*offensive_scheme\s*=\s*([^\n\|]+)/i);

      const hc = hcMatch ? hcMatch[1].trim().replace(/\|.*$/, '').trim() : null;
      const oc = ocMatch ? ocMatch[1].trim().replace(/\|.*$/, '').trim() : null;
      const scheme = schemeMatch ? schemeMatch[1].trim().replace(/\[\[|\]\]/g, '').replace(/\|.*$/, '').trim() : null;

      byYear[yr] = {
        hc: hc || 'Unknown',
        oc: oc || 'Unknown',
        scheme: scheme || '',
        source: 'Wikipedia'
      };

      if (hc) {
        console.log(`    ${team} ${yr}: HC=${hc} OC=${oc || '?'}`);
      }

    } catch(e) {
      // Silent fail for individual years
    }
  }

  return byYear;
}

async function buildCoachingStaff() {
  console.log('\n=== Building NFL Coaching Staff History (Wikipedia) ===');
  console.log(`Years: ${START_YEAR}-${END_YEAR}`);
  fs.mkdirSync('public/data', { recursive: true });

  const allTeams = {};
  const teams = Object.keys(TEAM_WIKI_PAGES);

  for (const team of teams) {
    console.log(`\n  Fetching ${team}...`);
    try {
      allTeams[team] = await fetchTeamCoachingData(team);
      const found = Object.values(allTeams[team]).filter(y => y.hc !== 'Unknown').length;
      console.log(`  ${team}: ${found}/${END_YEAR - START_YEAR + 1} years found`);
    } catch(e) {
      console.warn(`  ${team} failed:`, e.message);
      allTeams[team] = {};
    }
    // Rate limit between teams
    await new Promise(r => setTimeout(r, 500));
  }

  // Summary stats
  let totalFound = 0;
  let totalPossible = teams.length * (END_YEAR - START_YEAR + 1);
  for (const teamData of Object.values(allTeams)) {
    for (const yr of Object.values(teamData)) {
      if (yr.hc && yr.hc !== 'Unknown') totalFound++;
    }
  }

  const output = {
    generated: new Date().toISOString(),
    source: 'Wikipedia NFL season articles',
    years_covered: `${START_YEAR}-${END_YEAR}`,
    coverage: `${totalFound}/${totalPossible} team-years`,
    teams: allTeams
  };

  fs.writeFileSync('public/data/coaching-staff.json', JSON.stringify(output));
  const kb = (fs.statSync('public/data/coaching-staff.json').size / 1024).toFixed(0);
  console.log(`\n✓ coaching-staff.json: ${totalFound}/${totalPossible} team-years, ${kb}KB`);
}

buildCoachingStaff().catch(console.error);
