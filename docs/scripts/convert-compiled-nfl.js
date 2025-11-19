#!/usr/bin/env node
/**
 * Robust pass: messy compiled JSON -> clean v1 schema skeleton (+ Money Line Movement).
 * - Uses exact paths you discovered, with fallbacks.
 * - Only picks range arrays from moneylinemovement (ignores pointspread/overunder).
 *
 * Usage:
 *   node docs/scripts/convert-compiled-nfl.js <input.json> <output.json> <HOME_ABBR> <AWAY_ABBR> [SEASON_YEAR]
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

function parseMoney(val) {
  if (val == null) return null;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const n = parseInt(val.trim().replace(/\s/g, ''), 10);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function monthToNum(m) {
  const map = { Jan:1, Feb:2, Mar:3, Apr:4, May:5, Jun:6, Jul:7, Aug:8, Sep:9, Oct:10, Nov:11, Dec:12 };
  return map[m] || null;
}

function parseToISO(label, seasonYear) {
  if (!label || typeof label !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(label)) return label;
  try {
    let year = parseInt(seasonYear, 10);
    if (!year || Number.isNaN(year)) year = new Date().getUTCFullYear();

    const a = label.match(/^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/);
    if (a) {
      const mon = monthToNum(a[1]);
      let hh = parseInt(a[3], 10);
      const mm = parseInt(a[4], 10);
      const ampm = a[5];
      if (ampm === 'PM' && hh !== 12) hh += 12;
      if (ampm === 'AM' && hh === 12) hh = 0;
      return new Date(Date.UTC(year, mon - 1, parseInt(a[2], 10), hh, mm, 0)).toISOString();
    }

    const b = label.match(/^(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})\s*(AM|PM)$/);
    if (b) {
      const mon = parseInt(b[1], 10);
      const day = parseInt(b[2], 10);
      let hh = parseInt(b[3], 10);
      const mm = parseInt(b[4], 10);
      const ampm = b[5];
      if (ampm === 'PM' && hh !== 12) hh += 12;
      if (ampm === 'AM' && hh === 12) hh = 0;
      return new Date(Date.UTC(year, mon - 1, day, hh, mm, 0)).toISOString();
    }
    return null;
  } catch {
    return null;
  }
}

function walk(obj, fn, pathArr = []) {
  if (!obj || typeof obj !== 'object') return;
  fn(obj, pathArr);
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => walk(v, fn, pathArr.concat([i])));
  } else {
    for (const k of Object.keys(obj)) walk(obj[k], fn, pathArr.concat([k]));
  }
}

function get(obj, pathArr, def = undefined) {
  try {
    return pathArr.reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj) ?? def;
  } catch {
    return def;
  }
}

function detectTeamKeys(rec, preferredHome, preferredAway) {
  const ignore = new Set(['time stamp', 'timestamp', 'label']);
  const keys = Object.keys(rec || {}).filter(k => !ignore.has(k));
  // Prefer provided abbreviations
  const hasHome = preferredHome && keys.includes(preferredHome);
  const hasAway = preferredAway && keys.includes(preferredAway);
  if (hasHome && hasAway) return { homeKey: preferredHome, awayKey: preferredAway };
  // Fallback: pick first two, map [0] => away, [1] => home consistently
  if (keys.length >= 2) return { homeKey: keys[1], awayKey: keys[0] };
  return { homeKey: null, awayKey: null };
}

function extractMoneyLineHistory(arr, preferredHome, preferredAway, seasonYear) {
  const out = [];
  if (!Array.isArray(arr)) return out;
  let keysChosen = null;

  for (const rec of arr) {
    if (!rec || typeof rec !== 'object') continue;
    if (!keysChosen) keysChosen = detectTeamKeys(rec, preferredHome, preferredAway);
    const label = rec['time stamp'] ?? rec['timestamp'] ?? rec['label'] ?? '';
    const timestamp = parseToISO(label, seasonYear);
    const home = parseMoney(rec[keysChosen.homeKey]);
    const away = parseMoney(rec[keysChosen.awayKey]);
    if (home == null && away == null) continue;
    out.push({ timestamp: timestamp || null, label: label || null, home, away });
  }
  return out;
}

function reduceRange(records) {
  const range = { open: null, high: null, low: null, last: null };
  if (!Array.isArray(records)) return range;

  const setIfLabel = (label, value) => {
    const L = String(label || '').toLowerCase();
    const val = typeof value === 'string' ? parseMoney(value) : value;
    if (typeof val !== 'number') return;
    if (L.includes('open') && range.open == null) range.open = val;
    if (L.includes('high') && range.high == null) range.high = val;
    if (L.includes('low') && range.low == null) range.low = val;
    if (L.includes('last') && range.last == null) range.last = val;
  };

  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    setIfLabel(r.price_label_1, r.price_1);
    setIfLabel(r.price_label_2, r.price_2);
  }
  return range;
}

// Find arrays with price_label_1/price_1 and return both path & arr
function findRangeArraysWithPaths(root) {
  const out = [];
  walk(root, (node, pathArr) => {
    if (!Array.isArray(node)) return;
    const first = node.find(v => v && typeof v === 'object');
    if (!first) return;
    const keys = Object.keys(first);
    const hasPrice = keys.some(k => /^price_?label_?1$/i.test(k) || /^price_?1$/i.test(k));
    if (hasPrice) out.push({ path: pathArr.join('.'), arr: node });
  });
  return out;
}

function main() {
  const [, , inputPath, outputPath, HOME_ABBR, AWAY_ABBR, SEASON_YEAR] = process.argv;
  if (!inputPath || !outputPath) {
    console.error('Usage: node docs/scripts/convert-compiled-nfl.js <input.json> <output.json> <HOME_ABBR> <AWAY_ABBR> [SEASON_YEAR]');
    process.exit(1);
  }

  const root = readJSON(inputPath);

  // 1) HISTORY — try exact path first (from your debug), then fallback search
  let histArr =
    get(root, ['raw', 'moneylinemovement', 'data', 'sections', 'Money Line History']) ||
    null;

  if (!histArr) {
    // Fallback: recursive search for any array under a key containing "Money Line" and "History"
    walk(root, (node, pathArr) => {
      if (!histArr && Array.isArray(node)) {
        const lastKey = String(pathArr[pathArr.length - 1] ?? '');
        if (/money\s*line/i.test(lastKey) && /history/i.test(lastKey)) histArr = node;
      }
    });
  }

  const history = extractMoneyLineHistory(histArr, HOME_ABBR, AWAY_ABBR, SEASON_YEAR);

  // 2) CURRENT — prefer a "Current" labeled row if present
  let current = { home: null, away: null };
  if (history.length) {
    const currentRow = history.find(h => (h.label || '').toLowerCase() === 'current') || history[0];
    current = { home: currentRow.home ?? null, away: currentRow.away ?? null };
  }

  // 3) RANGES — use only moneylinemovement arrays
  const ranges = findRangeArraysWithPaths(root)
    .filter(x => /(^|\.)(moneylinemovement)(\.|$)/i.test(x.path)); // keep only moneyline movement

  // Try to pick "Matchup Menu" as home and "Line Movement" as away
  const homeRangeArr = ranges.find(x => /matchup menu/i.test(x.path))?.arr || ranges[0]?.arr || [];
  const awayRangeArr = ranges.find(x => /line movement/i.test(x.path))?.arr || ranges[1]?.arr || [];

  const range_home = reduceRange(homeRangeArr);
  const range_away = reduceRange(awayRangeArr);

  const compiled = {
    meta: {
      league: 'NFL',
      season: SEASON_YEAR ? parseInt(SEASON_YEAR, 10) : undefined,
      home_team: HOME_ABBR || null,
      away_team: AWAY_ABBR || null,
      generated_at: new Date().toISOString()
    },

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
