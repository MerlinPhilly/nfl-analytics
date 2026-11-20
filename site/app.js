/* NFL Analytics — static single-page app. Reads JSON exported by nfl/export.py. */
"use strict";

const DATA = "data";
const $ = (sel, el = document) => el.querySelector(sel);
const app = $("#app");
const cache = new Map();

// ------------------------------------------------------------------ utils
async function load(path) {
  if (cache.has(path)) return cache.get(path);
  const p = fetch(`${DATA}/${path}`, { cache: "no-cache" }).then(r => {
    if (!r.ok) throw new Error(`${r.status} ${path}`);
    return r.json();
  });
  cache.set(path, p);
  try { return await p; } catch (e) { cache.delete(path); throw e; }
}
const objs = t => t ? t.rows.map(r => Object.fromEntries(t.cols.map((c, i) => [c, r[i]]))) : [];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const n = (x, k) => Number(x[k]) || 0;
const sum = (a, k) => a.reduce((s, x) => s + n(x, k), 0);
const div = (a, b) => (b ? a / b : null);
const seasonLabel = s => String(s);
const fmt = (v, d = 0) => (v == null || Number.isNaN(v) ? "–" : Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmtPct = (v, d = 1) => (v == null ? "–" : (v * 100).toFixed(d) + "%");
const fmt3 = v => (v == null ? "–" : v.toFixed(3).replace(/^0/, "").replace(/^-0/, "-"));
const fmtSigned = (v, d = 0) => (v == null ? "–" : (v > 0 ? "+" : "") + Number(v).toFixed(d));
const fmtDate = d => { const x = new Date(d + "T12:00:00"); return x.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); };
const shortDate = d => { const x = new Date(d + "T12:00:00"); return x.toLocaleDateString(undefined, { month: "short", day: "numeric" }); };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ROUND = { WC: "Wild Card", DIV: "Divisional", CON: "Conference", SB: "Super Bowl" };
const weekLabel = g => (g.round && g.round !== "REG" ? ROUND[g.round] || g.round : `Week ${g.week}`);
const wkShort = g => (g.round && g.round !== "REG" ? g.round : `W${g.week}`);
const h = (strings, ...vals) => strings.reduce((s, str, i) => s + str + (i < vals.length ? vals[i] : ""), "");
const numOf = s => parseFloat(String(s).replace(/[,+]/g, ""));
const groupBy = (arr, fn) => { const o = {}; for (const x of arr) (o[fn(x)] ||= []).push(x); return o; };

let META = null, TEAMS = [], TEAM_BY = {}, INDEX = [];

// ------------------------------------------------------------------ tooltip
const tip = $("#tooltip");
function showTip(html, x, y) {
  tip.innerHTML = html; tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let left = x + 14, top = y + 14;
  if (left + r.width > innerWidth - 8) left = x - r.width - 14;
  if (top + r.height > innerHeight - 8) top = y - r.height - 14;
  tip.style.left = left + "px"; tip.style.top = top + "px";
}
const hideTip = () => { tip.hidden = true; };

// ------------------------------------------------------------------ chart
function niceTicks(min, max, cnt = 4) {
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / cnt, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const out = []; for (let v = lo; v <= hi + step / 2; v += step) out.push(+v.toFixed(10));
  return out;
}
/** opts = { series:[{name,color,values,dots}], ref:{value}, yFmt, xLabels, tipHtml(i), height, zeroBase } */
function lineChart(el, opts) {
  const draw = () => {
    const W = el.clientWidth || 800, H = opts.height || 240, m = { l: 48, r: 14, t: 12, b: 26 };
    const cnt = Math.max(...opts.series.map(s => s.values.length));
    if (!cnt) { el.innerHTML = `<div class="empty">No games match these filters.</div>`; return; }
    const all = opts.series.flatMap(s => [...s.values, ...(s.dots || [])]).filter(v => v != null);
    if (opts.ref?.value != null) all.push(opts.ref.value);
    if (!all.length) { el.innerHTML = `<div class="empty">No data for this stat.</div>`; return; }
    let lo = Math.min(...all), hi = Math.max(...all);
    if (opts.zeroBase !== false && lo >= 0) lo = 0;
    const ticks = niceTicks(lo, hi);
    lo = ticks[0]; hi = ticks[ticks.length - 1];
    const x = i => m.l + (cnt === 1 ? (W - m.l - m.r) / 2 : (i / (cnt - 1)) * (W - m.l - m.r));
    const y = v => m.t + (1 - (v - lo) / (hi - lo || 1)) * (H - m.t - m.b);
    const yFmt = opts.yFmt || (v => fmt(v, Math.abs(hi - lo) < 3 ? 2 : 0));
    let svg = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="${esc(opts.title || "chart")}">`;
    for (const t of ticks) svg += `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/><text class="axis-label" x="${m.l - 6}" y="${y(t) + 4}" text-anchor="end">${yFmt(t)}</text>`;
    const xl = opts.xLabels || [];
    const idxs = cnt <= 1 ? [0] : [0, Math.floor((cnt - 1) / 3), Math.floor(2 * (cnt - 1) / 3), cnt - 1];
    for (const i of [...new Set(idxs)]) if (xl[i]) svg += `<text class="axis-label" x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === cnt - 1 ? "end" : "middle"}">${esc(xl[i])}</text>`;
    if (opts.ref?.value != null) svg += `<line class="ref" x1="${m.l}" x2="${W - m.r}" y1="${y(opts.ref.value)}" y2="${y(opts.ref.value)}"/>`;
    for (const s of opts.series) {
      if (s.dots) s.dots.forEach((v, i) => { if (v != null) svg += `<circle class="dot" cx="${x(i)}" cy="${y(v)}" r="3" fill="${s.color}"/>`; });
      let d = "", pen = false;
      s.values.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true; });
      svg += `<path class="line" d="${d}" stroke="${s.color}"/>`;
    }
    svg += `<g class="hover" style="display:none"><line class="cross" y1="${m.t}" y2="${H - m.b}"/>${opts.series.map(s => `<circle class="hover-dot" r="4.5" fill="${s.color}"/>`).join("")}</g>`;
    svg += `<rect x="${m.l}" y="0" width="${W - m.l - m.r}" height="${H}" fill="transparent" class="hit"/></svg>`;
    el.innerHTML = svg;
    const hover = el.querySelector(".hover"), hit = el.querySelector(".hit"), svgEl = el.querySelector("svg");
    const move = (cx, cy) => {
      const r = svgEl.getBoundingClientRect(), px = (cx - r.left) * (W / r.width);
      const i = Math.max(0, Math.min(cnt - 1, Math.round(cnt === 1 ? 0 : ((px - m.l) / (W - m.l - m.r)) * (cnt - 1))));
      hover.style.display = "";
      hover.querySelector("line").setAttribute("x1", x(i)); hover.querySelector("line").setAttribute("x2", x(i));
      hover.querySelectorAll("circle").forEach((c, k) => {
        const v = opts.series[k].values[i];
        c.style.display = v == null ? "none" : ""; if (v != null) { c.setAttribute("cx", x(i)); c.setAttribute("cy", y(v)); }
      });
      showTip(opts.tipHtml(i), cx, cy);
    };
    hit.addEventListener("mousemove", ev => move(ev.clientX, ev.clientY));
    hit.addEventListener("touchstart", ev => { const t = ev.touches[0]; move(t.clientX, t.clientY); }, { passive: true });
    hit.addEventListener("mouseleave", () => { hover.style.display = "none"; hideTip(); });
  };
  draw();
  el._redraw = draw;
}
let resizeTimer;
addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => document.querySelectorAll(".chart").forEach(c => c._redraw && c._redraw()), 150); });

function rolling(vals, w) {
  return vals.map((_, i) => {
    const win = vals.slice(Math.max(0, i - w + 1), i + 1).filter(v => v != null);
    return i + 1 < Math.min(w, vals.length) || !win.length ? null : win.reduce((a, b) => a + b, 0) / win.length;
  });
}
function rollingRatio(num, den, w) {
  return num.map((_, i) => {
    if (i + 1 < Math.min(w, num.length)) return null;
    let a = 0, b = 0; for (let k = Math.max(0, i - w + 1); k <= i; k++) { a += num[k] || 0; b += den[k] || 0; }
    return b ? a / b : null;
  });
}

// ------------------------------------------------------------------ sortable table
/** cols: [{k, label, fmt?(v,row), val?(row), html?(row), n?, title?, cellCls?(row), sortVal?(row), csv?(row)}] */
function sortTable(el, rows, cols, { sortKey, desc = true, limit = 0, csvName, full = false } = {}) {
  let key = sortKey, dsc = desc;
  const raw = (c, r) => (c.val ? c.val(r) : r[c.k]);
  const render = () => {
    const c = cols.find(c => c.k === key);
    const sv = r => (c?.sortVal ? c.sortVal(r) : c ? raw(c, r) : r[key]);
    const sorted = key ? [...rows].sort((a, b) => {
      const va = sv(a), vb = sv(b);
      const na = va == null || Number.isNaN(va), nb = vb == null || Number.isNaN(vb);
      if (na && nb) return 0; if (na) return 1; if (nb) return -1;
      return (va > vb ? 1 : va < vb ? -1 : 0) * (dsc ? -1 : 1);
    }) : rows;
    const shown = limit ? sorted.slice(0, limit) : sorted;
    const cell = (c, r) => (c.html ? c.html(r) : esc(c.fmt ? c.fmt(raw(c, r), r) : raw(c, r) ?? "–"));
    el.innerHTML = h`
      ${csvName ? `<div class="tbl-tools"><span class="muted">${rows.length} rows${limit && rows.length > limit ? ` · showing top ${limit}` : ""}</span><button class="btn csv">Download CSV</button></div>` : ""}
      <div class="tbl-wrap" ${full ? 'style="max-height:none"' : ""}><table><thead><tr>${cols.map(c => `<th data-k="${c.k}" class="${c.n ? "n" : ""} ${c.k === key ? "sorted" + (dsc ? "" : " asc") : ""}" title="${esc(c.title || "")}">${c.label}</th>`).join("")}</tr></thead>
      <tbody>${shown.map(r => `<tr>${cols.map(c => `<td class="${c.n ? "n" : ""} ${c.cellCls ? c.cellCls(r) : ""}">${cell(c, r)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    el.querySelectorAll("th").forEach(th => th.onclick = () => {
      if (key === th.dataset.k) dsc = !dsc; else { key = th.dataset.k; dsc = true; }
      render();
    });
    const btn = el.querySelector(".csv");
    if (btn) btn.onclick = () => downloadCsv(csvName, sorted, cols);
  };
  render();
}
function downloadCsv(name, rows, cols) {
  const q = v => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [cols.map(c => q(c.label.replace(/<[^>]+>/g, ""))).join(",")];
  for (const r of rows) lines.push(cols.map(c => { const v = c.val ? c.val(r) : r[c.k]; return q(c.csv ? c.csv(r) : c.fmt ? c.fmt(v, r) : v); }).join(","));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
  a.download = `${name}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ------------------------------------------------------------------ player stat definitions
// Every stat is a function of a "totals" object: { gp, <stat sums> }. The same function works on a
// player's filtered games (aggPlayer) and on a league season row, so rankings compare like with like.
const P_STATS = ["completions", "attempts", "passing_yards", "passing_tds", "passing_interceptions", "sacks_suffered", "sack_yards_lost", "sack_fumbles_lost",
  "passing_air_yards", "passing_yards_after_catch", "passing_first_downs", "passing_epa", "passing_2pt_conversions", "carries", "rushing_yards", "rushing_tds",
  "rushing_fumbles_lost", "rushing_first_downs", "rushing_epa", "rushing_2pt_conversions", "receptions", "targets", "receiving_yards", "receiving_tds",
  "receiving_fumbles_lost", "receiving_air_yards", "receiving_yards_after_catch", "receiving_first_downs", "receiving_epa", "receiving_2pt_conversions",
  "def_tackles_solo", "def_tackle_assists", "def_tackles_for_loss", "def_sacks", "def_qb_hits", "def_interceptions", "def_pass_defended", "def_fumbles_forced",
  "def_tds", "fumble_recovery_opp", "fg_made", "fg_att", "fg_made_40_49", "fg_att_50p", "fg_made_50p", "pat_made", "pat_att", "pt_att", "pt_yards", "pt_net_yards",
  "pt_inside_20", "punt_return_yards", "kickoff_return_yards", "special_teams_tds", "fantasy_points", "fantasy_points_ppr", "total_tds", "scrimmage_yds", "touches", "tackles"];
function aggPlayer(g) {
  const a = { gp: g.length };
  for (const k of P_STATS) a[k] = sum(g, k);
  const tg = g.filter(x => n(x, "targets") > 0);
  for (const k of ["target_share", "air_yards_share", "wopr"]) a[k] = tg.length ? sum(tg, k) / tg.length : null;
  const cp = g.filter(x => x.passing_cpoe != null && n(x, "attempts") > 0);
  a.passing_cpoe = cp.length ? cp.reduce((s, x) => s + x.passing_cpoe * x.attempts, 0) / sum(cp, "attempts") : null;
  a.fg_long = Math.max(0, ...g.map(x => n(x, "fg_long"))) || null;
  a.w = g.filter(x => x.team_result === "W").length; a.l = g.filter(x => x.team_result === "L").length; a.t = g.filter(x => x.team_result === "T").length;
  return a;
}
const pg = k => a => div(a[k], a.gp);
const f1 = v => fmt(v, 1), f2 = v => fmt(v, 2), fp = v => fmtPct(v, 1), fs2 = v => fmtSigned(v, 2);
const tot = k => a => fmt(a[k]);
const db = a => a.attempts + a.sacks_suffered;
/** label, f (rate used for ranking), fmt, lower (lower is better), basis, total (tile headline), sub (tile subline), min (sample needed) */
const PD = {
  pass_yds: { label: "Pass yds", f: pg("passing_yards"), fmt: f1, total: tot("passing_yards"), basis: "passing yards per game" },
  pass_td: { label: "Pass TD", f: pg("passing_tds"), fmt: f2, total: tot("passing_tds"), basis: "TD passes per game" },
  ints: { label: "INT", f: a => div(a.passing_interceptions, a.attempts), fmt: v => fmtPct(v, 1), total: tot("passing_interceptions"), sub: a => fmtPct(div(a.passing_interceptions, a.attempts), 1) + " of att", lower: true, basis: "interception rate", min: a => a.attempts >= 30 },
  cmp: { label: "Comp %", f: a => div(a.completions, a.attempts), fmt: fp, sub: a => `${fmt(a.completions)}/${fmt(a.attempts)}`, basis: "completion %", min: a => a.attempts >= 30 },
  ypa: { label: "Yds/att", f: a => div(a.passing_yards, a.attempts), fmt: f1, basis: "yards per attempt", min: a => a.attempts >= 30 },
  anya: { label: "ANY/A", f: a => div(a.passing_yards + 20 * a.passing_tds - 45 * a.passing_interceptions - Math.abs(a.sack_yards_lost), db(a)), fmt: f2, basis: "adjusted net yards per attempt", title: "(Pass yds + 20×TD − 45×INT − sack yds) ÷ (att + sacks)", min: a => a.attempts >= 30 },
  epa_db: { label: "EPA/dropback", f: a => div(a.passing_epa, db(a)), fmt: fs2, basis: "passing EPA per dropback", min: a => a.attempts >= 30 },
  cpoe: { label: "CPOE", f: a => a.passing_cpoe, fmt: v => (v == null ? "–" : fmtSigned(v, 1)), basis: "completion % over expected", min: a => a.attempts >= 30 },
  sack_rate: { label: "Sack %", f: a => div(a.sacks_suffered, db(a)), fmt: fp, lower: true, total: tot("sacks_suffered"), sub: a => fmtPct(div(a.sacks_suffered, db(a)), 1), basis: "sack rate", min: a => a.attempts >= 30 },
  adot: { label: "aDOT", norank: 1, f: a => div(a.passing_air_yards, a.attempts), fmt: f1, basis: "air yards per attempt", min: a => a.attempts >= 30 },
  rush_att: { label: "Carries", f: pg("carries"), fmt: f1, total: tot("carries"), basis: "carries per game" },
  rush_yds: { label: "Rush yds", f: pg("rushing_yards"), fmt: f1, total: tot("rushing_yards"), basis: "rushing yards per game" },
  ypc: { label: "Yds/carry", f: a => div(a.rushing_yards, a.carries), fmt: f2, basis: "yards per carry", min: a => a.carries >= 20 },
  rush_td: { label: "Rush TD", f: pg("rushing_tds"), fmt: f2, total: tot("rushing_tds"), basis: "rushing TDs per game" },
  epa_rush: { label: "EPA/carry", f: a => div(a.rushing_epa, a.carries), fmt: fs2, basis: "rushing EPA per carry", min: a => a.carries >= 20 },
  tgt: { label: "Targets", f: pg("targets"), fmt: f1, total: tot("targets"), basis: "targets per game" },
  rec: { label: "Receptions", f: pg("receptions"), fmt: f1, total: tot("receptions"), basis: "receptions per game" },
  rec_yds: { label: "Rec yds", f: pg("receiving_yards"), fmt: f1, total: tot("receiving_yards"), basis: "receiving yards per game" },
  rec_td: { label: "Rec TD", f: pg("receiving_tds"), fmt: f2, total: tot("receiving_tds"), basis: "receiving TDs per game" },
  ypr: { label: "Yds/rec", f: a => div(a.receiving_yards, a.receptions), fmt: f1, basis: "yards per reception", min: a => a.receptions >= 10 },
  ypt: { label: "Yds/target", f: a => div(a.receiving_yards, a.targets), fmt: f1, basis: "yards per target", min: a => a.targets >= 15 },
  catch: { label: "Catch %", f: a => div(a.receptions, a.targets), fmt: fp, basis: "catch rate", min: a => a.targets >= 15 },
  tshare: { label: "Target share", f: a => a.target_share, fmt: fp, basis: "share of team targets" },
  ayshare: { label: "Air yds share", f: a => a.air_yards_share, fmt: fp, basis: "share of team air yards" },
  wopr: { label: "WOPR", f: a => a.wopr, fmt: f2, basis: "weighted opportunity rating", title: "1.5 × target share + 0.7 × air-yards share" },
  yac: { label: "YAC", f: pg("receiving_yards_after_catch"), fmt: f1, total: tot("receiving_yards_after_catch"), basis: "yards after catch per game" },
  epa_tgt: { label: "EPA/target", f: a => div(a.receiving_epa, a.targets), fmt: fs2, basis: "receiving EPA per target", min: a => a.targets >= 15 },
  scrim: { label: "Scrimmage yds", f: pg("scrimmage_yds"), fmt: f1, total: tot("scrimmage_yds"), basis: "scrimmage yards per game" },
  touches: { label: "Touches", f: pg("touches"), fmt: f1, total: tot("touches"), basis: "touches per game" },
  tds: { label: "Total TD", f: pg("total_tds"), fmt: f2, total: tot("total_tds"), basis: "touchdowns per game" },
  fum: { label: "Fumbles lost", f: a => div(a.rushing_fumbles_lost + a.receiving_fumbles_lost + a.sack_fumbles_lost, a.gp), fmt: f2, lower: true, total: a => fmt(a.rushing_fumbles_lost + a.receiving_fumbles_lost + a.sack_fumbles_lost), basis: "fumbles lost per game" },
  ppr: { label: "PPR pts", f: pg("fantasy_points_ppr"), fmt: f1, total: a => fmt(a.fantasy_points_ppr, 1), basis: "PPR fantasy points per game" },
  std: { label: "Std fantasy", f: pg("fantasy_points"), fmt: f1, total: a => fmt(a.fantasy_points, 1), basis: "standard fantasy points per game" },
  tkl: { label: "Tackles", f: pg("tackles"), fmt: f1, total: tot("tackles"), sub: a => `${fmt(a.def_tackles_solo)} solo`, basis: "tackles per game" },
  tfl: { label: "TFL", f: pg("def_tackles_for_loss"), fmt: f2, total: tot("def_tackles_for_loss"), basis: "tackles for loss per game" },
  sacks: { label: "Sacks", f: pg("def_sacks"), fmt: f2, total: a => fmt(a.def_sacks, 1), basis: "sacks per game" },
  qbh: { label: "QB hits", f: pg("def_qb_hits"), fmt: f2, total: tot("def_qb_hits"), basis: "QB hits per game" },
  dint: { label: "INT", f: pg("def_interceptions"), fmt: f2, total: tot("def_interceptions"), basis: "interceptions per game" },
  pd: { label: "Passes defended", f: pg("def_pass_defended"), fmt: f2, total: tot("def_pass_defended"), basis: "passes defended per game" },
  ff: { label: "Forced fumbles", f: pg("def_fumbles_forced"), fmt: f2, total: tot("def_fumbles_forced"), basis: "forced fumbles per game" },
  dtd: { label: "Def TD", f: pg("def_tds"), fmt: f2, total: tot("def_tds"), basis: "defensive TDs per game" },
  fg_pct: { label: "FG %", f: a => div(a.fg_made, a.fg_att), fmt: fp, sub: a => `${a.fg_made}/${a.fg_att}`, basis: "field-goal %", min: a => a.fg_att >= 5 },
  fg_g: { label: "FG made", f: pg("fg_made"), fmt: f2, total: tot("fg_made"), basis: "field goals per game" },
  fg50: { label: "50+ FG", f: a => div(a.fg_made_50p, a.fg_att_50p), fmt: fp, sub: a => `${a.fg_made_50p}/${a.fg_att_50p}`, basis: "50+ yard FG %", min: a => a.fg_att_50p >= 3 },
  fg_long: { label: "Long", f: a => a.fg_long, fmt: v => fmt(v), basis: "longest field goal" },
  pat: { label: "XP %", f: a => div(a.pat_made, a.pat_att), fmt: fp, sub: a => `${a.pat_made}/${a.pat_att}`, basis: "extra-point %", min: a => a.pat_att >= 5 },
  punts: { label: "Punts", f: pg("pt_att"), fmt: f1, total: tot("pt_att"), basis: "punts per game" },
  pt_avg: { label: "Gross avg", f: a => div(a.pt_yards, a.pt_att), fmt: f1, basis: "gross punt average", min: a => a.pt_att >= 10 },
  pt_net: { label: "Net avg", f: a => div(a.pt_net_yards, a.pt_att), fmt: f1, basis: "net punt average", min: a => a.pt_att >= 10 },
  pt_i20: { label: "Inside 20", f: a => div(a.pt_inside_20, a.pt_att), fmt: fp, total: tot("pt_inside_20"), sub: a => fmtPct(div(a.pt_inside_20, a.pt_att), 0), basis: "share of punts inside the 20", min: a => a.pt_att >= 10 },
  ret: { label: "Return yds", f: a => div(a.punt_return_yards + a.kickoff_return_yards, a.gp), fmt: f1, total: a => fmt(a.punt_return_yards + a.kickoff_return_yards), basis: "return yards per game" },
};

// Per position group: which stats to show where, who counts as a peer, and the trend metrics.
const per = (k, lbl) => ({ label: lbl, num: g => n(g, k) });
const GROUPS = {
  QB: { name: "Quarterback", peers: "QBs", usage: a => div(a.attempts, a.gp) >= 15,
    tiles: ["pass_yds", "pass_td", "ints", "cmp", "ypa", "anya", "epa_db", "cpoe", "sack_rate", "adot", "rush_yds", "rush_td", "ppr"],
    pct: ["epa_db", "anya", "cpoe", "ypa", "pass_yds", "pass_td", "ints", "sack_rate", "rush_yds", "ppr"],
    split: ["pass_yds", "pass_td", "ints", "cmp", "ypa", "anya", "epa_db", "sack_rate", "rush_yds", "ppr"],
    trend: { passing_yards: per("passing_yards", "Passing yards"), passing_tds: per("passing_tds", "TD passes"),
      epa: { label: "EPA per dropback", num: g => n(g, "passing_epa"), den: g => n(g, "attempts") + n(g, "sacks_suffered"), ratio: 1 },
      cmp: { label: "Completion %", num: g => n(g, "completions"), den: g => n(g, "attempts"), ratio: 1, pct: 1 },
      ypa: { label: "Yards per attempt", num: g => n(g, "passing_yards"), den: g => n(g, "attempts"), ratio: 1 },
      rushing_yards: per("rushing_yards", "Rushing yards"), ppr: per("fantasy_points_ppr", "PPR points") },
    log: [["completions", "Cmp"], ["attempts", "Att"], ["passing_yards", "Yds"], ["passing_tds", "TD"], ["passing_interceptions", "Int"], ["sacks_suffered", "Sk"],
      ["passing_epa", "EPA", v => fmtSigned(v, 1)], ["passing_cpoe", "CPOE", v => (v == null ? "–" : fmtSigned(v, 1))], ["carries", "Car"], ["rushing_yards", "RuYd"], ["rushing_tds", "RuTD"], ["fantasy_points_ppr", "PPR", f1]] },
  RB: { name: "Running back", peers: "RBs", usage: a => div(a.touches, a.gp) >= 6,
    tiles: ["rush_att", "rush_yds", "ypc", "rush_td", "epa_rush", "tgt", "rec", "rec_yds", "scrim", "touches", "tds", "fum", "ppr"],
    pct: ["rush_yds", "ypc", "epa_rush", "touches", "tgt", "rec_yds", "scrim", "tds", "ppr"],
    split: ["touches", "rush_att", "rush_yds", "ypc", "rush_td", "tgt", "rec", "rec_yds", "scrim", "tds", "ppr"],
    trend: { scrimmage_yds: per("scrimmage_yds", "Scrimmage yards"), rushing_yards: per("rushing_yards", "Rushing yards"), carries: per("carries", "Carries"),
      touches: per("touches", "Touches"), ypc: { label: "Yards per carry", num: g => n(g, "rushing_yards"), den: g => n(g, "carries"), ratio: 1 },
      targets: per("targets", "Targets"), total_tds: per("total_tds", "Touchdowns"), ppr: per("fantasy_points_ppr", "PPR points") },
    log: [["carries", "Car"], ["rushing_yards", "Yds"], ["rushing_tds", "TD"], ["rushing_epa", "EPA", v => fmtSigned(v, 1)], ["targets", "Tgt"], ["receptions", "Rec"], ["receiving_yards", "ReYd"], ["receiving_tds", "ReTD"],
      ["rushing_fumbles_lost", "FL"], ["fantasy_points_ppr", "PPR", f1]] },
  WR: { name: "Wide receiver", peers: "WRs", usage: a => div(a.targets, a.gp) >= 3,
    tiles: ["tgt", "rec", "rec_yds", "rec_td", "ypr", "ypt", "catch", "tshare", "ayshare", "wopr", "yac", "epa_tgt", "ppr"],
    pct: ["tshare", "wopr", "tgt", "rec_yds", "ypt", "epa_tgt", "yac", "rec_td", "ppr"],
    split: ["tgt", "rec", "rec_yds", "rec_td", "ypr", "ypt", "catch", "tshare", "ppr"],
    trend: { receiving_yards: per("receiving_yards", "Receiving yards"), targets: per("targets", "Targets"), receptions: per("receptions", "Receptions"),
      tshare: { label: "Target share", num: g => n(g, "target_share"), pct: 1 }, air: per("receiving_air_yards", "Air yards"),
      receiving_tds: per("receiving_tds", "Receiving TDs"), ppr: per("fantasy_points_ppr", "PPR points") },
    log: [["targets", "Tgt"], ["receptions", "Rec"], ["receiving_yards", "Yds"], ["receiving_tds", "TD"], ["receiving_air_yards", "Air"], ["receiving_yards_after_catch", "YAC"],
      ["target_share", "Tgt%", v => (v == null ? "–" : fmtPct(v, 0))], ["receiving_epa", "EPA", v => fmtSigned(v, 1)], ["carries", "Car"], ["rushing_yards", "RuYd"], ["fantasy_points_ppr", "PPR", f1]] },
  DL: { name: "Defensive line", peers: "defensive linemen", usage: a => div(a.tackles + a.def_qb_hits, a.gp) >= 1.5,
    tiles: ["tkl", "tfl", "sacks", "qbh", "ff", "pd", "dint", "dtd"], pct: ["sacks", "qbh", "tfl", "tkl", "ff"], split: ["tkl", "tfl", "sacks", "qbh", "ff", "pd"],
    trend: { tackles: per("tackles", "Tackles"), def_sacks: per("def_sacks", "Sacks"), def_qb_hits: per("def_qb_hits", "QB hits"), tfl: per("def_tackles_for_loss", "Tackles for loss") },
    log: [["tackles", "Tkl"], ["def_tackles_solo", "Solo"], ["def_tackles_for_loss", "TFL"], ["def_sacks", "Sk"], ["def_qb_hits", "QBH"], ["def_pass_defended", "PD"], ["def_interceptions", "Int"], ["def_fumbles_forced", "FF"], ["def_tds", "TD"]] },
  K: { name: "Kicker", peers: "kickers", usage: a => a.fg_att + a.pat_att >= 5,
    tiles: ["fg_pct", "fg_g", "fg50", "fg_long", "pat"], pct: ["fg_pct", "fg50", "fg_g", "pat"], split: ["fg_g", "fg_pct", "fg50", "pat"],
    trend: { fg_made: per("fg_made", "FG made"), fgp: { label: "FG %", num: g => n(g, "fg_made"), den: g => n(g, "fg_att"), ratio: 1, pct: 1 } },
    log: [["fg_made", "FGM"], ["fg_att", "FGA"], ["fg_long", "Long"], ["fg_made_50p", "50+"], ["pat_made", "XPM"], ["pat_att", "XPA"]] },
  P: { name: "Punter", peers: "punters", usage: a => a.pt_att >= 10,
    tiles: ["punts", "pt_avg", "pt_net", "pt_i20"], pct: ["pt_net", "pt_avg", "pt_i20"], split: ["punts", "pt_avg", "pt_net", "pt_i20"],
    trend: { net: { label: "Net average", num: g => n(g, "pt_net_yards"), den: g => n(g, "pt_att"), ratio: 1 }, punts: per("pt_att", "Punts") },
    log: [["pt_att", "Punts"], ["pt_yards", "Yds"], ["pt_net_yards", "Net"], ["pt_inside_20", "In20"]] },
};
GROUPS.TE = { ...GROUPS.WR, name: "Tight end", peers: "TEs", usage: a => div(a.targets, a.gp) >= 2 };
GROUPS.LB = { ...GROUPS.DL, name: "Linebacker", peers: "linebackers", usage: a => div(a.tackles, a.gp) >= 2, pct: ["tkl", "tfl", "sacks", "pd", "ff"] };
GROUPS.DB = { ...GROUPS.DL, name: "Defensive back", peers: "defensive backs", usage: a => div(a.tackles, a.gp) >= 2,
  tiles: ["tkl", "dint", "pd", "tfl", "ff", "sacks", "dtd", "ret"], pct: ["dint", "pd", "tkl", "ff"], split: ["tkl", "dint", "pd", "ff", "tfl"] };
const grpOf = g => (GROUPS[g] ? g : g === "OL" || g === "LS" || g === "ST" ? "DL" : "WR");

// ------------------------------------------------------------------ team stat definitions
const T_SUM = ["completions", "pass_att", "pass_yds", "pass_td", "ints", "sacks_taken", "sack_yds", "carries", "rush_yds", "rush_td", "pass_epa", "rush_epa", "first_downs",
  "fumbles_lost", "penalties", "penalty_yds", "def_sacks", "def_ints", "def_ff", "def_tds", "fg_made", "fg_att", "st_tds", "pass_20p", "rush_20p", "plays", "dropbacks",
  "net_pass_yds", "yards", "turnovers", "epa", "opp_completions", "opp_pass_att", "opp_net_pass_yds", "opp_rush_yds", "opp_pass_td", "opp_rush_td", "opp_plays", "opp_yards",
  "opp_epa", "opp_pass_epa", "opp_rush_epa", "opp_first_downs", "takeaways", "opp_dropbacks", "opp_carries", "pf", "pa"];
function aggTeam(g) {
  const a = { gp: g.length };
  for (const k of T_SUM) a[k] = sum(g, k);
  const c = (k, v) => g.filter(x => x[k] === v).length;
  Object.assign(a, { w: c("result", "W"), l: c("result", "L"), t: c("result", "T"), atsw: c("ats", "W"), atsl: c("ats", "L"), atsp: c("ats", "P"), ovr: c("ou", "O"), und: c("ou", "U"),
    close_w: g.filter(x => Math.abs(x.pf - x.pa) <= 8 && x.result === "W").length, close_l: g.filter(x => Math.abs(x.pf - x.pa) <= 8 && x.result === "L").length });
  return a;
}
const wpct = a => div(a.w + 0.5 * a.t, a.gp);
const recStr = a => `${a.w}-${a.l}${a.t ? "-" + a.t : ""}`;
const TD = {
  rec: { label: "Record", f: wpct, fmt: fmt3, total: recStr, sub: a => fmt3(wpct(a)), basis: "win %" },
  pf: { label: "Points/G", f: pg("pf"), fmt: f1, basis: "points scored per game" },
  pa: { label: "Allowed/G", f: pg("pa"), fmt: f1, lower: true, basis: "points allowed per game" },
  pd: { label: "Point diff", f: a => div(a.pf - a.pa, a.gp), fmt: v => fmtSigned(v, 1), total: a => fmtSigned(a.pf - a.pa), sub: a => fmtSigned(div(a.pf - a.pa, a.gp), 1) + "/G", basis: "point differential per game" },
  ypp: { label: "Yds/play", f: a => div(a.yards, a.plays), fmt: f2, basis: "offensive yards per play" },
  dypp: { label: "Yds/play allowed", f: a => div(a.opp_yards, a.opp_plays), fmt: f2, lower: true, basis: "yards per play allowed" },
  epa: { label: "Off EPA/play", f: a => div(a.epa, a.plays), fmt: fs2, basis: "offensive EPA per play" },
  depa: { label: "Def EPA/play", f: a => div(a.opp_epa, a.opp_plays), fmt: fs2, lower: true, basis: "defensive EPA per play allowed" },
  pass_epa: { label: "Pass EPA/db", f: a => div(a.pass_epa, a.dropbacks), fmt: fs2, basis: "passing EPA per dropback" },
  rush_epa: { label: "Rush EPA/car", f: a => div(a.rush_epa, a.carries), fmt: fs2, basis: "rushing EPA per carry" },
  dpass_epa: { label: "Def pass EPA", f: a => div(a.opp_pass_epa, a.opp_dropbacks), fmt: fs2, lower: true, basis: "pass EPA per dropback allowed" },
  drush_epa: { label: "Def rush EPA", f: a => div(a.opp_rush_epa, a.opp_carries), fmt: fs2, lower: true, basis: "rush EPA per carry allowed" },
  yds: { label: "Yards/G", f: pg("yards"), fmt: f1, basis: "yards per game" },
  pass: { label: "Pass yds/G", f: pg("net_pass_yds"), fmt: f1, basis: "net passing yards per game" },
  rush: { label: "Rush yds/G", f: pg("rush_yds"), fmt: f1, basis: "rushing yards per game" },
  dyds: { label: "Yds allowed/G", f: pg("opp_yards"), fmt: f1, lower: true, basis: "yards allowed per game" },
  to: { label: "Giveaways", f: pg("turnovers"), fmt: f2, lower: true, total: tot("turnovers"), basis: "turnovers per game" },
  tk: { label: "Takeaways", f: pg("takeaways"), fmt: f2, total: tot("takeaways"), basis: "takeaways per game" },
  tom: { label: "TO margin", f: a => div(a.takeaways - a.turnovers, a.gp), fmt: fs2, total: a => fmtSigned(a.takeaways - a.turnovers), basis: "turnover margin per game" },
  sacks: { label: "Sacks", f: pg("def_sacks"), fmt: f2, total: a => fmt(a.def_sacks, 0), basis: "sacks per game" },
  sk_allowed: { label: "Sack % allowed", f: a => div(a.sacks_taken, a.dropbacks), fmt: fp, lower: true, total: tot("sacks_taken"), sub: a => fmtPct(div(a.sacks_taken, a.dropbacks), 1) + " of dropbacks", basis: "sack rate allowed" },
  expl: { label: "Explosive plays", f: a => div(a.pass_20p + a.rush_20p, a.gp), fmt: f1, basis: "20+ yard plays per game" },
  fd: { label: "First downs/G", f: pg("first_downs"), fmt: f1, basis: "first downs per game" },
  pen: { label: "Penalty yds/G", f: pg("penalty_yds"), fmt: f1, lower: true, basis: "penalty yards per game" },
  ats: { label: "Vs spread", f: a => div(a.atsw, a.atsw + a.atsl), fmt: fp, total: a => `${a.atsw}-${a.atsl}${a.atsp ? "-" + a.atsp : ""}`, sub: a => fmtPct(div(a.atsw, a.atsw + a.atsl), 0) + " cover", basis: "cover rate against the spread" },
};
const T_TILES = ["rec", "pf", "pa", "pd", "epa", "depa", "ypp", "dypp", "pass", "rush", "dyds", "tom", "sacks", "sk_allowed", "expl", "pen", "ats"];
const T_SPLIT = ["pf", "pa", "pd", "ypp", "epa", "depa", "tom", "ats"];

// ------------------------------------------------------------------ filters
const DEFAULT_FILTER = () => ({ seasons: null, type: "R", venue: "all", opp: "all", result: "all", rest: "all", lastN: 0, from: "", to: "" });
const restBucket = r => (r == null ? null : r <= 5 ? "short" : r <= 8 ? "normal" : "long");
function applyFilter(games, f, resultKey) {
  let out = games.filter(g =>
    (!f.seasons || f.seasons.includes(g.season)) &&
    (f.type === "all" || g.game_type === f.type) &&
    (f.venue === "all" || (f.venue === "H") === !!g.is_home) &&
    (f.opp === "all" || g.opp === f.opp) &&
    (f.result === "all" || g[resultKey] === f.result) &&
    (f.rest === "all" || restBucket(g.rest_days) === f.rest) &&
    (!f.from || g.game_date >= f.from) && (!f.to || g.game_date <= f.to));
  if (f.lastN) out = out.slice(-f.lastN);
  return out;
}
const isNarrowed = f => f.venue !== "all" || f.opp !== "all" || f.result !== "all" || f.rest !== "all" || f.lastN || f.from || f.to || !f.seasons || f.seasons.length > 1;
function filterBar(f, { seasons, opps, onChange, resultLabel = "Team result" }) {
  const el = document.createElement("div");
  el.className = "card filters";
  const sel = (name, label, options, val) => `<label>${label}<select data-f="${name}">${options.map(([v, t]) => `<option value="${v}" ${String(v) === String(val) ? "selected" : ""}>${t}</option>`).join("")}</select></label>`;
  el.innerHTML = h`
    <label>Seasons<div class="chips">${seasons.map(s => `<button class="chip ${!f.seasons || f.seasons.includes(s) ? "on" : ""}" data-season="${s}">${s}</button>`).join("")}
      <button class="chip" data-season="all">All</button></div></label>
    ${sel("type", "Game type", [["R", "Regular season"], ["P", "Playoffs"], ["all", "Both"]], f.type)}
    ${sel("venue", "Venue", [["all", "Home & away"], ["H", "Home"], ["A", "Away"]], f.venue)}
    ${sel("opp", "Opponent", [["all", "All"], ...opps.map(o => [o, o])], f.opp)}
    ${sel("result", resultLabel, [["all", "All"], ["W", "Wins"], ["L", "Losses"]], f.result)}
    ${sel("rest", "Rest", [["all", "Any"], ["short", "Short week (≤5 days)"], ["normal", "Normal (6–8)"], ["long", "Extra / off bye (9+)"]], f.rest)}
    ${sel("lastN", "Last N games", [[0, "All"], [3, "Last 3"], [5, "Last 5"], [8, "Last 8"], [17, "Last 17"]], f.lastN)}
    <label>From<input type="date" data-f="from" value="${f.from}"></label>
    <label>To<input type="date" data-f="to" value="${f.to}"></label>
    <button class="btn" data-reset>Reset</button>
    <span class="filter-note"></span>`;
  el.querySelectorAll("[data-season]").forEach(b => b.onclick = () => {
    const s = b.dataset.season;
    if (s === "all") f.seasons = null;
    else {
      const v = +s, cur = f.seasons ? [...f.seasons] : [];
      f.seasons = !f.seasons ? [v] : cur.includes(v) ? cur.filter(x => x !== v) : [...cur, v].sort();
      if (f.seasons.length === 0 || f.seasons.length === seasons.length) f.seasons = null;
    }
    el.querySelectorAll("[data-season]").forEach(c => c.classList.toggle("on", c.dataset.season !== "all" && (!f.seasons || f.seasons.includes(+c.dataset.season))));
    onChange();
  });
  el.querySelectorAll("[data-f]").forEach(i => i.onchange = () => { const k = i.dataset.f; f[k] = k === "lastN" ? +i.value : i.value; onChange(); });
  el.querySelector("[data-reset]").onclick = () => {
    Object.assign(f, DEFAULT_FILTER(), { seasons: f._defaultSeasons });
    el.replaceWith(filterBar(f, { seasons, opps, onChange, resultLabel })); onChange();
  };
  return el;
}

// ------------------------------------------------------------------ splits
const restLabel = r => (r == null ? "Unknown" : r <= 5 ? "Short week (≤5 days)" : r <= 8 ? "Normal rest (6–8)" : r <= 12 ? "Extra rest (9–12)" : "Off a bye (13+)");
const REST_ORDER = ["Short week (≤5 days)", "Normal rest (6–8)", "Extra rest (9–12)", "Off a bye (13+)", "Unknown"];
function slot(g) {
  const hr = +(g.gametime || "13:00").slice(0, 2);
  switch (g.weekday) {
    case "Thursday": return "Thursday night";
    case "Monday": return "Monday night";
    case "Saturday": return "Saturday";
    case "Sunday": return hr < 16 ? "Sunday early" : hr < 20 ? "Sunday late" : "Sunday night";
    default: return "Other day";
  }
}
const SLOTS = ["Thursday night", "Saturday", "Sunday early", "Sunday late", "Sunday night", "Monday night", "Other day"];
const indoors = g => g.roof === "dome" || g.roof === "closed";
const weather = g => (indoors(g) ? "Indoors" : g.temp == null ? "Outdoors, temp n/a" : g.temp < 40 ? "Cold (<40°F)" : g.temp < 60 ? "Cool (40–59°F)" : g.temp < 80 ? "Mild (60–79°F)" : "Hot (80°F+)");
const WEATHER = ["Cold (<40°F)", "Cool (40–59°F)", "Mild (60–79°F)", "Hot (80°F+)", "Outdoors, temp n/a", "Indoors"];
const lineBucket = l => (l == null ? "No line" : l >= 7 ? "Favored by 7+" : l > 0 ? "Favored by <7" : l === 0 ? "Pick'em" : l > -7 ? "Underdog by <7" : "Underdog by 7+");
const LINES = ["Favored by 7+", "Favored by <7", "Pick'em", "Underdog by <7", "Underdog by 7+", "No line"];
function commonSplits(resultKey, teamFirst = false) {
  const lineKey = "team_line";
  return [
    { key: "season", label: "Season", fn: g => String(g.season) },
    { key: "venue", label: "Home/Away", fn: g => (g.is_home ? "Home" : "Away") },
    { key: "opp", label: "Opponent", fn: g => g.opp },
    { key: "div", label: "Opp. division", fn: g => TEAM_BY[g.opp]?.division || "Other" },
    { key: "result", label: teamFirst ? "Result" : "Team result", fn: g => ({ W: "Win", L: "Loss", T: "Tie" }[g[resultKey]] || "–") },
    { key: "line", label: "Favorite/underdog", fn: g => lineBucket(g[lineKey]), order: k => LINES.indexOf(k) },
    { key: "rest", label: "Rest", fn: g => restLabel(g.rest_days), order: k => REST_ORDER.indexOf(k) },
    { key: "slot", label: "Time slot", fn: slot, order: k => SLOTS.indexOf(k) },
    { key: "weather", label: "Weather", fn: weather, order: k => WEATHER.indexOf(k) },
    { key: "surface", label: "Surface", fn: g => (!g.surface ? "Unknown" : g.surface === "grass" ? "Grass" : "Turf") },
    { key: "divgame", label: "Division game", fn: g => (g.div_game ? "Division" : "Non-division") },
    { key: "month", label: "Month", fn: g => MONTHS[+g.game_date.slice(5, 7) - 1], order: k => (MONTHS.indexOf(k) + 4) % 12 },
    { key: "type", label: "Reg/Playoffs", fn: g => (g.game_type === "P" ? "Playoffs" : "Regular season") },
  ];
}
const defCols = (defs, keys) => keys.map(k => ({ k, label: defs[k].label, n: 1, title: defs[k].basis, val: r => defs[k].f(r), fmt: v => defs[k].fmt(v) }));
function splitsBlock(el, games, aggFn, cols, defs) {
  let current = defs[0].key;
  const render = () => {
    const def = defs.find(d => d.key === current);
    const groups = new Map();
    for (const g of games) { const k = def.fn(g); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(g); }
    const rows = [...groups].map(([k, gs]) => ({ split: k, ...aggFn(gs), _order: def.order ? def.order(k) : k }));
    rows.sort((a, b) => (a._order > b._order ? 1 : -1));
    el.innerHTML = `<div class="tabs">${defs.map(d => `<button class="tab ${d.key === current ? "on" : ""}" data-k="${d.key}">${d.label}</button>`).join("")}</div><div class="split-tbl"></div>`;
    el.querySelectorAll(".tab").forEach(t => t.onclick = () => { current = t.dataset.k; render(); });
    sortTable(el.querySelector(".split-tbl"), rows, [{ k: "split", label: def.label, sortVal: r => r._order }, { k: "gp", label: "G", n: 1 },
      { k: "wl", label: "W-L", val: r => recStr(r), sortVal: r => wpct(r) }, ...cols], { csvName: `splits-${current}` });
  };
  render();
}

// ------------------------------------------------------------------ league ranks
const TIERS = [[90, "elite", "Elite"], [70, "above", "Above avg"], [30, "avg", "Average"], [10, "below", "Below avg"], [0, "poor", "Bottom 10%"]];
const ordinal = x => { const v = x % 100; return x + (v >= 11 && v <= 13 ? "th" : ["th", "st", "nd", "rd"][x % 10] || "th"); };
const rankTitle = rk => `Ranks #${rk.rank} of ${rk.n} on ${rk.basis} (${ordinal(rk.pct)} percentile${rk.lower ? ", lower is better" : ""})`;
function rankOne(mine, peerVals, lower) {
  const vals = peerVals.filter(v => v != null && Number.isFinite(v));
  if (mine == null || !Number.isFinite(mine) || vals.length < 5) return null;
  const better = vals.filter(v => (lower ? v < mine : v > mine)).length;
  const worse = vals.filter(v => (lower ? v > mine : v < mine)).length;
  const ties = vals.length - better - worse;
  const pct = Math.min(99, Math.max(1, Math.round(((worse + 0.5 * ties) / vals.length) * 100)));
  return { rank: better + 1, n: vals.length + 1, pct, tied: ties > 0, tier: TIERS.find(t => pct >= t[0]) };
}
function rankFor(ctx, defs, key, a) {
  const d = defs[key];
  if (!ctx || !d || d.norank || (d.min && !d.min(a))) return null;
  const r = rankOne(d.f(a), ctx.peers.filter(p => !d.min || d.min(p)).map(d.f), d.lower);
  return r && { ...r, basis: d.basis, lower: !!d.lower };
}
async function playerRankContext(id, grp, season, type) {
  let lg; try { lg = await load(`league/${season}.json`); } catch { return null; }
  const rows = objs(lg.players).filter(r => r.game_type === type && grpOf(r.grp) === grp);
  if (!rows.length) return null;
  const maxGp = Math.max(...rows.map(r => r.gp));
  const minGp = Math.max(1, Math.round(maxGp * 0.4));
  const peers = rows.filter(r => r.gp >= minGp && r.player_id !== id && GROUPS[grp].usage(r));
  return peers.length >= 5 ? { peers, minGp, season, type, label: GROUPS[grp].peers } : null;
}
async function teamRankContext(abbr, season, type) {
  let lg; try { lg = await load(`league/${season}.json`); } catch { return null; }
  const peers = objs(lg.teams).filter(r => r.game_type === type && r.team !== abbr && r.gp > 0);
  return peers.length >= 5 ? { peers, season, type, label: "teams" } : null;
}
function rankHeader(ctx, f, what) {
  if (!ctx) return `<div class="rank-bar muted">League ranks unavailable for this selection.</div>`;
  return `<div class="rank-bar"><span class="rank-legend">${TIERS.map(t => `<span class="t-${t[1]}"><i class="sw"></i>${t[2]}${t[0] ? ` <span class="muted">${t[0]}+</span>` : ""}</span>`).join("")}</span>
    <span class="rank-basis">Ranked vs ${ctx.season} ${ctx.type === "P" ? "playoff" : "regular-season"} ${ctx.label}${ctx.minGp ? ` with ${ctx.minGp}+ games and a regular role` : ""} (${ctx.peers.length + 1}), on per-game rates
    ${isNarrowed(f) ? `<span class="muted"> · ${what}'s numbers use your filters; league numbers are full-season</span>` : ""}</span></div>`;
}
function tilesHtml(defs, keys, a, ctx, lead = []) {
  const one = (label, v, s, rk, title) => `<div class="tile ${rk ? "t-" + rk.tier[1] : ""}" title="${esc(rk ? rankTitle(rk) : title || "")}"><div class="k">${label}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ""}${rk ? `<div class="rk"><span class="tier"><i class="sw"></i>${rk.tier[2]}</span><span class="pos">${rk.tied ? "T-" : ""}#${rk.rank} of ${rk.n} · ${ordinal(rk.pct)} pct</span></div>` : ""}</div>`;
  return `<div class="tiles">${lead.map(([l, v, s]) => one(l, v, s)).join("")}${keys.map(k => {
    const d = defs[k], val = d.f(a);
    const big = d.total ? d.total(a) : d.fmt(val);
    const sub = d.sub ? d.sub(a) : d.total ? d.fmt(val) + "/G" : "";
    return one(d.label, big, sub, rankFor(ctx, defs, k, a), d.basis);
  }).join("")}</div>`;
}
function pctBars(el, defs, keys, a, ctx) {
  if (!ctx) { el.innerHTML = '<div class="empty">No league comparison for this selection.</div>'; return; }
  el.innerHTML = keys.map(k => {
    const d = defs[k], rk = rankFor(ctx, defs, k, a), v = d.f(a);
    return `<div class="pct-row"><span class="sec" title="${esc(d.basis)}">${d.label}</span><div class="meter" title="${rk ? esc(rankTitle(rk)) : "Not enough volume to rank"}"><div class="t-${rk ? rk.tier[1] : "avg"}" style="width:${rk ? rk.pct : 0}%"></div></div><span class="num">${d.fmt(v)}</span><span class="num"><b>${rk ? rk.pct : "–"}</b></span></div>`;
  }).join("") + `<div class="muted" style="font-size:12px;margin-top:6px">Right column = percentile vs ${ctx.label} (100 = best; "lower is better" stats are flipped).</div>`;
}

// ------------------------------------------------------------------ form (hot / cold)
const FORM = { hot: ["🔥", "Hot"], warming: ["▲", "Warming"], steady: ["–", "Steady"], cooling: ["▼", "Cooling"], cold: ["❄", "Cold"] };
const FLAG_TEXT = { regression_risk: "Likely to cool", buy_low: "Due to heat up", role_up: "Role ↑", role_down: "Role ↓" };
const formBadge = (st, cls = "") => (st ? `<span class="form f-${st} ${cls}">${FORM[st][0]} ${FORM[st][1]}</span>` : `<span class="muted">–</span>`);
const flagChips = flags => (flags || []).map(f => `<span class="flag">${FLAG_TEXT[f] || f}</span>`).join("");
async function formFor(kind, id, season) {
  try { const lg = await load(`league/${season}.json`); return { f: lg.form?.[kind]?.[String(id)], asOf: lg.form?.as_of }; } catch { return {}; }
}
function formCard(fm, season, what) {
  if (!fm) return `<div class="card"><h2>Current form</h2><div class="muted">${what === "na" ? "Hot/cold tracking covers QBs, RBs, WRs, TEs and teams." : `Not enough games in ${season} yet to judge form (needs 5).`}</div></div>`;
  const current = season === META.current_season;
  return `<div class="card"><h2>${current ? "Current form" : "Form at season's end"} <span class="muted">· through ${fmtDate(fm.last_game)}</span></h2>
    <div class="form-card"><div>${formBadge(fm.status, "big")}<div class="muted" style="font-size:11px;margin-top:6px" title="How unusual the recent stretch is vs expectation (±1.8 = hot/cold)">score ${fmtSigned(fm.score, 1)}</div></div>
    <div><ul>${fm.reasons.map(r => `<li>${esc(r)}</li>`).join("")}</ul>${fm.flags?.length ? `<div style="margin-top:6px">${flagChips(fm.flags)}</div>` : ""}</div></div></div>`;
}

// ------------------------------------------------------------------ shared bits
const teamName = a => TEAM_BY[a]?.name || a;
const teamLink = a => `<a href="#/team/${a}">${esc(a)}</a>`;
const playerLink = (id, name) => `<a href="#/player/${id}">${esc(name)}</a>`;
const oppCell = g => `${g.is_home ? "vs" : "@"} ${teamLink(g.opp)}`;
const lineStr = g => { const s = g.spread_line; if (s == null) return ""; return s === 0 ? "Pick'em" : s > 0 ? `${g.home_team} −${s}` : `${g.away_team} −${-s}`; };
const teamLineStr = l => (l == null ? "–" : l === 0 ? "PK" : (l > 0 ? "−" : "+") + Math.abs(l));
const streakOf = s => { if (!s) return "–"; const c = s[s.length - 1]; let k = 0; for (let i = s.length - 1; i >= 0 && s[i] === c; i--) k++; return c + k; };
function trendControls(metrics, metric, wins, win) {
  return `<select id="metric">${Object.entries(metrics).map(([k, m]) => `<option value="${k}" ${k === metric ? "selected" : ""}>${m.label}</option>`).join("")}</select>
    <select id="win">${wins.map(w => `<option value="${w}" ${w === win ? "selected" : ""}>${w}-game rolling</option>`).join("")}</select>`;
}
function metricSeries(fg, m, w) {
  const vals = fg.map(g => (m.den ? div(m.num(g), m.den(g)) : m.num(g)));
  const roll = m.den ? rollingRatio(fg.map(m.num), fg.map(m.den), w) : rolling(vals, w);
  const avg = m.den ? div(fg.reduce((s, g) => s + m.num(g), 0), fg.reduce((s, g) => s + m.den(g), 0)) : vals.length ? vals.reduce((a, b) => a + (b || 0), 0) / vals.length : null;
  const yf = m.pct ? v => fmtPct(v, 0) : m.ratio ? v => fmt(v, 2) : v => fmt(v, 1);
  return { vals, roll, avg, yf };
}
function gameCard(g) {
  const played = g.played !== false && g.home_score != null;
  const awayWin = played && g.away_score > g.home_score, homeWin = played && g.home_score > g.away_score;
  const inner = `<div class="line ${awayWin ? "win" : ""}"><span>${esc(g.away_team)}</span><span class="num">${played ? g.away_score : ""}</span></div>
    <div class="line ${homeWin ? "win" : ""}"><span>${esc(g.home_team)}</span><span class="num">${played ? g.home_score : ""}</span></div>
    <div class="sub">${g.weekday ? g.weekday.slice(0, 3) + " " : ""}${shortDate(g.game_date)} · ${played ? "Final" + (g.overtime ? "/OT" : "") : (g.gametime || "TBD") + " ET"}${g.game_type === "P" ? " · " + (ROUND[g.round] || "Playoffs") : ""}</div>
    ${g.spread_line != null ? `<div class="sub2">${lineStr(g)} · O/U ${g.total_line ?? "–"}${played ? ` · total ${g.home_score + g.away_score}` : ""}</div>` : ""}`;
  return played ? `<a class="game-card" href="#/game/${g.game_id}">${inner}</a>` : `<div class="game-card">${inner}</div>`;
}

// ------------------------------------------------------------------ home
async function pageHome() {
  const season = META.current_season;
  const [league, games] = await Promise.all([load(`league/${season}.json`), load(`games/${season}.json`)]);
  const teams = objs(league.teams).filter(t => t.game_type === "R");
  const pl = objs(league.players).filter(p => p.game_type === "R");
  const gl = objs(games);
  const lw = META.last_week;
  const lastGames = gl.filter(g => g.played && lw && g.week === lw.week);
  const upcoming = gl.filter(g => !g.played);
  const nextWeek = upcoming.length ? Math.min(...upcoming.map(g => g.week)) : null;
  const nextGames = upcoming.filter(g => g.week === nextWeek);
  const thisWeekLeft = nextWeek === lw?.week;

  app.innerHTML = h`
    <div class="head"><div><h1>${season} season</h1><div class="meta">Through ${lw ? weekLabel(lw) : "–"} (${META.last_game ? fmtDate(META.last_game) : "–"}) · ${META.counts.games.toLocaleString()} games loaded across ${META.seasons.length} seasons</div></div></div>
    <div class="card"><h2>${lw ? weekLabel(lw) : "Latest"} results</h2><div class="games-list">${lastGames.map(gameCard).join("") || '<div class="empty">No games yet.</div>'}</div></div>
    ${nextGames.length ? `<div class="card"><h2>${thisWeekLeft ? "Still to play this week" : `Up next · ${weekLabel(nextGames[0])}`}</h2><div class="games-list">${nextGames.map(gameCard).join("")}</div></div>` : ""}
    <div class="grid2" id="leaders"></div>
    <div class="card"><h2>Standings</h2><div class="grid2" id="standings"></div></div>`;

  const top = (arr, f, k = 8) => [...arr].filter(x => f(x) != null).sort((a, b) => f(b) - f(a)).slice(0, k);
  const leader = (title, rows, val, sub) => `<div class="card"><h2>${title}</h2><table><tbody>${rows.map((r, i) =>
    `<tr><td class="muted" style="width:24px">${i + 1}</td><td>${playerLink(r.player_id, r.name)} <span class="muted">${esc(r.pos || "")} · ${r.team}</span></td><td class="n"><b>${val(r)}</b></td><td class="n muted">${sub(r)}</td></tr>`).join("")}</tbody></table></div>`;
  const form = league.form?.players || {};
  const hot = Object.entries(form).map(([id, f]) => ({ id, ...f, r: pl.find(x => x.player_id === id) })).filter(x => x.r && x.score >= 0.9).sort((a, b) => b.score - a.score).slice(0, 8);
  $("#leaders").innerHTML =
    leader("Passing yards", top(pl, p => p.passing_yards), p => fmt(p.passing_yards), p => `${p.passing_tds} TD · ${p.gp} G`) +
    leader("Rushing yards", top(pl, p => p.rushing_yards), p => fmt(p.rushing_yards), p => `${p.rushing_tds} TD · ${fmt(div(p.rushing_yards, p.carries), 1)} ypc`) +
    leader("Receiving yards", top(pl, p => p.receiving_yards), p => fmt(p.receiving_yards), p => `${p.receptions} rec · ${p.receiving_tds} TD`) +
    leader("PPR fantasy points", top(pl, p => p.fantasy_points_ppr), p => fmt(p.fantasy_points_ppr, 1), p => `${fmt(p.fantasy_points_ppr / p.gp, 1)}/G`) +
    leader("Sacks", top(pl, p => p.def_sacks), p => fmt(p.def_sacks, 1), p => `${p.def_qb_hits} QB hits`) +
    `<div class="card"><h2>Hottest right now <a href="#/trends" style="font-size:12px;font-weight:400;margin-left:6px">All trends →</a></h2><ul class="trend-list">${hot.map(x =>
      `<li><span>${playerLink(x.id, x.r.name)} <span class="muted">${esc(x.r.pos || "")} · ${x.r.team}</span></span><span>${formBadge(x.status)}</span><span class="why">${esc(x.reasons[0])}</span></li>`).join("") || '<li class="muted">Nobody is well above expectation right now.</li>'}</ul></div>`;

  const divs = groupBy(teams, t => TEAM_BY[t.team]?.division || "League");
  $("#standings").innerHTML = Object.keys(divs).sort().map(d => {
    const rows = divs[d].sort((a, b) => wpct(b) - wpct(a) || (b.dw - b.dl) - (a.dw - a.dl) || (b.pf - b.pa) - (a.pf - a.pa));
    return `<div><h3>${esc(d)}</h3><table class="standings"><thead><tr><th>Team</th><th class="n">W-L</th><th class="n">Pct</th><th class="n">PF</th><th class="n">PA</th><th class="n">Diff</th><th class="n">Div</th><th class="n">Conf</th><th class="n">Strk</th><th class="n">L5</th><th>Form</th></tr></thead><tbody>${rows.map(t =>
      `<tr><td>${teamLink(t.team)} <span class="muted">${esc(TEAM_BY[t.team]?.nick || "")}</span></td><td class="n"><b>${recStr(t)}</b></td><td class="n">${fmt3(wpct(t))}</td><td class="n">${t.pf}</td><td class="n">${t.pa}</td><td class="n">${fmtSigned(t.pf - t.pa)}</td><td class="n">${t.dw}-${t.dl}${t.dt ? "-" + t.dt : ""}</td><td class="n">${t.cw}-${t.cl}</td><td class="n">${streakOf(t.results)}</td><td class="n">${t.w5}-${t.l5}${t.t5 ? "-" + t.t5 : ""}</td><td>${formBadge(league.form?.teams?.[t.team]?.status)}</td></tr>`).join("")}</tbody></table></div>`;
  }).join("");
}

// ------------------------------------------------------------------ player
async function pagePlayer(id) {
  const doc = await load(`players/${id}.json`);
  const bio = doc.bio;
  const grp = grpOf(bio.grp), G = GROUPS[grp];
  const games = objs(doc.games);
  const seasons = [...new Set(games.map(g => g.season))].sort();
  const latest = seasons[seasons.length - 1];
  const f = DEFAULT_FILTER(); f.seasons = [latest]; f._defaultSeasons = [latest];
  const opps = [...new Set(games.map(g => g.opp))].sort();
  const age = bio.birth_date ? Math.floor((Date.now() - new Date(bio.birth_date)) / 3.15576e10) : null;
  const team = bio.current_team || games[games.length - 1]?.team;
  const teamsPlayed = [...new Set(games.map(g => g.team))];
  const draft = bio.draft_round ? `${bio.draft_year} draft, round ${bio.draft_round}, pick ${bio.draft_pick}${bio.draft_team ? " (" + esc(bio.draft_team) + ")" : ""}` : bio.rookie_season ? `Undrafted, rookie year ${bio.rookie_season}` : "";

  app.innerHTML = h`
    <div class="head"><div>
      <h1>${esc(bio.name)} ${bio.jersey ? `<span class="muted">#${esc(bio.jersey)}</span>` : ""}</h1>
      <div class="meta">${esc(bio.pos || grp)} · ${team ? teamLink(team) + " " + esc(TEAM_BY[team]?.nick || "") : ""}${age != null ? ` · Age ${age}` : ""}
        ${bio.height_in ? ` · ${Math.floor(bio.height_in / 12)}'${bio.height_in % 12}"` : ""}${bio.weight_lb ? `, ${bio.weight_lb} lb` : ""}${bio.college ? ` · ${esc(bio.college)}` : ""}</div>
      <div class="meta">${draft ? draft + " · " : ""}${games.length} games loaded · ${seasons.join(", ")}${teamsPlayed.length > 1 ? " · Teams: " + teamsPlayed.map(teamLink).join(", ") : ""}</div>
    </div><div><a class="btn" href="#/compare?a=${id}">Compare with…</a></div></div>
    <div id="form"></div><div id="fbar"></div><div id="body"></div>`;
  const skill = ["QB", "RB", "WR", "TE"].includes(grp);
  if (skill) formFor("players", id, latest).then(({ f: fm }) => { const el = $("#form"); if (el) el.innerHTML = formCard(fm, latest, "player"); });
  else $("#form").remove();

  const body = $("#body");
  let metric = Object.keys(G.trend)[0], win = 3;
  const render = async () => {
    const fg = applyFilter(games, f, "team_result");
    $(".filter-note").textContent = `${fg.length} of ${games.length} games`;
    const a = aggPlayer(fg);
    const rankSeason = f.seasons?.length ? Math.max(...f.seasons) : latest;
    const ctx = await playerRankContext(id, grp, rankSeason, f.type === "P" ? "P" : "R");
    const lead = [["Games", a.gp, `Team ${recStr(a)}`]];
    body.innerHTML = h`
      ${rankHeader(ctx, f, "this player")}
      ${tilesHtml(PD, G.tiles, a, ctx, lead)}
      <div class="grid2" style="margin-top:16px">
        <div class="card"><div class="chart-controls"><h2 style="margin:0">Trend</h2>${trendControls(G.trend, metric, [2, 3, 4, 6], win)}</div>
          <div class="legend" id="tleg"></div><div class="chart" id="trend"></div></div>
        <div class="card"><h2>League percentiles <span class="muted">· ${rankSeason}</span></h2><div id="pct"></div></div>
      </div>
      <div class="card"><h2>Splits</h2><div id="splits"></div></div>
      <div class="card"><h2>Game log</h2><div id="log"></div></div>
      <div class="card"><h2>By season</h2><div id="career"></div></div>`;
    drawTrend(fg);
    pctBars($("#pct"), PD, G.pct, a, ctx);
    splitsBlock($("#splits"), fg, aggPlayer, defCols(PD, G.split), commonSplits("team_result"));
    sortTable($("#log"), [...fg].reverse(), [
      { k: "game_date", label: "Date", html: r => `<a href="#/game/${r.game_id}">${shortDate(r.game_date)}</a> <span class="muted">${r.season} ${wkShort(r)}</span>`, sortVal: r => r.game_date, csv: r => r.game_date },
      { k: "opp", label: "Opp", html: oppCell, csv: r => (r.is_home ? "vs " : "@ ") + r.opp },
      { k: "team_result", label: "Result", val: r => `${r.team_result} ${r.team_pf}-${r.team_pa}` },
      ...G.log.map(([k, label, fm]) => ({ k, label, n: 1, val: r => r[k] ?? 0, fmt: fm || (v => fmt(v, Number.isInteger(v) ? 0 : 1)) })),
      { k: "rest_days", label: "Rest", n: 1 }], { sortKey: "game_date", csvName: `${bio.name}-gamelog` });
    const careerRows = Object.entries(groupBy(games, g => g.season + "|" + g.game_type + "|" + g.team)).map(([k, gs]) => {
      const [s, t, tm] = k.split("|"); return { season: +s, type: t, team: tm, ...aggPlayer(gs) };
    });
    sortTable($("#career"), careerRows, [{ k: "season", label: "Season" }, { k: "type", label: "Type", fmt: v => (v === "P" ? "Playoffs" : "Regular") },
      { k: "team", label: "Team", html: r => teamLink(r.team) }, { k: "gp", label: "G", n: 1 }, ...defCols(PD, G.tiles).map(c => ({ ...c, val: r => (PD[c.k].total ? r : PD[c.k].f(r)), fmt: v => (typeof v === "object" ? PD[c.k].total(v) : PD[c.k].fmt(v)), sortVal: r => PD[c.k].f(r) }))],
    { sortKey: "season", csvName: `${bio.name}-seasons` });
    $("#metric").onchange = e => { metric = e.target.value; drawTrend(fg); };
    $("#win").onchange = e => { win = +e.target.value; drawTrend(fg); };
  };
  function drawTrend(fg) {
    const m = G.trend[metric], { vals, roll, avg, yf } = metricSeries(fg, m, win);
    $("#tleg").innerHTML = `<span><i style="background:var(--series-1)"></i>${win}-game ${m.den ? "rate" : "average"}</span><span><i style="background:var(--series-1);opacity:.35;height:6px;width:6px;border-radius:3px"></i>Single game</span><span><i class="dash"></i>Filtered average (${yf(avg)})</span>`;
    lineChart($("#trend"), {
      title: m.label, series: [{ name: m.label, color: "var(--series-1)", values: roll, dots: vals }], ref: { value: avg }, yFmt: yf,
      xLabels: fg.map(g => `${String(g.season).slice(2)} ${wkShort(g)}`), zeroBase: !String(metric).includes("epa"),
      tipHtml: i => { const g = fg[i]; return `<b>${g.season} ${weekLabel(g)} ${g.is_home ? "vs" : "@"} ${g.opp}</b><div class="row"><span>${m.label}</span><span>${yf(vals[i])}</span></div><div class="row"><span>${win}-game</span><span>${yf(roll[i])}</span></div><div class="row"><span>Team</span><span>${g.team_result} ${g.team_pf}-${g.team_pa}</span></div><div class="row"><span>PPR</span><span>${fmt(n(g, "fantasy_points_ppr"), 1)}</span></div>`; },
    });
  }
  $("#fbar").appendChild(filterBar(f, { seasons, opps, onChange: render }));
  render();
}

// ------------------------------------------------------------------ team
const TEAM_METRICS = {
  points: { label: "Points for vs against", two: ["pf", "pa"] },
  yards: { label: "Yards for vs allowed", two: ["yards", "opp_yards"] },
  epa: { label: "EPA/play: offense vs defense", two: [["epa", "plays"], ["opp_epa", "opp_plays"]] },
  diff: { label: "Point differential", one: g => g.pf - g.pa },
  to: { label: "Turnover margin", one: g => g.takeaways - g.turnovers },
  win: { label: "Win % (rolling)", win: 1 },
};
async function pageTeam(abbr) {
  const doc = await load(`teams/${abbr}.json`);
  const games = objs(doc.games), players = objs(doc.players), sched = objs(doc.schedule);
  const seasons = [...new Set(games.map(g => g.season))].sort();
  const latest = seasons[seasons.length - 1];
  const f = DEFAULT_FILTER(); f.seasons = [latest]; f._defaultSeasons = [latest];
  const opps = [...new Set(games.map(g => g.opp))].sort();
  const t = TEAM_BY[abbr] || {};
  let metric = "points", win = 4, ptab = "passing";

  app.innerHTML = h`
    <div class="head"><div><h1>${esc(t.name || abbr)}</h1><div class="meta">${t.division ? esc(t.division) + " · " : ""}${games.length} games loaded</div></div>
      <div><a class="btn" href="#/compare?ta=${abbr}">Compare with…</a></div></div>
    <div id="form"></div><div id="fbar"></div><div id="body"></div>`;
  formFor("teams", abbr, latest).then(({ f: fm }) => { const el = $("#form"); if (el) el.innerHTML = formCard(fm, latest, "team"); });
  const body = $("#body");
  const render = async () => {
    const fg = applyFilter(games, f, "result");
    $(".filter-note").textContent = `${fg.length} of ${games.length} games`;
    const a = aggTeam(fg);
    const ctx = await teamRankContext(abbr, f.seasons?.length ? Math.max(...f.seasons) : latest, f.type === "P" ? "P" : "R");
    body.innerHTML = h`
      ${rankHeader(ctx, f, "this team")}
      ${tilesHtml(TD, T_TILES, a, ctx)}
      <div class="card" style="margin-top:16px"><h2>Results <span class="muted">· oldest → newest</span></h2><div class="strip">${fg.map(g => `<a class="${g.result}" href="#/game/${g.game_id}" title="${g.season} ${weekLabel(g)} ${g.is_home ? "vs" : "@"} ${g.opp} ${g.pf}-${g.pa}${g.overtime ? " (OT)" : ""}">${g.result}</a>`).join("")}</div>
        <div class="legend" style="margin-top:8px"><span>W = win</span><span>L = loss</span><span>T = tie</span><span>One-score games: ${a.close_w}-${a.close_l}</span><span>Over/under: ${a.ovr}-${a.und}</span></div></div>
      <div class="card"><div class="chart-controls"><h2 style="margin:0">Trend</h2>${trendControls(TEAM_METRICS, metric, [2, 4, 6, 8], win)}</div>
        <div class="legend" id="tleg"></div><div class="chart" id="trend"></div></div>
      <div class="card"><h2>Splits</h2><div id="splits"></div></div>
      <div class="card"><h2>Players <span class="muted" id="roster-note"></span></h2><div class="tabs subtabs" id="ptabs"></div><div id="players"></div></div>
      ${sched.length && (!f.seasons || f.seasons.includes(latest)) ? `<div class="card"><h2>Upcoming schedule</h2><div id="sched"></div></div>` : ""}
      <div class="card"><h2>Game log</h2><div id="log"></div></div>`;
    drawTrend(fg);
    splitsBlock($("#splits"), fg, aggTeam, defCols(TD, T_SPLIT), commonSplits("result", true));
    drawPlayers();
    if ($("#sched")) drawSchedule();
    sortTable($("#log"), [...fg].reverse(), [
      { k: "game_date", label: "Date", html: r => `<a href="#/game/${r.game_id}">${shortDate(r.game_date)}</a> <span class="muted">${r.season} ${wkShort(r)}</span>`, sortVal: r => r.game_date, csv: r => r.game_date },
      { k: "opp", label: "Opp", html: oppCell, csv: r => (r.is_home ? "vs " : "@ ") + r.opp },
      { k: "result", label: "Res", val: r => `${r.result} ${r.pf}-${r.pa}${r.overtime ? " OT" : ""}`, sortVal: r => r.pf - r.pa },
      { k: "team_line", label: "Line", n: 1, fmt: teamLineStr }, { k: "ats", label: "ATS" }, { k: "ou", label: "O/U" },
      { k: "yards", label: "Yds", n: 1 }, { k: "opp_yards", label: "Yds allowed", n: 1 },
      { k: "epa_pp", label: "EPA/play", n: 1, val: r => div(r.epa, r.plays), fmt: fs2 }, { k: "depa_pp", label: "Def EPA/play", n: 1, val: r => div(r.opp_epa, r.opp_plays), fmt: fs2 },
      { k: "turnovers", label: "TO", n: 1 }, { k: "takeaways", label: "Take", n: 1 }, { k: "def_sacks", label: "Sacks", n: 1 },
      { k: "qb", label: "QB" }, { k: "rest_days", label: "Rest", n: 1 }, { k: "temp", label: "Temp", n: 1, fmt: (v, r) => (indoors(r) ? "Indoor" : v == null ? "–" : v + "°") }],
    { sortKey: "game_date", csvName: `${abbr}-gamelog` });
    $("#metric").onchange = e => { metric = e.target.value; drawTrend(fg); };
    $("#win").onchange = e => { win = +e.target.value; drawTrend(fg); };
  };
  function drawPlayers() {
    const ss = f.seasons || seasons, tp = f.type;
    $("#roster-note").textContent = `· ${ss.join(", ")} · ${tp === "P" ? "Playoffs" : tp === "R" ? "Regular season" : "All games"} · season totals (other filters don't apply)`;
    const rows = Object.values(groupBy(players.filter(r => ss.includes(r.season) && (tp === "all" || r.game_type === tp)), r => r.id)).map(rs => {
      const o = { id: rs[0].id, name: rs[0].name, pos: rs[0].pos, grp: rs[0].grp, gp: sum(rs, "gp") };
      for (const k of P_STATS) o[k] = sum(rs, k);
      o.target_share = rs.some(r => r.target_share != null) ? rs.reduce((s, r) => s + (r.target_share || 0) * r.gp, 0) / Math.max(1, sum(rs.filter(r => r.target_share != null), "gp")) : null;
      o.fg_long = Math.max(0, ...rs.map(r => n(r, "fg_long")));
      return o;
    });
    const TABS = {
      passing: ["Passing", r => r.attempts > 0, ["pass_yds", "pass_td", "ints", "cmp", "ypa", "anya", "epa_db", "sack_rate"], "passing_yards"],
      rushing: ["Rushing", r => r.carries > 0, ["rush_att", "rush_yds", "ypc", "rush_td", "epa_rush", "fum"], "rushing_yards"],
      receiving: ["Receiving", r => r.targets > 0, ["tgt", "rec", "rec_yds", "rec_td", "ypr", "catch", "tshare", "yac"], "receiving_yards"],
      defense: ["Defense", r => r.tackles + r.def_sacks + r.def_pass_defended > 0 && ["DL", "LB", "DB"].includes(r.grp), ["tkl", "tfl", "sacks", "qbh", "dint", "pd", "ff"], "tackles"],
      kicking: ["Kicking", r => r.fg_att + r.pat_att + r.pt_att > 0, ["fg_pct", "fg50", "fg_long", "pat", "punts", "pt_net"], "fg_made"],
      fantasy: ["Fantasy", r => r.fantasy_points_ppr > 0, ["ppr", "std", "scrim", "tds", "touches", "tgt"], "fantasy_points_ppr"],
    };
    $("#ptabs").innerHTML = Object.entries(TABS).map(([k, [l]]) => `<button class="tab ${k === ptab ? "on" : ""}" data-k="${k}">${l}</button>`).join("");
    $("#ptabs").querySelectorAll(".tab").forEach(b => b.onclick = () => { ptab = b.dataset.k; drawPlayers(); });
    const [, filt, keys, sortK] = TABS[ptab];
    const totalCol = k => ({ k, label: PD[k].label, n: 1, title: PD[k].basis, val: r => (PD[k].total ? r : PD[k].f(r)), fmt: v => (typeof v === "object" ? PD[k].total(v) : PD[k].fmt(v)), sortVal: r => (PD[k].total ? numOf(PD[k].total(r)) : PD[k].f(r)), csv: r => (PD[k].total ? PD[k].total(r) : PD[k].fmt(PD[k].f(r))) });
    sortTable($("#players"), rows.filter(filt), [{ k: "name", label: "Player", html: r => playerLink(r.id, r.name) }, { k: "pos", label: "Pos" }, { k: "gp", label: "G", n: 1 }, ...keys.map(totalCol)],
      { sortKey: keys[0], csvName: `${abbr}-${ptab}` });
  }
  async function drawSchedule() {
    let lg = null; try { lg = await load(`league/${latest}.json`); } catch { }
    const recs = Object.fromEntries(objs(lg?.teams).filter(r => r.game_type === "R").map(r => [r.team, r]));
    const form = lg?.form?.teams || {};
    sortTable($("#sched"), sched, [{ k: "game_date", label: "Date", val: r => `${shortDate(r.game_date)} · ${weekLabel(r)}`, sortVal: r => r.game_date },
      { k: "opp", label: "Opponent", html: r => `${r.is_home ? "vs" : "@"} ${teamLink(r.opp)} <span class="muted">${esc(TEAM_BY[r.opp]?.nick || "")}</span>` },
      { k: "orec", label: "Opp record", val: r => (recs[r.opp] ? recStr(recs[r.opp]) : "–"), sortVal: r => (recs[r.opp] ? wpct(recs[r.opp]) : null) },
      { k: "opd", label: "Opp pt diff/G", n: 1, val: r => (recs[r.opp] ? div(recs[r.opp].pf - recs[r.opp].pa, recs[r.opp].gp) : null), fmt: v => fmtSigned(v, 1), cellCls: r => { const v = recs[r.opp] ? (recs[r.opp].pf - recs[r.opp].pa) / recs[r.opp].gp : 0; return v > 5 ? "cold" : v < -5 ? "hot" : ""; }, title: "Tough opponents shaded red, soft ones green" },
      { k: "oform", label: "Opp form", html: r => formBadge(form[r.opp]?.status), sortVal: r => form[r.opp]?.score },
      { k: "team_line", label: "Line", n: 1, fmt: teamLineStr }, { k: "gametime", label: "Kickoff", val: r => `${(r.weekday || "").slice(0, 3)} ${r.gametime || ""}` }],
    { sortKey: "game_date", desc: false, full: true });
  }
  function drawTrend(fg) {
    const m = TEAM_METRICS[metric], xl = fg.map(g => `${String(g.season).slice(2)} ${wkShort(g)}`);
    const tipBase = i => { const g = fg[i]; return `<b>${g.season} ${weekLabel(g)} ${g.is_home ? "vs" : "@"} ${g.opp}</b><div class="row"><span>Result</span><span>${g.result} ${g.pf}-${g.pa}${g.overtime ? " OT" : ""}</span></div><div class="row"><span>Yards</span><span>${g.yards}-${g.opp_yards}</span></div>`; };
    if (m.two) {
      const ser = m.two.map(k => (Array.isArray(k) ? rollingRatio(fg.map(g => g[k[0]]), fg.map(g => g[k[1]]), win) : rolling(fg.map(g => g[k]), win)));
      const yf = metric === "epa" ? fs2 : f1;
      $("#tleg").innerHTML = `<span><i style="background:var(--series-1)"></i>Offense (${win}-game)</span><span><i style="background:var(--series-2)"></i>${metric === "epa" ? "Defense allowed" : "Opponent"} (${win}-game)</span>`;
      lineChart($("#trend"), { series: [{ name: "For", color: "var(--series-1)", values: ser[0] }, { name: "Against", color: "var(--series-2)", values: ser[1] }], xLabels: xl, yFmt: yf, zeroBase: metric !== "epa",
        tipHtml: i => tipBase(i) + `<div class="row"><span>Offense, ${win}g</span><span>${yf(ser[0][i])}</span></div><div class="row"><span>Against, ${win}g</span><span>${yf(ser[1][i])}</span></div>` });
    } else if (m.one) {
      const vals = fg.map(m.one), r = rolling(vals, win);
      $("#tleg").innerHTML = `<span><i style="background:var(--series-1)"></i>${m.label} (${win}-game avg)</span><span><i class="dash"></i>Even</span>`;
      lineChart($("#trend"), { series: [{ name: m.label, color: "var(--series-1)", values: r, dots: vals }], ref: { value: 0 }, xLabels: xl, zeroBase: false, yFmt: v => fmtSigned(v, 1),
        tipHtml: i => tipBase(i) + `<div class="row"><span>This game</span><span>${fmtSigned(vals[i])}</span></div><div class="row"><span>${win}-game avg</span><span>${fmtSigned(r[i], 1)}</span></div>` });
    } else {
      const r = rollingRatio(fg.map(g => (g.result === "W" ? 1 : g.result === "T" ? 0.5 : 0)), fg.map(() => 1), win);
      $("#tleg").innerHTML = `<span><i style="background:var(--series-1)"></i>Win % (${win}-game)</span><span><i class="dash"></i>.500</span>`;
      lineChart($("#trend"), { series: [{ name: "Win%", color: "var(--series-1)", values: r }], ref: { value: 0.5 }, xLabels: xl, yFmt: fmt3, tipHtml: i => tipBase(i) + `<div class="row"><span>Win %, ${win}g</span><span>${fmt3(r[i])}</span></div>` });
    }
  }
  $("#fbar").appendChild(filterBar(f, { seasons, opps, onChange: render, resultLabel: "Result" }));
  render();
}

// ------------------------------------------------------------------ trends
async function pageTrends(params) {
  const st = { season: +(params.get("season") || META.current_season), grp: "all", team: "all", activeOnly: true };
  const render = async () => {
    const lg = await load(`league/${st.season}.json`);
    const form = lg.form || {}, asOf = form.as_of;
    const recent = d => !st.activeOnly || !asOf || (new Date(asOf) - new Date(d)) / 864e5 <= 14;
    const info = {}; for (const r of objs(lg.players)) if (!info[r.player_id] || r.game_type === "R") info[r.player_id] = r;
    const P = Object.entries(form.players || {}).map(([id, f]) => ({ id, ...f, name: info[id]?.name || id, team: info[id]?.team, pos: info[id]?.pos, grp: info[id]?.grp }))
      .filter(r => recent(r.last_game) && (st.team === "all" || r.team === st.team) && (st.grp === "all" || r.grp === st.grp));
    const T = Object.entries(form.teams || {}).map(([team, f]) => ({ team, ...f }));
    const li = r => `<li><span>${r.id ? playerLink(r.id, r.name) + ` <span class="muted">${esc(r.pos || "")} · ${esc(r.team || "")}</span>` : teamLink(r.team) + ` <span class="muted">${esc(TEAM_BY[r.team]?.nick || "")}</span>`}</span>
      <span>${formBadge(r.status)}</span><span class="why">${r.reasons.slice(0, 2).map(esc).join(" · ")}${r.flags?.length ? " " + flagChips(r.flags) : ""}</span></li>`;
    const list = (title, rows, empty) => `<div class="card"><h2>${title}</h2>${rows.length ? `<ul class="trend-list">${rows.map(li).join("")}</ul>` : `<div class="muted">${empty}</div>`}</div>`;
    const hot = arr => arr.filter(r => r.score >= 0.9).sort((a, b) => b.score - a.score);
    const cold = arr => arr.filter(r => r.score <= -0.9).sort((a, b) => a.score - b.score);
    const flagged = (arr, fl) => arr.filter(r => r.flags?.includes(fl)).sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
    const opt = (arr, v) => arr.map(([k, l]) => `<option value="${k}" ${String(k) === String(v) ? "selected" : ""}>${l}</option>`).join("");
    const counts = Object.fromEntries(Object.keys(FORM).map(k => [k, P.filter(r => r.status === k).length]));
    app.innerHTML = h`
      <div class="head"><div><h1>Trends</h1><div class="meta">Who's hot and who's cold${asOf ? ", through " + fmtDate(asOf) : ""}. Each player's or team's last few games vs what we'd expect from them, flagged only when the gap is too big to be ordinary week-to-week noise.</div></div></div>
      <div class="card filters">
        <label>Season<select data-k="season">${opt([...META.seasons].reverse().map(x => [x, x]), st.season)}</select></label>
        <label>Position<select data-k="grp">${opt([["all", "QB / RB / WR / TE"], ["QB", "QB"], ["RB", "RB"], ["WR", "WR"], ["TE", "TE"]], st.grp)}</select></label>
        <label>Team<select data-k="team">${opt([["all", "All"], ...TEAMS.filter(t => t.current).map(t => [t.abbrev, t.abbrev])], st.team)}</select></label>
        <label>Players<select data-k="activeOnly">${opt([["true", "Played in last 2 weeks"], ["false", "Everyone"]], String(st.activeOnly))}</select></label>
        <span class="filter-note">${Object.entries(counts).map(([k, c]) => `${formBadge(k)} ${c}`).join(" &nbsp; ")}</span>
      </div>
      <div class="grid2">${list("Hottest players", hot(P).slice(0, 15), "Nobody is running well above expectation right now.")}${list("Coldest players", cold(P).slice(0, 15), "Nobody is running well below expectation right now.")}</div>
      <div class="card"><h2>Teams</h2><div id="tt"></div></div>
      <div class="grid3">${list("Likely to cool off", flagged([...P, ...T], "regression_risk").slice(0, 10), "None flagged.")}${list("Due to heat up", flagged([...P, ...T], "buy_low").slice(0, 10), "None flagged.")}${list("Role changes (targets / touches)", [...flagged(P, "role_up"), ...flagged(P, "role_down")].slice(0, 14), "None flagged.")}</div>
      <div class="card muted" style="font-size:12px"><b>How this works.</b> For each QB, RB, WR and TE we set an expected PPR fantasy output per game from his earlier games this season, blended with last season (or the position average) so a short sample can't swing it. His last 4 games and last 2 games are compared with that expectation, scaled by how much a player at his level normally swings week to week (fitted from the whole league). +0.9 or more is Warming and +1.8 or more is Hot; the same below zero means Cooling and Cold. Teams use wins and point differential over their last 4 games. "Likely to cool" marks hot runs built on touchdowns well beyond what the yardage usually produces (or, for teams, a record well ahead of point differential while winning close games). "Due to heat up" marks the reverse. "Role" flags a clear change in target share or touches. NFL samples are small, so roughly 1 in 5 players shows Warming or Cooling by chance alone: read the reasons.</div>`;
    sortTable($("#tt"), T, [{ k: "team", label: "Team", html: r => `${teamLink(r.team)} <span class="muted">${esc(TEAM_BY[r.team]?.nick || "")}</span>` },
      { k: "status", label: "Form", html: r => formBadge(r.status), sortVal: r => r.score }, { k: "score", label: "Score", n: 1, fmt: v => fmtSigned(v, 1) },
      { k: "pyth", label: "Pyth win %", n: 1, fmt: fmt3, title: "Win % that the season's points for and against usually produce" },
      { k: "why", label: "Why", html: r => r.reasons.map(esc).join(" · ") + " " + flagChips(r.flags), csv: r => r.reasons.join(" | ") }], { sortKey: "score", csvName: `team-form-${st.season}` });
    app.querySelectorAll("[data-k]").forEach(i => i.onchange = () => { const k = i.dataset.k; st[k] = k === "season" ? +i.value : k === "activeOnly" ? i.value === "true" : i.value; render(); });
  };
  await render();
}

// ------------------------------------------------------------------ screener
const SCREENS = {
  passing: { label: "Passing", grps: ["QB"], filt: r => r.attempts > 0, keys: ["pass_yds", "pass_td", "ints", "cmp", "ypa", "anya", "epa_db", "cpoe", "sack_rate", "adot", "rush_yds", "ppr"], sort: "pass_yds",
    l3: [["pyd3", "L3 pass yds/G", r => div(r.pyd3, r.gp3), r => div(r.pyd3, r.gp3) - div(r.passing_yards, r.gp), 40]] },
  rushing: { label: "Rushing", grps: ["RB", "QB", "WR"], filt: r => r.carries > 0, keys: ["rush_att", "rush_yds", "ypc", "rush_td", "epa_rush", "tgt", "rec_yds", "scrim", "touches", "tds", "ppr"], sort: "rush_yds",
    l3: [["tch3", "L3 touches/G", r => div(r.tch3, r.gp3), r => div(r.tch3, r.gp3) - div(r.touches, r.gp), 4]] },
  receiving: { label: "Receiving", grps: ["WR", "TE", "RB"], filt: r => r.targets > 0, keys: ["tgt", "rec", "rec_yds", "rec_td", "ypr", "ypt", "catch", "tshare", "ayshare", "wopr", "yac", "epa_tgt", "ppr"], sort: "rec_yds",
    l3: [["tgt3", "L3 tgt/G", r => div(r.tgt3, r.gp3), r => div(r.tgt3, r.gp3) - div(r.targets, r.gp), 2.5], ["ts3", "L3 tgt share", r => r.ts3, r => (r.ts3 == null || r.target_share == null ? null : r.ts3 - r.target_share), 0.06, true]] },
  defense: { label: "Defense", grps: ["DL", "LB", "DB"], filt: r => ["DL", "LB", "DB"].includes(r.grp), keys: ["tkl", "tfl", "sacks", "qbh", "dint", "pd", "ff", "dtd"], sort: "tkl",
    l3: [["tkl3", "L3 tkl/G", r => div(r.tkl3, r.gp3), r => div(r.tkl3, r.gp3) - div(r.tackles, r.gp), 2.5]] },
  kicking: { label: "Kicking", grps: ["K"], filt: r => r.fg_att + r.pat_att > 0, keys: ["fg_g", "fg_pct", "fg50", "fg_long", "pat"], sort: "fg_g", l3: [] },
  punting: { label: "Punting", grps: ["P"], filt: r => r.pt_att > 0, keys: ["punts", "pt_avg", "pt_net", "pt_i20"], sort: "pt_net", l3: [] },
  fantasy: { label: "Fantasy", grps: ["QB", "RB", "WR", "TE"], filt: r => r.fantasy_points_ppr > 0, keys: ["ppr", "std", "scrim", "tds", "touches", "tgt", "tshare", "pass_yds"], sort: "ppr",
    l3: [["ppr3", "L3 PPR/G", r => div(r.ppr3, r.gp3), r => div(r.ppr3, r.gp3) - div(r.fantasy_points_ppr, r.gp), 5]] },
};
async function pageScreener(params) {
  const st = { season: +(params.get("season") || META.current_season), type: "R", tab: params.get("tab") || "passing", grp: "all", team: "all", minGp: null, q: "" };
  app.innerHTML = `<div class="head"><div><h1>Screener</h1><div class="meta">Every player or team for a season, sortable on any column. Count columns are season totals; the "/G" columns next to them rank by per-game rate. "L3" columns compare the last 3 games with the season.</div></div></div><div id="ctl" class="card filters"></div><div class="card" id="res"></div>`;
  const render = async () => {
    const league = await load(`league/${st.season}.json`);
    const ctl = $("#ctl"), S = SCREENS[st.tab];
    const opt = (arr, v) => arr.map(([k, l]) => `<option value="${k}" ${String(k) === String(v) ? "selected" : ""}>${l}</option>`).join("");
    ctl.innerHTML = `<div class="chips">${[...Object.entries(SCREENS).map(([k, s]) => [k, s.label]), ["teams", "Teams"]].map(([k, l]) => `<button class="chip ${st.tab === k ? "on" : ""}" data-tab="${k}">${l}</button>`).join("")}</div>
      <label>Season<select data-k="season">${opt([...META.seasons].reverse().map(s => [s, s]), st.season)}</select></label>
      <label>Game type<select data-k="type">${opt([["R", "Regular season"], ["P", "Playoffs"]], st.type)}</select></label>
      ${st.tab !== "teams" ? `${S.grps.length > 1 ? `<label>Position<select data-k="grp">${opt([["all", "All"], ...S.grps.map(g => [g, g])], st.grp)}</select></label>` : ""}
      <label>Team<select data-k="team">${opt([["all", "All"], ...TEAMS.filter(t => t.current).map(t => [t.abbrev, t.abbrev])], st.team)}</select></label>
      <label>Min games<input type="number" min="0" data-k="minGp" value="${st.minGp ?? ""}" placeholder="auto" style="width:80px"></label>
      <label>Name<input type="search" data-k="q" value="${esc(st.q)}" placeholder="filter…"></label>` : ""}`;
    ctl.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => { st.tab = b.dataset.tab; st.grp = "all"; render(); });
    ctl.querySelectorAll("[data-k]").forEach(i => { i[i.type === "search" ? "oninput" : "onchange"] = () => { const k = i.dataset.k; st[k] = k === "season" ? +i.value : k === "minGp" ? (i.value === "" ? null : +i.value) : i.value; if (k === "q") drawTable(); else render(); }; });
    drawTable();
    function drawTable() {
      const res = $("#res"), F = league.form || {};
      if (st.tab === "teams") {
        const rows = objs(league.teams).filter(t => t.game_type === st.type);
        sortTable(res, rows, [{ k: "team", label: "Team", html: r => `${teamLink(r.team)} <span class="muted">${esc(TEAM_BY[r.team]?.nick || "")}</span>` },
          { k: "form", label: "Form", html: r => formBadge(F.teams?.[r.team]?.status), sortVal: r => F.teams?.[r.team]?.score },
          { k: "gp", label: "G", n: 1 }, ...defCols(TD, ["rec", "pf", "pa", "pd", "epa", "depa", "pass_epa", "rush_epa", "dpass_epa", "drush_epa", "ypp", "dypp", "tom", "sacks", "sk_allowed", "expl", "pen", "ats"]).map(c => (TD[c.k].total ? { ...c, fmt: (v, r) => TD[c.k].total(r) } : c)),
          { k: "ou", label: "O/U", val: r => `${r.ovr}-${r.und}`, sortVal: r => div(r.ovr, r.ovr + r.und) },
          { k: "close", label: "1-score", val: r => `${r.close_w}-${r.close_l}`, sortVal: r => r.close_w - r.close_l, title: "Record in games decided by 8 or fewer" },
          { k: "l5", label: "L5", val: r => `${r.w5}-${r.l5}`, sortVal: r => r.w5 - r.l5 }, { k: "strk", label: "Strk", val: r => streakOf(r.results) }],
        { sortKey: "rec", csvName: `teams-${st.season}` });
        return;
      }
      let rows = objs(league.players).filter(r => r.game_type === st.type && S.grps.includes(grpOf(r.grp)) && S.filt(r));
      const maxGp = Math.max(0, ...rows.map(r => r.gp));
      const minGp = st.minGp ?? Math.max(1, Math.round(maxGp * 0.3));
      rows = rows.filter(r => r.gp >= minGp && (st.grp === "all" || grpOf(r.grp) === st.grp) && (st.team === "all" || r.team === st.team) && (!st.q || r.name.toLowerCase().includes(st.q.toLowerCase())));
      const totalCol = k => ({ k, label: PD[k].label, n: 1, title: PD[k].basis, val: r => PD[k].f(r), fmt: (v, r) => (PD[k].total ? PD[k].total(r) : PD[k].fmt(v)), sortVal: r => (PD[k].total ? numOf(PD[k].total(r)) : PD[k].f(r)), csv: r => (PD[k].total ? PD[k].total(r) : PD[k].fmt(PD[k].f(r))) });
      const pgCol = k => (PD[k].total ? [totalCol(k), { k: k + "_r", label: PD[k].label + (PD[k].f === undefined ? "" : PD[k].basis.includes("per game") ? "/G" : " rate"), n: 1, val: r => PD[k].f(r), fmt: v => PD[k].fmt(v) }] : [totalCol(k)]);
      const l3cols = S.l3.flatMap(([k, label, fv, fd, thr, pct]) => [{ k, label, n: 1, val: fv, fmt: v => (pct ? fmtPct(v, 0) : fmt(v, 1)) },
        { k: k + "_d", label: "Δ vs season", n: 1, val: fd, fmt: v => (v == null ? "–" : pct ? fmtSigned(v * 100, 0) + " pts" : fmtSigned(v, 1)), cellCls: r => { const d = fd(r); return d == null ? "" : d >= thr ? "hot" : d <= -thr ? "cold" : ""; } }]);
      const skill = S.grps.some(g => ["QB", "RB", "WR", "TE"].includes(g));
      sortTable(res, rows, [{ k: "name", label: "Player", html: r => playerLink(r.player_id, r.name) }, { k: "team", label: "Team", html: r => teamLink(r.team) }, { k: "pos", label: "Pos" },
        ...(skill ? [{ k: "form", label: "Form", html: r => formBadge(F.players?.[r.player_id]?.status), sortVal: r => F.players?.[r.player_id]?.score ?? null, csv: r => F.players?.[r.player_id]?.status || "" }] : []),
        { k: "gp", label: "G", n: 1 }, ...S.keys.flatMap(k => (["pass_yds", "rush_yds", "rec_yds", "tkl", "ppr", "tgt"].includes(k) ? pgCol(k) : [totalCol(k)])), ...l3cols,
        { k: "last_game", label: "Last G", fmt: v => (v ? shortDate(v) : "–") }],
      { sortKey: S.sort, limit: 400, csvName: `${st.tab}-${st.season}` });
    }
  };
  render();
}

// ------------------------------------------------------------------ compare
async function pageCompare(params) {
  const isTeam = params.has("ta") || params.get("mode") === "teams";
  const A = params.get(isTeam ? "ta" : "a"), B = params.get(isTeam ? "tb" : "b");
  app.innerHTML = `<div class="head"><div><h1>Compare</h1><div class="meta">Side by side over the same filters, with an overlaid trend.</div></div>
    <div class="chips"><a class="chip ${!isTeam ? "on" : ""}" href="#/compare">Players</a><a class="chip ${isTeam ? "on" : ""}" href="#/compare?mode=teams">Teams</a></div></div>
    <div class="card filters"><div class="picker" style="flex:1"><label>${isTeam ? "Team" : "Player"} A</label><input id="pa" placeholder="Search…"><div class="search-results" hidden></div></div>
    <div class="picker" style="flex:1"><label>${isTeam ? "Team" : "Player"} B</label><input id="pb" placeholder="Search…"><div class="search-results" hidden></div></div></div><div id="cbody"></div>`;
  const go = (a, b) => { const q = new URLSearchParams(); if (isTeam) { if (a) q.set("ta", a); if (b) q.set("tb", b); if (!a && !b) q.set("mode", "teams"); } else { if (a) q.set("a", a); if (b) q.set("b", b); } location.hash = "#/compare?" + q; };
  attachPicker($("#pa"), isTeam, v => go(v, B));
  attachPicker($("#pb"), isTeam, v => go(A, v));
  if (isTeam) { if (A) $("#pa").value = teamName(A); if (B) $("#pb").value = teamName(B); }
  else { const find = id => INDEX.find(p => String(p.id) === String(id)); if (A) $("#pa").value = find(A)?.name || ""; if (B) $("#pb").value = find(B)?.name || ""; }
  if (!A || !B) { $("#cbody").innerHTML = `<div class="card empty">Pick two ${isTeam ? "teams" : "players"} to compare.</div>`; return; }
  const [da, dbb] = await Promise.all([load(isTeam ? `teams/${A}.json` : `players/${A}.json`), load(isTeam ? `teams/${B}.json` : `players/${B}.json`)]);
  const ga = objs(da.games), gb = objs(dbb.games);
  const nameA = isTeam ? teamName(A) : da.bio.name, nameB = isTeam ? teamName(B) : dbb.bio.name;
  const grp = isTeam ? null : grpOf(da.bio.grp);
  const defs = isTeam ? TD : PD;
  const keys = isTeam ? T_TILES : [...new Set([...GROUPS[grp].tiles, ...(grpOf(dbb.bio.grp) !== grp ? GROUPS[grpOf(dbb.bio.grp)].tiles : [])])];
  const metrics = isTeam ? { pf: { label: "Points scored", num: g => g.pf }, pa: { label: "Points allowed", num: g => g.pa }, epa: { label: "Off EPA/play", num: g => g.epa, den: g => g.plays, ratio: 1 }, depa: { label: "Def EPA/play", num: g => g.opp_epa, den: g => g.opp_plays, ratio: 1 }, yards: { label: "Yards", num: g => g.yards } } : GROUPS[grp].trend;
  const seasons = [...new Set([...ga, ...gb].map(g => g.season))].sort();
  const f = DEFAULT_FILTER(); f.seasons = [seasons[seasons.length - 1]]; f._defaultSeasons = f.seasons;
  const opps = [...new Set([...ga, ...gb].map(g => g.opp))].sort();
  const resultKey = isTeam ? "result" : "team_result", agg = isTeam ? aggTeam : aggPlayer;
  let metric = Object.keys(metrics)[0], win = 3;
  const body = document.createElement("div");
  const render = () => {
    const fa = applyFilter(ga, f, resultKey), fb = applyFilter(gb, f, resultKey);
    $(".filter-note").textContent = `${fa.length} vs ${fb.length} games`;
    const sa = agg(fa), sb = agg(fb);
    body.innerHTML = h`<div class="card"><table><thead><tr><th>Stat</th><th class="n">${esc(nameA)}</th><th class="n">${esc(nameB)}</th></tr></thead><tbody>
      <tr><td>Games</td><td class="n">${sa.gp} <span class="muted">(${recStr(sa)})</span></td><td class="n">${sb.gp} <span class="muted">(${recStr(sb)})</span></td></tr>
      ${keys.map(k => { const d = defs[k], va = d.f(sa), vb = d.f(sb); const better = va == null || vb == null || va === vb ? 0 : (va > vb) !== !!d.lower ? 1 : 2;
        const show = (s, v) => (d.total ? `${d.total(s)} <span class="muted">${d.sub ? d.sub(s) : d.fmt(v) + "/G"}</span>` : d.fmt(v));
        return `<tr><td title="${esc(d.basis)}">${d.label}</td><td class="n">${better === 1 ? "<b>" + show(sa, va) + "</b>" : show(sa, va)}</td><td class="n">${better === 2 ? "<b>" + show(sb, vb) + "</b>" : show(sb, vb)}</td></tr>`; }).join("")}
      </tbody></table><div class="muted" style="font-size:12px;margin-top:6px">Bold = better of the two, judged on the per-game or rate figure.</div></div>
      <div class="card"><div class="chart-controls"><h2 style="margin:0">Trend</h2>${trendControls(metrics, metric, [2, 3, 4, 6], win).replace('id="metric"', 'id="cm"').replace('id="win"', 'id="cw"')}<span class="muted">x-axis = game number within the filtered set</span></div>
      <div class="legend"><span><i style="background:var(--series-1)"></i>${esc(nameA)}</span><span><i style="background:var(--series-2)"></i>${esc(nameB)}</span></div><div class="chart" id="ctrend"></div></div>`;
    const m = metrics[metric], s1 = metricSeries(fa, m, win), s2 = metricSeries(fb, m, win);
    const cnt = Math.max(fa.length, fb.length);
    lineChart($("#ctrend"), { series: [{ name: nameA, color: "var(--series-1)", values: s1.roll }, { name: nameB, color: "var(--series-2)", values: s2.roll }],
      xLabels: Array.from({ length: cnt }, (_, i) => `G${i + 1}`), yFmt: s1.yf, zeroBase: !String(metric).includes("epa"),
      tipHtml: i => `<b>Game ${i + 1} of filtered set</b>` + [[nameA, s1, fa], [nameB, s2, fb]].map(([nm, s, gs]) => `<div class="row"><span>${esc(nm)}</span><span>${s.yf(s.roll[i])}${gs[i] ? " · " + gs[i].season + " " + wkShort(gs[i]) : ""}</span></div>`).join("") });
    $("#cm").onchange = e => { metric = e.target.value; render(); };
    $("#cw").onchange = e => { win = +e.target.value; render(); };
  };
  $("#cbody").appendChild(filterBar(f, { seasons, opps, onChange: render, resultLabel: isTeam ? "Result" : "Team result" }));
  $("#cbody").appendChild(body);
  render();
}

// ------------------------------------------------------------------ games & box score
async function pageGames(params) {
  const st = { season: +(params.get("season") || META.current_season), wk: params.get("wk") || "" };
  const render = async () => {
    const gl = objs(await load(`games/${st.season}.json`));
    const weeks = [...new Map(gl.map(g => [`${g.game_type}-${g.week}`, g])).values()].sort((a, b) => a.week - b.week);
    const key = g => `${g.game_type}-${g.week}`;
    if (!st.wk || !weeks.some(w => key(w) === st.wk)) {
      const lw = META.last_week;
      st.wk = lw && lw.season === st.season ? `${lw.type}-${lw.week}` : key([...weeks].reverse().find(w => gl.some(g => g.played && key(g) === key(w))) || weeks[0]);
    }
    const i = weeks.findIndex(w => key(w) === st.wk);
    const played = gl.filter(g => g.played);
    app.innerHTML = `<div class="head"><div><h1>Games</h1><div class="meta">${played.length} of ${gl.length} games played in ${st.season}</div></div></div>
      <div class="card filters"><label>Season<select id="gs">${[...META.seasons].reverse().map(s => `<option value="${s}" ${s === st.season ? "selected" : ""}>${s}</option>`).join("")}</select></label>
      <label>Week<select id="gw">${weeks.map(w => `<option value="${key(w)}" ${key(w) === st.wk ? "selected" : ""}>${weekLabel(w)}</option>`).join("")}</select></label>
      <button class="btn" id="prev" ${i <= 0 ? "disabled" : ""}>← Previous week</button><button class="btn" id="next" ${i >= weeks.length - 1 ? "disabled" : ""}>Next week →</button></div>
      <div class="card"><h2>${i >= 0 ? weekLabel(weeks[i]) : ""}</h2><div class="games-list">${gl.filter(g => key(g) === st.wk).map(gameCard).join("") || '<div class="empty">No games.</div>'}</div></div>
      <div class="card"><h2>All results</h2><div id="all"></div></div>`;
    $("#gs").onchange = e => { st.season = +e.target.value; st.wk = ""; render(); };
    $("#gw").onchange = e => { st.wk = e.target.value; render(); };
    $("#prev").onclick = () => { st.wk = key(weeks[i - 1]); render(); };
    $("#next").onclick = () => { st.wk = key(weeks[i + 1]); render(); };
    sortTable($("#all"), played, [{ k: "game_date", label: "Date", html: r => `<a href="#/game/${r.game_id}">${shortDate(r.game_date)}</a>`, sortVal: r => r.game_date, csv: r => r.game_date },
      { k: "week", label: "Week", val: r => wkShort(r), sortVal: r => r.week }, { k: "away_team", label: "Away", html: r => teamLink(r.away_team) }, { k: "away_score", label: "", n: 1 },
      { k: "home_team", label: "Home", html: r => teamLink(r.home_team) }, { k: "home_score", label: "", n: 1 }, { k: "overtime", label: "OT", fmt: v => (v ? "OT" : "") },
      { k: "line", label: "Line", val: r => lineStr(r) }, { k: "total_line", label: "O/U", n: 1 },
      { k: "total", label: "Total pts", n: 1, val: r => r.away_score + r.home_score }, { k: "margin", label: "Margin", n: 1, val: r => Math.abs(r.home_score - r.away_score) },
      { k: "weather", label: "Weather", val: r => (indoors(r) ? "Indoors" : r.temp == null ? "–" : `${r.temp}°${r.wind ? `, wind ${r.wind}` : ""}`), sortVal: r => r.temp }],
    { sortKey: "game_date", limit: 300, csvName: `games-${st.season}` });
  };
  render();
}

async function pageBox(id) {
  const d = await load(`box/${id}.json`);
  const g = d.game, pl = objs(d.players);
  const tm = Object.fromEntries(d.teams.map(t => [t.team, t]));
  const A = tm[g.away] || {}, H = tm[g.home] || {};
  const row = (label, fn) => `<tr><td class="n">${fn(A)}</td><td style="text-align:center" class="sec">${label}</td><td class="n">${fn(H)}</td></tr>`;
  const homeLine = g.spread == null ? null : g.spread;
  const atsTxt = homeLine == null ? "" : (() => { const m = g.home_score - g.away_score - homeLine; return m === 0 ? "Push" : `${m > 0 ? g.home : g.away} covered`; })();
  app.innerHTML = h`
    <div class="head"><div><h1>${teamLink(g.away)} ${g.away_score} <span class="muted">@</span> ${teamLink(g.home)} ${g.home_score}</h1>
      <div class="meta">${fmtDate(g.date)} · ${g.season} ${weekLabel(g)} · Final${g.overtime ? "/OT" : ""}${g.stadium ? " · " + esc(g.stadium) : ""}${g.temp != null && !["dome", "closed"].includes(g.roof) ? ` · ${g.temp}°F${g.wind ? ", wind " + g.wind + " mph" : ""}` : ""}</div>
      ${homeLine != null ? `<div class="meta">Line: ${lineStr({ spread_line: homeLine, home_team: g.home, away_team: g.away })} (${atsTxt}) · O/U ${g.total ?? "–"} (${g.home_score + g.away_score > g.total ? "over" : g.home_score + g.away_score < g.total ? "under" : "push"})</div>` : ""}</div></div>
    <div class="grid2"><div class="card"><h2>Team stats</h2><table><thead><tr><th class="n">${esc(g.away)}</th><th></th><th class="n">${esc(g.home)}</th></tr></thead><tbody>
      ${row("Total yards", t => t.yards ?? "–")}${row("Plays", t => t.plays ?? "–")}${row("Yards per play", t => fmt(div(t.yards, t.plays), 1))}
      ${row("EPA per play", t => fs2(div(t.epa, t.plays)))}${row("First downs", t => t.first_downs ?? "–")}
      ${row("Passing (net)", t => `${t.completions}/${t.pass_att}, ${t.net_pass_yds}`)}${row("Pass TD / INT", t => `${t.pass_td} / ${t.ints}`)}${row("Sacked", t => `${t.sacks_taken} (${Math.abs(t.sack_yds)} yds)`)}
      ${row("Rushing", t => `${t.carries}-${t.rush_yds}`)}${row("Rush TD", t => t.rush_td)}${row("20+ yd plays", t => t.pass_20p + t.rush_20p)}
      ${row("Turnovers", t => t.turnovers)}${row("Penalties", t => `${t.penalties}-${t.penalty_yds}`)}${row("Field goals", t => `${t.fg_made}/${t.fg_att}`)}${row("Rest days", t => t.rest_days ?? "–")}
      </tbody></table></div>
      <div class="card"><h2>Fantasy (PPR) leaders</h2><div id="fan"></div></div></div>
    <div class="grid2"><div class="card box-section"><h2>${esc(teamName(g.away))}</h2><div id="ba"></div></div><div class="card box-section"><h2>${esc(teamName(g.home))}</h2><div id="bh"></div></div></div>`;
  sortTable($("#fan"), pl.filter(p => p.fantasy_points_ppr > 0).slice(0), [{ k: "name", label: "Player", html: r => playerLink(r.id, r.name) }, { k: "pos", label: "Pos" }, { k: "team", label: "Team" },
    { k: "fantasy_points_ppr", label: "PPR", n: 1, fmt: f1 }], { sortKey: "fantasy_points_ppr", limit: 10 });
  const sect = (el, team) => {
    const ps = pl.filter(p => p.team === team);
    const parts = [
      ["Passing", ps.filter(p => p.attempts > 0), [["completions", "Cmp"], ["attempts", "Att"], ["passing_yards", "Yds"], ["passing_tds", "TD"], ["passing_interceptions", "Int"], ["sacks_suffered", "Sk"], ["passing_epa", "EPA", v => fmtSigned(v, 1)]]],
      ["Rushing", ps.filter(p => p.carries > 0), [["carries", "Car"], ["rushing_yards", "Yds"], ["ypc", "Avg", null, r => fmt(div(r.rushing_yards, r.carries), 1)], ["rushing_tds", "TD"], ["rushing_fumbles_lost", "FL"]]],
      ["Receiving", ps.filter(p => p.targets > 0), [["targets", "Tgt"], ["receptions", "Rec"], ["receiving_yards", "Yds"], ["receiving_tds", "TD"], ["receiving_yards_after_catch", "YAC"]]],
      ["Defense", ps.filter(p => (p.def_tackles_solo || 0) + (p.def_tackle_assists || 0) + (p.def_sacks || 0) + (p.def_pass_defended || 0) > 0), [["tkl", "Tkl", null, r => (r.def_tackles_solo || 0) + (r.def_tackle_assists || 0)], ["def_tackles_for_loss", "TFL"], ["def_sacks", "Sk"], ["def_qb_hits", "QBH"], ["def_interceptions", "Int"], ["def_pass_defended", "PD"], ["def_fumbles_forced", "FF"]]],
      ["Kicking & punting", ps.filter(p => p.fg_att + p.pat_att + p.pt_att > 0), [["fg", "FG", null, r => `${r.fg_made}/${r.fg_att}`], ["fg_long", "Long"], ["xp", "XP", null, r => `${r.pat_made}/${r.pat_att}`], ["pt_att", "Punts"], ["pt_yards", "Punt yds"], ["pt_inside_20", "In 20"]]],
    ].filter(p => p[1].length);
    el.innerHTML = parts.map((_, i) => `<h3>${parts[i][0]}</h3><div id="${el.id}-${i}"></div>`).join("");
    parts.forEach(([, rows, cols], i) => sortTable($(`#${el.id}-${i}`), rows, [{ k: "name", label: "Player", html: r => playerLink(r.id, r.name) },
      ...cols.map(([k, label, fm, fn]) => ({ k, label, n: 1, val: fn || (r => r[k] ?? 0), fmt: fm || (v => (typeof v === "number" ? fmt(v, Number.isInteger(v) ? 0 : 1) : v)) }))], { sortKey: cols[0][0], full: true }));
  };
  sect($("#ba"), g.away); sect($("#bh"), g.home);
}

// ------------------------------------------------------------------ search
function matches(q, limit = 12) {
  q = q.trim().toLowerCase(); if (!q) return [];
  const teams = TEAMS.filter(t => t.current && (t.abbrev.toLowerCase() === q || (t.name || "").toLowerCase().includes(q))).map(t => ({ href: `#/team/${t.abbrev}`, label: t.name || t.abbrev, sub: "Team", val: t.abbrev }));
  const ps = INDEX.filter(p => p.name && p.name.toLowerCase().includes(q))
    .sort((a, b) => (b.last_game > a.last_game ? 1 : -1) || b.gp - a.gp)
    .slice(0, limit).map(p => ({ href: `#/player/${p.id}`, label: p.name, sub: `${p.pos || ""} · ${p.team || ""}`, val: p.id }));
  return [...teams.slice(0, 4), ...ps].slice(0, limit);
}
function wireSearch(input, box, { teamsOnly = false, onPick } = {}) {
  let hl = -1, items = [];
  const draw = () => {
    items = matches(input.value).filter(m => !teamsOnly || m.sub === "Team");
    if (onPick && !teamsOnly) items = items.filter(m => m.sub !== "Team");
    box.hidden = !items.length;
    box.innerHTML = items.map((m, i) => `<a href="${m.href}" data-i="${i}" class="${i === hl ? "hl" : ""}"><span>${esc(m.label)}</span><span class="muted">${esc(m.sub)}</span></a>`).join("");
    box.querySelectorAll("a").forEach(a => a.onmousedown = e => { if (onPick) { e.preventDefault(); pick(+a.dataset.i); } });
  };
  const pick = i => { const m = items[i]; if (!m) return; box.hidden = true; if (onPick) { input.value = m.label; onPick(m.val); } else { location.hash = m.href; input.value = ""; } };
  input.addEventListener("input", () => { hl = -1; draw(); });
  input.addEventListener("keydown", e => {
    if (e.key === "ArrowDown") { hl = Math.min(items.length - 1, hl + 1); draw(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { hl = Math.max(0, hl - 1); draw(); e.preventDefault(); }
    else if (e.key === "Enter") { pick(hl < 0 ? 0 : hl); }
    else if (e.key === "Escape") box.hidden = true;
  });
  input.addEventListener("blur", () => setTimeout(() => (box.hidden = true), 150));
}
function attachPicker(input, teams, onPick) { wireSearch(input, input.nextElementSibling, { teamsOnly: teams, onPick }); }

// ------------------------------------------------------------------ router
async function route() {
  hideTip();
  const [path, query] = location.hash.slice(1).split("?");
  const parts = (path || "/").split("/").filter(Boolean);
  const params = new URLSearchParams(query || "");
  document.querySelectorAll("[data-nav]").forEach(a => a.classList.toggle("active", a.dataset.nav === (parts[0] || "home")));
  app.innerHTML = '<div class="loading">Loading…</div>';
  scrollTo(0, 0);
  try {
    if (!parts.length) await pageHome();
    else if (parts[0] === "player") await pagePlayer(decodeURIComponent(parts[1]));
    else if (parts[0] === "team") await pageTeam(parts[1]);
    else if (parts[0] === "screener") await pageScreener(params);
    else if (parts[0] === "compare") await pageCompare(params);
    else if (parts[0] === "games") await pageGames(params);
    else if (parts[0] === "trends") await pageTrends(params);
    else if (parts[0] === "game") await pageBox(parts[1]);
    else app.innerHTML = '<div class="empty">Page not found.</div>';
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="card empty">Couldn't load this page (${esc(e.message)}).</div>`;
  }
}

async function init() {
  const saved = (() => { try { return localStorage.getItem("theme"); } catch { return null; } })();
  if (saved) document.documentElement.dataset.theme = saved;
  $("#theme").onclick = () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch { }
    document.querySelectorAll(".chart").forEach(c => c._redraw && c._redraw());
  };
  try {
    [META, TEAMS] = await Promise.all([load("meta.json"), load("teams.json")]);
    INDEX = objs(await load("players.json"));
  } catch (e) {
    app.innerHTML = `<div class="card empty">No data yet. Run the "Update data" workflow first (${esc(e.message)}).</div>`;
    return;
  }
  TEAM_BY = Object.fromEntries(TEAMS.map(t => [t.abbrev, t]));
  TEAMS.sort((a, b) => a.abbrev.localeCompare(b.abbrev));
  $("#updated").textContent = `Data through ${META.last_game ? fmtDate(META.last_game) : "–"} · refreshed ${new Date(META.updated_at).toLocaleString()}`;
  wireSearch($("#search"), $("#search-results"));
  addEventListener("hashchange", route);
  route();
}
init();
