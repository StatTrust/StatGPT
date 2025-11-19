#!/usr/bin/env node
/**
 * Converter (Money Line Movement filled properly).
 * Paths we use (all arrays):
 *   sections["Money Line History"].moneylinemovement
 *   sections["Matchup Menu: TB @ BUF"].moneylinemovement   (home/favorite range rows)
 *   sections["Line Movement"].moneylinemovement            (away/underdog range rows)
 * Fallback mirror paths under raw.* if top-level sections missing.
 *
 * Usage:
 *   node docs/scripts/convert-compiled-nfl.js tmp/compiled-28.json tmp/out/compiled_nfl_v1.json BUF TB 2021
 */

const fs = require('fs');
const path = require('path');

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function writeJSON(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}
function parseMoney(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseInt(v.replace(/\s/g, ''), 10);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}
function monthToNum(m) {
  return {
    Jan:1, Feb:2, Mar:3, Apr:4, May:5, Jun:6,
    Jul:7, Aug:8, Sep:9, Oct:10, Nov:11, Dec:12
  }[m] || null;
}
function parseToISO(label, seasonYear) {
  if (!label || typeof label !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(label)) return label;
  let year = parseInt(seasonYear, 10);
  if (!year || Number.isNaN(year)) year = new Date().getUTCFullYear();

  // "Nov 16 12:18 PM"
  let m = label.match(/^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/);
  if (m) {
    let hh = parseInt(m[3], 10);
    const mm = parseInt(m[4], 10);
    const ampm = m[5];
    if (ampm === 'PM' && hh !== 12) hh += 12;
    if (ampm === 'AM' && hh === 12) hh = 0;
    const mon = monthToNum(m[1]);
    return new Date(Date.UTC(year, mon - 1, parseInt(m[2], 10), hh, mm, 0)).toISOString();
  }
  return null; // we ignore ones we can’t parse (like "historic_line_movement")
}

function extractHistory(arr, homeAbbr, awayAbbr, seasonYear) {
  const out = [];
  if (!Array.isArray(arr)) return out;

  for (const row of arr) {
    if (!row || typeof row !== 'object') continue;
    // Skip marker rows like { label: 'historic_line_movement' }
    if (row.label && /historic_line_movement/i.test(row.label)) continue;

    const label = row['time stamp'] || row['timestamp'] || row.label || '';
    const iso = parseToISO(label, seasonYear);

    // We expect columns named exactly homeAbbr and awayAbbr (BUF/TB).
    const homeVal = parseMoney(row[homeAbbr]);
    const awayVal = parseMoney(row[awayAbbr]);

    // If one side missing, still push (we want continuity).
    if (homeVal == null && awayVal == null) continue;

    out.push({
      timestamp: iso,      // null if could not parse
      label,               // original label
      home: homeVal,
      away: awayVal
    });
  }
  return out;
}

function reduceRange(rows) {
  const range = { open: null, high: null, low: null, last: null };
  if (!Array.isArray(rows)) return range;

  const set = (label, value) => {
    const L = (label || '').toLowerCase();
    const num = parseMoney(value);
    if (num == null) return;
    if (L.includes('open') && range.open == null) range.open = num;
    if (L.includes('high') && range.high == null) range.high = num;
    if (L.includes('low') && range.low == null) range.low = num;
    if (L.includes('last') && range.last == null) range.last = num;
  };

  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    set(r.price_label_1, r.price_1);
    set(r.price_label_2, r.price_2);
  }
  return range;
}

function main() {
  const [, , inFile, outFile, HOME, AWAY, SEASON] = process.argv;
  if (!inFile || !outFile || !HOME || !AWAY) {
    console.error('Usage: node docs/scripts/convert-compiled-nfl.js <input.json> <output.json> <HOME_ABBR> <AWAY_ABBR> [SEASON_YEAR]');
    process.exit(1);
  }

  const root = readJSON(inFile);

  // Direct paths (preferred)
  const topSections = root.sections || {};
  const rawSections = (((root.raw || {}).moneylinemovement || {}).data || {}).sections || {};

  const histTop = (topSections['Money Line History'] || {}).moneylinemovement;
  const histRaw = (rawSections['Money Line History'] || {}).moneylinemovement;

  const homeRangeTop = (topSections[`Matchup Menu: ${AWAY} @ ${HOME}`] || {}).moneylinemovement;
  const homeRangeRaw = (rawSections[`Matchup Menu: ${AWAY} @ ${HOME}`] || {}).moneylinemovement;

  const awayRangeTop = (topSections['Line Movement'] || {}).moneylinemovement;
  const awayRangeRaw = (rawSections['Line Movement'] || {}).moneylinemovement;

  // Use top-level first, fallback to raw mirror.
  const historyArr = Array.isArray(histTop) ? histTop : (Array.isArray(histRaw) ? histRaw : []);
  const homeRangeArr = Array.isArray(homeRangeTop) ? homeRangeTop : (Array.isArray(homeRangeRaw) ? homeRangeRaw : []);
  const awayRangeArr = Array.isArray(awayRangeTop) ? awayRangeTop : (Array.isArray(awayRangeRaw) ? awayRangeRaw : []);

  const history = extractHistory(historyArr, HOME, AWAY, SEASON);
  // Current: look for label "Current" else first row.
  let current = { home: null, away: null };
  if (history.length) {
    const currentRow = history.find(r => (r.label || '').toLowerCase() === 'current') || history[0];
    current = { home: currentRow.home, away: currentRow.away };
  }

  const range_home = reduceRange(homeRangeArr);
  const range_away = reduceRange(awayRangeArr);

  const compiled = {
    meta: {
      league: 'NFL',
      season: SEASON ? parseInt(SEASON, 10) : undefined,
      home_team: HOME,
      away_team: AWAY,
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

  writeJSON(outFile, compiled);
  console.log(`Wrote ${outFile}`);
  console.log(`History rows: ${compiled.moneylinemovement.history.length}`);
  console.log('Current:', compiled.moneylinemovement.current);
  console.log('Range home:', compiled.moneylinemovement.range_home);
  console.log('Range away:', compiled.moneylinemovement.range_away);
}

if (require.main === module) main();
