/* Data Pulse — Age & Sex dashboard (ACS S0101). Plain JS + D3, no build step. */
(() => {
  "use strict";

  const DEFAULT_YEAR = 2024;
  const MAP_URL = "https://cdn.jsdelivr.net/npm/us-atlas@3.0.1/states-albers-10m.json";
  const AGE_ROWS = d3.range(2, 20).map(n => String(n).padStart(3, "0")); // 002..019 five-year bands

  const fmtInt = d3.format(",");
  const fmt1 = d3.format(".1f");
  const fmtBig = n => n >= 1e6 ? `${fmt1(n / 1e6)}M` : fmtInt(n);

  const METRICS = [
    { id: "median",   label: "Median age",                 key: "C01_032", fmt: v => fmt1(v),       unit: " yrs", scheme: d3.interpolateYlOrBr },
    { id: "p65",      label: "% aged 65 and over",         key: "C02_030", fmt: v => fmt1(v) + "%", unit: "",     scheme: d3.interpolateOranges },
    { id: "p18",      label: "% under 18",                 key: "C02_022", fmt: v => fmt1(v) + "%", unit: "",     scheme: d3.interpolateGreens },
    { id: "p85",      label: "% aged 85 and over",         key: "C02_019", fmt: v => fmt1(v) + "%", unit: "",     scheme: d3.interpolatePurples },
    { id: "sexratio", label: "Men per 100 women",          key: "C01_033", fmt: v => fmt1(v),       unit: "",     diverging: 100 },
    { id: "olddep",   label: "Old-age dependency ratio",   key: "C01_035", fmt: v => fmt1(v),       unit: "",     scheme: d3.interpolateOrRd },
    { id: "childdep", label: "Child dependency ratio",     key: "C01_036", fmt: v => fmt1(v),       unit: "",     scheme: d3.interpolateBuGn },
    { id: "dep",      label: "Total age dependency ratio", key: "C01_034", fmt: v => fmt1(v),       unit: "",     scheme: d3.interpolateYlGnBu },
  ];
  const metricById = Object.fromEntries(METRICS.map(m => [m.id, m]));

  const state = { data: null, topo: null, year: DEFAULT_YEAR, metric: "median", selected: null, manifest: null };

  // ---------- helpers ----------
  const est = (g, k) => g?.v?.[k]?.[0] ?? null;
  const moe = (g, k) => g?.v?.[k]?.[1] ?? null;
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const $ = sel => document.querySelector(sel);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

  // Two ACS estimates differ significantly (90% level) if |a-b| > sqrt(moeA² + moeB²).
  const sigDiff = (a, ma, b, mb) => (ma == null || mb == null) ? true : Math.abs(a - b) > Math.hypot(ma, mb);

  const geos = () => Object.entries(state.data.states).map(([fips, g]) => ({ fips, ...g }));
  const shortName = n => n === "District of Columbia" ? "D.C." : n;

  function bandLabel(row) {
    const parts = state.data.labels[row] || [];
    const s = parts[parts.length - 1] || row;
    return s.replace("Under 5 years", "<5").replace(" years and over", "+").replace(" to ", "–").replace(" years", "");
  }

  // Share of the *total* population in each age band, by sex (so pyramids are comparable).
  function pyramidShares(g) {
    const total = est(g, "C01_001");
    return AGE_ROWS.map(r => ({
      row: r, band: bandLabel(r),
      male: (est(g, `C03_${r}`) ?? 0) / total * 100,
      female: (est(g, `C05_${r}`) ?? 0) / total * 100,
    }));
  }

  // ---------- URL state ----------
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    if (p.get("metric") && metricById[p.get("metric")]) state.metric = p.get("metric");
    if (p.get("year")) state.year = +p.get("year");
    if (p.get("state")) state.selected = p.get("state");
  }
  function writeHash() {
    const p = new URLSearchParams({ year: state.year, metric: state.metric });
    if (state.selected) p.set("state", state.selected);
    history.replaceState(null, "", "#" + p.toString());
  }

  // ---------- loading ----------
  async function loadJSON(url) {
    const r = await fetch(url, { cache: "no-cache" });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
  }

  async function init() {
    readHash();
    try {
      const [manifest, topo] = await Promise.all([loadJSON("data/manifest.json"), loadJSON(MAP_URL)]);
      state.manifest = manifest.s0101;
      state.topo = topo;
      const years = state.manifest.vintages || [DEFAULT_YEAR];
      if (!years.includes(state.year)) state.year = years.includes(DEFAULT_YEAR) ? DEFAULT_YEAR : Math.max(...years);
      const ysel = $("#year");
      ysel.innerHTML = years.slice().sort((a, b) => b - a).map(y => `<option value="${y}">${y}</option>`).join("");
      ysel.value = state.year;
      ysel.addEventListener("change", () => loadYear(+ysel.value));

      const msel = $("#metric");
      msel.innerHTML = METRICS.map(m => `<option value="${m.id}">${m.label}</option>`).join("");
      msel.value = state.metric;
      msel.addEventListener("change", () => { state.metric = msel.value; writeHash(); renderMap(); renderRank(); });

      $("#clear-state").addEventListener("click", () => select(null));
      renderFreshness();
      await loadYear(state.year);
    } catch (err) {
      console.error(err);
      $("#kpis").innerHTML = `<div class="error">Couldn't load data (${err.message}). If you're running locally, start a server with <code>python3 -m http.server</code> and make sure <code>data/</code> has been fetched.</div>`;
    }
  }

  async function loadYear(year) {
    state.year = year;
    state.data = await loadJSON(`data/s0101/${year}.json`);
    if (state.selected && !state.data.states[state.selected]) state.selected = null;
    $("#vintage-label").textContent = `${year} 1-year estimates`;
    $("#source-link").href = state.data.source;
    writeHash();
    renderKPIs(); renderFacts(); renderMap(); renderRank(); renderDetail();
  }

  function renderFreshness() {
    const m = state.manifest;
    const d = s => s ? new Date(s).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";
    $("#freshness").innerHTML = `Checked <strong>${d(m.last_checked)}</strong> · data changed ${d(m.last_changed)}`;
    $("#freshness").title = `Last checked ${m.last_checked}\nLast changed ${m.last_changed}`;
  }

  // ---------- KPIs ----------
  const KPI_DEFS = [
    { label: "Population", key: "C01_001", fmt: v => fmtBig(v) },
    { label: "Median age", key: "C01_032", fmt: v => fmt1(v), suffix: " yrs" },
    { label: "Men per 100 women", key: "C01_033", fmt: v => fmt1(v) },
    { label: "Aged 65+", key: "C02_030", fmt: v => fmt1(v) + "%" },
    { label: "Under 18", key: "C02_022", fmt: v => fmt1(v) + "%" },
    { label: "Old-age dependency", key: "C01_035", fmt: v => fmt1(v), note: "65+ per 100 working-age" },
  ];

  function renderKPIs() {
    const us = state.data.us;
    const box = $("#kpis");
    box.innerHTML = "";
    for (const k of KPI_DEFS) {
      const v = est(us, k.key), m = moe(us, k.key);
      const c = el("div", "kpi card");
      c.innerHTML = `<div class="label">${k.label}</div>
        <div class="value">${v == null ? "—" : k.fmt(v)}<span class="muted">${k.suffix || ""}</span></div>
        <div class="moe">${m != null ? "± " + (k.key === "C01_001" ? fmtInt(m) : fmt1(m)) : (k.note || "Census-controlled total")}</div>`;
      if (k.note && m != null) c.title = k.note;
      box.append(c);
    }
  }

  // ---------- Facts ----------
  function renderFacts() {
    const all = geos();
    const us = state.data.us;
    const facts = [];
    const tieNote = (a, b, key) => sigDiff(est(a, key), moe(a, key), est(b, key), moe(b, key))
      ? "" : `<span class="tie">Statistically tied with ${b.name} (within margin of error)</span>`;
    const by = key => all.filter(g => est(g, key) != null).sort((a, b) => est(b, key) - est(a, key));

    // Oldest / youngest
    const ages = by("C01_032");
    if (ages.length > 1) {
      const [o1, o2] = ages, [y1, y2] = [ages.at(-1), ages.at(-2)];
      facts.push({ kicker: "Oldest", fips: o1.fips,
        headline: `${o1.name} has the oldest population`,
        body: `Median age ${fmt1(est(o1, "C01_032"))}, vs ${fmt1(est(us, "C01_032"))} for the US overall. Runner-up: ${o2.name} (${fmt1(est(o2, "C01_032"))}).`,
        extra: tieNote(o1, o2, "C01_032") });
      const youngestClear = sigDiff(est(y1, "C01_032"), moe(y1, "C01_032"), est(y2, "C01_032"), moe(y2, "C01_032"));
      facts.push({ kicker: "Youngest", fips: y1.fips,
        headline: youngestClear ? `${y1.name} is the youngest place in America` : `${y1.name} edges out ${y2.name} as the youngest`,
        body: `Median age ${fmt1(est(y1, "C01_032"))}, a gap of ${fmt1(est(o1, "C01_032") - est(y1, "C01_032"))} years from ${o1.name}. Next youngest: ${y2.name} (${fmt1(est(y2, "C01_032"))}).`,
        extra: tieNote(y1, y2, "C01_032") });
    }

    // Seniors outnumber children
    const flipped = all.filter(g => est(g, "C02_030") > est(g, "C02_022"))
      .sort((a, b) => (est(b, "C02_030") - est(b, "C02_022")) - (est(a, "C02_030") - est(a, "C02_022")));
    if (flipped.length) {
      const names = flipped.map(g => shortName(g.name));
      facts.push({ kicker: "A demographic tipping point", fips: flipped[0].fips,
        headline: `In ${flipped.length} ${flipped.length === 1 ? "place" : "places"}, people 65+ now outnumber children`,
        body: `${names.slice(0, 6).join(", ")}${names.length > 6 ? ` and ${names.length - 6} more` : ""}. Nationally, ${fmt1(est(us, "C02_030"))}% are 65+ and ${fmt1(est(us, "C02_022"))}% are under 18.` });
    } else {
      const closest = all.slice().sort((a, b) => (est(a, "C02_022") - est(a, "C02_030")) - (est(b, "C02_022") - est(b, "C02_030")))[0];
      facts.push({ kicker: "A demographic tipping point", fips: closest.fips,
        headline: `Children still outnumber seniors everywhere, but ${closest.name} is close`,
        body: `${fmt1(est(closest, "C02_030"))}% aged 65+ vs ${fmt1(est(closest, "C02_022"))}% under 18.` });
    }

    // Sex ratio extremes
    const sr = by("C01_033");
    if (sr.length > 1) {
      const m = sr[0], f = sr.at(-1);
      facts.push({ kicker: "Where the men (and women) are", fips: m.fips,
        headline: `${m.name}: ${fmt1(est(m, "C01_033"))} men per 100 women`,
        body: `The most male-skewed place, at the opposite end from ${f.name} (${fmt1(est(f, "C01_033"))}). The US overall: ${fmt1(est(us, "C01_033"))}.` });
    }

    // Women outlive men
    const m85 = est(us, "C03_019"), f85 = est(us, "C05_019"), m5 = est(us, "C03_002"), f5 = est(us, "C05_002");
    if (m85 && f85 && m5 && f5) {
      facts.push({ kicker: "The longevity gap",
        headline: `Among Americans 85+, there are ${Math.round(f85 / m85 * 100)} women for every 100 men`,
        body: `It starts the other way round: among children under 5, there are ${fmt1(m5 / f5 * 100)} boys for every 100 girls. The median woman is ${fmt1(est(us, "C05_032") - est(us, "C03_032"))} years older than the median man.` });
    }

    // Most unusual pyramid
    const usShares = pyramidShares(us);
    const scored = all.map(g => {
      const s = pyramidShares(g);
      let total = 0, biggest = null;
      s.forEach((b, i) => {
        const d = (b.male + b.female) - (usShares[i].male + usShares[i].female);
        total += Math.abs(b.male - usShares[i].male) + Math.abs(b.female - usShares[i].female);
        if (!biggest || Math.abs(d) > Math.abs(biggest.d)) biggest = { band: b.band, d };
      });
      return { g, total, biggest };
    }).sort((a, b) => b.total - a.total);
    if (scored.length) {
      const { g, total, biggest } = scored[0];
      facts.push({ kicker: "Least like the rest of America", fips: g.fips,
        headline: `${g.name}'s age profile looks least like the nation's`,
        body: `Its age-by-sex distribution differs from the US by ${fmt1(total)} percentage points in total. The biggest gap is ages ${biggest.band}: ${biggest.d > 0 ? "+" : ""}${fmt1(biggest.d)} pts. Click to see its pyramid.` });
    }

    const box = $("#facts");
    box.innerHTML = "";
    for (const f of facts) {
      const c = el("article", "fact card", `<div class="kicker">${f.kicker}</div><div class="headline">${f.headline}</div><p>${f.body}</p>${f.extra || ""}`);
      if (f.fips) {
        c.style.cursor = "pointer"; c.tabIndex = 0;
        const go = () => { select(f.fips); $(".detail").scrollIntoView({ behavior: "smooth", block: "start" }); };
        c.addEventListener("click", go);
        c.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
      }
      box.append(c);
    }
  }

  // ---------- Map ----------
  function colorScale(metric, values) {
    const [lo, hi] = d3.extent(values);
    if (metric.diverging != null) {
      const c = metric.diverging, span = Math.max(hi - c, c - lo);
      return d3.scaleDiverging(d3.interpolateRgbBasis([css("--female"), css("--map-empty"), css("--male")]))
        .domain([c - span, c, c + span]);
    }
    return d3.scaleSequential(metric.scheme).domain([lo, hi]);
  }

  function renderMap() {
    const metric = metricById[state.metric];
    const data = state.data.states;
    const values = Object.values(data).map(g => est(g, metric.key)).filter(v => v != null);
    const color = colorScale(metric, values);
    const features = topojson.feature(state.topo, state.topo.objects.states).features;
    const path = d3.geoPath();

    const root = d3.select("#map");
    let svg = root.select("svg");
    if (svg.empty()) {
      svg = root.append("svg").attr("viewBox", "0 0 975 610");
      svg.append("g").attr("class", "states");
    }
    svg.select("g.states").selectAll("path.state")
      .data(features, f => f.id)
      .join(enter => enter.append("path").attr("class", "state").attr("d", path)
        .on("mousemove", (ev, f) => showTip(ev, f.id))
        .on("mouseenter", (ev, f) => highlight(f.id))
        .on("mouseleave", () => { hideTip(); highlight(null); })
        .on("click", (ev, f) => select(f.id === state.selected ? null : f.id)))
      .classed("selected", f => f.id === state.selected)
      .transition().duration(400)
      .attr("fill", f => { const v = est(data[f.id], metric.key); return v == null ? css("--map-empty") : color(v); });

    // legend
    const [lo, hi] = color.domain().length === 3 ? [color.domain()[0], color.domain()[2]] : color.domain();
    const stops = d3.range(0, 1.01, 0.1).map(t => color(lo + t * (hi - lo))).join(",");
    $("#legend").innerHTML = `<span>${metric.fmt(lo)}</span><span class="bar" style="background:linear-gradient(90deg,${stops})"></span><span>${metric.fmt(hi)}</span>
      ${data["72"] ? '<span class="muted" style="margin-left:auto">Puerto Rico is shown in the ranking</span>' : ""}`;
  }

  function highlight(fips) {
    d3.selectAll("#map path.state").classed("hl", f => f.id === fips);
    document.querySelectorAll("#rank-list li").forEach(li => li.classList.toggle("hl", li.dataset.fips === fips));
  }

  // ---------- Tooltip ----------
  const tip = () => $("#tooltip");
  function showTip(ev, fips) {
    const g = state.data.states[fips];
    if (!g) return;
    const metric = metricById[state.metric];
    const v = est(g, metric.key), m = moe(g, metric.key);
    const ranked = rankList();
    const rank = ranked.findIndex(x => x.fips === fips) + 1;
    tip().innerHTML = `<b>${g.name}</b><br>${metric.label}: ${v == null ? "n/a" : metric.fmt(v) + metric.unit}${m != null ? ` <span style="opacity:.7">± ${fmt1(m)}</span>` : ""}<br>
      <span style="opacity:.7">Rank ${rank} of ${ranked.length} · pop. ${fmtBig(est(g, "C01_001"))}</span>`;
    tip().hidden = false;
    const x = Math.min(ev.clientX + 14, window.innerWidth - 270);
    tip().style.left = x + "px";
    tip().style.top = (ev.clientY + 14) + "px";
  }
  function hideTip() { tip().hidden = true; }

  // ---------- Ranking ----------
  function rankList() {
    const key = metricById[state.metric].key;
    return geos().filter(g => est(g, key) != null).sort((a, b) => est(b, key) - est(a, key));
  }

  function renderRank() {
    const metric = metricById[state.metric];
    const ranked = rankList();
    const values = ranked.map(g => est(g, metric.key));
    const color = colorScale(metric, values);
    const [lo, hi] = d3.extent(values);
    const usVal = est(state.data.us, metric.key);
    $("#rank-title").textContent = metric.label;
    const list = $("#rank-list");
    list.innerHTML = "";
    let usPlaced = false;
    const addUS = () => {
      if (usPlaced || usVal == null) return;
      const li = el("li", "us", `<span class="nm">United States</span><span class="val">${metric.fmt(usVal)}</span>`);
      li.style.counterIncrement = "none";
      li.dataset.fips = "";
      li.addEventListener("click", () => select(null));
      list.append(li);
      usPlaced = true;
    };
    for (const g of ranked) {
      const v = est(g, metric.key);
      if (v < usVal) addUS();
      const w = hi === lo ? 100 : 15 + 85 * (v - lo) / (hi - lo);
      const li = el("li", g.fips === state.selected ? "selected" : "",
        `<span class="nm">${g.name}<span class="bar" style="width:${w}%;background:${color(v)}"></span></span><span class="val" title="± ${moe(g, metric.key) ?? "n/a"}">${metric.fmt(v)}</span>`);
      li.dataset.fips = g.fips;
      li.tabIndex = 0;
      li.addEventListener("click", () => select(g.fips === state.selected ? null : g.fips));
      li.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(g.fips); } });
      li.addEventListener("mouseenter", () => highlight(g.fips));
      li.addEventListener("mouseleave", () => highlight(null));
      list.append(li);
    }
    addUS();
    const sel = list.querySelector("li.selected");
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }

  // ---------- Selection + detail ----------
  function select(fips) {
    state.selected = fips || null;
    writeHash();
    d3.selectAll("#map path.state").classed("selected", f => f.id === state.selected);
    document.querySelectorAll("#rank-list li").forEach(li => li.classList.toggle("selected", li.dataset.fips === state.selected));
    renderDetail();
  }

  function renderDetail() {
    const us = state.data.us;
    const g = state.selected ? state.data.states[state.selected] : null;
    $("#clear-state").hidden = !g;
    $("#detail-h").textContent = g ? `${g.name} vs the United States` : "Population pyramid: United States";
    drawPyramid(g ? pyramidShares(g) : pyramidShares(us), g ? pyramidShares(us) : null, g ? g.name : "United States");

    const box = $("#state-kpis");
    const subject = g || us;
    const rows = [
      ["Population", "C01_001", v => fmtInt(v), false],
      ["Median age", "C01_032", v => fmt1(v), true],
      ["Men per 100 women", "C01_033", v => fmt1(v), true],
      ["Under 18", "C02_022", v => fmt1(v) + "%", true],
      ["Aged 65+", "C02_030", v => fmt1(v) + "%", true],
      ["Aged 85+", "C02_019", v => fmt1(v) + "%", true],
      ["Old-age dependency", "C01_035", v => fmt1(v), true],
      ["Child dependency", "C01_036", v => fmt1(v), true],
    ];
    box.innerHTML = rows.map(([label, key, f, cmp]) => {
      const v = est(subject, key);
      let delta = "";
      if (g && cmp && v != null) {
        const d = v - est(us, key);
        const sig = sigDiff(v, moe(subject, key), est(us, key), moe(us, key));
        delta = `<span class="delta" title="${sig ? "Statistically significant at 90%" : "Not statistically different from US"}">${d >= 0 ? "+" : ""}${fmt1(d)}${sig ? "" : "*"}</span>`;
      }
      return `<div class="row"><span>${label}</span><span>${v == null ? "—" : f(v)}${delta}</span></div>`;
    }).join("") + (g ? `<p class="muted">Differences are compared with the US. * = within margin of error.</p>` : "");
  }

  function drawPyramid(main, overlay, name) {
    const W = 760, rowH = 24, M = { top: 34, right: 16, bottom: 30, left: 16 }, mid = 56;
    const H = M.top + M.bottom + rowH * main.length;
    const half = (W - M.left - M.right - mid) / 2;
    const maxV = d3.max([...main, ...(overlay || [])], d => Math.max(d.male, d.female)) * 1.08;
    const x = d3.scaleLinear().domain([0, maxV]).range([0, half]);
    const y = d3.scaleBand().domain(main.map(d => d.band).reverse()).range([M.top, H - M.bottom]).padding(0.18);
    const cxL = M.left + half, cxR = cxL + mid;

    const root = d3.select("#pyramid");
    root.selectAll("*").remove();
    const svg = root.append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("role", "img")
      .attr("aria-label", `Population pyramid for ${name}`);

    const ticks = x.ticks(4);
    const grid = svg.append("g").attr("class", "grid");
    for (const t of ticks) {
      for (const xx of [cxL - x(t), cxR + x(t)]) {
        grid.append("line").attr("x1", xx).attr("x2", xx).attr("y1", M.top).attr("y2", H - M.bottom);
        grid.append("text").attr("x", xx).attr("y", H - M.bottom + 16).attr("text-anchor", "middle").text(`${t}%`);
      }
    }
    svg.append("text").attr("class", "axis-label").attr("x", cxL).attr("y", 16).attr("text-anchor", "end").attr("fill", css("--male")).text("Male ←");
    svg.append("text").attr("class", "axis-label").attr("x", cxR).attr("y", 16).text("→ Female");

    const rows = svg.append("g").selectAll("g").data(main).join("g");
    rows.append("rect").attr("y", d => y(d.band)).attr("height", y.bandwidth()).attr("rx", 2)
      .attr("x", cxL).attr("width", 0).attr("fill", css("--male")).attr("opacity", .85)
      .transition().duration(500).attr("x", d => cxL - x(d.male)).attr("width", d => x(d.male));
    rows.append("rect").attr("y", d => y(d.band)).attr("height", y.bandwidth()).attr("rx", 2)
      .attr("x", cxR).attr("width", 0).attr("fill", css("--female")).attr("opacity", .85)
      .transition().duration(500).attr("width", d => x(d.female));
    rows.append("text").attr("x", (cxL + cxR) / 2).attr("y", d => y(d.band) + y.bandwidth() / 2).attr("dy", "0.35em")
      .attr("text-anchor", "middle").text(d => d.band);

    rows.append("title").text(d => `${name}, ages ${d.band}: men ${fmt1(d.male)}%, women ${fmt1(d.female)}% of population`);

    if (overlay) {
      const line = (side) => {
        const pts = [];
        for (const d of overlay) {
          const xv = side === "m" ? cxL - x(d.male) : cxR + x(d.female);
          pts.push([xv, y(d.band)], [xv, y(d.band) + y.bandwidth()]);
        }
        return d3.line()(pts.sort((a, b) => a[1] - b[1]));
      };
      for (const s of ["m", "f"]) {
        svg.append("path").attr("d", line(s)).attr("fill", "none").attr("stroke", css("--us-outline"))
          .attr("stroke-width", 1.75).attr("stroke-dasharray", "4 3");
      }
    }

    const keys = d3.select("#pyramid").append("div").attr("class", "legend-keys");
    keys.html(`<span><i style="background:${css("--male")}"></i>${name} men</span><span><i style="background:${css("--female")}"></i>${name} women</span>` +
      (overlay ? `<span><i style="border:2px dashed ${css("--us-outline")};background:none"></i>United States</span>` : ""));
  }

  // Re-render colors when the OS theme flips.
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (state.data) { renderMap(); renderRank(); renderDetail(); }
  });

  init();
})();
