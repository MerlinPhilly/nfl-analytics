"""Hot / cold form detection, NFL edition.

Same idea as the NHL site: compare each player's or team's most recent games
with what we'd *expect* from them, and flag only gaps too big to be noise.

Players (QB, RB, WR, TE): production = PPR fantasy points per game, the one
number that blends yards, touchdowns and catches across positions.
  expected = earlier games this season blended with last season's rate
             (or the position average), weighted as K_GAMES extra games
  noise    = how much a player at that production level normally swings
             game to game (fitted from the league each season)
  score    = 0.65 * z(last 4 games) + 0.35 * z(last 2 games)

Teams: wins and point differential over the last 4 games vs expectation.

Status: >= +1.8 hot, >= +0.9 warming, <= -0.9 cooling, <= -1.8 cold.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

HOT, WARM, COOL, COLD = 1.8, 0.9, -0.9, -1.8
K_GAMES = 4          # prior weight, in games
WIN, SHORT = 4, 2    # recent windows
MIN_GP = 5
GAME_PD_SD = 13.5    # typical game-to-game swing in NFL point differential
SKILL = ("QB", "RB", "WR", "TE")


def status_of(score: float) -> str:
    if score >= HOT:
        return "hot"
    if score >= WARM:
        return "warming"
    if score <= COLD:
        return "cold"
    if score <= COOL:
        return "cooling"
    return "steady"


def _streak(flags) -> int:
    n = 0
    for f in reversed(list(flags)):
        if not f:
            break
        n += 1
    return n


def _r(x, d=2):
    return None if x is None or (isinstance(x, float) and math.isnan(x)) else round(float(x), d)


# ---------------------------------------------------------------- players
def player_form(con, season: int) -> dict:
    g = con.execute(f"""
        SELECT player_id, pos_group grp, game_date, game_type, fantasy_points_ppr ppr, targets, carries, receptions,
               coalesce(target_share, 0) tshare, passing_yards, passing_tds, passing_interceptions ints,
               attempts, sacks_suffered sacks, passing_epa, rushing_epa, scrimmage_yds, rushing_yards, receiving_yards,
               rushing_tds + receiving_tds AS sc_tds, total_tds, touches
        FROM v_player_games WHERE season = ? AND pos_group IN {SKILL}
        ORDER BY player_id, game_date, game_id""", [season]).df().fillna(0)
    if g.empty:
        return {}
    as_of = g["game_date"].max()
    prev = con.execute(f"""SELECT player_id, count(*) gp, avg(fantasy_points_ppr) ppr FROM v_player_games
                           WHERE season = ? AND game_type = 'R' AND pos_group IN {SKILL} GROUP BY 1""",
                       [season - 1]).df().set_index("player_id")

    # Fit game-to-game noise as a function of a player's level: sd ~ a + b * mean (per position group).
    noise = {}
    lvl = g.groupby(["grp", "player_id"])["ppr"].agg(["mean", "std", "count"])
    lvl = lvl[lvl["count"] >= 4].dropna()
    for grp, d in lvl.groupby(level=0):
        if len(d) >= 8:
            b, a = np.polyfit(d["mean"], d["std"], 1)
            noise[grp] = (max(2.0, a), max(0.2, b))
    pos_avg = g.groupby("grp")["ppr"].mean()
    # Touchdowns per scrimmage yard (and per passing yard), to judge TD luck.
    sc_rate = g["sc_tds"].sum() / max(1, g["scrimmage_yds"].sum())
    pa_rate = g["passing_tds"].sum() / max(1, g["passing_yards"].sum())

    out = {}
    for pid, d in g.groupby("player_id", sort=False):
        n = len(d)
        if n < MIN_GP:
            continue
        grp = d["grp"].iloc[-1]
        w = min(WIN, n - 1)
        rec, pri, short = d.iloc[-w:], d.iloc[:-w], d.iloc[-SHORT:]
        pv = pos_avg.get(grp, 10.0)
        if pid in prev.index and prev.at[pid, "gp"] >= 6:
            pv = prev.at[pid, "ppr"]
        exp = (pri["ppr"].sum() + K_GAMES * pv) / (len(pri) + K_GAMES)
        a, b = noise.get(grp, (3.0, 0.5))
        sd = a + b * max(exp, 0)

        def z(sub):
            return (sub["ppr"].mean() - exp) / (sd / math.sqrt(len(sub)))
        score = 0.65 * z(rec) + 0.35 * z(short)
        if exp < 6 and score < 0:          # a fringe player can't really be "cold"
            score = max(score, -0.85)
        if rec["ppr"].mean() < 8 and score > 0:   # ...or "hot" while still producing little
            score = min(score, 0.85)
        st = status_of(score)

        reasons, flags = [f"{rec['ppr'].mean():.1f} PPR pts/game last {w} vs {exp:.1f} expected"], []
        # usage / role
        if grp in ("WR", "TE") or (grp == "RB" and rec["targets"].sum() >= 6):
            ts_r, ts_p = rec["tshare"].mean(), (pri["tshare"].mean() if len(pri) else None)
            if ts_p is not None and abs(ts_r - ts_p) >= 0.06 and max(ts_r, ts_p) >= 0.12:
                up = ts_r > ts_p
                reasons.append(f"Target share {'up' if up else 'down'}: {ts_r:.0%} last {w} vs {ts_p:.0%} before")
                flags.append("role_up" if up else "role_down")
        if grp == "RB" and len(pri):
            t_r, t_p = rec["touches"].mean(), pri["touches"].mean()
            if abs(t_r - t_p) >= 4 and max(t_r, t_p) >= 8:
                up = t_r > t_p
                reasons.append(f"Touches {'up' if up else 'down'}: {t_r:.1f}/game last {w} vs {t_p:.1f} before")
                flags.append("role_up" if up else "role_down")
        if grp == "QB":
            db_r = rec["attempts"].sum() + rec["sacks"].sum()
            db_all = d["attempts"].sum() + d["sacks"].sum()
            if db_r >= 40 and db_all:
                e_r = (rec["passing_epa"].sum()) / db_r
                e_s = d["passing_epa"].sum() / db_all
                if abs(e_r - e_s) >= 0.08:
                    reasons.append(f"EPA per dropback {e_r:+.2f} last {w} vs {e_s:+.2f} season")
            i_r = rec["ints"].sum()
            if i_r >= 4:
                reasons.append(f"{int(i_r)} interceptions in last {w}")
        # streaks
        if grp == "QB":
            s3 = _streak(d["passing_tds"] >= 2)
            if s3 >= 3:
                reasons.append(f"2+ TD passes in {s3} straight")
        else:
            s_td = _streak(d["total_tds"] > 0)
            if s_td >= 3:
                reasons.append(f"Touchdown in {s_td} straight games")
            ycol, ylab, thr = ("receiving_yards", "receiving", 80) if grp in ("WR", "TE") else ("scrimmage_yds", "scrimmage", 100)
            s_y = _streak(d[ycol] >= thr)
            if s_y >= 3:
                reasons.append(f"{thr}+ {ylab} yards in {s_y} straight")
        dry = _streak(d["ppr"] < max(4.0, 0.5 * exp))
        if dry >= 3:
            reasons.append(f"{dry} straight quiet games (under half his usual output)")
        # touchdown luck: TDs far above / below what the yardage usually produces
        if grp == "QB":
            td_r, td_e = rec["passing_tds"].sum(), rec["passing_yards"].sum() * pa_rate
            what = "TD passes"
        else:
            td_r, td_e = rec["sc_tds"].sum(), rec["scrimmage_yds"].sum() * sc_rate
            what = "TDs"
        if st in ("hot", "warming") and td_r - td_e >= 2.0 and td_r >= 1.6 * td_e:
            reasons.append(f"{int(td_r)} {what} last {w} on yardage that usually yields ~{td_e:.1f} — scoring pace likely to cool")
            flags.append("regression_risk")
        if st in ("cold", "cooling", "steady") and td_e - td_r >= 1.5:
            reasons.append(f"Yardage is there but only {int(td_r)} {what} last {w} (~{td_e:.1f} typical) — due to heat up")
            flags.append("buy_low")

        out[pid] = {"status": st, "score": _r(score), "window": w, "reasons": reasons, "flags": flags,
                    "ppr_recent": _r(rec["ppr"].mean(), 1), "ppr_exp": _r(exp, 1),
                    "last_game": str(d["game_date"].iloc[-1])[:10]}
    return {"as_of": str(as_of)[:10], "players": out}


# ---------------------------------------------------------------- teams
def team_form(con, season: int) -> dict:
    g = con.execute("""
        SELECT team, game_date, result, pf, pa, epa, plays, opp_epa, opp_plays, turnovers, takeaways
        FROM v_team_games WHERE season = ? ORDER BY team, game_date, game_id""", [season]).df()
    if g.empty:
        return {}
    prev = con.execute("""SELECT team, avg(CASE result WHEN 'W' THEN 1 WHEN 'T' THEN .5 ELSE 0 END) wp,
                          avg(pf - pa) pd FROM v_team_games WHERE season = ? AND game_type = 'R' GROUP BY 1""",
                       [season - 1]).df().set_index("team")
    g["wf"] = g["result"].map({"W": 1.0, "T": 0.5, "L": 0.0})
    g["pd"] = g["pf"] - g["pa"]
    out = {}
    for team, d in g.groupby("team", sort=False):
        n = len(d)
        if n < MIN_GP:
            continue
        w = min(WIN, n - 1)
        rec, pri = d.iloc[-w:], d.iloc[:-w]
        wp_prev = prev.at[team, "wp"] if team in prev.index else 0.5
        pd_prev = prev.at[team, "pd"] if team in prev.index else 0.0
        # last season counts for less in the NFL (rosters turn over): shrink it halfway to average
        wp_prev, pd_prev = 0.5 + 0.5 * (wp_prev - 0.5), 0.5 * pd_prev
        bw = (pri["wf"].sum() + K_GAMES * wp_prev) / (len(pri) + K_GAMES)
        bpd = (pri["pd"].sum() + K_GAMES * pd_prev) / (len(pri) + K_GAMES)
        z_w = (rec["wf"].sum() - bw * w) / math.sqrt(max(0.15, bw * (1 - bw)) * w)
        z_pd = (rec["pd"].sum() - bpd * w) / (GAME_PD_SD * math.sqrt(w))
        score = 0.4 * z_w + 0.6 * z_pd
        res = d["result"].tolist()
        win_streak, skid = _streak([r == "W" for r in res]), _streak([r != "W" for r in res])
        W, L, T = (rec["result"] == "W").sum(), (rec["result"] == "L").sum(), (rec["result"] == "T").sum()
        rec_str = f"{W}-{L}" + (f"-{T}" if T else "")
        reasons = [f"{rec_str} last {w}, point diff {int(rec['pd'].sum()):+d} ({rec['pf'].mean():.1f} for, {rec['pa'].mean():.1f} against per game)"]
        if win_streak >= 3:
            reasons.append(f"{win_streak}-game win streak")
        if skid >= 3:
            reasons.append(f"{skid} straight without a win")
        if rec["plays"].sum() and rec["opp_plays"].sum():
            net = rec["epa"].sum() / rec["plays"].sum() - rec["opp_epa"].sum() / rec["opp_plays"].sum()
            reasons.append(f"Net EPA/play {net:+.2f} last {w} (offense minus defense)")
        tm = int(rec["takeaways"].sum() - rec["turnovers"].sum())
        if abs(tm) >= 4:
            reasons.append(f"Turnover margin {tm:+d} last {w}")

        # luck checks over the whole season
        flags = []
        close = d[d["pd"].abs() <= 8]
        cw, cl = (close["result"] == "W").sum(), (close["result"] == "L").sum()
        wp_season, pd_g = d["wf"].mean(), d["pd"].mean()
        # Pythagorean expectation (NFL exponent 2.37)
        pf, pa = d["pf"].sum(), d["pa"].sum()
        pyth = pf ** 2.37 / (pf ** 2.37 + pa ** 2.37) if pf + pa else 0.5
        if wp_season - pyth >= 0.15 and cw - cl >= 2:
            reasons.append(f"Record ({wp_season:.3f}) well ahead of point differential ({pyth:.3f} expected); {cw}-{cl} in one-score games — may not last".replace("0.", "."))
            flags.append("regression_risk")
        elif pyth - wp_season >= 0.15 and cl - cw >= 2:
            reasons.append(f"Point differential says {pyth:.3f}, record says {wp_season:.3f}; {cw}-{cl} in one-score games — due to turn".replace("0.", "."))
            flags.append("buy_low")
        out[team] = {"status": status_of(score), "score": _r(score), "window": w, "reasons": reasons, "flags": flags,
                     "win_streak": win_streak, "skid": skid, "pyth": _r(pyth, 3), "pd_g": _r(pd_g, 1),
                     "last_game": str(d["game_date"].iloc[-1])[:10]}
    return {"as_of": str(g["game_date"].max())[:10], "teams": out}


def season_form(con, season: int) -> dict:
    pl, tm = player_form(con, season), team_form(con, season)
    return {"as_of": pl.get("as_of") or tm.get("as_of"), "players": pl.get("players", {}),
            "teams": tm.get("teams", {})}
