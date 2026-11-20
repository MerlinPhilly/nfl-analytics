"""DuckDB schema and analysis views."""
from __future__ import annotations

import os

import duckdb

DEFAULT_PATH = os.environ.get("NFL_DB", "data/nfl.duckdb")

SCHEMA = """
CREATE TABLE teams (abbrev VARCHAR PRIMARY KEY, name VARCHAR, nick VARCHAR, conference VARCHAR,
    division VARCHAR, color VARCHAR, color2 VARCHAR, current BOOLEAN);

CREATE TABLE games (game_id VARCHAR PRIMARY KEY, season INTEGER, game_type VARCHAR, round VARCHAR,
    week INTEGER, game_date DATE, weekday VARCHAR, gametime VARCHAR, away_team VARCHAR, away_score INTEGER,
    home_team VARCHAR, home_score INTEGER, overtime BOOLEAN, away_rest INTEGER, home_rest INTEGER,
    spread_line DOUBLE, total_line DOUBLE, div_game BOOLEAN, roof VARCHAR, surface VARCHAR, temp DOUBLE,
    wind DOUBLE, stadium VARCHAR, away_qb VARCHAR, home_qb VARCHAR, away_coach VARCHAR, home_coach VARCHAR,
    played BOOLEAN);

CREATE TABLE team_stats (game_id VARCHAR, team VARCHAR, completions INTEGER, pass_att INTEGER,
    pass_yds INTEGER, pass_td INTEGER, ints INTEGER, sacks_taken INTEGER, sack_yds INTEGER, carries INTEGER,
    rush_yds INTEGER, rush_td INTEGER, pass_epa DOUBLE, rush_epa DOUBLE, first_downs INTEGER,
    fumbles_lost INTEGER, penalties INTEGER, penalty_yds INTEGER, def_sacks DOUBLE, def_ints INTEGER,
    def_ff INTEGER, def_tds INTEGER, fg_made INTEGER, fg_att INTEGER, pat_made INTEGER, pat_att INTEGER,
    st_tds INTEGER, pass_20p INTEGER, rush_20p INTEGER, PRIMARY KEY (game_id, team));

CREATE TABLE player_games (player_id VARCHAR, name VARCHAR, position VARCHAR, pos_group VARCHAR,
    game_id VARCHAR, team VARCHAR,
    completions INTEGER, attempts INTEGER, passing_yards INTEGER, passing_tds INTEGER,
    passing_interceptions INTEGER, sacks_suffered INTEGER, sack_yards_lost INTEGER, sack_fumbles_lost INTEGER,
    passing_air_yards INTEGER, passing_yards_after_catch INTEGER, passing_first_downs INTEGER,
    passing_epa DOUBLE, passing_cpoe DOUBLE, passing_2pt_conversions INTEGER,
    carries INTEGER, rushing_yards INTEGER, rushing_tds INTEGER, rushing_fumbles_lost INTEGER,
    rushing_first_downs INTEGER, rushing_epa DOUBLE, rushing_2pt_conversions INTEGER,
    receptions INTEGER, targets INTEGER, receiving_yards INTEGER, receiving_tds INTEGER,
    receiving_fumbles_lost INTEGER, receiving_air_yards INTEGER, receiving_yards_after_catch INTEGER,
    receiving_first_downs INTEGER, receiving_epa DOUBLE, receiving_2pt_conversions INTEGER,
    target_share DOUBLE, air_yards_share DOUBLE, wopr DOUBLE,
    def_tackles_solo INTEGER, def_tackle_assists INTEGER, def_tackles_for_loss DOUBLE, def_sacks DOUBLE,
    def_qb_hits INTEGER, def_interceptions INTEGER, def_pass_defended INTEGER, def_fumbles_forced INTEGER,
    def_tds INTEGER, fumble_recovery_opp INTEGER,
    fg_made INTEGER, fg_att INTEGER, fg_long INTEGER, fg_made_40_49 INTEGER, fg_att_50p INTEGER,
    fg_made_50p INTEGER, pat_made INTEGER, pat_att INTEGER, pt_att INTEGER, pt_yards INTEGER,
    pt_net_yards INTEGER, pt_inside_20 INTEGER, punt_return_yards INTEGER, kickoff_return_yards INTEGER,
    special_teams_tds INTEGER, fantasy_points DOUBLE, fantasy_points_ppr DOUBLE);

CREATE TABLE players (player_id VARCHAR PRIMARY KEY, full_name VARCHAR, position VARCHAR, pos_group VARCHAR,
    birth_date DATE, height_in DOUBLE, weight_lb DOUBLE, college VARCHAR, jersey VARCHAR,
    current_team VARCHAR, status VARCHAR, rookie_season INTEGER, years_exp INTEGER, draft_year INTEGER,
    draft_round INTEGER, draft_pick INTEGER, draft_team VARCHAR);

CREATE TABLE run_log (ran_at TIMESTAMP, seasons VARCHAR, games INTEGER);

-- One row per team per completed game: its own offense, plus what it allowed.
CREATE VIEW v_team_games AS
WITH sides AS (
  SELECT g.*, home_team AS team, away_team AS opp, TRUE AS is_home, home_score AS pf, away_score AS pa,
         home_rest AS rest_days, away_rest AS opp_rest, spread_line AS team_line, home_qb AS qb
  FROM games g WHERE played
  UNION ALL
  SELECT g.*, away_team, home_team, FALSE, away_score, home_score, away_rest, home_rest, -spread_line, away_qb
  FROM games g WHERE played),
base AS (
  SELECT s.*, o.* EXCLUDE (game_id, team), x.completions AS opp_completions, x.pass_att AS opp_pass_att,
         x.pass_yds - abs(x.sack_yds) AS opp_net_pass_yds, x.rush_yds AS opp_rush_yds, x.pass_td AS opp_pass_td,
         x.rush_td AS opp_rush_td, x.pass_att + x.sacks_taken + x.carries AS opp_plays,
         x.pass_yds - abs(x.sack_yds) + x.rush_yds AS opp_yards, x.pass_epa + x.rush_epa AS opp_epa,
         x.pass_epa AS opp_pass_epa, x.rush_epa AS opp_rush_epa, x.first_downs AS opp_first_downs,
         x.ints + x.fumbles_lost AS takeaways, x.pass_att + x.sacks_taken AS opp_dropbacks, x.carries AS opp_carries
  FROM sides s
  LEFT JOIN team_stats o ON o.game_id = s.game_id AND o.team = s.team
  LEFT JOIN team_stats x ON x.game_id = s.game_id AND x.team = s.opp)
SELECT game_id, season, game_type, round, week, game_date, weekday, gametime, team, opp, is_home,
       pf, pa, CASE WHEN pf > pa THEN 'W' WHEN pf < pa THEN 'L' ELSE 'T' END AS result, overtime,
       rest_days, opp_rest, team_line,
       CASE WHEN team_line IS NULL THEN NULL WHEN pf - pa - team_line > 0 THEN 'W'
            WHEN pf - pa - team_line < 0 THEN 'L' ELSE 'P' END AS ats,
       total_line,
       CASE WHEN total_line IS NULL THEN NULL WHEN pf + pa > total_line THEN 'O'
            WHEN pf + pa < total_line THEN 'U' ELSE 'P' END AS ou,
       div_game, roof, surface, temp, wind, qb,
       completions, pass_att, pass_yds, pass_td, ints, sacks_taken, sack_yds, carries, rush_yds, rush_td,
       pass_epa, rush_epa, first_downs, fumbles_lost, penalties, penalty_yds, def_sacks, def_ints, def_ff,
       def_tds, fg_made, fg_att, st_tds, pass_20p, rush_20p,
       pass_att + sacks_taken + carries AS plays, pass_att + sacks_taken AS dropbacks,
       pass_yds - abs(sack_yds) AS net_pass_yds, pass_yds - abs(sack_yds) + rush_yds AS yards,
       ints + fumbles_lost AS turnovers, pass_epa + rush_epa AS epa,
       opp_completions, opp_pass_att, opp_net_pass_yds, opp_rush_yds, opp_pass_td, opp_rush_td, opp_plays,
       opp_yards, opp_epa, opp_pass_epa, opp_rush_epa, opp_first_downs, takeaways, opp_dropbacks, opp_carries,
       (team_stats_ok) AS has_stats,
       row_number() OVER (PARTITION BY team, season, game_type ORDER BY game_date, game_id) AS game_num
FROM (SELECT *, pass_att IS NOT NULL AS team_stats_ok FROM base);

-- One row per player per game, with the game context attached.
CREATE VIEW v_player_games AS
SELECT p.*, t.season, t.game_type, t.round, t.week, t.game_date, t.weekday, t.gametime, t.opp, t.is_home,
       t.result AS team_result, t.pf AS team_pf, t.pa AS team_pa, t.rest_days, t.team_line, t.div_game,
       t.roof, t.surface, t.temp,
       coalesce(p.passing_tds, 0) + coalesce(p.rushing_tds, 0) + coalesce(p.receiving_tds, 0)
           + coalesce(p.special_teams_tds, 0) AS total_tds,
       coalesce(p.rushing_yards, 0) + coalesce(p.receiving_yards, 0) AS scrimmage_yds,
       coalesce(p.carries, 0) + coalesce(p.receptions, 0) AS touches,
       coalesce(p.def_tackles_solo, 0) + coalesce(p.def_tackle_assists, 0) AS tackles
FROM player_games p JOIN v_team_games t ON t.game_id = p.game_id AND t.team = p.team;
"""


def connect(path: str | None = None, fresh: bool = False):
    path = path or DEFAULT_PATH
    if path != ":memory:":
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        if fresh:
            for p in (path, path + ".wal"):
                if os.path.exists(p):
                    os.remove(p)
    con = duckdb.connect(path)
    if fresh:
        con.execute(SCHEMA)
    return con
