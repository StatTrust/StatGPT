#!/usr/bin/env node
/**
 * Very first pass converter: messy compiled JSON -> clean v1 schema skeleton.
 * Usage:
 *   node scripts/convert-compiled-nfl.js <input.json> <output.json> <HOME_ABBR> <AWAY_ABBR> [SEASON_YEAR]
 * Example:
 *   node scripts/convert-compiled-nfl.js data/compiled-28.json out/compiled_nfl_v1.json BUF PIT 2021
 *
 * What this does now:
 * - Creates the v1 top-level structure with empty sections (placeholders).
 * - Converts Money Line History into moneylinemovement.history (numbers).
 * - Sets moneylinemovement.current if a "Current" row exists (or uses last row).
 * - Tries to fill range_home and range_away from “Matchup Menu” and “Line Movement” sections if present.
 *
 * We will add the other sections (injuries, matchupstats, etc.) in the next steps.
 */

const fs = require('fs');
const path = require('path');

function readJSON(p) {
  const raw = fs.readFileSync(p, 'utf8');
  return JSON.parse(raw);
}

function writeJSON(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

function get(obj, pathArr, def = undefined) {
  try {
    return pathArr.reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj) ?? def;
  } catch {
    return def;
  }
}

function parseMoney(val) {
  if (val == null) return null;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    // "+233" or "-267"
    const n = parseInt(val.replace(/\s/g, ''), 10);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function monthToNum(m) {
  const map = { Jan:1, Feb:2, Mar:3, Apr:4, May:5, Jun:6, Jul:7, Aug:8, Sep:9, Oct:10, Nov:11, Dec:12 };
  return map[m] || null;
}

// Try to parse strings like "Sep 12 1:02 PM" using a season year.
// Returns ISO string or null if it can’t parse.
function parseToISO(label, seasonYear) {
  if (!label || typeof label !== 'string') return null;
  // Already ISO?
  if (/^\d{4}-\d{2}-\d{2}T/.test(label)) return label;

  // Examples seen: "Sep 12 1:02 PM", "09/12 01:05 PM"
  try {
    let year = parseInt(seasonYear, 10);
    if (!year || Number.isNaN(year)) {
      // fallback: use current year
      year = new Date().getUTCFullYear();
    }

    // Format A: "Sep 12 1:02 PM"
    const a = label.match(/^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/);
    if (a) {
      const mon = monthToNum(a[1]);
      let hh = parseInt(a[3], 10);
      const mm = parseInt(a[4], 10);
      const ampm = a[5];
      if (ampm === 'PM' && hh !== 12) hh += 12;
      if (ampm === 'AM' && hh === 12) hh = 0;
      const iso = new Date(Date.UTC(year, mon - 1, parseInt(a[2], 10), hh, mm, 0)).toISOString();
      return iso;
    }

    // Format B: "09/12 01:05 PM"
    const b = label.match(/^(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})\s*(AM|PM)$/);
    if (b) {
      const mon = parseInt(b[1], 10);
      const day = parseInt(b[2], 10);
      let hh = parseInt(b[3], 10);
      const mm = parseInt(b[4], 10);
      const ampm = b[5];
      if (ampm === 'PM' && hh !== 12) hh += 12;
      if (ampm === 'AM' && hh === 12) hh = 0;
      const iso = new Date(Date.UTC(year, mon - 1, day, hh, mm, 0)).toISOString();
      return iso;
    }

    // Accept tokens like "Current", "Open" → no ISO
    return null;
  } catch {
    return null;
  }
}

// Detect team keys from a record (anything that isn't "time stamp"/"timestamp"/"label")
function detectTeamKeys(rec) {
  const ignore = new Set(['time stamp', 'timestamp', 'label']);
  return Object.keys(rec || {}).filter(k => !ignore.has(k));
}

function extractMoneyLineHistory(raw, homeKey, awayKey, seasonYear) {
  const out = [];
  if (!Array.isArray(raw)) return out;

  // Try to infer team keys from the first row that has at least 2 team columns.
  let inferred = null;
  for (const rec of raw) {
    const keys = detectTeamKeys(rec);
    if (keys.length >= 2) {
      inferred = keys;
      break;
    }
  }

  for (const rec of raw) {
    const label = rec['time stamp'] ?? rec['timestamp'] ?? rec['label'] ?? '';
    const timestamp = parseToISO(label, seasonYear);

    let hk = homeKey;
    let ak = awayKey;

    // If provided keys aren't present, fall back to inferred ones.
    if (!rec[hk] || !rec[ak]) {
      if (inferred && inferred.length >= 2) {
        // If the provided keys don't match, assume inferred[1] is home (usually favorite) if negative,
        // but we don't know. We'll just map inferred[0] => away, inferred[1] => home for consistency.
        ak = inferred[0];
        hk = inferred[1];
      }
    }

    const home = parseMoney(rec[hk]);
    const away = parseMoney(rec[ak]);

    // Skip lines with no money values (like header markers)
    if (home == null && away == null) continue;

    out.push({
      timestamp: timestamp || null,
      label: label || null,
      home,
      away
    });
  }
  return out;
}

function reduceRange(records, side /* 'home' | 'away' */) {
  // Find labels like Open/High/Low/Last across rows
  // Records look like: { team_line: "BUF -267", price_label_1: "Open", price_1: -285, price_label_2: "High", price_2: -315 }
  const range = { open: null, high: null, low: null, last: null };
  if (!Array.isArray(records)) return range;

  const setIfLabel = (label, value) => {
    if (typeof value !== 'number') return;
    const L = (label || '').toLowerCase();
    if (L.includes('open') && range.open == null) range.open = value;
    if (L.includes('high') && range.high == null) range.high = value;
    if (L.includes('low') && range.low == null) range.low = value;
    if (L.includes('last') && range.last == null) range.last = value;
  };

  for (const r of records) {
    setIfLabel(r.price_label_1, r.price_1);
    setIfLabel(r.price_label_2, r.price_2);
  }

  return range;
}

function extractMoneylineRanges(moneylineMovementSection, homeKey, awayKey) {
  // moneylineMovementSection is expected to be an object with keys like:
  // "Matchup Menu: PIT @ BUF": [ ...home rows... ]
  // "Line Movement": [ ...away rows... ]
  const keys = Object.keys(moneylineMovementSection || {});
  const matchupKey = keys.find(k => /matchup menu/i.test(k)) || null;
  const awayKeyBlock = keys.find(k => /^line movement$/i.test(k)) || null;

  const homeRows = matchupKey ? moneylineMovementSection[matchupKey] : null;
  const awayRows = awayKeyBlock ? moneylineMovementSection[awayKeyBlock] : null;

  const range_home = reduceRange(homeRows, 'home');
  const range_away = reduceRange(awayRows, 'away');
  return { range_home, range_away };
}

function main() {
  const [, , inputPath, outputPath, HOME_ABBR, AWAY_ABBR, SEASON_YEAR] = process.argv;

  if (!inputPath || !outputPath) {
    console.error('Usage: node scripts/convert-compiled-nfl.js <input.json> <output.json> <HOME_ABBR> <AWAY_ABBR> [SEASON_YEAR]');
    process.exit(1);
  }

  const input = readJSON(inputPath);

  // Try to find the "Money Line History" array (case insensitive search through moneylinemovement)
  const moneylineMovementSection = get(input, ['moneylinemovement']) || get(input, ['Money Line Movement']) || {};
  const mlHistory =
    get(moneylineMovementSection, ['Money Line History']) ||
    get(moneylineMovementSection, ['money line history']) ||
    get(moneylineMovementSection, ['history']) || [];

  const history = extractMoneyLineHistory(mlHistory, HOME_ABBR, AWAY_ABBR, SEASON_YEAR);

  // Determine current from a "Current" row, else last row
  let current = { home: null, away: null };
  const currentRow = history.find(h => (h.label || '').toLowerCase() === 'current');
  const effective = currentRow || history[0] || null;
  if (effective) current = { home: effective.home, away: effective.away };

  // Ranges
  const { range_home, range_away } = extractMoneylineRanges(moneylineMovementSection, HOME_ABBR, AWAY_ABBR);

  const compiled = {
    meta: {
      league: 'NFL',
      season: SEASON_YEAR ? parseInt(SEASON_YEAR, 10) : undefined,
      home_team: HOME_ABBR || null,
      away_team: AWAY_ABBR || null,
      generated_at: new Date().toISOString()
    },

    // Placeholders for now; we will fill these in later steps.
    dualgamelog: {},
    efficiencystats: {},
    headtohead: {},
    injuryreport: {},
    matchupstats: {},
    moneylineanalysis: {},

    moneylinemovement: {
      current,
      range_home,
      range_away,
      history
    },

    overunderanalysis: {},
    overunderlinemovement: {},
    overview: {},
    pointspreadanalysis: {},
    pointspreadlinemovement: {},
    powerratings: {},
    similargamesanalysis: {},
    situationaltrends: {},
    statsplits: {},
    travelanalysis: {}
  };

  writeJSON(outputPath, compiled);
  console.log(`Wrote ${outputPath}`);
}

if (require.main === module) {
  main();
}
