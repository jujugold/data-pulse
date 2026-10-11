/* America in Dots — a scroll story. Every dot is 1,000 real people (ACS S0101), placed by census tract. Raw WebGL2. */
(() => {
  "use strict";

  const DEFAULT_YEAR = 2024;
  const MAP_URL = "https://cdn.jsdelivr.net/npm/us-atlas@3.0.1/states-albers-10m.json";
  const NB = 18;
  const BAND_LABEL = ["Under 5", "5–9", "10–14", "15–19", "20–24", "25–29", "30–34", "35–39", "40–44", "45–49",
    "50–54", "55–59", "60–64", "65–69", "70–74", "75–79", "80–84", "85+"];
  const ABBR = { "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE", "11": "DC", "12": "FL",
    "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY", "22": "LA", "23": "ME", "24": "MD",
    "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM",
    "36": "NY", "37": "NC", "38": "ND", "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD", "47": "TN",
    "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI", "56": "WY", "72": "PR" };
  const CITIES = [["New York", -74.006, 40.713], ["Los Angeles", -118.244, 34.052], ["Chicago", -87.63, 41.878],
    ["Houston", -95.37, 29.76], ["Phoenix", -112.074, 33.448], ["Dallas", -96.797, 32.777], ["Atlanta", -84.388, 33.749],
    ["Miami", -80.192, 25.762], ["Seattle", -122.332, 47.606], ["Denver", -104.99, 39.739], ["San Francisco", -122.419, 37.775],
    ["Washington", -77.037, 38.907], ["Minneapolis", -93.265, 44.978]];

  const SMALL = Math.min(innerWidth, innerHeight) < 700 || (navigator.deviceMemory && navigator.deviceMemory <= 4);
  const SUB = SMALL ? 4 : 1;                    // phones draw every 4th dot
  const PER_DOT = 1000 * SUB;
  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const DPR = Math.min(devicePixelRatio || 1, 2);
  const LIGHT = 0, AGE = 1, SEX = 2;

  const $ = s => document.querySelector(s);
  const fmt = d3.format(",");
  const fmt1 = d3.format(".1f");
  const millions = n => n >= 1e6 ? `${fmt1(n / 1e6)} million` : fmt(Math.round(n));
  const est = (g, k) => g?.v?.[k]?.[0] ?? null;
  const ease = p => p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  const rand = (a => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; })(20240101);

  const S = {
    N: 0, states: [], us: null, layouts: {}, groups: new Map(),
    from: null, to: null, t: 1, morphStart: 0, morphDur: 2200, spin: 0, spinVel: 0, layout: null,
    modeA: LIGHT, modeB: LIGHT, mix: 1, mixStart: 0,
    cam: { x: 487, y: 305, z: 1 }, camT: { x: 487, y: 305, z: 1 },
    hi: -1, you: -1, dim: 0, dimT: 0, step: -1,
  };

  // ------------------------------------------------------------------ load
  async function boot() {
    const canvas = $("#gl");
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
    if (!gl) { $("#fallback").hidden = false; $("#loading").classList.add("done"); return; }

    const json = u => fetch(u, { cache: "no-cache" }).then(r => { if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.json(); });
    const manifest = await json("data/manifest.json");
    const m = manifest.s0101;
    const year = (m.vintages || [DEFAULT_YEAR]).includes(DEFAULT_YEAR) ? DEFAULT_YEAR : m.latest;
    const [data, meta, bin, places, topo] = await Promise.all([
      json(`data/s0101/${year}.json`), json(`data/s0101/dots-${year}.json`),
      fetch(`data/s0101/dots-${year}.bin`).then(r => r.arrayBuffer()),
      json(`data/s0101/places-${year}.json`), json(MAP_URL),
    ]);
    S.year = year; S.meta = meta; S.places = places; S.data = data;
    $("#fresh").textContent = `ACS ${year} · updated ${new Date(m.last_checked).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;

    buildStates(data, meta);
    buildParticles(meta, new Uint16Array(bin));
    buildMap(topo);
    S.layouts.galaxy = layoutGalaxy();
    S.layouts.pyramid = layoutPyramid();
    S.layouts.spectrum = layoutSpectrum();

    initGL(gl, canvas);
    buildStory();
    $("#loading").classList.add("done");
    intro();
  }

  function buildStates(data, meta) {
    const counts = g => [0, 1].map(sex => d3.range(NB).map(b => est(g, `${sex ? "C05" : "C03"}_${String(b + 2).padStart(3, "0")}`) || 0));
    S.us = { pop: est(data.us, "C01_001"), median: est(data.us, "C01_032"), counts: counts(data.us), g: data.us };
    S.states = meta.fips.map((fips, idx) => {
      const g = data.states[fips];
      return { fips, idx, g, name: g.name, abbr: ABBR[fips] || fips, pop: est(g, "C01_001"), median: est(g, "C01_032"),
        p65: est(g, "C02_030"), p18: est(g, "C02_022"), counts: counts(g),
        teen: [0, 1].map(sex => (est(g, `${sex ? "C05" : "C03"}_021`) || 0) / Math.max(1, est(g, `${sex ? "C05" : "C03"}_005`) || 1)) };
    });
    S.byFips = Object.fromEntries(S.states.map(s => [s.fips, s]));
  }

  // ------------------------------------------------------------------ particles
  const albers = d3.geoAlbersUsa().scale(1300).translate([487.5, 305]);
  let prProj;

  function buildParticles(meta, q) {
    const plan = [];
    let off = 0;
    meta.fips.forEach((fips, si) => {
      for (let sex = 0; sex < 2; sex++) for (let b = 0; b < NB; b++) {
        const n1 = meta.counts[si][sex * NB + b];
        plan.push({ si, sex, b, off, n: SUB > 1 ? Math.round(n1 / SUB) : n1 });
        off += n1;
      }
    });
    const N = S.N = d3.sum(plan, p => p.n);
    S.stateOf = new Uint8Array(N); S.sexOf = new Uint8Array(N); S.bandOf = new Uint8Array(N);
    S.ageGroup = new Uint8Array(N); S.seed = new Float32Array(N);
    S.mapPos = new Float32Array(N * 2);

    const miami = albers([-80.19, 25.76]);
    prProj = d3.geoMercator().center([-66.45, 18.22]).scale(1300).translate([miami[0] + 80, miami[1] + 14]);
    const [lon0, lonSpan] = meta.lon, [lat0, latSpan] = meta.lat;

    let i = 0;
    for (const p of plan) {
      S.groups.set(`${p.si}|${p.sex}|${p.b}`, [i, p.n]);
      const st = S.states[p.si], isPR = st.fips === "72";
      for (let k = 0; k < p.n; k++, i++) {
        S.stateOf[i] = p.si; S.sexOf[i] = p.sex; S.bandOf[i] = p.b; S.seed[i] = rand();
        S.ageGroup[i] = p.b < 3 ? 0 : p.b === 3 ? (rand() < st.teen[p.sex] ? 0 : 1) : p.b < 13 ? 1 : 2;
        const j = 2 * (p.off + k);
        const lonlat = [lon0 + q[j] / 65535 * lonSpan, lat0 + q[j + 1] / 65535 * latSpan];
        const xy = isPR ? prProj(lonlat) : albers(lonlat);
        if (xy) { S.mapPos[2 * i] = xy[0]; S.mapPos[2 * i + 1] = xy[1]; }
        else if (k > 0) { S.mapPos[2 * i] = S.mapPos[2 * i - 2] + rand() - .5; S.mapPos[2 * i + 1] = S.mapPos[2 * i - 1] + rand() - .5; }
        else { const c = albers([-150, 63]) || [100, 520]; S.mapPos[2 * i] = c[0]; S.mapPos[2 * i + 1] = c[1]; }
      }
    }
    S.byState = S.states.map(() => []);
    for (let j = 0; j < N; j++) S.byState[S.stateOf[j]].push(j);
  }

  function buildMap(topo) {
    const features = topojson.feature(topo, topo.objects.states).features;
    const path = d3.geoPath();
    $("#borders .mesh").setAttribute("d", path(topojson.mesh(topo, topo.objects.states)));
    S.featurePath = {};
    // hit-test raster for hover
    const W = 975, H = 610, cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    const cpath = d3.geoPath(null, ctx);
    for (const f of features) {
      const s = S.byFips[f.id]; if (!s) continue;
      S.featurePath[s.idx] = path(f);
      ctx.beginPath(); cpath(f); ctx.fillStyle = `rgb(${s.idx + 1},0,0)`; ctx.fill();
    }
    const img = ctx.getImageData(0, 0, W, H).data;
    S.raster = new Uint8Array(W * H);
    for (let p = 0; p < W * H; p++) if (img[4 * p + 3] === 255 && img[4 * p + 1] === 0) S.raster[p] = img[4 * p];
    const pr = S.byFips["72"];
    if (pr) {
      const pts = S.byState[pr.idx].map(i => [S.mapPos[2 * i], S.mapPos[2 * i + 1]]);
      S.prBox = [d3.min(pts, d => d[0]) - 3, d3.min(pts, d => d[1]) - 3, d3.max(pts, d => d[0]) + 3, d3.max(pts, d => d[1]) + 3];
    }
    S.layouts.map = { pos: S.mapPos, bbox: [0, 0, 975, 610], state: mapStateAt };
  }

  function mapStateAt(x, y) {
    const px = Math.floor(x), py = Math.floor(y);
    if (px >= 0 && py >= 0 && px < 975 && py < 610 && S.raster[py * 975 + px]) return S.raster[py * 975 + px] - 1;
    const b = S.prBox;
    if (b && x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]) return S.byFips["72"].idx;
    return -1;
  }

  // ------------------------------------------------------------------ layouts
  function layoutGalaxy() {
    const pos = new Float32Array(S.N * 2);
    for (let i = 0; i < S.N; i++) {
      const r = Math.pow(rand(), .55) * 330, arm = (i % 3) * 2 * Math.PI / 3;
      const th = arm + r * .016 + (rand() - .5) * (1.1 - r / 500);
      pos[2 * i] = 487 + Math.cos(th) * r;
      pos[2 * i + 1] = 305 + Math.sin(th) * r * .6;
    }
    return { pos, bbox: [100, 60, 875, 550] };
  }

  function layoutPyramid() {
    const groups = d3.range(NB).map(() => [[], []]);
    for (let i = 0; i < S.N; i++) groups[S.bandOf[i]][S.sexOf[i]].push(i);
    groups.forEach(g => g.forEach(list => list.sort((a, b) => S.ageGroup[a] - S.ageGroup[b] || S.seed[a] - S.seed[b])));
    const sp = Math.sqrt(SUB), d = 1.05 * sp, rowH = 30 * sp, inner = rowH - 4 * sp, perCol = Math.max(1, Math.floor(inner / d));
    const spine = 30 * sp, pos = new Float32Array(S.N * 2);
    for (let b = 0; b < NB; b++) {
      const top = (NB - 1 - b) * rowH;
      for (let sex = 0; sex < 2; sex++) groups[b][sex].forEach((i, k) => {
        const dx = spine + (Math.floor(k / perCol) + rand() * .6) * d;
        pos[2 * i] = sex ? dx : -dx;
        pos[2 * i + 1] = top + (k % perCol + rand() * .6) * d;
      });
    }
    const half = d3.max(groups.flat(), l => Math.ceil(l.length / perCol)) * d + spine;
    const rowY = b => (NB - 1 - b) * rowH + inner / 2;
    const rowX = (b, sex) => (spine + Math.ceil(groups[b][sex].length / perCol) * d) * (sex ? 1 : -1);
    return {
      pos, bbox: [-half - 20 * sp, -54 * sp, half + 150 * sp, rowH * NB + 40 * sp], rowY, rowX, spine, half,
      hit(x, y) {
        const b = NB - 1 - Math.floor(y / rowH);
        if (b < 0 || b >= NB || Math.abs(x) < spine * .6 || Math.abs(x) > half) return null;
        const sex = x < 0 ? 0 : 1, n = S.us.counts[sex][b];
        return `<b>${sex ? "Women" : "Men"}, ${BAND_LABEL[b].toLowerCase()}</b><br>${millions(n)}<br><span>${fmt1(n / S.us.pop * 100)}% of everyone</span>`;
      },
    };
  }

  function layoutSpectrum() {
    // one column per state: width ∝ population, sorted by median age, youngest residents at the bottom
    const order = S.states.slice().sort((a, b) => a.median - b.median);
    const H = 520, gap = 1.5, usable = S.N * 1.25 * SUB / H;
    const pos = new Float32Array(S.N * 2), cols = [];
    let x = 0;
    for (const s of order) {
      const list = S.byState[s.idx].slice().sort((a, b) => S.bandOf[a] - S.bandOf[b] || S.ageGroup[a] - S.ageGroup[b] || S.seed[a] - S.seed[b]);
      const w = list.length / S.N * usable;
      list.forEach((i, k) => { pos[2 * i] = x + rand() * w; pos[2 * i + 1] = H - (k + rand()) / list.length * H; });
      cols.push({ s, x0: x, x1: x + w });
      x += w + gap;
    }
    const find = wx => cols.find(c => wx >= c.x0 - gap / 2 && wx <= c.x1 + gap / 2);
    const state = (wx, wy) => (wy >= 0 && wy <= H && find(wx)) ? find(wx).s.idx : -1;
    return { pos, bbox: [-10, -40, x - gap + 10, H + 50], cols, H, width: x - gap, state };
  }

  // ------------------------------------------------------------------ WebGL
  const VS = `#version 300 es
  precision highp float;
  in vec2 aFrom; in vec2 aTo; in vec4 aMeta; in float aState;
  uniform float uT, uSpin, uZoom, uTime, uSize, uHi, uDim, uAlpha, uMix, uOver;
  uniform vec2 uCam, uRes;
  uniform int uModeA, uModeB, uYou;
  out vec4 vColor; out float vYou; out float vOver;
  vec4 look(int m){
    if(m==0) return vec4(1.,.79,.5,.34);
    if(m==1){ float g=aMeta.z; return g<.5?vec4(.2,.86,.77,.9): g<1.5?vec4(.32,.36,.66,.42): vec4(1.,.76,.18,.95); }
    return aMeta.y<.5?vec4(.38,.65,1.,.85):vec4(.98,.45,.72,.85);
  }
  void main(){
    float seed=aMeta.w;
    float p=clamp((uT-seed*.3)/.7,0.,1.);
    float e=p<.5?4.*p*p*p:1.-pow(-2.*p+2.,3.)/2.;
    vec2 from=aFrom;
    if(uSpin!=0.){ vec2 c=vec2(487.,305.); vec2 r=from-c; float a=uSpin*(.4+80./(length(r)+50.)); float cs=cos(a), sn=sin(a); from=c+vec2(cs*r.x-sn*r.y, sn*r.x+cs*r.y); }
    vec2 d=aTo-from;
    vec2 pos=mix(from,aTo,e)+vec2(-d.y,d.x)*sin(3.14159*e)*(seed-.5)*.35;
    pos+=vec2(sin(uTime*.6+seed*61.),cos(uTime*.5+seed*47.))*.12;
    vec2 px=(pos-uCam)*uZoom;
    gl_Position=vec4(px.x/(uRes.x*.5),-px.y/(uRes.y*.5),0.,1.);
    vec4 c=mix(look(uModeA),look(uModeB),uMix);
    float a=c.a*uAlpha, size=uSize;
    if(uHi>=0.) a*= abs(aState-uHi)<.5 ? 1.6 : .35;
    a*=mix(1.,.22,uDim);
    vYou=0.; vOver=uOver;
    if(gl_VertexID==uYou){ size=max(uSize*3.,10.)+6.; a=1.; c.rgb=vec3(1.,.96,.86); vYou=1.; }
    gl_PointSize=size;
    vColor=vec4(c.rgb,a);
  }`;
  const FS = `#version 300 es
  precision mediump float;
  in vec4 vColor; in float vYou; in float vOver; out vec4 o;
  void main(){
    float r=length(gl_PointCoord-.5)*2.;
    if(r>1.) discard;
    float f=vYou>.5 ? smoothstep(1.,.2,r)*1.5 : (1.-r*r);
    float a=min(1.,vColor.a*f);
    o=vec4(vColor.rgb*a, a*vOver);
  }`;

  let gl, U = {}, bufFrom, bufTo, canvas;
  function initGL(g, c) {
    gl = g; canvas = c;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    for (const n of ["uT", "uSpin", "uZoom", "uTime", "uSize", "uHi", "uDim", "uAlpha", "uMix", "uOver", "uCam", "uRes", "uModeA", "uModeB", "uYou"]) U[n] = gl.getUniformLocation(prog, n);
    gl.bindVertexArray(gl.createVertexArray());
    const attr = (name, size, arr, usage) => {
      const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, arr, usage);
      const loc = gl.getAttribLocation(prog, name); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      return b;
    };
    const meta = new Float32Array(S.N * 4), st = new Float32Array(S.N);
    for (let i = 0; i < S.N; i++) {
      meta[4 * i] = S.bandOf[i] / (NB - 1); meta[4 * i + 1] = S.sexOf[i]; meta[4 * i + 2] = S.ageGroup[i]; meta[4 * i + 3] = S.seed[i];
      st[i] = S.stateOf[i];
    }
    attr("aMeta", 4, meta, gl.STATIC_DRAW);
    attr("aState", 1, st, gl.STATIC_DRAW);
    S.from = S.layouts.galaxy.pos.slice(); S.to = S.layouts.galaxy.pos.slice();
    bufFrom = attr("aFrom", 2, S.from, gl.DYNAMIC_DRAW);
    bufTo = attr("aTo", 2, S.to, gl.DYNAMIC_DRAW);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    // draw in random order so no age group or state always sits on top
    const order = new Uint32Array(S.N);
    for (let i = 0; i < S.N; i++) order[i] = i;
    for (let i = S.N - 1; i > 0; i--) { const j = (rand() * (i + 1)) | 0; const t = order[i]; order[i] = order[j]; order[j] = t; }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, order, gl.STATIC_DRAW);
    gl.clearColor(.02, .024, .043, 1);
    S.layout = "galaxy";
    addEventListener("resize", () => { resize(); if (STEPS[S.step]?.you && S.showYou) zoomToYou(); else fitCamera(true); });
    resize(); fitCamera(true);
    initPointer();
    requestAnimationFrame(frame);
  }

  function resize() {
    canvas.width = Math.round(innerWidth * DPR); canvas.height = Math.round(innerHeight * DPR);
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  // CPU mirror of the vertex shader (without shimmer): lets a morph start mid-flight and tracks the "you" dot.
  function currentPos(i, out) {
    const seed = S.seed[i], e = ease(Math.min(1, Math.max(0, (S.t - seed * .3) / .7)));
    let fx = S.from[2 * i], fy = S.from[2 * i + 1];
    if (S.spin) {
      const rx = fx - 487, ry = fy - 305, a = S.spin * (.4 + 80 / (Math.hypot(rx, ry) + 50)), cs = Math.cos(a), sn = Math.sin(a);
      fx = 487 + cs * rx - sn * ry; fy = 305 + sn * rx + cs * ry;
    }
    const dx = S.to[2 * i] - fx, dy = S.to[2 * i + 1] - fy, arc = Math.sin(Math.PI * e) * (seed - .5) * .35;
    out[0] = fx + dx * e - dy * arc; out[1] = fy + dy * e + dx * arc;
    return out;
  }

  function morphTo(name, dur = 2200) {
    if (S.layout === name) return;
    if (S.t < 1 || S.spin) {
      const tmp = [0, 0];
      for (let i = 0; i < S.N; i++) { currentPos(i, tmp); S.from[2 * i] = tmp[0]; S.from[2 * i + 1] = tmp[1]; }
    } else S.from.set(S.to);
    S.spin = 0; S.spinVel = 0;
    S.to.set(S.layouts[name].pos);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufFrom); gl.bufferSubData(gl.ARRAY_BUFFER, 0, S.from);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufTo); gl.bufferSubData(gl.ARRAY_BUFFER, 0, S.to);
    S.t = REDUCED ? 1 : 0; S.morphStart = performance.now(); S.morphDur = dur;
    S.layout = name;
  }

  function setColor(mode) {
    if (mode === S.modeB) return;
    S.modeA = S.mix < .5 ? S.modeA : S.modeB;
    S.modeB = mode; S.mix = REDUCED ? 1 : 0; S.mixStart = performance.now();
  }

  // Screen area the visualization may use (the story cards cover the rest).
  function viewport() {
    if (innerWidth >= 900) return { x0: 500, y0: 70, x1: innerWidth - 60, y1: innerHeight - 40 };
    return { x0: 12, y0: 56, x1: innerWidth - 20, y1: innerHeight * .52 };
  }

  function fitCamera(instant, bbox) {
    const L = S.layouts[S.layout]; if (!L) return;
    const [x0, y0, x1, y1] = bbox || L.bbox, v = viewport();
    const aw = v.x1 - v.x0, ah = v.y1 - v.y0;
    const z = Math.min(aw / (x1 - x0), ah / (y1 - y0));
    S.camT = { z: z * DPR, x: (x0 + x1) / 2 - ((v.x0 + v.x1) / 2 - innerWidth / 2) / z, y: (y0 + y1) / 2 - ((v.y0 + v.y1) / 2 - innerHeight / 2) / z };
    if (instant || REDUCED) S.cam = { ...S.camT };
  }

  const toScreen = (x, y) => [(x - S.cam.x) * S.cam.z / DPR + innerWidth / 2, (y - S.cam.y) * S.cam.z / DPR + innerHeight / 2];
  const toWorld = (sx, sy) => [S.cam.x + (sx - innerWidth / 2) * DPR / S.cam.z, S.cam.y + (sy - innerHeight / 2) * DPR / S.cam.z];

  const tmpYou = [0, 0];
  function frame(now) {
    if (S.t < 1) S.t = Math.min(1, (now - S.morphStart) / S.morphDur);
    if (S.mix < 1) S.mix = Math.min(1, (now - S.mixStart) / 700);
    if (S.spinVel) S.spin += S.spinVel / 60;
    for (const k of ["x", "y", "z"]) S.cam[k] += (S.camT[k] - S.cam[k]) * (REDUCED ? 1 : .06);
    S.dim += (S.dimT - S.dim) * .08;

    const zCss = S.cam.z / DPR;
    const sizeCss = Math.max(1.5, Math.min(zCss * 1.15 * Math.sqrt(SUB), 7));
    const alpha = Math.min(1.2, 1.9 / sizeCss) * (SUB > 1 ? 1.5 : 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(U.uT, S.t); gl.uniform1f(U.uSpin, S.spin); gl.uniform1f(U.uZoom, S.cam.z);
    gl.uniform1f(U.uTime, REDUCED ? 0 : now / 1000); gl.uniform1f(U.uSize, sizeCss * DPR); gl.uniform1f(U.uAlpha, alpha);
    gl.uniform1f(U.uHi, S.hi); gl.uniform1f(U.uDim, S.dim); gl.uniform1f(U.uMix, ease(S.mix));
    const ov = m => m === LIGHT ? 0 : 1;
    gl.uniform1f(U.uOver, ov(S.modeA) + (ov(S.modeB) - ov(S.modeA)) * ease(S.mix));
    gl.uniform2f(U.uCam, S.cam.x, S.cam.y); gl.uniform2f(U.uRes, canvas.width, canvas.height);
    gl.uniform1i(U.uModeA, S.modeA); gl.uniform1i(U.uModeB, S.modeB); gl.uniform1i(U.uYou, S.showYou ? S.you : -1);
    gl.drawElements(gl.POINTS, S.N, gl.UNSIGNED_INT, 0);
    if (S.showYou && S.you >= 0) gl.drawArrays(gl.POINTS, S.you, 1); // keep "you" on top

    // overlays follow the camera
    const s = zCss, tx = innerWidth / 2 - S.cam.x * s, ty = innerHeight / 2 - S.cam.y * s;
    $("#borders g").setAttribute("transform", `translate(${tx},${ty}) scale(${s})`);
    $("#borders").classList.toggle("on", S.layout === "map" && S.t > .85 && !!STEPS[S.step]?.borders);
    for (const [d, l] of labelEls) {
      const [x, y] = toScreen(l.x, l.y);
      d.style.left = x + "px"; d.style.top = y + "px";
      if (l.c === "callout") d.classList.toggle("flip", x > innerWidth - 190);
    }
    $("#labels").classList.toggle("on", S.t >= 1 && S.layout !== "galaxy");
    const bc = $("#beacon");
    if (S.showYou && S.you >= 0) {
      currentPos(S.you, tmpYou); const [x, y] = toScreen(tmpYou[0], tmpYou[1]);
      bc.hidden = false; bc.style.transform = `translate(${x}px, ${y}px)`;
    } else bc.hidden = true;
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------ labels
  let labelEls = [];
  function setLabels(list) {
    const box = $("#labels"); box.innerHTML = "";
    labelEls = list.map(l => { const d = document.createElement("div"); d.className = l.c; d.innerHTML = l.t; box.append(d); return [d, l]; });
  }
  const cityLabels = () => CITIES.map(([t, lon, lat]) => { const p = albers([lon, lat]); return p && { x: p[0], y: p[1], t, c: "city" }; }).filter(Boolean);
  function countyLabel(c, kind) {
    const p = albers([c.lon, c.lat]); if (!p) return null;
    const st = S.states.find(s => s.name === c.state);
    const stat = kind === "old" ? `<b class="t-senior">${Math.round(c.p65)}%</b> are 65 or older` : `<b class="t-kid">${Math.round(c.p18)}%</b> are children`;
    return { x: p[0], y: p[1], t: `${c.name}, ${st ? st.abbr : c.state}<small>${stat}</small>`, c: "callout" };
  }
  function pyramidLabels(extra = []) {
    const L = S.layouts.pyramid, sp = Math.sqrt(SUB);
    return [
      ...d3.range(NB).map(b => ({ x: 0, y: L.rowY(b), t: BAND_LABEL[b].replace("Under 5", "<5"), c: "axis" })),
      { x: -L.half * .5, y: -36 * sp, t: "Men", c: "head" }, { x: L.half * .5, y: -36 * sp, t: "Women", c: "head" },
      ...extra,
    ];
  }

  // ------------------------------------------------------------------ the story (all numbers come from the data)
  function generation(born) {
    if (born >= 2013) return "Gen Alpha"; if (born >= 1997) return "Gen Z"; if (born >= 1981) return "Millennials";
    if (born >= 1965) return "Gen X"; if (born >= 1946) return "Baby Boomers"; return "the Silent Generation";
  }
  const decadeWords = b => { const a = b * 5; return a === 0 ? "under 5" : `${a % 10 === 0 ? "early" : "late"} ${a - a % 10}s`; };

  let STEPS = [];
  function buildStory() {
    const us = S.us, year = S.year;
    const fifty = S.states.filter(s => s.fips !== "72").sort((a, b) => b.pop - a.pop);
    let acc = 0, k = 0;
    while (acc < us.pop / 2) acc += fifty[k++].pop;
    const halfNames = fifty.slice(0, k).map(s => s.name);
    const p18 = est(us.g, "C02_022"), p65 = est(us.g, "C02_030"), padult = 100 - p18 - p65;
    const old = S.places.oldest[0], young = S.places.youngest[0];

    // generational bulges: peaks in the national age profile with real prominence
    const tot = d3.range(NB).map(b => us.counts[0][b] + us.counts[1][b]);
    const peaks = d3.range(1, NB - 1).filter(b => tot[b] > tot[b - 1] && tot[b] >= tot[b + 1]).map(b => {
      const higher = d3.range(NB).filter(j => tot[j] > tot[b]);
      const nearest = higher.length ? higher.reduce((a, j) => Math.abs(j - b) < Math.abs(a - b) ? j : a) : null;
      const valley = nearest == null ? 0 : d3.min(d3.range(Math.min(b, nearest), Math.max(b, nearest) + 1), j => tot[j]);
      return { b, prom: nearest == null ? Infinity : tot[b] - valley };
    }).filter(p => p.prom > tot[p.b] * .04).sort((a, b) => a.b - b.b).slice(0, 3);
    const gens = peaks.map(p => ({ ...p, gen: generation(year - p.b * 5 - 2), from: year - p.b * 5 - 4, to: year - p.b * 5 }));
    const genText = gens.length >= 2
      ? gens.map(g => `<strong>${g.gen}</strong>, now in their ${decadeWords(g.b)}`).join(" and ")
      : `people in their ${decadeWords(d3.maxIndex(tot))}`;

    const boys = Math.round(us.counts[0][0] / us.counts[1][0] * 100);
    const women85 = Math.round(us.counts[1][NB - 1] / us.counts[0][NB - 1] * 100);
    let cross = NB - 1;
    for (let b = NB - 1; b >= 0; b--) { if (us.counts[1][b] >= us.counts[0][b]) cross = b; else break; }
    const L = S.layouts.pyramid;
    const sp = Math.sqrt(SUB);

    const byAge = S.states.slice().sort((a, b) => a.median - b.median);
    const yS = byAge[0], oS = byAge.at(-1);
    const flipped = S.states.filter(s => s.p65 > s.p18).length;
    const keyAge = `<div class="key">
        <div><i class="c-kid"></i>Children (under 18)<b>${fmt1(p18)}%</b></div>
        <div><i class="c-adult"></i>Adults 18–64<b>${fmt1(padult)}%</b></div>
        <div><i class="c-senior"></i>65 and older<b>${fmt1(p65)}%</b></div></div>`;
    const men = d3.sum(us.counts[0]), women = d3.sum(us.counts[1]);

    STEPS = [
      { layout: "map", mode: LIGHT, borders: true, labels: () => [],
        html: `<p class="kicker">America in Dots</p>
          <div class="hero" id="hero-count">0</div>
          <p>people live in the United States. Here, <strong>every dot is ${fmt(PER_DOT)} of them</strong>, placed in the neighborhoods where they actually live.</p>
          <p class="cue">Scroll to explore</p>` },
      { layout: "map", mode: LIGHT, borders: true, labels: cityLabels,
        html: `<p class="kicker">Where we live</p>
          <h2>Half the country lives in just ${k} states</h2>
          <p>${halfNames.slice(0, -1).join(", ")} and ${halfNames.at(-1)}.</p>
          <p>The brightest patches are metro areas. The darkness across much of the West isn't missing data: very few people live there.</p>` },
      { layout: "map", mode: AGE, borders: true, labels: () => [countyLabel(old, "old"), countyLabel(young, "young")].filter(Boolean),
        html: `<p class="kicker">Who lives where</p>
          <h2>Young and old don't live in the same places</h2>
          <p>Each dot now shows an age group. Retirement areas glow gold: in <strong>${old.name}, ${old.state}</strong>, ${Math.round(old.p65)}% of residents are 65 or older. In <strong>${young.name}, ${young.state}</strong>, ${Math.round(young.p18)}% are children.</p>
          ${keyAge}` },
      { layout: "pyramid", mode: AGE, labels: () => pyramidLabels(gens.map(g => ({
          x: L.rowX(g.b, 1) + 10 * sp, y: L.rowY(g.b), c: "note l", t: `${g.gen}<small>born ${g.from}–${String(g.to).slice(2)}</small>` }))),
        html: `<p class="kicker">Everyone, by age</p>
          <h2>${gens.length >= 2 ? `${gens.length === 2 ? "Two" : "Three"} generations stand out` : "The shape of a nation"}</h2>
          <p>Now every dot is stacked by age, men on the left and women on the right. The widest bars belong to ${genText}.</p>
          ${keyAge}` },
      { layout: "pyramid", mode: SEX, labels: () => pyramidLabels([
          { x: L.rowX(NB - 1, 1) + 10 * sp, y: L.rowY(NB - 1), c: "note l", t: `<b class="t-women">${women85}</b> women per 100 men<small>ages 85 and older</small>` },
          { x: L.rowX(0, 0) / 2, y: L.rowY(0) + 34 * sp, c: "note", t: `<b class="t-men">${boys}</b> boys per 100 girls<small>under age 5</small>` }]),
        html: `<p class="kicker">Men and women</p>
          <h2>Boys outnumber girls. Women outlive men</h2>
          <p>Among children under 5 there are <strong>${boys} boys for every 100 girls</strong>. Women outnumber men from their ${decadeWords(cross)} on, and by 85 there are <strong>${women85} women for every 100 men</strong>.</p>
          <div class="key"><div><i class="c-men"></i>Men<b>${millions(men)}</b></div><div><i class="c-women"></i>Women<b>${millions(women)}</b></div></div>` },
      { layout: "spectrum", mode: AGE, labels: spectrumLabels,
        html: `<p class="kicker">State by state</p>
          <h2>From ${yS.name} to ${oS.name}</h2>
          <p>Each column is a state, as wide as its population and sorted by median age. Younger residents sit at the bottom.</p>
          <p>The typical resident of ${yS.name} is <strong>${fmt1(yS.median)}</strong>; in ${oS.name}, <strong>${fmt1(oS.median)}</strong>. In ${flipped} of these places, people 65 and older already outnumber children.</p>
          ${keyAge}` },
      { layout: "map", mode: AGE, borders: true, you: true, labels: () => [],
        html: `<p class="kicker">Find yourself</p>
          <h2>Where do you fit in?</h2>
          <p>We'll light up a dot that shares your state, sex and age group.</p>
          <form class="you" id="you-form">
            <label>Age<input id="you-age" type="number" min="0" max="110" value="35" inputmode="numeric" required></label>
            <label>Sex<select id="you-sex"><option value="1">Female</option><option value="0">Male</option></select></label>
            <label class="wide">State<select id="you-state">${S.states.slice().sort((a, b) => a.name.localeCompare(b.name)).map(s => `<option value="${s.fips}">${s.name}</option>`).join("")}</select></label>
            <button type="submit">Find my dot</button>
          </form>
          <div class="result" id="you-result"></div>` },
    ];

    const story = $("#story"), rail = $("#progress");
    STEPS.forEach((st, i) => {
      const sec = document.createElement("section");
      sec.className = "step"; sec.dataset.i = i;
      sec.innerHTML = `<div class="card">${st.html}</div>`;
      story.append(sec);
      const dot = document.createElement("button");
      dot.setAttribute("aria-label", `Go to step ${i + 1}`);
      dot.addEventListener("click", () => sec.scrollIntoView({ block: "center" }));
      rail.append(dot);
    });
    $("#method-text").innerHTML = `Dot counts come from the ${year} American Community Survey 1-year estimates (Census table S0101), one dot per ${fmt(PER_DOT)} people, including Puerto Rico (shown southeast of Florida).
      Each dot is assigned to a census tract in proportion to that tract's residents of the same sex and five-year age group (ACS ${S.meta.acs5_year - 4}–${S.meta.acs5_year} 5-year estimates, table B01001), then placed at random within the tract's land area.
      Dots show where groups of people live; they are not the locations of real individuals. County figures use counties with at least ${fmt(S.places.min_pop)} residents. Data is checked daily.`;

    $("#you-state").value = "06";
    readHash();
    $("#you-form").addEventListener("submit", e => { e.preventDefault(); findYou(); });

    const io = new IntersectionObserver(entries => {
      for (const en of entries) if (en.isIntersecting) setStep(+en.target.dataset.i);
    }, { rootMargin: "-45% 0px -45% 0px" });
    document.querySelectorAll(".step").forEach(s => io.observe(s));
    const jump = +new URLSearchParams(location.hash.slice(1)).get("step");
    if (jump > 0) document.querySelectorAll(".step")[jump]?.scrollIntoView({ block: "center", behavior: "instant" });
  }

  function spectrumLabels() {
    const L = S.layouts.spectrum, out = [];
    for (const c of L.cols) if (c.x1 - c.x0 > 16) out.push({ x: (c.x0 + c.x1) / 2, y: L.H + 12, t: c.s.abbr, c: "abbr" });
    const first = L.cols[0], last = L.cols.at(-1);
    out.push({ x: first.x0, y: -16, t: `← younger · ${first.s.abbr} ${fmt1(first.s.median)}`, c: "axis l" },
      { x: last.x1, y: -16, t: `${last.s.abbr} ${fmt1(last.s.median)} · older →`, c: "axis r" });
    return out;
  }

  function setStep(i) {
    if (i === S.step) return;
    S.step = i;
    const st = STEPS[i];
    document.querySelectorAll(".step").forEach((el, j) => el.classList.toggle("active", j === i));
    document.querySelectorAll("#progress button").forEach((el, j) => el.classList.toggle("on", j === i));
    if (S.intro && i > 0) endIntro();
    if (!S.intro) morphTo(st.layout);
    setColor(st.mode);
    setLabels(st.labels());
    S.showYou = !!st.you && S.you >= 0;
    S.dimT = S.showYou ? 1 : 0;
    if (S.showYou) zoomToYou(); else if (!S.intro) fitCamera(false);
    hideTip();
  }

  // ------------------------------------------------------------------ intro
  function intro() {
    S.intro = true;
    setStep(0);
    S.modeA = S.modeB = LIGHT; S.mix = 1;
    if (REDUCED) { endIntro(); return; }
    S.spinVel = .5;
    S.introTimer = setTimeout(endIntro, 1300);
  }
  function endIntro() {
    if (!S.intro) return;
    S.intro = false;
    clearTimeout(S.introTimer);
    const target = STEPS[S.step].layout;
    morphTo(target, REDUCED ? 0 : 3400);
    if (STEPS[S.step].you && S.you >= 0) zoomToYou(); else fitCamera(false);
    const el = $("#hero-count"), t0 = performance.now(), dur = REDUCED ? 0 : 3400;
    const tick = now => {
      const p = dur ? Math.min(1, (now - t0) / dur) : 1;
      el.textContent = fmt(Math.round(S.us.pop * ease(p)));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------------ hover
  function initPointer() {
    canvas.addEventListener("pointermove", e => {
      if (e.pointerType === "touch") return;
      const L = S.layouts[S.layout];
      if (!L || S.t < 1 || S.layout === "galaxy" || STEPS[S.step]?.you) { hideTip(); return; }
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      let html = L.hit ? L.hit(wx, wy) : null, st = -1;
      if (!html && L.state) {
        st = L.state(wx, wy);
        if (st >= 0) { const s = S.states[st]; html = `<b>${s.name}</b><br>${millions(s.pop)} people<br><span>Median age ${fmt1(s.median)} · ${fmt1(s.p65)}% are 65+</span>`; }
      }
      highlight(st);
      if (!html) { hideTip(); return; }
      const tip = $("#tip"); tip.innerHTML = html; tip.hidden = false;
      tip.style.left = Math.min(e.clientX + 16, innerWidth - 250) + "px";
      tip.style.top = Math.min(e.clientY + 16, innerHeight - 90) + "px";
    });
    canvas.addEventListener("pointerleave", hideTip);
  }
  function highlight(st) {
    S.hi = st;
    $("#borders .hi").setAttribute("d", st >= 0 && S.layout === "map" ? (S.featurePath[st] || "") : "");
  }
  function hideTip() { $("#tip").hidden = true; highlight(-1); }

  // ------------------------------------------------------------------ find yourself
  const bandFor = age => Math.min(NB - 1, Math.floor(age / 5));
  function pctYounger(counts, total, age) {
    const b = bandFor(age);
    let below = 0;
    for (let j = 0; j < b; j++) below += counts[0][j] + counts[1][j];
    const width = b === NB - 1 ? 15 : 5, within = Math.min(1, (age - b * 5 + .5) / width);
    return (below + within * (counts[0][b] + counts[1][b])) / total * 100;
  }

  function findYou() {
    const age = Math.max(0, Math.min(110, Math.round(+$("#you-age").value)));
    const sex = +$("#you-sex").value, s = S.byFips[$("#you-state").value];
    if (!s || !Number.isFinite(age)) return;
    const b = bandFor(age), [start, n] = S.groups.get(`${s.idx}|${sex}|${b}`) || [0, 0];
    const out = $("#you-result");
    if (!n) { out.innerHTML = `<p>There are too few people in that group to draw a dot at this scale. Try a nearby age.</p>`; return; }
    S.you = start + ((age * 7919 + 13) % n);
    const older = Math.round(pctYounger(s.counts, s.pop, age)), olderUS = Math.round(pctYounger(S.us.counts, S.us.pop, age));
    const peers = s.counts[sex][b];
    out.innerHTML = `<p class="big">You're older than <b>${older}%</b> of people in ${s.name}.</p>
      <p>Nationally, you're older than ${olderUS}% of Americans. About <strong>${millions(peers)}</strong> ${sex ? "women" : "men"} in ${s.name} are ${b === 0 ? "under 5" : b === NB - 1 ? "85 or older" : `aged ${BAND_LABEL[b]}`}.</p>`;
    history.replaceState(null, "", `#age=${age}&sex=${sex}&state=${s.fips}`);
    if (STEPS[S.step]?.you) { S.showYou = true; S.dimT = 1; zoomToYou(); }
  }

  function zoomToYou() {
    const x = S.mapPos[2 * S.you], y = S.mapPos[2 * S.you + 1], r = 90;
    fitCamera(false, [x - r, y - r * .62, x + r, y + r * .62]);
  }

  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    if (p.has("age")) $("#you-age").value = p.get("age");
    if (p.has("sex")) $("#you-sex").value = p.get("sex");
    if (p.has("state") && S.byFips[p.get("state")]) $("#you-state").value = p.get("state");
  }

  boot().catch(err => {
    console.error(err);
    $("#loading").classList.add("done");
    const f = $("#fallback"); f.hidden = false;
    f.innerHTML = `<h2>Something went wrong loading the data</h2><p>${err.message}</p><p><a href="index.html">Back to the dashboard</a></p>`;
  });
})();
