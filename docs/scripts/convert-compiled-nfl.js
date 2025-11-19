#!/usr/bin/env node
/**
 * Converter (Money Line Movement filled properly).
 * Paths we use (arrays):
 *   sections["Money Line History"].moneylinemovement
 *   sections["Matchup Menu: <AWAY> @ <HOME>"].moneylinemovement
 *   sections["Line Movement"].moneylinemovement
 * Fallback mirrors:
 *   raw.moneylinemovement.data.sections["Money Line History"].moneylinemovement
 *   raw.moneylinemovement.data.sections["Matchup Menu: <AWAY> @ <HOME>"].moneylinemovement
 *   raw.moneylinemovement.data.sections["Line Movement"].moneylinemovement
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
  return { Jan:1, Feb:2, Mar:3, Apr:4, May:5, Jun:6, Jul:7, Aug:8, Sep:9, Oct:10, Nov:11, Dec:12 }[m] || null;
}
function parseToISO(label, seasonYear) {
  if (!label || typeof label !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(label)) return label;
  let year = parseInt(seasonYear, 10);
  if (!year || Number.isNaN(year)) year = new Date().getUTCFullYear();
  const m = label.match(/^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/);
  if (m) {
    let hh = parseInt(m[3], 10);
    const mm = parseInt(m[4], 10);
    const ampm = m[5];
    if (ampm === 'PM' && hh !== 12) hh += 12;
    if (ampm === 'AM' && hh === 12) hh = 0;
    const mon = monthToNum(m[1]);
    return new Date(Date.UTC(year, mon - 1, parseInt(m[2], 10), hh, mm, 0)).toISOString();
  }
  return null;
}
function extractHistory(arr, homeAbbr, awayAbbr, seasonYear) {
  const out = [];
  if (!Array.isArray(arr)) return out;
  for (const row of arr) {
    if (!row || typeof row !== 'object') continue;
    if (row.label && /historic_line_movement/i.test(row.label)) continue; // skip marker
    const label = row['time stamp'] || row['timestamp'] || row.label || '';
    const iso = parseToISO(label, seasonYear);
    const homeVal = parseMoney(row[homeAbbr]);
    const awayVal = parseMoney(row[awayAbbr]);
    if (homeVal == null && awayVal == null) continue;
    out.push({ timestamp: iso, label, home: homeVal, away: awayVal });
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

  console.log('[converter] START version: moneyline-path-fix');
  console.log('[converter] Params:', { inFile, outFile, HOME, AWAY, SEASON });

  const root = readJSON(inFile);
  const topSections = root.sections || {};
  const rawSections = (((root.raw || {}).moneylinemovement || {}).data || {}).sections || {};

  // History arrays
  const histTop = (topSections['Money Line History'] || {}).moneylinemovement;
  const histRaw = (rawSections['Money Line History'] || {}).moneylinemovement;
  console.log('[converter] histTop is array?', Array.isArray(histTop), 'length:', histTop && histTop.length);
  console.log('[converter] histRaw is array?', Array.isArray(histRaw), 'length:', histRaw && histRaw.length);

  const historyArr = Array.isArray(histTop) ? histTop : (Array.isArray(histRaw) ? histRaw : []);
  console.log('[converter] chosen historyArr length:', historyArr.length);
  console.log('[converter] first historyArr row keys:', historyArr[0] && Object.keys(historyArr[0]));

  // Range arrays
  const menuKey = `Matchup Menu: ${AWAY} @ ${HOME}`;
  const homeRangeTop = (topSections[menuKey] || {}).moneylinemovement;
  const homeRangeRaw = (rawSections[menuKey] || {}).moneylinemovement;
  const awayRangeTop = (topSections['Line Movement'] || {}).moneylinemovement;
  const awayRangeRaw = (rawSections['Line Movement'] || {}).moneylinemovement;

  const homeRangeArr = Array.isArray(homeRangeTop) ? homeRangeTop : (Array.isArray(homeRangeRaw) ? homeRangeRaw : []);
  const awayRangeArr = Array.isArray(awayRangeTop) ? awayRangeTop : (Array.isArray(awayRangeRaw) ? awayRangeRaw : []);

  console.log('[converter] homeRangeArr length:', homeRangeArr.length);
  console.log('[converter] awayRangeArr length:', awayRangeArr.length);

  const history = extractHistory(historyArr, HOME, AWAY, SEASON);
  console.log('[converter] extracted history length:', history.length);
  if (history[0]) console.log('[converter] first extracted history entry:', history[0]);

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
  console.log('[converter] DONE. Output moneyline summary:',
    { current, range_home, range_away, history_len: history.length });
}

if (require.main === module) main();
