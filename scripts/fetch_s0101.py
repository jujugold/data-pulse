#!/usr/bin/env python3
"""Fetch ACS 1-year subject table S0101 (Age and Sex) for the US and all states.

Writes:
  data/s0101/<year>.json   one file per available vintage
  data/manifest.json       freshness metadata (last_checked / last_changed / hash)

Standard library only so it runs anywhere (local or GitHub Actions).
"""
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
TABLE = "S0101"
TABLE_DIR = DATA_DIR / TABLE.lower()
BASE_YEAR = 2024          # the vintage this dashboard was built around
MAX_PROBE_AHEAD = 3       # look for up to 3 newer vintages each run
API = "https://api.census.gov/data/{year}/acs/acs1/subject"

# Census uses large negative sentinels for "not available" / "not applicable".
SENTINELS = {-666666666, -999999999, -888888888, -222222222, -333333333, -555555555}


def load_key():
    key = os.environ.get("CENSUS_API_KEY", "").strip()
    env_file = ROOT / ".env"
    if not key and env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.strip().startswith("CENSUS_API_KEY="):
                key = line.split("=", 1)[1].strip().strip('"').strip("'")
    if not key:
        sys.exit("CENSUS_API_KEY is not set (env var or .env). Get one at "
                 "https://api.census.gov/data/key_signup.html")
    return key


def http_get(url, retries=4):
    """GET returning (status, text). 404 is returned rather than raised."""
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "gov-data-dashboard/1.0"})
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.status, resp.read().decode("utf-8"), resp.geturl()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return 404, "", url
            err = e
        except (urllib.error.URLError, TimeoutError) as e:
            err = e
        wait = 2 ** attempt
        print(f"  request failed ({err}); retrying in {wait}s", file=sys.stderr)
        time.sleep(wait)
    raise RuntimeError(f"giving up on {url}: {err}")


def vintage_exists(year):
    status, body, final = http_get(f"{API.format(year=year)}/groups/{TABLE}.json")
    return status == 200 and "missing" not in final and body.lstrip().startswith("{")


def fetch_labels(year):
    _, body, _ = http_get(f"{API.format(year=year)}/groups/{TABLE}.json")
    variables = json.loads(body)["variables"]
    labels = {}
    for name, meta in variables.items():
        # Keep one label per row number, taken from the Total column.
        if name.startswith(f"{TABLE}_C01_") and name.endswith("E"):
            row = name.split("_")[2][:-1]
            labels[row] = meta["label"].replace("Estimate!!Total!!", "").split("!!")
    return dict(sorted(labels.items()))


def to_num(v):
    if v in (None, "", "null", "N", "(X)", "-"):
        return None
    try:
        n = float(v)
    except ValueError:
        return None
    if int(n) in SENTINELS:
        return None
    return int(n) if n.is_integer() else n


def fetch_geo(year, key, geo):
    params = urllib.parse.urlencode({"get": f"NAME,group({TABLE})", "for": geo, "key": key},
                                    safe="(),:*")
    status, body, final = http_get(f"{API.format(year=year)}?{params}")
    if status != 200 or "missing_key" in final or "invalid_key" in final:
        raise RuntimeError(f"Census API rejected request for {geo} {year} "
                           f"(status {status}, url {final}). Check CENSUS_API_KEY.")
    try:
        rows = json.loads(body)
    except json.JSONDecodeError:
        raise RuntimeError(f"Non-JSON response for {geo} {year}: {body[:200]}")
    header, records = rows[0], rows[1:]
    out = {}
    for rec in records:
        r = dict(zip(header, rec))
        fips = r.get("state") or "US"
        values = {}
        for col, val in r.items():
            if not col.startswith(f"{TABLE}_C"):
                continue
            # S0101_C01_001E -> C01_001 ; skip annotation cols (EA / MA)
            suffix = col[-1]
            if col.endswith(("EA", "MA")) or suffix not in "EM":
                continue
            short = col[len(TABLE) + 1:-1]
            values.setdefault(short, [None, None])[0 if suffix == "E" else 1] = to_num(val)
        out[fips] = {"name": r["NAME"], "v": dict(sorted(values.items()))}
    return out


def build_vintage(year, key):
    print(f"Fetching {TABLE} {year} …")
    us = fetch_geo(year, key, "us:1")
    states = fetch_geo(year, key, "state:*")
    return {
        "table": TABLE,
        "year": year,
        "dataset": "acs/acs1/subject",
        "source": f"https://data.census.gov/table/ACSST1Y{year}.{TABLE}",
        "labels": fetch_labels(year),
        "us": us["US"],
        "states": dict(sorted(states.items())),
    }


def dump(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def main():
    key = load_key()
    TABLE_DIR.mkdir(parents=True, exist_ok=True)

    years = [BASE_YEAR]
    for y in range(BASE_YEAR + 1, BASE_YEAR + 1 + MAX_PROBE_AHEAD):
        if y == 2020:
            continue  # no standard ACS 1-year release for 2020
        if vintage_exists(y):
            years.append(y)
        else:
            break

    digest = hashlib.sha256()
    for year in years:
        payload = dump(build_vintage(year, key))
        (TABLE_DIR / f"{year}.json").write_text(payload + "\n")
        digest.update(payload.encode())
        print(f"  wrote data/{TABLE.lower()}/{year}.json ({len(payload)/1024:.0f} KB)")

    manifest_path = DATA_DIR / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    entry = manifest.get(TABLE.lower(), {})
    new_hash = digest.hexdigest()
    if entry.get("hash") != new_hash:
        entry["last_changed"] = now
        print("  data changed")
    else:
        print("  data unchanged")
    entry.update({"hash": new_hash, "vintages": years, "latest": max(years), "last_checked": now})
    manifest[TABLE.lower()] = entry
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
