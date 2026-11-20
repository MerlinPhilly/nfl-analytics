# NFL Analytics

A personal NFL research platform covering the current season plus the previous five. It includes results, box scores, player and team game logs, league rankings, splits, hot/cold trends and a screener. The data refreshes twice a day on its own.

It's the football version of [nhl-analytics](https://github.com/MerlinPhilly/nhl-analytics): same layout, same colors, same ideas.

**How it works**

```
nflverse files on GitHub ──► GitHub Actions (5:41 AM + 11:41 AM ET) ──► DuckDB ──► JSON ──► website (GitHub Pages)
                              nfl/ingest.py                              nfl/export.py      site/
```

- **Data source:** [nflverse](https://nflverse.com), the open NFL data project used by most public football analytics. The pipeline downloads its weekly player stats, weekly team stats, schedules (with betting lines, rest days, roof, surface and weather), player bios and team info. No API key is needed. nflverse usually posts a game's stats within hours of the final whistle.
- **Database:** a single DuckDB file, rebuilt from scratch on every run (about 2 minutes). There's no history load to run and nothing to resume: if a run fails, the next one fixes it. The latest database is attached to the repo's `data-store` release if you want to query it yourself.
- **Website:** a static site with no server. Each run rebuilds it.

## One-time setup (about 5 minutes)

1. **Turn on Pages.** In the repo, go to *Settings → Pages → Build and deployment → Source* and choose **GitHub Actions**.
2. **Run it once.** Go to *Actions → Update data → Run workflow*. It takes about 3 minutes.
3. **Open the site** at `https://<your-username>.github.io/nfl-analytics/`.

After that it runs by itself twice a day. To refresh right after a game, use *Actions → Update data → Run workflow*.

## What's on the site

| Page | What you get |
|---|---|
| **Home** | Latest week's results with the line and total, games still to play, leaders (passing, rushing, receiving, PPR fantasy, sacks), hottest players, standings by division with division/conference records, streak, last 5 and form |
| **Player** | Bio and draft; filters for season, game type, home/away, opponent, team result, rest and dates; ranked stat boxes built for the position (QB, RB, WR, TE, DL, LB, DB, K, P); rolling trend chart; league percentiles; splits; game log; season-by-season table |
| **Team** | Same filters; ranked stat boxes (points, EPA per play on both sides, yards per play, turnover margin, sacks, explosive plays, penalties, record against the spread); results strip; trend charts; splits; player tables (passing, rushing, receiving, defense, kicking, fantasy); upcoming schedule with each opponent's record, point differential and form; game log |
| **Trends** | Hottest and coldest QBs, RBs, WRs and TEs; all 32 teams ranked by form; "likely to cool off", "due to heat up" and role changes |
| **Screener** | Passing, rushing, receiving, defense, kicking, punting, fantasy and team tables for any season, sortable on any column, with last-3-games vs season columns |
| **Compare** | Two players or two teams side by side over the same filters, with an overlaid trend |
| **Games** | Every week's results and lines, plus a box score for every game |

Every table has a **Download CSV** button.

**Splits** available everywhere: season, home/away, opponent, opponent's division, result, favorite/underdog (by size of the line), rest (short week, normal, extra, off a bye), time slot (Thursday, Sunday early/late/night, Monday), weather (cold, cool, mild, hot, indoors), surface (grass/turf), division games, month, regular season/playoffs.

## Colors and form

Every ranking uses one scale: **green = good, gray = middle, orange/red = bad**, with the tier name and rank printed next to every color. Rankings compare per-game rates against players at the same position group who have played at least 40% of the leader's games and hold a regular role (for example 15+ pass attempts a game for QBs, 3+ targets for WRs). Stats where lower is better (interception rate, sack rate, points allowed) are flipped.

**Form** (`nfl/trends.py`): for each QB, RB, WR and TE, an expected PPR output per game comes from his earlier games this season blended with last season (or the position average). His last 4 and last 2 games are compared with that expectation, scaled by how much a player at his level normally swings week to week. +0.9 or more is Warming, +1.8 or more is Hot, and the same below zero means Cooling and Cold. Teams use wins and point differential over the last 4. Flags:

- **Likely to cool:** a player scoring far more touchdowns than his yardage usually produces, or a team whose record is well ahead of its point differential while winning one-score games.
- **Due to heat up:** the reverse.
- **Role ↑ / ↓:** a clear change in target share or touches.

NFL samples are small, so read the reasons on each badge rather than the badge alone.

## Running it on your Mac (optional)

```bash
pip install -r requirements.txt
python -m nfl.ingest                     # about 1 minute
python -m nfl.export --out _site/data && cp -r site/* _site/
cd _site && python -m http.server 8000   # open http://localhost:8000
```

Query the database directly with `duckdb data/nfl.duckdb`, for example
`SELECT game_date, opp, receiving_yards, targets FROM v_player_games WHERE name = 'Ja''Marr Chase' ORDER BY game_date DESC LIMIT 10;`

**Tables and views:** `games` (full schedule, played and upcoming), `team_stats`, `player_games`, `players`, `teams`, `v_team_games` (each team's offense plus what it allowed, result, against-the-spread and over/under results), `v_player_games` (player stats with game context).

## Not included yet

Play-by-play detail (third down, red zone, success rate, situational splits), snap counts and Next Gen Stats. nflverse publishes all three, so they can be added later.

## Credit

Data from nflverse. Personal research tool, not affiliated with the NFL.
