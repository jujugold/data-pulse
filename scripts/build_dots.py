#!/usr/bin/env python3
"""Place every "America in Dots" dot where people actually live.

The number of dots per state × sex × age band comes from ACS 1-year table S0101
(data/s0101/<year>.json, one dot per 1,000 people). Each dot is then assigned to a
census tract, sampled in proportion to that tract's population of the same sex and
age band (ACS 5-year table B01001), and scattered within the tract's land area
around its Gazetteer internal point.

Writes:
  data/s0101/dots-<year>.bin    uint16 little-endian (lon, lat) pairs, quantised
  data/s0101/dots-<year>.json   ordering, group sizes, quantisation, sources
  data/s0101/places-<year>.json oldest / youngest large counties (for annotations)

Standard library only. Output is deterministic (seeded), so unchanged inputs give
byte-identical files and no git diff.
"""
import array
import csv
import hashlib
import io
import json
import math
import random
import sys
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_s0101 import ROOT, http_get, load_key  # noqa: E402

PER_DOT = 1000
NB = 18
LON0, LON_SPAN = -180.0, 116.0   # -180 … -64
LAT0, LAT_SPAN = 17.0, 55.0      # 17 … 72
GAZ = "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/{y}_Gazetteer/{y}_Gaz_tracts_national.zip"
ACS5 = "https://api.census.gov/data/{y}/acs/acs5"

# B01001 detailed age rows → the 18 five-year bands used by S0101. Male rows 003–025; female = male + 24.
BAND_ROWS = [[3], [4], [5], [6, 7], [8, 9, 10], [11], [12], [13], [14], [15], [16], [17],
             [18, 19], [20, 21], [22], [23], [24], [25]]
UNDER18_ROWS = [3, 4, 5, 6]
OVER65_ROWS = [20, 21, 22, 23, 24, 25]


def var(row, female):
    return f"B01001_{row + (24 if female else 0):03d}E"


VARS = [var(r, f) for f in (0, 1) for r in range(3, 26)]


def round_half_up(x):
    return int(math.floor(x + 0.5))


def pick_year(year, key):
    """Most recent ACS 5-year release at or before the S0101 year."""
    for y in range(year, year - 4, -1):
        status, body, final = http_get(f"{ACS5.format(y=y)}?get=B01001_001E&for=state:44&key={key}")
        if status == 200 and "_key" not in final and body.startswith("["):
            return y
    raise RuntimeError("No ACS 5-year release found")


def load_gazetteer(year):
    for y in range(year, year - 4, -1):
        url = GAZ.format(y=y)
        try:
            with urllib.request.urlopen(url, timeout=180) as r:
                blob = r.read()
        except Exception as e:  # noqa: BLE001
            print(f"  gazetteer {y} unavailable ({e})", file=sys.stderr)
            continue
        with zipfile.ZipFile(io.BytesIO(blob)) as z:
            name = next(n for n in z.namelist() if n.endswith(".txt"))
            text = z.read(name).decode("latin-1")
        rows = csv.reader(io.StringIO(text), delimiter="\t")
        header = [h.strip() for h in next(rows)]
        ig, ia, ila, ilo = (header.index(c) for c in ("GEOID", "ALAND", "INTPTLAT", "INTPTLONG"))
        tracts = {r[ig].strip(): (float(r[ila]), float(r[ilo]), float(r[ia])) for r in rows if len(r) > ilo}
        print(f"  gazetteer {y}: {len(tracts):,} tracts")
        return y, tracts
    raise RuntimeError("No Gazetteer tract file found")


def fetch_tracts(year, key, fips):
    params = f"get=NAME,{','.join(VARS)}&for=tract:*&in=state:{fips}&key={key}"
    status, body, final = http_get(f"{ACS5.format(y=year)}?{params}")
    if status != 200 or not body.startswith("["):
        raise RuntimeError(f"ACS5 tract request failed for state {fips}: {status} {final}")
    rows = json.loads(body)
    h = rows[0]
    idx = {c: i for i, c in enumerate(h)}
    out = []
    for r in rows[1:]:
        geoid = r[idx["state"]] + r[idx["county"]] + r[idx["tract"]]
        v = {c: max(0, int(float(r[idx[c]] or 0))) for c in VARS}
        out.append((geoid, r[idx["NAME"]], v))
    return out


def main():
    key = load_key()
    manifest = json.loads((ROOT / "data" / "manifest.json").read_text())
    years = manifest["s0101"]["vintages"]
    for year in years:
        build(year, key)


def build(year, key):
    src = (ROOT / "data" / "s0101" / f"{year}.json").read_bytes()
    s0101 = json.loads(src)
    acs5_year = pick_year(year, key)
    # Placement only changes when S0101 or the ACS 5-year release changes; skip the ~5 minute rebuild otherwise.
    inputs = hashlib.sha256(src + str(acs5_year).encode()).hexdigest()
    meta_path = ROOT / "data" / "s0101" / f"dots-{year}.json"
    if meta_path.exists() and (ROOT / "data" / "s0101" / f"dots-{year}.bin").exists() \
            and json.loads(meta_path.read_text()).get("inputs") == inputs and "--force" not in sys.argv:
        print(f"Dots for {year} are up to date (ACS5 {acs5_year}); skipping")
        return
    gaz_year, gaz = load_gazetteer(acs5_year)
    print(f"Building dots for S0101 {year} using ACS5 {acs5_year} tracts")

    states = sorted(f for f, g in s0101["states"].items() if (g["v"].get("C01_001") or [None])[0])
    counts, coords = [], array.array("H")
    counties = {}
    for fips in states:
        g = s0101["states"][fips]["v"]
        tracts = [(gid, name, v) for gid, name, v in fetch_tracts(acs5_year, key, fips) if gid in gaz]
        # county aggregates for annotations
        for gid, name, v in tracts:
            c = counties.setdefault(gid[:5], {"name": name.split("; ")[1] if "; " in name else name,
                                              "state": name.split("; ")[-1], "pop": 0, "u18": 0, "o65": 0, "lat": 0.0, "lon": 0.0})
            pop = sum(v.values())
            lat, lon, _ = gaz[gid]
            c["pop"] += pop
            c["u18"] += sum(v[var(r, f)] for f in (0, 1) for r in UNDER18_ROWS)
            c["o65"] += sum(v[var(r, f)] for f in (0, 1) for r in OVER65_ROWS)
            c["lat"] += lat * pop
            c["lon"] += lon * pop
        state_counts = []
        for sex, col in ((0, "C03"), (1, "C05")):
            for b in range(NB):
                total = (g.get(f"{col}_{b + 2:03d}") or [0])[0] or 0
                n = round_half_up(total / PER_DOT)
                state_counts.append(n)
                if not n:
                    continue
                weights = [sum(v[var(r, sex)] for r in BAND_ROWS[b]) for _, _, v in tracts]
                if sum(weights) == 0:
                    weights = [sum(v.values()) for _, _, v in tracts]
                cum, acc = [], 0
                for w in weights:
                    acc += w
                    cum.append(acc)
                rng = random.Random(f"{fips}-{sex}-{b}-{year}")
                for _ in range(n):
                    k = _bisect(cum, rng.random() * acc)
                    lat, lon, aland = gaz[tracts[k][0]]
                    radius = math.sqrt(max(aland, 2.0e4) / math.pi) * 0.9
                    r, th = radius * math.sqrt(rng.random()), rng.random() * 2 * math.pi
                    lat2 = lat + r * math.cos(th) / 111320.0
                    lon2 = lon + r * math.sin(th) / (111320.0 * max(0.2, math.cos(math.radians(lat))))
                    coords.append(_q((lon2 - LON0) / LON_SPAN))
                    coords.append(_q((lat2 - LAT0) / LAT_SPAN))
        counts.append(state_counts)
        print(f"  {fips}: {len(tracts):,} tracts, {sum(state_counts):,} dots")

    out = ROOT / "data" / "s0101"
    if sys.byteorder != "little":
        coords.byteswap()
    (out / f"dots-{year}.bin").write_bytes(coords.tobytes())
    meta = {
        "year": year, "acs5_year": acs5_year, "gazetteer_year": gaz_year, "per_dot": PER_DOT,
        "order": "state (fips asc) > sex (male, female) > age band (<5 … 85+)",
        "fips": states, "counts": counts, "dots": len(coords) // 2,
        "lon": [LON0, LON_SPAN], "lat": [LAT0, LAT_SPAN], "inputs": inputs,
    }
    (out / f"dots-{year}.json").write_text(json.dumps(meta, separators=(",", ":"), sort_keys=True) + "\n")

    big = [dict(c, fips=k, p65=c["o65"] / c["pop"] * 100, p18=c["u18"] / c["pop"] * 100,
                lat=c["lat"] / c["pop"], lon=c["lon"] / c["pop"])
           for k, c in counties.items() if c["pop"] >= 50000]
    keep = ("fips", "name", "state", "pop", "p65", "p18", "lat", "lon")
    trim = lambda c: {k: (round(c[k], 3) if isinstance(c[k], float) else c[k]) for k in keep}  # noqa: E731
    places = {
        "acs5_year": acs5_year, "min_pop": 50000,
        "oldest": [trim(c) for c in sorted(big, key=lambda c: -c["p65"])[:3]],
        "youngest": [trim(c) for c in sorted(big, key=lambda c: -c["p18"])[:3]],
    }
    (out / f"places-{year}.json").write_text(json.dumps(places, indent=1, sort_keys=True) + "\n")
    print(f"  wrote dots-{year}.bin ({len(coords) // 2:,} dots, {len(coords) * 2 / 1e6:.1f} MB)")


def _bisect(cum, x):
    lo, hi = 0, len(cum) - 1
    while lo < hi:
        mid = (lo + hi) // 2
        if cum[mid] > x:
            hi = mid
        else:
            lo = mid + 1
    return lo


def _q(t):
    return max(0, min(65535, int(round(t * 65535))))


if __name__ == "__main__":
    main()
