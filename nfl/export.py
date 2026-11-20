"""Export DuckDB → compact JSON files the static site reads.

  python -m nfl.export --out _site/data

Tables are written column-oriented ({"cols": [...], "rows": [[...], ...]}).
Per-player files drop stat columns that are all zero for that player (a
kicker's file has no passing columns); the site treats a missing stat as 0.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import math
import os
from collections import defaultdict

from . import db, trends
from .ingest import PLAYER_STATS

log = logging.getLogger("nfl.export")


def _clean(v):
    if isinstance(v, float):
        if math.isnan(v) or math.isinf(v):
            return None
        return int(v) if v.is_integer() else round(v, 4)
    if isinstance(v, (dt.date, dt.datetime)):
        return v.isoformat()
    if hasattr(v, "item"):
        return _clean(v.item())
    return v


def table(con, sql: str, params=None) -> dict:
    cur = con.execute(sql, params or [])
    cols = [d[0] for d in cur.description]
    return {"cols": cols, "rows": [[_clean(v) for v in r] for r in cur.fetchall()]}


def write(path: str, obj) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, separators=(",", ":"), default=_clean)


CONTEXT = ["game_id", "game_date", "season", "game_type", "round", "week", "weekday", "gametime", "team", "opp",
           "is_home", "team_result", "team_pf", "team_pa", "rest_days", "team_line", "div_game", "roof",
           "surface", "temp", "position"]
DERIVED = ["total_tds", "scrimmage_yds", "touches", "tackles"]
STATS = PLAYER_STATS + DERIVED
AVG_STATS = {"target_share", "air_yards_share", "wopr"}
MAX_STATS = {"fg_long"}

TEAM_COLS = """game_id, game_date, season, game_type, round, week, weekday, gametime, opp, is_home, pf, pa, result,
    overtime, rest_days, opp_rest, team_line, ats, total_line, ou, div_game, roof, surface, temp, wind, qb,
    completions, pass_att, pass_yds, pass_td, ints, sacks_taken, sack_yds, carries, rush_yds, rush_td,
    pass_epa, rush_epa, first_downs, fumbles_lost, penalties, penalty_yds, def_sacks, def_ints, def_ff, def_tds,
    fg_made, fg_att, st_tds, pass_20p, rush_20p, plays, dropbacks, net_pass_yds, yards, turnovers, epa,
    opp_completions, opp_pass_att, opp_net_pass_yds, opp_rush_yds, opp_pass_td, opp_rush_td, opp_plays,
    opp_yards, opp_epa, opp_pass_epa, opp_rush_epa, opp_first_downs, takeaways, opp_dropbacks, opp_carries,
    game_num"""
TEAM_SUM = [c.strip() for c in """completions, pass_att, pass_yds, pass_td, ints, sacks_taken, sack_yds, carries,
    rush_yds, rush_td, pass_epa, rush_epa, first_downs, fumbles_lost, penalties, penalty_yds, def_sacks, def_ints,
    def_ff, def_tds, fg_made, fg_att, st_tds, pass_20p, rush_20p, plays, dropbacks, net_pass_yds, yards, turnovers,
    epa, opp_completions, opp_pass_att, opp_net_pass_yds, opp_rush_yds, opp_pass_td, opp_rush_td, opp_plays,
    opp_yards, opp_epa, opp_pass_epa, opp_rush_epa, opp_first_downs, takeaways, opp_dropbacks, opp_carries,
    pf, pa""".split(",")]


def _stat_agg(prefix: str = "") -> str:
    parts = []
    for c in STATS:
        if c in AVG_STATS:
            parts.append(f"avg({prefix}{c}) FILTER ({prefix}targets > 0) AS {c}")
        elif c in MAX_STATS:
            parts.append(f"max({prefix}{c}) AS {c}")
        elif c == "passing_cpoe":
            parts.append(f"sum({prefix}passing_cpoe * {prefix}attempts) / nullif(sum({prefix}attempts) "
                         f"FILTER ({prefix}passing_cpoe IS NOT NULL), 0) AS passing_cpoe")
        else:
            parts.append(f"sum({prefix}{c}) AS {c}")
    return ",\n       ".join(parts)


PLAYER_AGG = f"""
WITH g AS (
  SELECT *, row_number() OVER (PARTITION BY player_id, season, game_type
                               ORDER BY game_date DESC, game_id DESC) AS rn
  FROM v_player_games WHERE pos_group NOT IN ('OL', 'LS'))
SELECT g.player_id, coalesce(any_value(p.full_name), any_value(g.name)) AS name,
       coalesce(any_value(p.pos_group), mode(g.pos_group)) AS grp, mode(g.position) AS pos,
       arg_max(g.team, g.game_date) AS team, g.season, g.game_type, count(*) AS gp,
       {_stat_agg('g.')},
       count(*) FILTER (rn <= 3) AS gp3, sum(fantasy_points_ppr) FILTER (rn <= 3) AS ppr3,
       sum(targets) FILTER (rn <= 3) AS tgt3, sum(touches) FILTER (rn <= 3) AS tch3,
       sum(scrimmage_yds) FILTER (rn <= 3) AS scr3, sum(passing_yards) FILTER (rn <= 3) AS pyd3,
       sum(total_tds) FILTER (rn <= 3) AS td3, sum(tackles) FILTER (rn <= 3) AS tkl3,
       sum(def_sacks) FILTER (rn <= 3) AS sk3, avg(target_share) FILTER (rn <= 3 AND targets > 0) AS ts3,
       max(game_date) AS last_game
FROM g LEFT JOIN players p USING (player_id)
WHERE g.season = ?
GROUP BY g.player_id, g.season, g.game_type
ORDER BY fantasy_points_ppr DESC NULLS LAST
"""

TEAM_AGG = f"""
WITH g AS (
  SELECT v.*, t1.conference AS conf, t2.conference AS opp_conf, t1.division AS division,
         row_number() OVER (PARTITION BY v.team, v.season, v.game_type ORDER BY v.game_date DESC, v.game_id DESC) AS rn
  FROM v_team_games v LEFT JOIN teams t1 ON t1.abbrev = v.team LEFT JOIN teams t2 ON t2.abbrev = v.opp)
SELECT team, season, game_type, count(*) AS gp,
       count(*) FILTER (result = 'W') AS w, count(*) FILTER (result = 'L') AS l, count(*) FILTER (result = 'T') AS t,
       {", ".join(f"sum({c}) AS {c}" for c in TEAM_SUM)},
       count(*) FILTER (rn <= 5 AND result = 'W') AS w5, count(*) FILTER (rn <= 5 AND result = 'L') AS l5,
       count(*) FILTER (rn <= 5 AND result = 'T') AS t5,
       sum(pf) FILTER (rn <= 5) AS pf5, sum(pa) FILTER (rn <= 5) AS pa5,
       count(*) FILTER (div_game AND result = 'W') AS dw, count(*) FILTER (div_game AND result = 'L') AS dl,
       count(*) FILTER (div_game AND result = 'T') AS dt,
       count(*) FILTER (conf = opp_conf AND result = 'W') AS cw, count(*) FILTER (conf = opp_conf AND result = 'L') AS cl,
       count(*) FILTER (is_home AND result = 'W') AS hw, count(*) FILTER (is_home) AS hgp,
       count(*) FILTER (NOT is_home AND result = 'W') AS aw, count(*) FILTER (NOT is_home) AS agp,
       count(*) FILTER (ats = 'W') AS atsw, count(*) FILTER (ats = 'L') AS atsl, count(*) FILTER (ats = 'P') AS atsp,
       count(*) FILTER (ou = 'O') AS ovr, count(*) FILTER (ou = 'U') AS und,
       count(*) FILTER (abs(pf - pa) <= 8 AND result = 'W') AS close_w,
       count(*) FILTER (abs(pf - pa) <= 8 AND result = 'L') AS close_l,
       string_agg(result, '' ORDER BY game_date) AS results
FROM g WHERE season = ?
GROUP BY team, season, game_type
ORDER BY w DESC
"""

BOX_PLAYER = ["completions", "attempts", "passing_yards", "passing_tds", "passing_interceptions", "sacks_suffered",
              "passing_epa", "carries", "rushing_yards", "rushing_tds", "rushing_epa", "receptions", "targets",
              "receiving_yards", "receiving_tds", "receiving_yards_after_catch", "rushing_fumbles_lost",
              "receiving_fumbles_lost", "def_tackles_solo", "def_tackle_assists", "def_tackles_for_loss", "def_sacks",
              "def_qb_hits", "def_interceptions", "def_pass_defended", "def_fumbles_forced", "def_tds",
              "fg_made", "fg_att", "fg_long", "pat_made", "pat_att", "pt_att", "pt_yards", "pt_inside_20",
              "punt_return_yards", "kickoff_return_yards", "fantasy_points_ppr"]


def export(con, out: str) -> dict:
    seasons = [r[0] for r in con.execute("SELECT DISTINCT season FROM games ORDER BY season").fetchall()]
    counts = {"games": con.execute("SELECT count(*) FROM games WHERE played").fetchone()[0],
              "player_games": con.execute("SELECT count(*) FROM player_games").fetchone()[0],
              "players": con.execute("SELECT count(DISTINCT player_id) FROM player_games").fetchone()[0]}
    last = con.execute("SELECT game_date, season, week, game_type, round FROM games WHERE played "
                       "ORDER BY game_date DESC, game_id DESC LIMIT 1").fetchone()

    # --- teams
    team_rows = con.execute("SELECT abbrev, name, nick, conference, division, color, color2, current "
                            "FROM teams ORDER BY abbrev").fetchall()
    write(f"{out}/teams.json", [dict(zip(["abbrev", "name", "nick", "conference", "division", "color", "color2",
                                          "current"], r)) for r in team_rows])

    # --- player index
    idx = table(con, """
        SELECT g.player_id AS id, coalesce(any_value(p.full_name), arg_max(g.name, g.game_date)) AS name,
               coalesce(any_value(p.position), mode(g.position)) AS pos,
               coalesce(any_value(p.pos_group), mode(g.pos_group)) AS grp,
               arg_max(g.team, g.game_date) AS team, list(DISTINCT g.season ORDER BY g.season) AS seasons,
               count(*) AS gp, max(g.game_date) AS last_game
        FROM v_player_games g LEFT JOIN players p USING (player_id)
        GROUP BY g.player_id ORDER BY name""")
    write(f"{out}/players.json", idx)

    # --- per-player files
    bio_cols = ["id", "name", "pos", "grp", "birth_date", "height_in", "weight_lb", "college", "jersey",
                "current_team", "status", "rookie_season", "years_exp", "draft_year", "draft_round", "draft_pick",
                "draft_team"]
    bios = {r[0]: dict(zip(bio_cols, [_clean(v) for v in r])) for r in con.execute(
        "SELECT player_id, full_name, position, pos_group, birth_date, height_in, weight_lb, college, jersey, "
        "current_team, status, rookie_season, years_exp, draft_year, draft_round, draft_pick, draft_team "
        "FROM players").fetchall()}
    pg = table(con, f"SELECT player_id, {', '.join(CONTEXT + STATS)} FROM v_player_games "
                    "ORDER BY player_id, game_date, game_id")
    cols = pg["cols"][1:]
    stat_idx = [i for i, c in enumerate(cols) if c in STATS]
    by_player: dict[str, list] = defaultdict(list)
    for r in pg["rows"]:
        by_player[r[0]].append(r[1:])
    for row in idx["rows"]:
        pid = row[0]
        rows = by_player[pid]
        keep = [i for i in range(len(cols)) if i not in stat_idx or any(r[i] not in (0, None) for r in rows)]
        bio = bios.get(pid) or {"id": pid, "name": row[1], "pos": row[2], "grp": row[3], "current_team": row[4]}
        bio["grp"] = bio.get("grp") or row[3]
        write(f"{out}/players/{pid}.json", {"bio": bio, "games": {
            "cols": [cols[i] for i in keep], "rows": [[r[i] for i in keep] for r in rows]}})

    # --- per-team files
    for (abbrev, *_rest) in team_rows:
        write(f"{out}/teams/{abbrev}.json", {
            "games": table(con, f"SELECT {TEAM_COLS} FROM v_team_games WHERE team = ? ORDER BY game_date, game_id",
                           [abbrev]),
            "players": table(con, f"""
                SELECT g.player_id AS id, coalesce(any_value(p.full_name), any_value(g.name)) AS name,
                       mode(g.position) AS pos, coalesce(any_value(p.pos_group), mode(g.pos_group)) AS grp,
                       season, game_type, count(*) AS gp, {_stat_agg('g.')}
                FROM v_player_games g LEFT JOIN players p USING (player_id)
                WHERE g.team = ? AND g.pos_group NOT IN ('OL', 'LS')
                GROUP BY g.player_id, season, game_type""", [abbrev]),
            "schedule": table(con, """
                SELECT game_id, season, game_type, round, week, game_date, gametime, weekday,
                       CASE WHEN home_team = ? THEN away_team ELSE home_team END AS opp, home_team = ? AS is_home,
                       CASE WHEN home_team = ? THEN spread_line ELSE -spread_line END AS team_line, total_line, roof
                FROM games WHERE NOT played AND ? IN (home_team, away_team) AND season = ?
                ORDER BY game_date""", [abbrev, abbrev, abbrev, abbrev, max(seasons)]),
        })

    # --- league-wide season files
    for season in seasons:
        write(f"{out}/league/{season}.json", {
            "players": table(con, PLAYER_AGG, [season]),
            "teams": table(con, TEAM_AGG, [season]),
            "form": trends.season_form(con, season),
        })
        write(f"{out}/games/{season}.json", table(con, """
            SELECT game_id, game_type, round, week, game_date, weekday, gametime, away_team, away_score, home_team,
                   home_score, overtime, spread_line, total_line, roof, temp, wind, stadium, played
            FROM games WHERE season = ? ORDER BY game_date, gametime, game_id""", [season]))

    # --- per-game box scores
    tg_cols = ["team"] + [c.strip() for c in TEAM_COLS.replace("\n", " ").split(",")]
    by_game_team = defaultdict(list)
    for r in con.execute(f"SELECT team, {TEAM_COLS} FROM v_team_games").fetchall():
        by_game_team[r[1]].append(dict(zip(tg_cols, [_clean(v) for v in r])))
    box_cols = ["id", "name", "pos", "grp", "team"] + BOX_PLAYER
    box = defaultdict(list)
    for r in con.execute(f"""
            SELECT g.game_id, g.player_id, coalesce(p.full_name, g.name), g.position, g.pos_group, g.team,
                   {', '.join('g.' + c for c in BOX_PLAYER)}
            FROM player_games g LEFT JOIN players p USING (player_id)
            ORDER BY g.game_id, g.team, g.fantasy_points_ppr DESC NULLS LAST""").fetchall():
        box[r[0]].append([_clean(v) for v in r[1:]])
    for (gid, season, gtype, rnd, week, gdate, home, away, hs, as_, ot, stadium, roof, temp, wind, spread,
         total, hqb, aqb, hc, ac) in con.execute(
            "SELECT game_id, season, game_type, round, week, game_date, home_team, away_team, home_score, "
            "away_score, overtime, stadium, roof, temp, wind, spread_line, total_line, home_qb, away_qb, "
            "home_coach, away_coach FROM games WHERE played").fetchall():
        write(f"{out}/box/{gid}.json", {
            "game": {"id": gid, "season": season, "type": gtype, "round": rnd, "week": week, "date": _clean(gdate),
                     "home": home, "away": away, "home_score": hs, "away_score": as_, "overtime": ot,
                     "stadium": stadium, "roof": roof, "temp": _clean(temp), "wind": _clean(wind),
                     "spread": _clean(spread), "total": _clean(total), "home_coach": hc, "away_coach": ac},
            "teams": by_game_team.get(gid, []),
            "players": {"cols": box_cols, "rows": box.get(gid, [])},
        })

    meta = {"updated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "last_game": _clean(last[0]) if last else None,
            "last_week": {"season": last[1], "week": last[2], "type": last[3], "round": last[4]} if last else None,
            "seasons": seasons, "current_season": seasons[-1] if seasons else None, "counts": counts}
    write(f"{out}/meta.json", meta)
    return meta


def main(argv=None):
    ap = argparse.ArgumentParser(prog="nfl.export")
    ap.add_argument("--db", default=None)
    ap.add_argument("--out", default="_site/data")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    con = db.connect(args.db)
    meta = export(con, args.out)
    log.info("exported: %s", meta)


if __name__ == "__main__":
    main()
