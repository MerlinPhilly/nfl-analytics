"""Download nflverse data and build the DuckDB database from scratch.

  python -m nfl.ingest                      # current season + previous 5
  python -m nfl.ingest --seasons 2024,2025,2026

Every source is a static file on the nflverse-data GitHub releases, so a full
rebuild takes a minute or two. There's no incremental mode to go wrong: each
run downloads the latest files and rebuilds every table.
"""
from __future__ import annotations

import argparse
import datetime as dt
import logging
import os
import time

import pandas as pd
import requests

from . import db

log = logging.getLogger("nfl.ingest")

BASE = os.environ.get("NFLVERSE_BASE", "https://github.com/nflverse/nflverse-data/releases/download")
RAW = os.environ.get("NFL_RAW_DIR", "data/raw")


def current_season(today: dt.date | None = None) -> int:
    """NFL seasons are named for the year they start. Jan-Feb games belong to last year's season."""
    today = today or dt.date.today()
    return today.year if today.month >= 3 else today.year - 1


def fetch(rel: str, max_age_h: float = 0) -> str:
    """Download a release file to data/raw (re-using a fresh local copy if max_age_h > 0)."""
    path = os.path.join(RAW, rel.replace("/", "__"))
    if max_age_h and os.path.exists(path) and time.time() - os.path.getmtime(path) < max_age_h * 3600:
        return path
    os.makedirs(RAW, exist_ok=True)
    url = f"{BASE}/{rel}"
    for attempt in range(4):
        try:
            r = requests.get(url, timeout=120)
            if r.status_code == 404:
                raise FileNotFoundError(url)
            r.raise_for_status()
            with open(path + ".tmp", "wb") as f:
                f.write(r.content)
            os.replace(path + ".tmp", path)
            log.info("downloaded %s (%.0f KB)", rel, len(r.content) / 1024)
            return path
        except FileNotFoundError:
            raise
        except Exception as e:  # network blip: back off and retry
            log.warning("download %s failed (%s), retry %d", rel, e, attempt + 1)
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"could not download {url}")


# ---------------------------------------------------------------- columns kept per player-game
PLAYER_STATS = [
    # passing
    "completions", "attempts", "passing_yards", "passing_tds", "passing_interceptions", "sacks_suffered",
    "sack_yards_lost", "sack_fumbles_lost", "passing_air_yards", "passing_yards_after_catch",
    "passing_first_downs", "passing_epa", "passing_cpoe", "passing_2pt_conversions",
    # rushing
    "carries", "rushing_yards", "rushing_tds", "rushing_fumbles_lost", "rushing_first_downs", "rushing_epa",
    "rushing_2pt_conversions",
    # receiving
    "receptions", "targets", "receiving_yards", "receiving_tds", "receiving_fumbles_lost", "receiving_air_yards",
    "receiving_yards_after_catch", "receiving_first_downs", "receiving_epa", "receiving_2pt_conversions",
    "target_share", "air_yards_share", "wopr",
    # defense
    "def_tackles_solo", "def_tackle_assists", "def_tackles_for_loss", "def_sacks", "def_qb_hits",
    "def_interceptions", "def_pass_defended", "def_fumbles_forced", "def_tds", "fumble_recovery_opp",
    # kicking / punting / returns
    "fg_made", "fg_att", "fg_long", "fg_made_40_49", "fg_att_50p", "fg_made_50p", "pat_made", "pat_att",
    "pt_att", "pt_yards", "pt_net_yards", "pt_inside_20",
    "punt_return_yards", "kickoff_return_yards", "special_teams_tds",
    "fantasy_points", "fantasy_points_ppr",
]
TEAM_STATS = {  # db column: nflverse column(s)
    "completions": "completions", "pass_att": "attempts", "pass_yds": "passing_yards", "pass_td": "passing_tds",
    "ints": "passing_interceptions", "sacks_taken": "sacks_suffered", "sack_yds": "sack_yards_lost",
    "carries": "carries", "rush_yds": "rushing_yards", "rush_td": "rushing_tds",
    "pass_epa": "passing_epa", "rush_epa": "rushing_epa",
    "first_downs": ("passing_first_downs", "rushing_first_downs"),
    "fumbles_lost": ("sack_fumbles_lost", "rushing_fumbles_lost", "receiving_fumbles_lost"),
    "penalties": "penalties", "penalty_yds": "penalty_yards",
    "def_sacks": "def_sacks", "def_ints": "def_interceptions", "def_ff": "def_fumbles_forced",
    "def_tds": "def_tds", "fg_made": "fg_made", "fg_att": "fg_att", "pat_made": "pat_made", "pat_att": "pat_att",
    "st_tds": "special_teams_tds", "pass_20p": "passing_20", "rush_20p": "rushing_20",
}


def _group(pos: str | None, grp: str | None) -> str | None:
    if pos in ("K", "P", "LS"):
        return pos
    if pos == "FB":
        return "RB"
    if grp == "SPEC":
        return "K" if pos == "K" else "P" if pos == "P" else "ST"
    return grp


def build(seasons: list[int], db_path: str | None = None, max_age_h: float = 0):
    con = db.connect(db_path, fresh=True)

    # --- teams
    t = pd.read_csv(fetch("teams/teams_colors_logos.csv", max_age_h))
    sched = pd.read_csv(fetch("schedules/games.csv", max_age_h), low_memory=False)
    sched = sched[sched.season.isin(seasons)].copy()
    current = set(sched[sched.season == max(seasons)].home_team)
    t = t[t.team_abbr.isin(set(sched.home_team) | set(sched.away_team))]
    teams = pd.DataFrame({
        "abbrev": t.team_abbr, "name": t.team_name, "nick": t.team_nick, "conference": t.team_conf,
        "division": t.team_division, "color": t.team_color, "color2": t.team_color2,
        "current": t.team_abbr.isin(current)})
    con.register("teams_df", teams)
    con.execute("INSERT INTO teams SELECT * FROM teams_df")

    # --- games (whole schedule, played or not)
    s = sched
    games = pd.DataFrame({
        "game_id": s.game_id, "season": s.season,
        "game_type": s.game_type.map(lambda x: "R" if x == "REG" else "P"), "round": s.game_type,
        "week": s.week, "game_date": pd.to_datetime(s.gameday).dt.date, "weekday": s.weekday,
        "gametime": s.gametime, "away_team": s.away_team, "away_score": s.away_score,
        "home_team": s.home_team, "home_score": s.home_score, "overtime": s.overtime.fillna(0).astype(bool),
        "away_rest": s.away_rest, "home_rest": s.home_rest, "spread_line": s.spread_line,
        "total_line": s.total_line, "div_game": s.div_game.fillna(0).astype(bool), "roof": s.roof,
        "surface": s.surface, "temp": s.temp, "wind": s.wind, "stadium": s.stadium,
        "away_qb": s.away_qb_name, "home_qb": s.home_qb_name, "away_coach": s.away_coach,
        "home_coach": s.home_coach, "played": s.result.notna()})
    con.register("games_df", games)
    con.execute("INSERT INTO games SELECT * FROM games_df")

    # --- team-game stats
    tframes = []
    for season in seasons:
        try:
            tframes.append(pd.read_parquet(fetch(f"stats_team/stats_team_week_{season}.parquet", max_age_h)))
        except FileNotFoundError:
            log.warning("no team stats file for %s yet", season)
    ts = pd.concat(tframes, ignore_index=True)
    out = pd.DataFrame({"game_id": ts.game_id, "team": ts.team})
    for col, src in TEAM_STATS.items():
        if isinstance(src, tuple):
            out[col] = sum(ts[c].fillna(0) for c in src)
        else:
            out[col] = ts[src]
    con.register("ts_df", out)
    con.execute("INSERT INTO team_stats SELECT * FROM ts_df")

    # --- player-game stats
    pframes = []
    for season in seasons:
        try:
            pframes.append(pd.read_parquet(fetch(f"stats_player/stats_player_week_{season}.parquet", max_age_h)))
        except FileNotFoundError:
            log.warning("no player stats file for %s yet", season)
    ps = pd.concat(pframes, ignore_index=True)
    ps["fg_att_50p"] = sum(ps[c].fillna(0) for c in ("fg_made_50_59", "fg_made_60_", "fg_missed_50_59", "fg_missed_60_"))
    ps["fg_made_50p"] = ps["fg_made_50_59"].fillna(0) + ps["fg_made_60_"].fillna(0)
    pg = pd.DataFrame({
        "player_id": ps.player_id, "name": ps.player_display_name, "position": ps.position,
        "pos_group": [_group(p, g) for p, g in zip(ps.position, ps.position_group)],
        "game_id": ps.game_id, "team": ps.team})
    for c in PLAYER_STATS:
        pg[c] = ps[c]
    pg = pg[pg.game_id.notna()]
    con.register("pg_df", pg)
    con.execute("INSERT INTO player_games SELECT * FROM pg_df")

    # --- player bios
    pl = pd.read_parquet(fetch("players/players.parquet", max_age_h))
    pl = pl[pl.gsis_id.isin(set(pg.player_id))]
    bios = pd.DataFrame({
        "player_id": pl.gsis_id, "full_name": pl.display_name, "position": pl.position,
        "pos_group": [_group(p, g) for p, g in zip(pl.position, pl.position_group)],
        "birth_date": pd.to_datetime(pl.birth_date, errors="coerce").dt.date, "height_in": pl.height,
        "weight_lb": pl.weight, "college": pl.college_name, "jersey": pl.jersey_number,
        "current_team": pl.latest_team, "status": pl.status, "rookie_season": pl.rookie_season,
        "years_exp": pl.years_of_experience, "draft_year": pl.draft_year, "draft_round": pl.draft_round,
        "draft_pick": pl.draft_pick, "draft_team": pl.draft_team})
    con.register("bio_df", bios)
    con.execute("INSERT INTO players SELECT * FROM bio_df")

    con.execute("INSERT INTO run_log VALUES (now(), ?, ?)", [",".join(map(str, seasons)),
                con.execute("SELECT count(*) FROM games WHERE played").fetchone()[0]])
    n = {k: con.execute(f"SELECT count(*) FROM {k}").fetchone()[0]
         for k in ("games", "team_stats", "player_games", "players")}
    log.info("built database: %s", n)
    return con


def main(argv=None):
    ap = argparse.ArgumentParser(prog="nfl.ingest")
    ap.add_argument("--db", default=None)
    ap.add_argument("--seasons", default=None, help="comma-separated, e.g. 2021,2022 (default: current + 5 prior)")
    ap.add_argument("--cache-hours", type=float, default=0, help="reuse downloaded files younger than this")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    cur = current_season()
    seasons = [int(x) for x in args.seasons.split(",")] if args.seasons else list(range(cur - 5, cur + 1))
    build(seasons, args.db, args.cache_hours)


if __name__ == "__main__":
    main()
