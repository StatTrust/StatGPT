#!/usr/bin/env node

/**
 * NFL compiled -> v1 schema converter
 *
 * Usage:
 *   node convert-compiled-nfl.js <input.json> <output.json> <HOME_ABBR> <AWAY_ABBR> [SEASON_YEAR]
 *
 * Example:
 *   node convert-compiled-nfl.js compiled-28.json compiled_nfl_v1.json BUF TB 2025
 *
 * Notes / assumptions:
 * - Works on the "messy" compiled JSON you shared (meta + sections + raw.* mirrors).
 * - Always emits all top-level v1 sections, even if empty.
 * - Money line / spread / total movement are fully normalized (current, range, history).
 * - Other sections (dualgamelog, efficiencystats, injuries, etc.) are populated in a
 *   conservative, schema-friendly way and are easy to extend.
 * - Missing sections/fields never crash the script; they log warnings instead.
 */

const fs = require('fs');
const path = require('path');

// --------------------------- small utilities ---------------------------

function readJSON(p) {
  try {
    const txt = fs.readFileSync(p, 'utf8');
    return JSON.parse(txt);
  } catch (err) {
    console.error(`Failed to read JSON from ${p}:`, err.message);
    process.exit(1);
  }
}

function writeJSON(p, data) {
  try {
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`Failed to write JSON to ${p}:`, err.message);
    process.exit(1);
  }
}

function get(obj, pathArr, defaultValue = null) {
  let cur = obj;
  for (const key of pathArr) {
    if (cur && Object.prototype.hasOwnProperty.call(cur, key)) {
      cur = cur[key];
    } else {
      return defaultValue;
    }
  }
  return cur;
}

function toSnakeCase(str) {
  if (!str || typeof str !== 'string') return str;
  return str
    .replace(/[%()]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function parseNumberOrNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : null;
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s || s === '--') return null;
    const n = Number(s.replace(/,/g, ''));
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function parseOdds(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s || s === '--') return null;
    const m = s.match(/^([+-]?\d+(\.\d+)?)/);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

// "36.52% (#24)" or "24.4 (#11)" or "36.52%"
function parsePercentRank(str) {
  if (str === null || str === undefined) return null;
  if (typeof str !== 'string') {
    const num = parseNumberOrNull(str);
    return num === null ? null : { value: num };
  }
  const s = str.trim();
  if (!s || s === '--') return null;

  let m = s.match(/^([\d.]+)%\s*\(#(\d+)\)$/); // percent + rank
  if (m) {
    const value = Number(m[1]) / 100;
    const rank = Number(m[2]);
    return { value, rank };
  }

  m = s.match(/^([\d.]+)\s*\(#(\d+)\)$/); // number + rank
  if (m) {
    const value = Number(m[1]);
    const rank = Number(m[2]);
    return { value, rank };
  }

  m = s.match(/^([\d.]+)%$/); // percent only
  if (m) {
    const value = Number(m[1]) / 100;
    return { value };
  }

  const num = parseNumberOrNull(s);
  if (num !== null) return { value: num };

  // Fallback: keep original
  return { value: s };
}

function parsePercent(str) {
  if (str === null || str === undefined) return null;
  if (typeof str === 'number') return str;
  const s = String(str).trim();
  if (!s || s === '--') return null;
  const m = s.match(/^([\d.]+)%$/);
  if (!m) {
    const n = parseNumberOrNull(s);
    return n;
  }
  const n = Number(m[1]);
  if (Number.isNaN(n)) return null;
  return n / 100;
}

/**
 * Parse labels like:
 *  - "Nov 16 12:18 PM"
 *  - "11/16 11:45 AM"
 *  - "05/16 09:04 AM"
 * If parsing fails, returns { label, timestamp: null }.
 */
function parseTimestampLabel(label, seasonYear) {
  if (!label || typeof label !== 'string') {
    return { label: label ?? null, timestamp: null };
  }
  const trimmed = label.trim();
  const result = { label: trimmed, timestamp: null };
  const year = seasonYear || new Date().getFullYear();

  const monthMap = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
  };

  // e.g. "Nov 16 12:18 PM"
  let m = trimmed.match(/^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (m) {
    const mm = monthMap[m[1].toLowerCase()];
    const dd = Number(m[2]);
    let hh = Number(m[3]) % 12;
    const minute = Number(m[4]);
    const ampm = m[5].toUpperCase();
    if (ampm === 'PM') hh += 12;
    const iso = `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`;
    result.timestamp = iso;
    return result;
  }

  // e.g. "11/16 11:45 AM"
  m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (m) {
    const mm = Number(m[1]);
    const dd = Number(m[2]);
    let hh = Number(m[3]) % 12;
    const minute = Number(m[4]);
    const ampm = m[5].toUpperCase();
    if (ampm === 'PM') hh += 12;
    const iso = `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`;
    result.timestamp = iso;
    return result;
  }

  // If nothing matched, keep label only.
  return result;
}

function normalizeInjuryStatus(status) {
  if (!status) return null;
  const s = String(status).trim().toUpperCase();
  if (s.includes('PROB')) return 'PROBABLE';
  if (s.includes('QUESTION')) return 'QUESTIONABLE';
  if (s === 'IR' || s.includes('INJURED RESERVE')) return 'I-R';
  if (s.includes('OUT')) return 'OUT';
  return s; // leave as-is but normalized
}

/**
 * Find a "section" in the top-level sections or in raw.<key>.data.sections.
 */
function findSection(root, label, rawKey) {
  const sections = root.sections || {};
  if (sections[label]) return sections[label];

  const rawSections = get(root, ['raw', rawKey, 'data', 'sections'], null);
  if (rawSections && rawSections[label]) return rawSections[label];

  return null;
}

/**
 * Given a record and a team abbreviation, pull the value whose key equals that abbr (case-insensitive).
 */
function getTeamField(rec, teamAbbr) {
  if (!rec || !teamAbbr) return null;
  const target = teamAbbr.toUpperCase();
  for (const k of Object.keys(rec)) {
    if (k.toUpperCase() === target) return rec[k];
  }
  return null;
}

// --------------------------- extractors ---------------------------

function extractMeta(root, HOME_ABBR, AWAY_ABBR, seasonYear) {
  const baseMeta = root.meta || {};
  const meta = {
    league: 'NFL',
    season: seasonYear || null,
    matchup_id: baseMeta.matchupId || null,
    home_team: HOME_ABBR,
    away_team: AWAY_ABBR,
    generated_at: new Date().toISOString()
  };
  return meta;
}

function buildRangeFromRows(rows) {
  const range = { open: null, high: null, low: null, last: null };
  if (!Array.isArray(rows)) return range;

  for (const rec of rows) {
    const label1 = rec.price_label_1 && String(rec.price_label_1).toLowerCase();
    const label2 = rec.price_label_2 && String(rec.price_label_2).toLowerCase();
    const v1 = parseOdds(rec.price_1);
    const v2 = parseOdds(rec.price_2);

    if (label1 && label1.includes('open')) range.open = v1;
    if (label1 && label1.includes('high')) range.high = v1;
    if (label1 && label1.includes('low')) range.low = v1;
    if (label1 && label1.includes('last')) range.last = v1;

    if (label2 && label2.includes('open')) range.open = v2;
    if (label2 && label2.includes('high')) range.high = v2;
    if (label2 && label2.includes('low')) range.low = v2;
    if (label2 && label2.includes('last')) range.last = v2;
  }
  return range;
}

function extractMoneyLineMovement(root, HOME_ABBR, AWAY_ABBR, seasonYear) {
  const result = {
    current: { home: null, away: null },
    range_home: { open: null, high: null, low: null, last: null },
    range_away: { open: null, high: null, low: null, last: null },
    history: []
  };

  // ----- history -----
  const histSection = findSection(root, 'Money Line History', 'moneylinemovement');
  const rawHistory = histSection && Array.isArray(histSection.moneylinemovement)
    ? histSection.moneylinemovement
    : [];

  if (!rawHistory.length) {
    console.warn('[moneylinemovement] Money Line History section not found or empty.');
  }

  let currentFromHistory = null;

  for (const rec of rawHistory) {
    if (rec.label && String(rec.label).toLowerCase().includes('historic_line_movement')) {
      continue; // skip marker rows
    }

    const rawLabel = rec['time stamp'] || rec.timestamp || rec.label || null;
    const ts = parseTimestampLabel(rawLabel, seasonYear);

    const homeVal = parseOdds(getTeamField(rec, HOME_ABBR));
    const awayVal = parseOdds(getTeamField(rec, AWAY_ABBR));

    if (homeVal === null && awayVal === null) continue;

    const point = {
      timestamp: ts.timestamp,
      label: ts.label,
      home: homeVal,
      away: awayVal
    };
    result.history.push(point);

    if (rawLabel && /^current$/i.test(rawLabel)) {
      currentFromHistory = { home: homeVal, away: awayVal };
    }
  }

  // ----- current -----
  if (currentFromHistory) {
    result.current = currentFromHistory;
  } else if (result.history.length > 0) {
    result.current = {
      home: result.history[0].home,
      away: result.history[0].away
    };
  }

  // ----- ranges -----
  const matchupLabel = `Matchup Menu: ${AWAY_ABBR} @ ${HOME_ABBR}`;
  let matchupMenu = get(root, ['sections', matchupLabel], null);
  if (!matchupMenu) {
    // Fallback: pick first section whose key starts with "Matchup Menu"
    const sections = root.sections || {};
    const key = Object.keys(sections).find(k => k.toLowerCase().startsWith('matchup menu'));
    if (key) matchupMenu = sections[key];
  }

  const lineMovementSec = findSection(root, 'Line Movement', 'moneylinemovement');

  if (!matchupMenu || !Array.isArray(matchupMenu.moneylinemovement)) {
    console.warn('[moneylinemovement] Matchup Menu moneylinemovement not found.');
  } else {
    result.range_home = buildRangeFromRows(matchupMenu.moneylinemovement);
  }

  if (!lineMovementSec || !Array.isArray(lineMovementSec.moneylinemovement)) {
    console.warn('[moneylinemovement] Line Movement moneylinemovement not found.');
  } else {
    result.range_away = buildRangeFromRows(lineMovementSec.moneylinemovement);
  }

  return result;
}

function extractSpreadMovement(root, HOME_ABBR, AWAY_ABBR, seasonYear) {
  const result = {
    current_spread: null,
    range_spread: { open: null, high: null, low: null, last: null },
    spread_history: []
  };

  const spreadHistSection = findSection(root, 'Spread History', 'pointspreadlinemovement');
  const rawHistory = spreadHistSection && Array.isArray(spreadHistSection.pointspreadlinemovement)
    ? spreadHistSection.pointspreadlinemovement
    : [];

  if (!rawHistory.length) {
    console.warn('[pointspreadlinemovement] Spread History not found or empty.');
  }

  let current = null;

  for (const rec of rawHistory) {
    const label = rec.timestamp || rec.label || null;
    const ts = parseTimestampLabel(label, seasonYear);
    const spread = parseOdds(rec.spread);

    result.spread_history.push({
      timestamp: ts.timestamp,
      label: ts.label,
      spread
    });

    if (label && /^current$/i.test(label)) {
      current = spread;
    }
  }

  if (current !== null) {
    result.current_spread = current;
  } else if (result.spread_history.length > 0) {
    result.current_spread = result.spread_history[0].spread;
  }

  // Range from Matchup Menu (home perspective)
  const matchupLabel = `Matchup Menu: ${AWAY_ABBR} @ ${HOME_ABBR}`;
  let matchupMenu = get(root, ['sections', matchupLabel], null);
  if (!matchupMenu) {
    const sections = root.sections || {};
    const key = Object.keys(sections).find(k => k.toLowerCase().startsWith('matchup menu'));
    if (key) matchupMenu = sections[key];
  }

  if (!matchupMenu || !Array.isArray(matchupMenu.pointspreadlinemovement)) {
    console.warn('[pointspreadlinemovement] Matchup Menu pointspreadlinemovement not found.');
  } else {
    result.range_spread = buildRangeFromRows(matchupMenu.pointspreadlinemovement);
  }

  return result;
}

function extractTotalsMovement(root, HOME_ABBR, AWAY_ABBR, seasonYear) {
  const result = {
    current_total: null,
    range_total: { open: null, high: null, low: null, last: null },
    totals_history: []
  };

  const totalsHistSection = findSection(root, 'Totals History', 'overunderlinemovement');
  const rawHistory = totalsHistSection && Array.isArray(totalsHistSection.overunderlinemovement)
    ? totalsHistSection.overunderlinemovement
    : [];

  if (!rawHistory.length) {
    console.warn('[overunderlinemovement] Totals History not found or empty.');
  }

  let current = null;

  for (const rec of rawHistory) {
    const label = rec.label || rec.timestamp || null;
    const ts = parseTimestampLabel(label, seasonYear);
    const total = parseNumberOrNull(rec.total);

    result.totals_history.push({
      timestamp: ts.timestamp,
      label: ts.label,
      total
    });

    if (label && /^current$/i.test(label)) {
      current = total;
    }
  }

  if (current !== null) {
    result.current_total = current;
  } else if (result.totals_history.length > 0) {
    result.current_total = result.totals_history[0].total;
  }

  const matchupLabel = `Matchup Menu: ${AWAY_ABBR} @ ${HOME_ABBR}`;
  let matchupMenu = get(root, ['sections', matchupLabel], null);
  if (!matchupMenu) {
    const sections = root.sections || {};
    const key = Object.keys(sections).find(k => k.toLowerCase().startsWith('matchup menu'));
    if (key) matchupMenu = sections[key];
  }

  if (!matchupMenu || !Array.isArray(matchupMenu.overunderlinemovement)) {
    console.warn('[overunderlinemovement] Matchup Menu overunderlinemovement not found.');
  } else {
    result.range_total = buildRangeFromRows(matchupMenu.overunderlinemovement);
  }

  return result;
}

function extractMoneylineAnalysis(root, HOME_ABBR, AWAY_ABBR) {
  const trendsSection = findSection(root, 'money line situational trends', 'moneylineanalysis');
  const trendsRaw = trendsSection && Array.isArray(trendsSection.moneylineanalysis)
    ? trendsSection.moneylineanalysis
    : [];

  const trends = trendsRaw.map(row => ({
    record: row.record || row.Record || null,
    home: row[HOME_ABBR] ?? row.home ?? null,
    away: row[AWAY_ABBR] ?? row.away ?? null
  }));

  // Many compiled files have no explicit moneyline "predictions"; keep empty but present.
  return {
    money_line_predictions: [],
    money_line_trends_last_season: trends
  };
}

function extractPointspreadAnalysis(root, HOME_ABBR, AWAY_ABBR) {
  const predsSection = findSection(root, 'ATS Predictions', 'pointspreadanalysis');
  const predsRaw = predsSection && Array.isArray(predsSection.pointspreadanalysis)
    ? predsSection.pointspreadanalysis
    : [];
  const predictions = predsRaw.map(row => ({
    model: toSnakeCase(row.Model || row.model || ''),
    pick: row.Pick ?? row.pick ?? null
  }));

  const trendsSection = findSection(root, 'ATS Situational Trends', 'pointspreadanalysis');
  const trendsRaw = trendsSection && Array.isArray(trendsSection.pointspreadanalysis)
    ? trendsSection.pointspreadanalysis
    : [];
  const trends = trendsRaw.map(row => ({
    record: row.Record || row.record || null,
    home: row[HOME_ABBR] ?? row.home ?? null,
    away: row[AWAY_ABBR] ?? row.away ?? null
  }));

  return {
    ats_predictions: predictions,
    ats_situational_trends_last_season: trends
  };
}

function extractOverUnderAnalysis(root, HOME_ABBR, AWAY_ABBR) {
  const predsSection = findSection(root, 'Over/Under Predictions', 'overunderanalysis');
  const predsRaw = predsSection && Array.isArray(predsSection.overunderanalysis)
    ? predsSection.overunderanalysis
    : [];
  const predictions = predsRaw.map(row => ({
    model: toSnakeCase(row.Model || row.model || ''),
    pick: row.Pick ?? row.pick ?? null
  }));

  const trendsSection = findSection(root, 'Over/Under Situational Trends', 'overunderanalysis');
  const trendsRaw = trendsSection && Array.isArray(trendsSection.overunderanalysis)
    ? trendsSection.overunderanalysis
    : [];
  const trends = trendsRaw.map(row => ({
    record: row.Record || row.record || null,
    home: row[HOME_ABBR] ?? row.home ?? null,
    away: row[AWAY_ABBR] ?? row.away ?? null
  }));

  return {
    predictions,
    trends_last_season: trends
  };
}

function normalizeHAN(value) {
  if (!value) return null;
  const s = String(value).trim().toLowerCase();
  if (s.startsWith('h')) return 'Home';
  if (s.startsWith('a')) return 'Away';
  if (s.startsWith('n')) return 'Neutral';
  return value;
}

function extractDualGameLog(root, HOME_ABBR, AWAY_ABBR) {
  const sections = root.sections || {};
  const out = {
    home_season_performance_last_season: [],
    away_season_performance_last_season: []
  };

  // Heuristic: section names that contain "season performance" are game logs.
  const seasonKeys = Object.keys(sections).filter(k =>
    k.toLowerCase().includes('season performance')
  );

  const homeKeyGuess = seasonKeys.find(k => k.toLowerCase().includes('buffalo')) || seasonKeys[0];
  const awayKeyGuess = seasonKeys.find(k => k.toLowerCase().includes('tampa bay')) || seasonKeys[1];

  if (homeKeyGuess && sections[homeKeyGuess] && Array.isArray(sections[homeKeyGuess].dualgamelog)) {
    out.home_season_performance_last_season = sections[homeKeyGuess].dualgamelog.map(row => ({
      week: row.week || null,
      opponent: row.opponent || null,
      rank: parseNumberOrNull(row.rank),
      home_away_neutral: normalizeHAN(row['h a n']),
      score: row.score || null
    }));
  }

  if (awayKeyGuess && sections[awayKeyGuess] && Array.isArray(sections[awayKeyGuess].dualgamelog)) {
    out.away_season_performance_last_season = sections[awayKeyGuess].dualgamelog.map(row => ({
      week: row.week || null,
      opponent: row.opponent || null,
      rank: parseNumberOrNull(row.rank),
      home_away_neutral: normalizeHAN(row['h a n']),
      score: row.score || null
    }));
  }

  if (!seasonKeys.length) {
    console.warn('[dualgamelog] No season performance sections found.');
  }

  return out;
}

function extractEfficiencyStats(root, HOME_ABBR, AWAY_ABBR) {
  const out = {};

  const keyOff = findSection(root, 'key offensive stats', 'efficiencystats');
  const keyDef = findSection(root, 'key defensive stats', 'efficiencystats');
  const offEff = findSection(root, 'tampa bayvsbuffalo offensive efficiency', 'efficiencystats');
  const defEff = findSection(root, 'tampa bayvsbuffalo defensive efficiency', 'efficiencystats');

  if (keyOff && Array.isArray(keyOff.efficiencystats)) {
    out.key_offensive_stats_last_season = keyOff.efficiencystats.map(row => ({
      stat: toSnakeCase(row.stat || ''),
      home: parseNumberOrNull(row[HOME_ABBR] ?? row.buf ?? row.home),
      away: parseNumberOrNull(row[AWAY_ABBR] ?? row.tb ?? row.away)
    }));
  } else {
    out.key_offensive_stats_last_season = [];
  }

  if (keyDef && Array.isArray(keyDef.efficiencystats)) {
    out.key_defensive_stats_last_season = keyDef.efficiencystats.map(row => ({
      stat: toSnakeCase(row.stat || ''),
      home: parseNumberOrNull(row[HOME_ABBR] ?? row.buf ?? row.home),
      away: parseNumberOrNull(row[AWAY_ABBR] ?? row.tb ?? row.away)
    }));
  } else {
    out.key_defensive_stats_last_season = [];
  }

  out.home_vs_away_offensive_efficiency_last_season =
    offEff && Array.isArray(offEff.efficiencystats)
      ? offEff.efficiencystats.map(row => ({
          stat: toSnakeCase(row.stat || ''),
          home: typeof row.buf === 'string' && row.buf.includes('%')
            ? parsePercent(row.buf)
            : parseNumberOrNull(row.buf),
          away: typeof row.tb === 'string' && row.tb.includes('%')
            ? parsePercent(row.tb)
            : parseNumberOrNull(row.tb)
        }))
      : [];

  out.home_vs_away_defensive_efficiency_last_season =
    defEff && Array.isArray(defEff.efficiencystats)
      ? defEff.efficiencystats.map(row => ({
          stat: toSnakeCase(row.stat || ''),
          home: typeof row.buf === 'string' && row.buf.includes('%')
            ? parsePercent(row.buf)
            : parseNumberOrNull(row.buf),
          away: typeof row.tb === 'string' && row.tb.includes('%')
            ? parsePercent(row.tb)
            : parseNumberOrNull(row.tb)
        }))
      : [];

  return out;
}

function extractOverview(root, HOME_ABBR, AWAY_ABBR) {
  const offComp = findSection(root, 'Offensive Stat Comparison', 'overview');
  const defComp = findSection(root, 'Defensive Stat Comparison', 'overview');

  const offensive = offComp && Array.isArray(offComp.overview)
    ? offComp.overview.map(row => ({
        stat: toSnakeCase(row.Stat || row.stat || ''),
        home: parseNumberOrNull(row[HOME_ABBR] ?? row.buf ?? row.home),
        away: parseNumberOrNull(row[AWAY_ABBR] ?? row.tb ?? row.away)
      }))
    : [];

  const defensive = defComp && Array.isArray(defComp.overview)
    ? defComp.overview.map(row => ({
        stat: toSnakeCase(row.Stat || row.stat || ''),
        home: parseNumberOrNull(row[HOME_ABBR] ?? row.buf ?? row.home),
        away: parseNumberOrNull(row[AWAY_ABBR] ?? row.tb ?? row.away)
      }))
    : [];

  return {
    offensive_stat_comparison_last_season: offensive,
    defensive_stat_comparison_last_season: defensive
  };
}

function extractInjuries(root, HOME_ABBR, AWAY_ABBR) {
  const secHome = findSection(root, 'buffalo injuries', 'injuryreport');
  const secAway = findSection(root, 'tampa bay injuries', 'injuryreport');

  const mapArr = arr => (Array.isArray(arr) ? arr : []).map(row => ({
    name: row.name || null,
    pos: row.pos || null,
    updated: row.updated || null,
    injury: row.injury || null,
    status: normalizeInjuryStatus(row.status),
    details: row.details || null
  }));

  return {
    home_injuries: mapArr(secHome && secHome.injuryreport),
    away_injuries: mapArr(secAway && secAway.injuryreport)
  };
}

function extractHeadToHead(root) {
  const sec = findSection(root, 'head to head since 1985 season', 'headtohead');
  const arr = sec && Array.isArray(sec.headtohead) ? sec.headtohead : [];

  const out = arr.map(row => ({
    date: row.date || null,
    winner: row.winner || null,
    winner_home_away_neutral: normalizeHAN(row['h a n'] || row.han),
    score: row.score || null,
    ats_cover: row.ats || row.ats_cover || null,
    ou_result: row.ou || row.ou_result || null
  }));

  return { head_to_head_since_1985_season: out };
}

function extractPowerRatings(root) {
  const comparisonSection = findSection(root, 'comparison_table', 'powerratings');
  const teamASection = findSection(root, 'teamA_rankings', 'powerratings');
  const teamBSection = findSection(root, 'teamB_rankings', 'powerratings');

  const comparisonRaw = comparisonSection && Array.isArray(comparisonSection.powerratings)
    ? comparisonSection.powerratings
    : [];

  const comparison = comparisonRaw.map(row => {
    const parsed = parsePercentRank(row.TB || row.Tb || row.tb || row.home);
    const parsed2 = parsePercentRank(row.BUF || row.Buf || row.buf || row.away);
    return {
      rating: toSnakeCase(row.Rating || row.rating || ''),
      home: parsed2 ? parsed2.value : null,
      away: parsed ? parsed.value : null
    };
  });

  const normalizePowerRows = rows => (Array.isArray(rows) ? rows : []).map(row => ({
    rating: toSnakeCase(row.Rating || row.rating || ''),
    value: row.Value || row.value || null,
    rank: row.Rank ? String(row.Rank).replace('#', '') : null,
    conf_rank: row['Conf Rank'] ? String(row['Conf Rank']).replace('#', '') : null
  }));

  const homeRankings = normalizePowerRows(teamASection && teamASection.powerratings);
  const awayRankings = normalizePowerRows(teamBSection && teamBSection.powerratings);

  return {
    comparison_table: comparison,
    home_rankings: homeRankings,
    away_rankings: awayRankings
  };
}

function extractSituationalTrends(root, HOME_ABBR, AWAY_ABBR) {
  const winLoss = findSection(root, 'Win-Loss Team Trends', 'situationaltrends');
  const ats = findSection(root, 'ATS Team Trends', 'situationaltrends');
  const ou = findSection(root, 'Over/Under Team Trends', 'situationaltrends');

  const mapTrends = (sec) =>
    sec && Array.isArray(sec.situationaltrends)
      ? sec.situationaltrends.map(row => ({
          record: row.Record || row.record || null,
          home: row[HOME_ABBR] ?? row.home ?? null,
          away: row[AWAY_ABBR] ?? row.away ?? null
        }))
      : [];

  return {
    win_loss_team_trends: mapTrends(winLoss),
    ats_team_trends: mapTrends(ats),
    over_under_team_trends: mapTrends(ou)
  };
}

function extractStatSplits(root, HOME_ABBR, AWAY_ABBR) {
  const scoring = findSection(root, 'Scoring & Yardage', 'statsplits');
  const off = findSection(root, 'Offensive Efficiency', 'statsplits');
  const def = findSection(root, 'Defensive Efficiency', 'statsplits');
  const top = findSection(root, 'Turnovers, Penalties & TOP', 'statsplits');

  function mapSplit(sec) {
    const arr = sec && Array.isArray(sec.statsplits) ? sec.statsplits : [];
    return arr.map(row => ({
      split_stat: toSnakeCase(row['Split | Stat'] || row.stat || ''),
      season_home: parseNumberOrNull(row[`Season | ${HOME_ABBR}`]),
      season_away: parseNumberOrNull(row[`Season | ${AWAY_ABBR}`]),
      last3_home: parseNumberOrNull(row[`Last 3 Games | ${HOME_ABBR}`]),
      last3_away: parseNumberOrNull(row[`Last 3 Games | ${AWAY_ABBR}`]),
      home_vs_home_home: parseNumberOrNull(row[`Away vs. Home | ${AWAY_ABBR}`]), // note perspective
      away_vs_home_away: parseNumberOrNull(row[`Away vs. Home | ${HOME_ABBR}`])
    }));
  }

  return {
    scoring_and_yardage_last_season: mapSplit(scoring),
    offensive_efficiency_last_season: mapSplit(off),
    defensive_efficiency_last_season: mapSplit(def),
    turnovers_penalties_top_last_season: mapSplit(top)
  };
}

function extractMatchupStats(root) {
  const sections = root.sections || {};
  const out = {};

  function mapMatchup(labelHome, labelAway, keyNameHome, keyNameAway) {
    const secHome = sections[labelHome];
    const secAway = sections[labelAway];

    const arrHome = secHome && Array.isArray(secHome.matchupstats)
      ? secHome.matchupstats
      : [];
    const arrAway = secAway && Array.isArray(secAway.matchupstats)
      ? secAway.matchupstats
      : [];

    out[keyNameHome] = arrHome.map(row => ({
      stat: toSnakeCase(row.tb || row.buf || row.stat || ''),
      home: parsePercentRank(row['value rank 1']),
      away_opponent: parsePercentRank(row['value rank'])
    }));

    out[keyNameAway] = arrAway.map(row => ({
      stat: toSnakeCase(row.buf || row.tb || row.stat || ''),
      home: parsePercentRank(row['value rank']),
      away_opponent: parsePercentRank(row['value rank 1'])
    }));
  }

  try {
    mapMatchup(
      'tampa bay vs buffalo overall',
      'buffalo vs tampa bay overall',
      'home_vs_away_overall_last_season',
      'away_vs_home_overall_last_season'
    );
  } catch (e) {
    console.warn('[matchupstats] overall mapping issue:', e.message);
  }

  try {
    mapMatchup(
      'tampa bay vs buffalo rushing',
      'buffalo vs tampa bay rushing',
      'home_vs_away_rushing_last_season',
      'away_vs_home_rushing_last_season'
    );
  } catch (e) {
    console.warn('[matchupstats] rushing mapping issue:', e.message);
  }

  try {
    mapMatchup(
      'tampa bay vs buffalo passing',
      'buffalo vs tampa bay passing',
      'home_vs_away_passing_last_season',
      'away_vs_home_passing_last_season'
    );
  } catch (e) {
    console.warn('[matchupstats] passing mapping issue:', e.message);
  }

  try {
    mapMatchup(
      'tampa bay vs buffalo kicking',
      'buffalo vs tampa bay kicking',
      'home_vs_away_kicking_last_season',
      'away_vs_home_kicking_last_season'
    );
  } catch (e) {
    console.warn('[matchupstats] kicking mapping issue:', e.message);
  }

  try {
    mapMatchup(
      'tampa bay vs buffalo turnovers',
      'buffalo vs tampa bay turnovers',
      'home_vs_away_turnovers_last_season',
      'away_vs_home_turnovers_last_season'
    );
  } catch (e) {
    console.warn('[matchupstats] turnovers mapping issue:', e.message);
  }

  try {
    mapMatchup(
      'tampa bay vs buffalo penalties',
      'buffalo vs tampa bay penalties',
      'home_vs_away_penalties_last_season',
      'away_vs_home_penalties_last_season'
    );
  } catch (e) {
    console.warn('[matchupstats] penalties mapping issue:', e.message);
  }

  try {
    mapMatchup(
      'tampa bay vs buffalo other',
      'buffalo vs tampa bay other',
      'home_vs_away_other_last_season',
      'away_vs_home_other_last_season'
    );
  } catch (e) {
    console.warn('[matchupstats] other mapping issue:', e.message);
  }

  return out;
}

function extractSimilarGames(root) {
  const sections = root.sections || {};
  const tb = sections['tampa bay season performance'];
  const buf = sections['buffalo season performance'];

  const matchupKey = root.meta && root.meta.matchupTitle ? root.meta.matchupTitle : null;

  return {
    matchup_key: matchupKey,
    home_similar_games: buf && Array.isArray(buf.similargamesanalysis) ? buf.similargamesanalysis : [],
    away_similar_games: tb && Array.isArray(tb.similargamesanalysis) ? tb.similargamesanalysis : []
  };
}

function extractTravelAnalysis(root, HOME_ABBR, AWAY_ABBR) {
  const sec = findSection(root, 'travel_analysis', 'travelanalysis');
  const obj = sec && sec.travelanalysis ? sec.travelanalysis : {};

  return {
    travel_analysis: {
      home_team: HOME_ABBR,
      away_team: AWAY_ABBR,
      away_team_travel_miles: parseNumberOrNull(obj.away_team_travel_miles || obj.away_miles)
    }
  };
}

/**
 * Vercel-safe pure converter:
 * Accepts a messy compiled object + team context, returns v1 normalized object.
 */
function convertCompiledNFLObject(input, HOME_ABBR, AWAY_ABBR, SEASON_YEAR = null) {
  const meta = extractMeta(input, HOME_ABBR, AWAY_ABBR, SEASON_YEAR);
  const moneylinemovement = extractMoneyLineMovement(input, HOME_ABBR, AWAY_ABBR, SEASON_YEAR);
  const pointspreadlinemovement = extractSpreadMovement(input, HOME_ABBR, AWAY_ABBR, SEASON_YEAR);
  const overunderlinemovement = extractTotalsMovement(input, HOME_ABBR, AWAY_ABBR, SEASON_YEAR);

  const moneylineanalysis = extractMoneylineAnalysis(input, HOME_ABBR, AWAY_ABBR);
  const pointspreadanalysis = extractPointspreadAnalysis(input, HOME_ABBR, AWAY_ABBR);
  const overunderanalysis = extractOverUnderAnalysis(input, HOME_ABBR, AWAY_ABBR);

  const dualgamelog = extractDualGameLog(input, HOME_ABBR, AWAY_ABBR);
  const efficiencystats = extractEfficiencyStats(input, HOME_ABBR, AWAY_ABBR);
  const overview = extractOverview(input, HOME_ABBR, AWAY_ABBR);
  const injuryreport = extractInjuries(input, HOME_ABBR, AWAY_ABBR);
  const headtohead = extractHeadToHead(input);
  const powerratings = extractPowerRatings(input);
  const situationaltrends = extractSituationalTrends(input, HOME_ABBR, AWAY_ABBR);
  const statsplits = extractStatSplits(input, HOME_ABBR, AWAY_ABBR);
  const matchupstats = extractMatchupStats(input);
  const similargamesanalysis = extractSimilarGames(input);
  const travelanalysis = extractTravelAnalysis(input, HOME_ABBR, AWAY_ABBR);

  return {
    meta,
    dualgamelog,
    efficiencystats,
    headtohead,
    injuryreport,
    matchupstats,
    moneylineanalysis,
    moneylinemovement,
    overunderanalysis,
    overunderlinemovement,
    overview,
    pointspreadanalysis,
    pointspreadlinemovement,
    powerratings,
    similargamesanalysis,
    situationaltrends,
    statsplits,
    travelanalysis
  };
}

// Alias with the exact name the router tries to import.
// (Keeps backwards-compat with your existing CLI + CJS usage.)
function convertCompiledNflObject(input, HOME_ABBR, AWAY_ABBR, SEASON_YEAR = null) {
  return convertCompiledNFLObject(input, HOME_ABBR, AWAY_ABBR, SEASON_YEAR);
}

// --------------------------- main ---------------------------

function main() {
  const [, , inputPath, outputPath, homeAbbr, awayAbbr, seasonYearStr] = process.argv;

  if (!inputPath || !outputPath || !homeAbbr || !awayAbbr) {
    console.error('Usage: node convert-compiled-nfl.js <input.json> <output.json> <HOME_ABBR> <AWAY_ABBR> [SEASON_YEAR]');
    process.exit(1);
  }

  const SEASON_YEAR = seasonYearStr ? Number(seasonYearStr) : null;

  const input = readJSON(inputPath);

  const HOME_ABBR = homeAbbr.toUpperCase();
  const AWAY_ABBR = awayAbbr.toUpperCase();

  const compiled = convertCompiledNFLObject(input, HOME_ABBR, AWAY_ABBR, SEASON_YEAR);

  writeJSON(outputPath, compiled);

  console.log(`Wrote ${outputPath}`);
  console.log('Summary:');
  console.log(`  Moneyline history rows: ${compiled.moneylinemovement.history.length}`);
  console.log(`  Spread history rows: ${compiled.pointspreadlinemovement.spread_history.length}`);
  console.log(`  Totals history rows: ${compiled.overunderlinemovement.totals_history.length}`);
  console.log(`  Home injuries: ${compiled.injuryreport.home_injuries.length}`);
  console.log(`  Away injuries: ${compiled.injuryreport.away_injuries.length}`);
  console.log(`  Stat splits (scoring): ${compiled.statsplits.scoring_and_yardage_last_season.length}`);
}

if (require.main === module) {
  main();
}

/**
 * Export for serverless usage (Vercel/router.js) AND legacy CJS usage.
 *
 * This allows:
 *   const { convertCompiledNFLObject } = require('../docs/scripts/convert-compiled-nfl');
 *   const { convertCompiledNflObject } = require('../docs/scripts/convert-compiled-nfl');
 *
 * Router import() of this CJS module will see these on mod.default.*
 */
module.exports = {
  convertCompiledNFLObject,
  convertCompiledNflObject
};
