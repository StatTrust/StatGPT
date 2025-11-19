# NFL Compiled File Schema (v1)

Purpose
- Single, clean JSON per matchup feeding LLMs and the widget.
- Based on the 2021_week1_bills_steelers_compiled.json structure you shared.
- Keep the same section hierarchy; normalize names and values for consistency.

Conventions
- File is ONE JSON object.
- Key naming: snake_case, no spaces. Example: "pittsburgh injuries" → pittsburgh_injuries.
- Timestamps: ISO 8601 (e.g., 2025-11-19T05:30:29Z).
- Percentages: numeric decimals (0.3975 for 39.75%). UIs may format display strings if needed.
- Moneylines/spreads/totals: numbers (e.g., -267, +232 → -267, 232).
- Ranks: store separately from values: { value: 24.4, rank: 11 }.
- Status enums: QUESTIONABLE | PROBABLE | OUT | I-R.
- Optional meta block is allowed.

Top-Level Shape
```json
{
  "meta": { ... },                          
  "dualgamelog": { ... },
  "efficiencystats": { ... },
  "headtohead": { ... },
  "injuryreport": { ... },
  "matchupstats": { ... },
  "moneylineanalysis": { ... },
  "moneylinemovement": { ... },
  "overunderanalysis": { ... },
  "overunderlinemovement": { ... },
  "overview": { ... },
  "pointspreadanalysis": { ... },
  "pointspreadlinemovement": { ... },
  "powerratings": { ... },
  "similargamesanalysis": { ... },
  "situationaltrends": { ... },
  "statsplits": { ... },
  "travelanalysis": { ... }
}
```

meta (optional, recommended)
- league: string ("NFL")
- season: number (e.g., 2021)
- week: string or number (e.g., "Week 1")
- matchup_id: string (stable id)
- home_team: string (short name)
- away_team: string (short name)
- generated_at: string (ISO timestamp)

dualgamelog
- home_season_performance_last_season: GameLogEntry[]
- away_season_performance_last_season: GameLogEntry[]

GameLogEntry
- week: string (e.g., "Week 1", "Wild Card")
- opponent: string (name with optional "at")
- rank: number
- home_away_neutral: "Home" | "Away" | "Neutral"
- score: string (e.g., "W 23-16")

efficiencystats
- key_offensive_stats_last_season: StatRow[]
- key_defensive_stats_last_season: StatRow[]
- home_vs_away_offensive_efficiency_last_season: StatRow[]
- home_vs_away_defensive_efficiency_last_season: StatRow[]

StatRow
- stat: string (label)
- home: number | string (when truly text)
- away: number | string

headtohead
- head_to_head_since_1985_season: HeadToHeadGame[]

HeadToHeadGame
- date: string (ISO)
- winner: string
- winner_home_away_neutral: "Home" | "Away" | "Neutral"
- score: { made: number, attempts: number }
- ats_cover: string (e.g., "Buffalo -10.0")
- ou_result: string (e.g., "Over 39.5")

injuryreport
- home_injuries: Injury[]
- away_injuries: Injury[]

Injury
- name: string
- pos: string
- updated: string (ISO or "MM/DD" if source lacks year; prefer ISO)
- injury: string
- status: "QUESTIONABLE" | "PROBABLE" | "OUT" | "I-R"
- details: string

matchupstats
- home_vs_away_overall_last_season: MatchupStatRow[]
- away_vs_home_overall_last_season: MatchupStatRow[]
- home_vs_away_rushing_last_season: MatchupStatRow[]
- away_vs_home_rushing_last_season: MatchupStatRow[]
- home_vs_away_passing_last_season: MatchupStatRow[]
- away_vs_home_passing_last_season: MatchupStatRow[]
- home_vs_away_kicking_last_season: MatchupStatRow[]
- away_vs_home_kicking_last_season: MatchupStatRow[]
- home_vs_away_turnovers_last_season: MatchupStatRow[]
- away_vs_home_turnovers_last_season: MatchupStatRow[]
- home_vs_away_penalties_last_season: MatchupStatRow[]
- away_vs_home_penalties_last_season: MatchupStatRow[]
- home_vs_away_other_last_season: MatchupStatRow[]
- away_vs_home_other_last_season: MatchupStatRow[]

MatchupStatRow
- stat: string
- home: { value?: number|string, rank?: number }
- away_opponent: { value?: number|string, rank?: number }

moneylineanalysis
- money_line_predictions: { model: string, value_pick: string }[]
- money_line_trends_last_season: { record: string, home: string, away: string }[]

moneylinemovement
- current: { home: number, away: number }
- range_home: { open: number, high: number, low: number, last: number }
- range_away: { open: number, high: number, low: number, last: number }
- history: MoneylinePoint[]

MoneylinePoint
- timestamp: string (ISO)
- home: number
- away: number

overunderanalysis
- predictions: { model: string, pick: string }[]
- trends_last_season: { record: string, home: string, away: string }[]

overunderlinemovement
- current_total: number
- range_total: { open: number, high: number, low: number, last: number }
- totals_history: { timestamp: string, total: number }[]

overview
- offensive_stat_comparison_last_season: { stat: string, home: number|string, away: number|string }[]
- defensive_stat_comparison_last_season: { stat: string, home: number|string, away: number|string }[]

pointspreadanalysis
- ats_predictions: { model: string, pick: string }[]
- ats_situational_trends_last_season: { record: string, home: string, away: string }[]

pointspreadlinemovement
- current_spread: number
- spread_history: { timestamp: string, spread: number }[]
- range_spread: { open: number, high: number, low: number, last: number }

powerratings
- comparison_table: { rating: string, home: string, away: string }[]
- home_rankings: PowerRow[]
- away_rankings: PowerRow[]

PowerRow
- rating: string
- value: string
- rank: string
- conf_rank?: string

similargamesanalysis
- matchup_key: string (e.g., "PIT @ BUF")
- win_odds: { home: number, away: number }

situationaltrends
- win_loss_team_trends: TrendRow[]
- ats_team_trends: TrendRow[]
- over_under_team_trends: TrendRow[]

TrendRow
- record: string
- home: string
- away: string

statsplits
- scoring_and_yardage_last_season: SplitRow[]
- offensive_efficiency_last_season: SplitRow[]
- defensive_efficiency_last_season: SplitRow[]
- turnovers_penalties_top_last_season: SplitRow[]

SplitRow
- split_stat: string
- season_home: number|string
- season_away: number|string
- last3_home?: number|string
- last3_away?: number|string
- home_vs_home_home?: number|string
- away_vs_home_away?: number|string

travelanalysis
- travel_analysis: {
    home_team: string,
    away_team: string,
    away_team_travel_miles: number
  }

Validation Rules
- All top-level sections exist (except meta which is optional).
- No percent symbols in numeric fields; store decimals.
- Timestamps ISO where feasible.
- snake_case keys; no spaces.
- Moneylines/spreads/totals are numbers.
