"""Sanity checks on the built database. Run after `python -m nfl.ingest`:  python -m pytest tests -q

These guard against nflverse changing a file's layout or meaning (for example
the sign of sack yards) without anyone noticing.
"""
import os

import pytest

from nfl import db, trends

DB = os.environ.get("NFL_DB", "data/nfl.duckdb")
pytestmark = pytest.mark.skipif(not os.path.exists(DB), reason="build the database first")


@pytest.fixture(scope="module")
def con():
    return db.connect(DB)


def test_every_played_game_has_team_stats(con):
    missing = con.execute("SELECT count(*) FROM v_team_games WHERE NOT has_stats").fetchone()[0]
    total = con.execute("SELECT count(*) FROM v_team_games").fetchone()[0]
    assert total > 0 and missing <= 0.01 * total


def test_team_and_player_passing_agree(con):
    bad = con.execute("""
        SELECT count(*) FROM team_stats t JOIN (
            SELECT game_id, team, sum(passing_yards) py FROM player_games GROUP BY 1, 2) p USING (game_id, team)
        WHERE t.pass_yds <> p.py""").fetchone()[0]
    assert bad == 0


def test_net_passing_is_below_gross(con):
    assert con.execute("SELECT count(*) FROM v_team_games WHERE net_pass_yds > pass_yds").fetchone()[0] == 0


def test_scores_and_results(con):
    assert con.execute("SELECT count(*) FROM v_team_games WHERE (pf > pa) <> (result = 'W')").fetchone()[0] == 0
    # every game appears once per side
    assert con.execute("SELECT count(*) FROM (SELECT game_id FROM v_team_games GROUP BY 1 HAVING count(*) <> 2)").fetchone()[0] == 0


def test_form_runs(con):
    season = con.execute("SELECT max(season) FROM games WHERE played").fetchone()[0]
    f = trends.season_form(con, season)
    assert isinstance(f["players"], dict) and isinstance(f["teams"], dict)
