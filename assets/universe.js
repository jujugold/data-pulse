/* America in Dots — every dot is N real Americans (ACS S0101), drawn with raw WebGL2. */
(() => {
  "use strict";

  const DEFAULT_YEAR = 2024;
  const MAP_URL = "https://cdn.jsdelivr.net/npm/us-atlas@3.0.1/states-albers-10m.json";
  const NB = 18; // five-year age bands: <5 … 85+
  const BAND_LABEL = ["<5", "5–9", "10–14", "15–19", "20–24", "25–29", "30–34", "35–39", "40–44", "45–49",
    "50–54", "55–59", "60–64", "65–69", "70–74", "75–79", "80–84", "85+"];
  const ABBR = { "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE", "11": "DC", "12": "FL",
    "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY", "22": "LA", "23": "ME", "24": "MD",
    "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM",
    "36": "NY", "37": "NC", "38": "ND", "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD", "47": "TN",
    "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI", "56": "WY", "72": "PR" };
  const PR_CENTER = [910, 560], PR_RX = 36, PR_RY = 11; // Puerto Rico isn't in the albers atlas; drawn as an inset

  const SMALL = Math.min(innerWidth, innerHeight) < 700 || (navigator.deviceMemory && navigator.deviceMemory <= 4);
  const PER_DOT = SMALL ? 4000 : 1000;
  const SPACING = Math.sqrt(PER_DOT / 1000); // world units between dots in packed layouts
  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const DPR = Math.min(devicePixelRatio || 1, 2);

  const SCENES = [
    { id: "map", name: "America", mode: 2 },
    { id: "pyramid", name: "One pyramid", mode: 0 },
    { id: "spectrum", name: "Youngest → oldest", mode: 0 },
    { id: "cells", name: "States as cells", mode: 0 },
    { id: "split", name: "Men | Women", mode: 1 },
  ];

  const $ = s => document.querySelector(s);
  const fmt = d3.format(",");
  const fmt1 = d3.format(".1f");
  const big = n => n >= 1e6 ? fmt1(n / 1e6) + "M" : fmt(Math.round(n));
  const est = (g, k) => g?.v?.[k]?.[0] ?? null;
  const rand = mulberry32(20240101);
  function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  // ---------------------------------------------------------------- state
  const S = {
    data: null, states: [], us: null, N: 0,
    stateOf: null, bandOf: null, sexOf: null, seed: null, groups: new Map(),
    layouts: {}, scene: 0, colorMode: 2, userMode: false,
    from: null, to: null, t: 1, morphStart: 0, morphDur: 2400, spin: 0, spinVel: 0,
    cam: { x: 500, y: 320, z: 1 }, camT: { x: 500, y: 320, z: 1 }, userCam: false,
    hiState: -1, you: -1, dim: 0, dimT: 0, raster: null, intro: true,
  };

  // ---------------------------------------------------------------- boot
  async function boot() {
    const canvas = $("#gl");
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, premultipliedAlpha: false });
    if (!gl) { $("#fallback").hidden = false; return; }

    const manifest = await (await fetch("data/manifest.json", { cache: "no-cache" })).json();
    const m = manifest.s0101;
    const years = m.vintages || [DEFAULT_YEAR];
    const year = years.includes(DEFAULT_YEAR) ? DEFAULT_YEAR : Math.max(...years);
    const [data, topo] = await Promise.all([
      fetch(`data/s0101/${year}.json`, { cache: "no-cache" }).then(r => r.json()),
      fetch(MAP_URL).then(r => r.json()),
    ]);
    S.data = data;
    $("#year").textContent = year;
    $("#per-dot").textContent = fmt(PER_DOT);
    $("#fresh").textContent = "checked " + new Date(m.last_checked).toLocaleDateString(undefined, { month: "short", day: "numeric" });

    buildStates(data);
    buildParticles();
    const features = topojson.feature(topo, topo.objects.states).features;
    S.layouts.galaxy = layoutGalaxy();
    S.layouts.map = layoutMap(features);
    S.layouts.pyramid = layoutPyramid();
    S.layouts.spectrum = layoutSpectrum();
    S.layouts.cells = layoutCells(features);
    S.layouts.split = layoutSplit();

    initGL(gl, canvas);
    initUI();
    readHash();
    startIntro();
  }

  // ---------------------------------------------------------------- data → particles
  function buildStates(data) {
    const us = data.us;
    const counts = g => [0, 1].map(sex => d3.range(NB).map(b => est(g, `${sex ? "C05" : "C03"}_${String(b + 2).padStart(3, "0")}`) || 0));
    S.us = { name: "United States", pop: est(us, "C01_001"), median: est(us, "C01_032"), counts: counts(us), g: us };
    S.states = Object.entries(data.states)
      .filter(([, g]) => est(g, "C01_001"))
      .map(([fips, g], idx) => ({ fips, idx, name: g.name, abbr: ABBR[fips] || fips, pop: est(g, "C01_001"),
        median: est(g, "C01_032"), sexRatio: est(g, "C01_033"), p65: est(g, "C02_030"), counts: counts(g), g }));
    const [lo, hi] = d3.extent(S.states, s => s.median);
    S.states.forEach(s => { s.medianT = (s.median - lo) / (hi - lo); });
    S.byFips = Object.fromEntries(S.states.map(s => [s.fips, s]));
  }

  function buildParticles() {
    const plan = [];
    for (const s of S.states) for (let sex = 0; sex < 2; sex++) for (let b = 0; b < NB; b++) {
      plan.push([s.idx, sex, b, Math.round(s.counts[sex][b] / PER_DOT)]);
    }
    const N = S.N = d3.sum(plan, p => p[3]);
    S.stateOf = new Uint8Array(N); S.sexOf = new Uint8Array(N); S.bandOf = new Uint8Array(N); S.seed = new Float32Array(N);
    let i = 0;
    for (const [st, sex, b, n] of plan) {
      S.groups.set(`${st}|${sex}|${b}`, [i, n]);
      for (let k = 0; k < n; k++, i++) { S.stateOf[i] = st; S.sexOf[i] = sex; S.bandOf[i] = b; S.seed[i] = rand(); }
    }
    S.byState = S.states.map(() => []);
    for (let j = 0; j < N; j++) S.byState[S.stateOf[j]].push(j);
  }

  // Each layout: { pos: Float32Array(2N), bbox:[x0,y0,x1,y1], labels:[{x,y,t,c}], hit(wx,wy) -> tooltip html|null, state(wx,wy) -> idx }
  function bboxOf(pos) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < pos.length; i += 2) {
      const x = pos[i], y = pos[i + 1];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return [x0, y0, x1, y1];
  }

  function layoutGalaxy() {
    const pos = new Float32Array(S.N * 2);
    for (let i = 0; i < S.N; i++) {
      const r = Math.pow(rand(), 0.6) * 330;
      const arm = (i % 4) * Math.PI / 2;
      const spread = (rand() - 0.5) * (0.9 - r / 600) + (rand() - 0.5) * 0.3;
      const th = arm + r * 0.018 + spread;
      pos[2 * i] = 500 + Math.cos(th) * r;
      pos[2 * i + 1] = 320 + Math.sin(th) * r * 0.62;
    }
    return { pos, bbox: [100, 60, 900, 580], labels: [] };
  }

  function layoutMap(features) {
    // Rasterise states with unique colours at 2× so every dot lands on real land in its own state.
    const K = 2, RW = 975 * K, RH = 610 * K;
    const cv = document.createElement("canvas"); cv.width = RW; cv.height = RH;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.scale(K, K);
    const path = d3.geoPath(null, ctx);
    S.centroid = {};
    const gp = d3.geoPath();
    for (const f of features) {
      const s = S.byFips[f.id];
      if (!s) continue;
      ctx.beginPath(); path(f); ctx.fillStyle = `rgb(${s.idx + 1},0,0)`; ctx.fill();
      S.centroid[s.idx] = gp.centroid(f);
    }
    const img = ctx.getImageData(0, 0, RW, RH).data;
    const raster = new Uint8Array(RW * RH);
    for (let p = 0; p < RW * RH; p++) if (img[4 * p + 3] === 255 && img[4 * p + 1] === 0) raster[p] = img[4 * p];
    S.raster = { data: raster, RW, RH, K };
    const pix = S.states.map(() => []);
    for (let y = 1; y < RH - 1; y++) for (let x = 1; x < RW - 1; x++) {
      const p = y * RW + x, v = raster[p];
      if (v && raster[p - 1] === v && raster[p + 1] === v && raster[p - RW] === v && raster[p + RW] === v) pix[v - 1].push(p);
    }
    const pr = S.byFips["72"];
    if (pr) S.centroid[pr.idx] = PR_CENTER;

    const pos = new Float32Array(S.N * 2);
    for (let i = 0; i < S.N; i++) {
      const st = S.stateOf[i], list = pix[st];
      let x, y;
      if (list.length > 8) {
        const p = list[(rand() * list.length) | 0];
        x = (p % RW + rand()) / K; y = (((p / RW) | 0) + rand()) / K;
      } else if (pr && st === pr.idx) {
        const a = rand() * Math.PI * 2, r = Math.sqrt(rand());
        x = PR_CENTER[0] + Math.cos(a) * r * PR_RX; y = PR_CENTER[1] + Math.sin(a) * r * PR_RY;
      } else { // tiny (DC): jitter around the centroid
        const c = S.centroid[st] || [500, 300], a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * 2.2;
        x = c[0] + Math.cos(a) * r; y = c[1] + Math.sin(a) * r;
      }
      pos[2 * i] = x; pos[2 * i + 1] = y;
    }
    S.mapPos = pos;
    const labels = pr ? [{ x: PR_CENTER[0], y: PR_CENTER[1] + 16, t: "Puerto Rico", c: "band" }] : [];
    return { pos, bbox: [0, 0, 975, 610], labels, state: (x, y) => mapStateAt(x, y) };
  }

  function mapStateAt(x, y) {
    const { data, RW, RH, K } = S.raster;
    const px = Math.floor(x * K), py = Math.floor(y * K);
    if (px >= 0 && py >= 0 && px < RW && py < RH && data[py * RW + px]) return data[py * RW + px] - 1;
    const pr = S.byFips["72"];
    if (pr && ((x - PR_CENTER[0]) / (PR_RX + 4)) ** 2 + ((y - PR_CENTER[1]) / (PR_RY + 4)) ** 2 <= 1) return pr.idx;
    const dc = S.byFips["11"];
    if (dc && S.centroid[dc.idx] && Math.hypot(x - S.centroid[dc.idx][0], y - S.centroid[dc.idx][1]) < 3) return dc.idx;
    return -1;
  }

  function layoutPyramid() {
    const groups = d3.range(NB).map(() => [[], []]);
    for (let i = 0; i < S.N; i++) groups[S.bandOf[i]][S.sexOf[i]].push(i);
    // within each band, younger states sit nearest the spine so "state median age" colouring forms gradients
    groups.forEach(g => g.forEach(list => list.sort((a, b) => S.states[S.stateOf[a]].median - S.states[S.stateOf[b]].median || S.seed[a] - S.seed[b])));
    const d = SPACING * 1.05, rowH = 30 * SPACING, inner = rowH - 3 * SPACING, perCol = Math.max(1, Math.floor(inner / d));
    const spine = 26 * SPACING;
    const pos = new Float32Array(S.N * 2);
    const labels = [];
    const H = rowH * NB;
    for (let b = 0; b < NB; b++) {
      const top = (NB - 1 - b) * rowH;
      for (let sex = 0; sex < 2; sex++) {
        groups[b][sex].forEach((i, k) => {
          const col = Math.floor(k / perCol), row = k % perCol;
          const dx = spine + (col + rand() * 0.5) * d;
          pos[2 * i] = sex === 0 ? -dx : dx;
          pos[2 * i + 1] = top + (row + rand() * 0.5) * d;
        });
      }
      labels.push({ x: 0, y: top + inner / 2, t: BAND_LABEL[b], c: "band" });
    }
    const half = d3.max(groups.flat(), l => Math.ceil(l.length / perCol)) * d + spine;
    labels.push({ x: -half * 0.55, y: -28 * SPACING, t: "Men", c: "h" }, { x: half * 0.55, y: -28 * SPACING, t: "Women", c: "h" });
    const bandTotals = d3.range(NB).map(b => S.us.counts[0][b] + S.us.counts[1][b]);
    return {
      pos, bbox: [-half, -45 * SPACING, half, H], labels,
      hit(x, y) {
        const b = NB - 1 - Math.floor(y / rowH);
        if (b < 0 || b >= NB || Math.abs(x) < spine * 0.6 || Math.abs(x) > half) return null;
        const sex = x < 0 ? 0 : 1, n = S.us.counts[sex][b];
        return `<b>${sex ? "Women" : "Men"} aged ${BAND_LABEL[b]}</b><br>${big(n)} people · ${fmt1(n / S.us.pop * 100)}% of the US<br>
          <span class="m">${fmt(Math.round(n / PER_DOT))} dots · ${sex ? "women" : "men"} are ${fmt1(n / bandTotals[b] * 100)}% of this age band</span>`;
      },
    };
  }

  function layoutSpectrum() {
    // Marimekko: one column per state, width ∝ population, sorted youngest → oldest, stacked young (bottom) → old (top).
    const order = S.states.slice().sort((a, b) => a.median - b.median);
    const H = 520, gap = 1.6;
    const areaPerDot = 1.25 * SPACING * SPACING;
    const usable = S.N * areaPerDot / H;
    const pos = new Float32Array(S.N * 2);
    const cols = [], labels = [];
    let x = 0;
    for (const s of order) {
      const list = S.byState[s.idx].slice().sort((a, b) => S.bandOf[a] - S.bandOf[b] || S.seed[a] - S.seed[b]);
      const w = list.length / S.N * usable;
      list.forEach((i, k) => {
        pos[2 * i] = x + rand() * w;
        pos[2 * i + 1] = H - (k + rand()) / list.length * H;
      });
      cols.push({ s, x0: x, x1: x + w });
      if (w > 9) labels.push({ x: x + w / 2, y: H + 12, t: s.abbr, c: "abbr" });
      if (w > 22) labels.push({ x: x + w / 2, y: -12, t: fmt1(s.median), c: "band" });
      x += w + gap;
    }
    labels.push({ x: 0, y: H + 34, t: "← youngest", c: "note" }, { x: x - gap, y: H + 34, t: "oldest →", c: "note" },
      { x: x / 2, y: -34, t: "median age", c: "band" });
    const find = (wx) => cols.find(c => wx >= c.x0 - gap / 2 && wx <= c.x1 + gap / 2);
    return {
      pos, bbox: [0, -50, x - gap, H + 45], labels,
      state: (wx, wy) => (wy >= 0 && wy <= H && find(wx)) ? find(wx).s.idx : -1,
      hit(wx, wy) {
        const c = (wy >= 0 && wy <= H) ? find(wx) : null;
        if (!c) return null;
        const s = c.s, total = s.pop, f = 1 - wy / H;
        let acc = 0, band = NB - 1;
        for (let b = 0; b < NB; b++) { acc += (s.counts[0][b] + s.counts[1][b]) / total; if (f <= acc) { band = b; break; } }
        return stateTip(s) + `<br><span class="m">Under the cursor: ages ${BAND_LABEL[band]} (${fmt1((s.counts[0][band] + s.counts[1][band]) / total * 100)}%)</span>`;
      },
    };
  }

  function layoutCells(features) {
    // Dorling cartogram: a circle per state near its real location, area ∝ population; dots spiral young (core) → old (rim).
    const a = 1.35 * SPACING * SPACING;
    const nodes = S.states.map(s => {
      const c = S.centroid[s.idx] || [500, 300];
      return { s, r: Math.sqrt(S.byState[s.idx].length * a / Math.PI), x: c[0], y: c[1], tx: c[0], ty: c[1] };
    });
    const sim = d3.forceSimulation(nodes)
      .force("x", d3.forceX(d => d.tx).strength(0.12))
      .force("y", d3.forceY(d => d.ty).strength(0.12))
      .force("collide", d3.forceCollide(d => d.r + 2.5).iterations(4))
      .stop();
    for (let k = 0; k < 400; k++) sim.tick();
    const pos = new Float32Array(S.N * 2);
    const labels = [];
    const GOLD = Math.PI * (3 - Math.sqrt(5));
    for (const nd of nodes) {
      const list = S.byState[nd.s.idx].slice().sort((p, q) => S.bandOf[p] - S.bandOf[q] || S.seed[p] - S.seed[q]);
      const n = list.length;
      list.forEach((i, k) => {
        const r = nd.r * Math.sqrt((k + 0.5) / n), th = k * GOLD;
        pos[2 * i] = nd.x + Math.cos(th) * r;
        pos[2 * i + 1] = nd.y + Math.sin(th) * r;
      });
      if (nd.r > 9) labels.push({ x: nd.x, y: nd.y - nd.r - 7, t: nd.s.abbr, c: "abbr" });
    }
    const at = (x, y) => nodes.find(nd => Math.hypot(x - nd.x, y - nd.y) <= nd.r + 1);
    return {
      pos, bbox: bboxOf(pos).map((v, i) => v + (i < 2 ? -22 : 10)), labels,
      state: (x, y) => at(x, y)?.s.idx ?? -1,
      hit(x, y) {
        const nd = at(x, y);
        if (!nd) return null;
        const f = Math.hypot(x - nd.x, y - nd.y) / nd.r;
        return stateTip(nd.s) + `<br><span class="m">${f > 0.8 ? "Rim = the oldest residents" : f < 0.35 ? "Core = the youngest residents" : "Young at the core, old at the rim"}</span>`;
      },
    };
  }

  function layoutSplit() {
    const OFF = 1060;
    const pos = new Float32Array(S.N * 2);
    for (let i = 0; i < S.N; i++) {
      pos[2 * i] = S.mapPos[2 * i] + (S.sexOf[i] ? OFF : 0);
      pos[2 * i + 1] = S.mapPos[2 * i + 1];
    }
    const men = d3.sum(S.us.counts[0]), women = d3.sum(S.us.counts[1]);
    return {
      pos, bbox: [0, -40, 975 + OFF, 610],
      labels: [{ x: 487, y: -20, t: `Men · ${big(men)}`, c: "h" }, { x: 487 + OFF, y: -20, t: `Women · ${big(women)}`, c: "h" }],
      state: (x, y) => mapStateAt(x >= OFF ? x - OFF : x, y),
      hit(x, y) {
        const st = mapStateAt(x >= OFF ? x - OFF : x, y);
        if (st < 0) return null;
        const s = S.states[st];
        return `<b>${s.name}</b><br>${fmt1(s.sexRatio)} men per 100 women<br><span class="m">${big(d3.sum(s.counts[0]))} men · ${big(d3.sum(s.counts[1]))} women</span>`;
      },
    };
  }

  function stateTip(s) {
    return `<b>${s.name}</b><br>${big(s.pop)} people · ${fmt(S.byState[s.idx].length)} dots<br>Median age ${fmt1(s.median)} · ${fmt1(s.p65)}% aged 65+`;
  }

  // ---------------------------------------------------------------- WebGL
  const VS = `#version 300 es
  precision highp float;
  in vec2 aFrom; in vec2 aTo; in vec4 aMeta; in float aState;
  uniform float uT, uSpin, uZoom, uTime, uSize, uHi, uDim, uAlpha;
  uniform vec2 uCam, uRes;
  uniform int uMode, uYou;
  out vec4 vColor; out float vYou;
  vec3 ramp(float t){
    vec3 c0=vec3(.13,.83,.93), c1=vec3(.36,.45,1.), c2=vec3(.68,.36,.98), c3=vec3(.98,.36,.62), c4=vec3(1.,.78,.18);
    t=clamp(t,0.,1.)*4.;
    if(t<1.) return mix(c0,c1,t); if(t<2.) return mix(c1,c2,t-1.); if(t<3.) return mix(c2,c3,t-2.); return mix(c3,c4,t-3.);
  }
  void main(){
    float seed=aMeta.w;
    float p=clamp((uT-seed*.35)/.65,0.,1.);
    float e=p<.5?4.*p*p*p:1.-pow(-2.*p+2.,3.)/2.;
    vec2 from=aFrom;
    if(uSpin!=0.){ vec2 c=vec2(500.,320.); vec2 r=from-c; float a=uSpin*(.45+90./(length(r)+50.)); float cs=cos(a), sn=sin(a); from=c+vec2(cs*r.x-sn*r.y, sn*r.x+cs*r.y); }
    vec2 d=aTo-from;
    vec2 pos=mix(from,aTo,e)+vec2(-d.y,d.x)*sin(3.14159*e)*(seed-.5)*.45;
    pos+=vec2(sin(uTime*.7+seed*61.),cos(uTime*.6+seed*47.))*.3;
    vec2 px=(pos-uCam)*uZoom;
    gl_Position=vec4(px.x/(uRes.x*.5),-px.y/(uRes.y*.5),0.,1.);
    vec3 col = uMode==0 ? ramp(aMeta.x) : uMode==1 ? (aMeta.y<.5?vec3(.33,.6,1.):vec3(1.,.36,.66)) : ramp(aMeta.z);
    float a=uAlpha, size=uSize;
    if(uHi>=0.){ bool on=abs(aState-uHi)<.5; a*=on?1.7:.28; }
    a*=mix(1.,.15,uDim);
    vYou=0.;
    if(gl_VertexID==uYou){ size=uSize*5.+10.; a=1.; col=vec3(1.,.95,.8); vYou=1.; }
    gl_PointSize=size;
    vColor=vec4(col,a);
  }`;
  const FS = `#version 300 es
  precision mediump float;
  in vec4 vColor; in float vYou; out vec4 o;
  void main(){
    float r=length(gl_PointCoord-.5)*2.;
    if(r>1.) discard;
    float f=vYou>.5 ? smoothstep(1.,.0,r)*1.4 : pow(1.-r,1.5);
    o=vec4(vColor.rgb*vColor.a*f,1.);
  }`;

  let gl, prog, U = {}, bufFrom, bufTo, canvas;
  function initGL(g, c) {
    gl = g; canvas = c;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    for (const n of ["uT", "uSpin", "uZoom", "uTime", "uSize", "uHi", "uDim", "uAlpha", "uCam", "uRes", "uMode", "uYou"]) U[n] = gl.getUniformLocation(prog, n);

    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const attr = (name, size, data, usage) => {
      const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, usage);
      const loc = gl.getAttribLocation(prog, name); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      return b;
    };
    const meta = new Float32Array(S.N * 4), st = new Float32Array(S.N);
    for (let i = 0; i < S.N; i++) {
      meta[4 * i] = S.bandOf[i] / (NB - 1); meta[4 * i + 1] = S.sexOf[i];
      meta[4 * i + 2] = S.states[S.stateOf[i]].medianT; meta[4 * i + 3] = S.seed[i];
      st[i] = S.stateOf[i];
    }
    attr("aMeta", 4, meta, gl.STATIC_DRAW);
    attr("aState", 1, st, gl.STATIC_DRAW);
    S.from = S.layouts.galaxy.pos.slice(); S.to = S.layouts.galaxy.pos.slice();
    bufFrom = attr("aFrom", 2, S.from, gl.DYNAMIC_DRAW);
    bufTo = attr("aTo", 2, S.to, gl.DYNAMIC_DRAW);

    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.clearColor(0.016, 0.02, 0.04, 1);
    addEventListener("resize", resize); resize();
    requestAnimationFrame(frame);
  }

  function resize() {
    canvas.width = Math.round(innerWidth * DPR); canvas.height = Math.round(innerHeight * DPR);
    gl.viewport(0, 0, canvas.width, canvas.height);
    if (!S.userCam) fitCamera(true);
  }

  const ease = p => p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  // CPU mirror of the vertex shader (minus shimmer) — used to start a morph mid-flight and to track the "you" dot.
  function currentPos(i, out) {
    const seed = S.seed[i];
    const p = Math.min(1, Math.max(0, (S.t - seed * .35) / .65)), e = ease(p);
    let fx = S.from[2 * i], fy = S.from[2 * i + 1];
    if (S.spin) {
      const rx = fx - 500, ry = fy - 320, a = S.spin * (.45 + 90 / (Math.hypot(rx, ry) + 50)), cs = Math.cos(a), sn = Math.sin(a);
      fx = 500 + cs * rx - sn * ry; fy = 320 + sn * rx + cs * ry;
    }
    const tx = S.to[2 * i], ty = S.to[2 * i + 1], dx = tx - fx, dy = ty - fy, arc = Math.sin(Math.PI * e) * (seed - .5) * .45;
    out[0] = fx + dx * e - dy * arc; out[1] = fy + dy * e + dx * arc;
    return out;
  }

  function morphTo(name, dur = 2400) {
    const target = S.layouts[name].pos;
    if (S.t < 1 || S.spin) {
      const tmp = [0, 0];
      for (let i = 0; i < S.N; i++) { currentPos(i, tmp); S.from[2 * i] = tmp[0]; S.from[2 * i + 1] = tmp[1]; }
    } else {
      S.from.set(S.to);
    }
    S.spin = 0; S.spinVel = 0;
    S.to.set(target);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufFrom); gl.bufferSubData(gl.ARRAY_BUFFER, 0, S.from);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufTo); gl.bufferSubData(gl.ARRAY_BUFFER, 0, S.to);
    S.t = REDUCED ? 1 : 0; S.morphStart = performance.now(); S.morphDur = dur;
    S.current = name;
    S.userCam = false;
    fitCamera(false);
    renderLabels();
  }

  // Fit the layout into the screen area not covered by the HUD.
  function fitCamera(instant) {
    const L = S.layouts[S.current || "galaxy"]; if (!L) return;
    const [x0, y0, x1, y1] = L.bbox;
    const top = innerWidth < 720 ? 185 : 100, bottom = innerWidth < 720 ? 215 : 150;
    const right = innerWidth >= 1100 ? 300 : 0;
    const aw = innerWidth - 40 - right, ah = innerHeight - top - bottom;
    const zCss = Math.min(aw / (x1 - x0), ah / (y1 - y0));
    const cxCss = 20 + aw / 2, cyCss = top + ah / 2;
    // camera centre in world so that bbox centre lands at (cxCss, cyCss)
    const z = zCss * DPR;
    S.camT = { z, x: (x0 + x1) / 2 - (cxCss - innerWidth / 2) / zCss, y: (y0 + y1) / 2 - (cyCss - innerHeight / 2) / zCss };
    if (instant || REDUCED) S.cam = { ...S.camT };
  }

  function frame(now) {
    if (S.t < 1) S.t = Math.min(1, (now - S.morphStart) / S.morphDur);
    if (S.spinVel) { S.spin += S.spinVel / 60; if (S.t > 0) S.spinVel *= 0.985; }
    for (const k of ["x", "y", "z"]) S.cam[k] += (S.camT[k] - S.cam[k]) * (REDUCED ? 1 : 0.07);
    S.dim += (S.dimT - S.dim) * 0.08;

    gl.clear(gl.COLOR_BUFFER_BIT);
    const pxPerUnit = S.cam.z;
    const size = Math.max(1.6 * DPR, Math.min(pxPerUnit * 1.25 * SPACING, 9 * DPR));
    // keep overall brightness steady: small dots on a zoomed-out view get brighter, big zoomed dots dimmer
    const alpha = Math.min(0.9, Math.max(0.16, 0.5 * (2.2 * DPR / size)));
    gl.uniform1f(U.uT, S.t); gl.uniform1f(U.uSpin, S.spin); gl.uniform1f(U.uZoom, S.cam.z);
    gl.uniform1f(U.uTime, REDUCED ? 0 : now / 1000); gl.uniform1f(U.uSize, size); gl.uniform1f(U.uAlpha, alpha);
    gl.uniform1f(U.uHi, S.hiState); gl.uniform1f(U.uDim, S.dim);
    gl.uniform2f(U.uCam, S.cam.x, S.cam.y); gl.uniform2f(U.uRes, canvas.width, canvas.height);
    gl.uniform1i(U.uMode, S.colorMode); gl.uniform1i(U.uYou, S.you);
    gl.drawArrays(gl.POINTS, 0, S.N);

    placeLabels();
    placeBeacon();
    $("#labels").classList.toggle("on", S.t >= 1 && S.current && S.current !== "galaxy");
    requestAnimationFrame(frame);
  }

  const toScreen = (x, y) => [(x - S.cam.x) * S.cam.z / DPR + innerWidth / 2, (y - S.cam.y) * S.cam.z / DPR + innerHeight / 2];
  const toWorld = (sx, sy) => [S.cam.x + (sx - innerWidth / 2) * DPR / S.cam.z, S.cam.y + (sy - innerHeight / 2) * DPR / S.cam.z];

  let labelEls = [];
  function renderLabels() {
    const box = $("#labels"); box.innerHTML = "";
    labelEls = (S.layouts[S.current]?.labels || []).map(l => { const d = document.createElement("div"); d.className = l.c; d.textContent = l.t; box.append(d); return [d, l]; });
  }
  function placeLabels() {
    for (const [d, l] of labelEls) { const [x, y] = toScreen(l.x, l.y); d.style.left = x + "px"; d.style.top = y + "px"; }
  }
  const tmpYou = [0, 0];
  function placeBeacon() {
    const b = $("#beacon");
    if (S.you < 0) { b.hidden = true; return; }
    currentPos(S.you, tmpYou);
    const [x, y] = toScreen(tmpYou[0], tmpYou[1]);
    b.hidden = false; b.style.transform = `translate(${x}px, ${y}px)`;
  }

  // ---------------------------------------------------------------- story
  function facts() {
    const us = S.us, ordered = S.states.slice().sort((a, b) => a.median - b.median);
    const young = ordered[0], old = ordered.at(-1), old2 = ordered.at(-2);
    const bands = d3.range(NB).map(b => us.counts[0][b] + us.counts[1][b]);
    const peak = d3.maxIndex(bands);
    const sr = S.states.slice().sort((a, b) => b.sexRatio - a.sexRatio);
    const flipped = S.states.filter(s => s.p65 > est(s.g, "C02_022"));
    return {
      map: `<b>${fmt(us.pop)}</b> Americans as <b>${fmt(S.N)}</b> points of light. Every dot is ${fmt(PER_DOT)} real people, placed inside their own state and coloured by its median age: <b>cool = young</b>, <b>warm = old</b>. The white-hot seams are where America crowds together.`,
      pyramid: `Fold everyone into one shape. The widest band is <b>ages ${BAND_LABEL[peak]}</b>, ${big(bands[peak])} people. At the very top, women outnumber men <b>${Math.round(us.counts[1][17] / us.counts[0][17] * 100)} to 100</b>.`,
      spectrum: `Every state, as wide as its population, sorted by median age. <b>${young.name}</b> (${fmt1(young.median)}) on the left, <b>${old.name}</b> (${fmt1(old.median)}) and ${old2.name} on the right. Watch the warm colours climb.`,
      cells: `Each state becomes a cell, young at the core and old at the rim. Thick hot rims mark ageing states: in <b>${flipped.length}</b> of them, people 65+ already outnumber children.`,
      split: `The same map, split by sex. <b>${sr[0].name}</b> has ${fmt1(sr[0].sexRatio)} men for every 100 women; <b>${sr.at(-1).name}</b> has ${fmt1(sr.at(-1).sexRatio)}.`,
    };
  }

  // ---------------------------------------------------------------- UI
  let FACTS;
  function initUI() {
    FACTS = facts();
    const nav = $("#scenes");
    SCENES.forEach((sc, k) => {
      const b = document.createElement("button");
      b.innerHTML = `<span>${k + 1}</span>${sc.name}`;
      b.addEventListener("click", () => goScene(k));
      nav.append(b);
    });
    document.querySelectorAll(".modes button").forEach(b => b.addEventListener("click", () => { S.userMode = true; setMode(+b.dataset.mode); }));
    addEventListener("keydown", e => {
      if (e.target.closest("input, select")) return;
      if (e.key === "ArrowRight") goScene(Math.min(SCENES.length - 1, S.scene + 1));
      if (e.key === "ArrowLeft") goScene(Math.max(0, S.scene - 1));
      if (/^[1-5]$/.test(e.key)) goScene(+e.key - 1);
    });
    $("#skip").addEventListener("click", endIntro);

    // you
    const sel = $("#you-state");
    sel.innerHTML = S.states.slice().sort((a, b) => a.name.localeCompare(b.name)).map(s => `<option value="${s.fips}">${s.name}</option>`).join("");
    sel.value = "06";
    $("#you-toggle").addEventListener("click", () => {
      const f = $("#you-form"); f.hidden = !f.hidden; $("#you-toggle").setAttribute("aria-expanded", String(!f.hidden));
    });
    $("#you-form").addEventListener("submit", e => { e.preventDefault(); findYou(+$("#you-age").value, +$("#you-sex").value, sel.value, true); });
    $("#you-clear").addEventListener("click", clearYou);

    // pan / zoom / hover
    let drag = null;
    canvas.addEventListener("pointerdown", e => { drag = { x: e.clientX, y: e.clientY, cx: S.camT.x, cy: S.camT.y, moved: false }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener("pointermove", e => {
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) { drag.moved = true; canvas.classList.add("dragging"); hideTip(); }
        if (drag.moved) { S.userCam = true; S.camT.x = drag.cx - dx * DPR / S.cam.z; S.camT.y = drag.cy - dy * DPR / S.cam.z; S.cam.x = S.camT.x; S.cam.y = S.camT.y; }
        return;
      }
      hover(e.clientX, e.clientY);
    });
    canvas.addEventListener("pointerup", () => { drag = null; canvas.classList.remove("dragging"); });
    canvas.addEventListener("pointerleave", () => { hideTip(); S.hiState = -1; });
    canvas.addEventListener("wheel", e => {
      e.preventDefault();
      S.userCam = true;
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      const k = Math.exp(-e.deltaY * 0.0015);
      const z = Math.min(Math.max(S.camT.z * k, 0.2), 80);
      S.camT.z = z;
      S.camT.x = wx - (e.clientX - innerWidth / 2) * DPR / z;
      S.camT.y = wy - (e.clientY - innerHeight / 2) * DPR / z;
    }, { passive: false });
    canvas.addEventListener("dblclick", () => { S.userCam = false; fitCamera(false); });
  }

  function hover(sx, sy) {
    const L = S.layouts[S.current];
    if (!L || S.t < 1 || S.current === "galaxy") return;
    const [wx, wy] = toWorld(sx, sy);
    let html = null, st = -1;
    if (L.hit) html = L.hit(wx, wy);
    if (L.state) st = L.state(wx, wy);
    if (!html && st >= 0) html = stateTip(S.states[st]);
    S.hiState = st;
    const tip = $("#tip");
    if (!html) { hideTip(); return; }
    tip.innerHTML = html; tip.hidden = false;
    tip.style.left = Math.min(sx + 16, innerWidth - 280) + "px";
    tip.style.top = Math.min(sy + 16, innerHeight - 120) + "px";
  }
  function hideTip() { $("#tip").hidden = true; }

  function setMode(m) {
    S.colorMode = m;
    document.querySelectorAll(".modes button").forEach(b => { const on = +b.dataset.mode === m; b.classList.toggle("on", on); b.setAttribute("aria-checked", on); });
    const L = $("#legend");
    const ramp = "linear-gradient(90deg,#22d3ee,#5b73ff,#ad5cfa,#fa5c9e,#ffc72e)";
    if (m === 0) L.innerHTML = `<span>age 0</span><span class="bar" style="background:${ramp}"></span><span>85+</span>`;
    if (m === 1) L.innerHTML = `<span class="sw" style="background:#5499ff"></span>Men<span class="sw" style="background:#ff5ca8"></span>Women`;
    if (m === 2) {
      const [lo, hi] = d3.extent(S.states, s => s.median);
      L.innerHTML = `<span>state median ${fmt1(lo)}</span><span class="bar" style="background:${ramp}"></span><span>${fmt1(hi)}</span>`;
    }
    writeHash();
  }

  function goScene(k) {
    S.scene = k;
    if (S.intro) endIntro(true);
    const sc = SCENES[k];
    if (!S.userMode) setMode(sc.mode);
    morphTo(sc.id);
    document.querySelectorAll("#scenes button").forEach((b, j) => b.classList.toggle("on", j === k));
    const cap = $("#caption");
    cap.style.opacity = 0;
    setTimeout(() => { cap.innerHTML = FACTS[sc.id]; cap.style.opacity = 1; }, REDUCED ? 0 : 250);
    hideTip(); S.hiState = -1;
    writeHash();
  }

  // ---------------------------------------------------------------- intro
  let introTimer, countAnim;
  function startIntro() {
    S.current = "galaxy";
    setMode(S.colorMode);
    document.querySelectorAll("#scenes button").forEach((b, j) => b.classList.toggle("on", j === S.scene));
    fitCamera(true);
    if (REDUCED || S.skipIntro) { endIntro(); return; }
    S.spinVel = 0.55;
    $("#caption").innerHTML = `Every dot you see is <b>${fmt(PER_DOT)}</b> real Americans…`;
    introTimer = setTimeout(() => {
      S.intro = false;
      morphTo(SCENES[S.scene].id, 3600);
      S.spin = S.spinVel = 0; // morphTo captured the spun positions as the new start
      countUp(3600);
      setTimeout(() => goCaption(), 1800);
      $("#skip").hidden = true;
    }, 2200);
  }
  function goCaption() { $("#caption").innerHTML = FACTS[SCENES[S.scene].id]; }
  function endIntro(silent) {
    clearTimeout(introTimer);
    S.intro = false;
    $("#skip").hidden = true;
    $("#count").textContent = fmt(S.us.pop);
    if (!silent) { morphTo(SCENES[S.scene].id, REDUCED ? 0 : 1600); goCaption(); }
  }
  function countUp(dur) {
    const t0 = performance.now(), el = $("#count");
    cancelAnimationFrame(countAnim);
    const step = now => {
      const p = Math.min(1, (now - t0) / dur);
      el.textContent = fmt(Math.round(S.us.pop * ease(p)));
      if (p < 1) countAnim = requestAnimationFrame(step);
    };
    countAnim = requestAnimationFrame(step);
  }

  // ---------------------------------------------------------------- find yourself
  function bandFor(age) { return Math.min(NB - 1, Math.floor(age / 5)); }
  function pctYounger(counts, total, age) {
    const b = bandFor(age);
    let below = 0;
    for (let k = 0; k < b; k++) below += counts[0][k] + counts[1][k];
    const width = b === NB - 1 ? 15 : 5, within = Math.min(1, (age - b * 5 + 0.5) / width);
    return (below + within * (counts[0][b] + counts[1][b])) / total * 100;
  }

  function findYou(age, sex, fips, zoom) {
    const s = S.byFips[fips];
    if (!s || !(age >= 0)) return;
    const b = bandFor(age);
    const [start, n] = S.groups.get(`${s.idx}|${sex}|${b}`) || [0, 0];
    if (!n) { $("#you-stats").innerHTML = `<p>No dot for that group at this scale. Try another state or age.</p>`; return; }
    S.you = start + ((age * 7919 + 13) % n);
    S.dimT = 1;
    S.youParams = { age, sex, fips };
    const inState = pctYounger(s.counts, s.pop, age), inUS = pctYounger(S.us.counts, S.us.pop, age);
    const peers = s.counts[sex][b];
    const of100 = peers / s.pop * 100;
    $("#you-stats").innerHTML = `
      <div class="big">You're older than <b>${Math.round(inState)}%</b> of ${s.name}.</div>
      <p>…and older than <b>${Math.round(inUS)}%</b> of all Americans. ${s.name}'s median resident is <b>${fmt1(s.median)}</b>.</p>
      <p>About <b>${big(peers)}</b> ${sex ? "women" : "men"} aged ${BAND_LABEL[b]} live in ${s.name}: <b>${fmt1(of100)}</b> of every 100 residents. That's ${fmt(n)} dots; the glowing one is you.</p>`;
    $("#you-form").hidden = false; $("#you-toggle").setAttribute("aria-expanded", "true");
    if (zoom) {
      // fly in so the beacon is centred, then let the user zoom back out
      const p = [0, 0];
      const L = S.layouts[S.current];
      const i2 = 2 * S.you;
      p[0] = L.pos[i2]; p[1] = L.pos[i2 + 1];
      S.userCam = true;
      const z = Math.max(S.camT.z * 2.6, 3 * DPR);
      S.camT = { x: p[0], y: p[1], z };
    }
    writeHash();
  }
  function clearYou() {
    S.you = -1; S.dimT = 0; S.youParams = null;
    $("#you-stats").innerHTML = "";
    S.userCam = false; fitCamera(false);
    writeHash();
  }

  // ---------------------------------------------------------------- URL
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    const k = SCENES.findIndex(s => s.id === p.get("scene"));
    if (k >= 0) S.scene = k;
    S.colorMode = SCENES[S.scene].mode;
    if (p.has("mode")) { S.colorMode = Math.max(0, Math.min(2, +p.get("mode"))); S.userMode = true; }
    if (p.has("intro") && p.get("intro") === "0") S.skipIntro = true;
    if (p.has("age") && p.has("state")) {
      $("#you-age").value = p.get("age"); $("#you-sex").value = p.get("sex") || "1"; $("#you-state").value = p.get("state");
      S.pendingYou = { age: +p.get("age"), sex: +(p.get("sex") || 1), fips: p.get("state") };
    }
  }
  function writeHash() {
    if (S.intro) return;
    const p = new URLSearchParams({ scene: SCENES[S.scene].id });
    if (S.userMode) p.set("mode", S.colorMode);
    if (S.youParams) { p.set("age", S.youParams.age); p.set("sex", S.youParams.sex); p.set("state", S.youParams.fips); }
    history.replaceState(null, "", "#" + p);
  }

  boot().then(() => {
    if (S.pendingYou) setTimeout(() => findYou(S.pendingYou.age, S.pendingYou.sex, S.pendingYou.fips, false), S.skipIntro || REDUCED ? 50 : 6000);
  }).catch(err => {
    console.error(err);
    const f = $("#fallback"); f.hidden = false;
    f.innerHTML = `<h2>Something went wrong loading the data</h2><p>${err.message}</p><p><a href="index.html">Back to the dashboard</a></p>`;
  });
})();
