# Data Pulse

Live dashboards built on US government open data. A GitHub Action refreshes them every day.

**Dashboard 1: Age & Sex.** Census ACS 1-year table [S0101](https://data.census.gov/table/ACSST1Y2024.S0101) for the US and every state (plus DC and Puerto Rico). It shows national KPIs, auto-generated "what stands out" facts, a state choropleth with a ranking, and a population pyramid that compares any state with the US. Rankings and comparisons are checked against margins of error.

## How it works
```
scripts/fetch_s0101.py   → data/s0101/<year>.json + data/manifest.json   (Python, stdlib only)
index.html + assets/     → static site (D3 from CDN, no build step)
.github/workflows/daily.yml → 11:00 UTC daily: fetch → commit if changed → deploy to GitHub Pages
```
The fetcher also checks for newer ACS vintages (2025, …). When the Census Bureau publishes one, it's picked up automatically and appears in the "Survey year" menu. `manifest.json` records `last_checked` (every run) and `last_changed` (only when the data actually changed), and the site header shows both.

## Setup
1. Get a free Census API key: https://api.census.gov/data/key_signup.html
2. Local run:
   ```bash
   cp .env.example .env              # paste your key into .env
   python3 scripts/fetch_s0101.py
   python3 -m http.server 8000       # open http://localhost:8000
   ```
3. GitHub:
   - Create a repo and push this folder to `main`.
   - **Settings → Secrets and variables → Actions → New repository secret:** `CENSUS_API_KEY`.
   - **Settings → Pages → Source:** *GitHub Actions*.
   - **Actions → "Daily data refresh & deploy" → Run workflow** for the first deploy.

## Adding a dashboard
Follow the same pattern: add a fetcher `scripts/fetch_<id>.py` that writes `data/<id>/` and updates `manifest.json`, add a step to the workflow, and add a page and tab.
