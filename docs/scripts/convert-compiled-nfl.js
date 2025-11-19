#!/usr/bin/env node
/**
 * Robust pass: messy compiled JSON -> clean v1 schema skeleton (+ Money Line Movement).
 * - Recursively searches for money line history anywhere in the JSON.
 * - Recursively searches for range arrays (price_label_1/price_1 pairs).
 * - Parses team moneyline columns dynamically (e.g., PIT/BUF, away/home).
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
    const trimmed = val.trim();
    // "+233", "-267", maybe quoted numbers
    const n = parseInt(trimmed.replace(/\s/g, ''), 10);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function monthToNum(m) {
  const map = { Jan:1, Feb:2, Mar:3, Apr:4, May:5, Jun:6, Jul:7, Aug:8, Sep:9, Oct:10, Nov:11, Dec:12 };
  return map[m] || null;
}

// Try to parse strings like "Sep 12 1:02 PM" or "09/12 01:05 PM" using a season year.
function parseToISO(label, seasonYear) {
  if (!label || typeof label !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(label)) return label;

  try {
    let year = parseInt(seasonYear, 10);
    if (!year || Number.isNaN(year)) year = new Date().getUTCFullYear();

    // "Sep 12 1:02 PM"
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

    // "09/12 01:05 PM"
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

// Helpers to search the entire object graph
function walk(obj, fn, path = []) {
  if (!obj || typeof obj !== 'object') return;
  fn(obj, path);
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => walk(v, fn, path.concat([i])));
  } else {
    Object.keys(obj).forEach(k => walk(obj[k], fn, path.concat([k])));
  }
}

function keyIncludesAny(key, regexes) {
  const s = String(key).toLowerCase();
  return regexes.some(rx => rx.test(s));
}

function findMoneyLineHistory(root) {
  // Find an array whose parent key looks like "money line history"
  // Example key variants: "Money Line History", "moneylinehistory", "money line history"
  const matches = [];
  walk(root, (node, path) => {
    if (!Array.isArray(node)) return;
    const lastKey = String(path[path.length - 1] ?? '').toLowerCase();
    if (/(^|[^a-z])money\s*line([^a-z]|$)/i.test(lastKey) && /history/i.test(lastKey)) {
      matches.push({ path, arr: node });
    }
  });
  // If none found, try to find any array of objects that has both team columns and a "time stamp"/"timestamp"/"label"
  if (matches.length === 0) {
    walk(root, (node, path) => {
      if (!Array.isArray(node)) return;
      const first = node.find(v => v && typeof v === 'object');
      if (!first) return;
      const keys = Object.keys(first);
      const hasLabel = keys.some(k => /^(time stamp|timestamp|label)$/i.test(k));
      // at least two non-label columns (teams)
      const teamCols = keys.filter(k => !/^(time stamp|timestamp|label)$/i.test(k));
      if (hasLabel && teamCols.length >= 2) {
        matches.push({ path, arr: node });
      }
    });
  }
  return matches[0]?.arr || null;
}

function findRangeArrays(root) {
  // Arrays containing objects with price_label_1/price_1 pairs
  const rangeArrays = [];
  walk(root, (node, path) => {
    if (!Array.isArray(node)) return;
    const first = node.find(v => v && typeof v === 'object');
    if (!first) return;
    const keys = Object.keys(first);
    const hasPrice = keys.some(k => /^price_?label_?1$/i.test(k) || /^price_?1$/i.test(k));
    if (hasPrice) rangeArrays.push({ path, arr: node });
  });
  return rangeArrays.map(x => x.arr);
}

function detectTeamKeys(rec, preferredHome, preferredAway) {
  const ignore = new Set(['time stamp', 'timestamp', 'label']);
  const keys = Object.keys(rec || {}).filter(k => !ignore.has(k));
  // Use provided abbreviations if present
  if (preferredHome && keys.includes(preferredHome)) {
    if (preferredAway && keys.includes(preferredAway)) return { homeKey: preferredHome, awayKey: preferredAway };
  }
  // Otherwise, just pick first two keys; later we will assign inferred[1] => home, inferred[0] => away
  if (keys.length >= 2) return { homeKey: keys[1], awayKey: keys[0] };
  return { homeKey: null, awayKey: null };
}

function extractMoneyLineHistory(arr, preferredHome, preferredAway, seasonYear) {
  const out = [];
  if (!Array.isArray(arr)) return out;
  let keysChosen = null;

  for (const rec of arr) {
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
  // Combine open/high/low/last from rows like:
  // { price_label_1: "Open", price_1: -285, price_label_2: "High", price_2: -315 }
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
    setIfLabel(r.price_label_1, r.price_1);
    setIfLabel(r.price_label_2, r.price_2);
  }
  return range;
}

function main() {
  const [, , inputPath, outputPath, HOME_ABBR, AWAY_ABBR, SEASON_YEAR] = process.argv;
  if (!inputPath || !outputPath) {
    console.error('Usage: node docs/scripts/convert-compiled-nfl.js <input.json> <output.json> <HOME_ABBR> <AWAY_ABBR> [SEASON_YEAR]');
    process.exit(1);
  }

  const root = readJSON(inputPath);

  // 1) HISTORY
  const histArr = findMoneyLineHistory(root);
  const history = extractMoneyLineHistory(histArr, HOME_ABBR, AWAY_ABBR, SEASON_YEAR);

  // 2) CURRENT from a "Current" row if present, otherwise first row
  let current = { home: null, away: null };
  if (history.length) {
    const currentRow = history.find(h => (h.label || '').toLowerCase() === 'current') || history[0];
    current = { home: currentRow.home ?? null, away: currentRow.away ?? null };
  }

  // 3) RANGES (pick first two qualifying arrays as home/away ranges)
  const rangeArrays = findRangeArrays(root);
  const range_home = reduceRange(rangeArrays[0] || []);
  const range_away = reduceRange(rangeArrays[1] || []);

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
