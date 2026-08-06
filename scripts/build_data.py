#!/usr/bin/env python3
"""Build the Texas Wind Atlas datasets from public sources.

Sources
-------
USWTDB  U.S. Wind Turbine Database (USGS / LBNL / ACP), public PostgREST API.
        https://energy.usgs.gov/uswtdb/  --  public domain (USGS)
Counties  Census cartographic county boundaries, pre-simplified GeoJSON mirror.

Outputs (public/data/)
---------------------
turbines.geojson   one point per Texas turbine, short property keys
counties.geojson   254 Texas counties with joined wind statistics
summary.json       statewide rollups: per-year build-out, manufacturers, records

Raw API pages are cached under scripts/.cache/ so re-runs don't hammer USGS.
Run:  python3 scripts/build_data.py [--refresh]
"""

from __future__ import annotations

import argparse
import gzip
import json
import statistics
import sys
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

USWTDB = "https://energy.usgs.gov/api/uswtdb/v1/turbines"
COUNTIES_URL = (
    "https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json"
)
TX_FIPS = "48"
PAGE = 5000

# Only the columns the atlas actually uses -- keeps the payload honest and small.
COLUMNS = [
    "case_id", "p_name", "p_year", "p_cap", "p_tnum",
    "t_manu", "t_model", "t_cap", "t_hh", "t_rd", "t_ttlh",
    "t_county", "t_fips", "t_retrofit", "xlong", "ylat",
]

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "scripts" / ".cache"
OUT = ROOT / "public" / "data"


def fetch(url: str, cache_name: str, refresh: bool) -> bytes:
    """GET with an on-disk cache. USWTDB updates quarterly; no need to re-pull."""
    CACHE.mkdir(parents=True, exist_ok=True)
    cached = CACHE / cache_name
    if cached.exists() and not refresh:
        return cached.read_bytes()
    req = urllib.request.Request(url, headers={"User-Agent": "texas-wind-atlas/1.0"})
    with urllib.request.urlopen(req, timeout=90) as resp:
        body = resp.read()
    cached.write_bytes(body)
    return body


def fetch_turbines(refresh: bool) -> list[dict]:
    """Page through every Texas turbine record."""
    rows: list[dict] = []
    offset = 0
    while True:
        url = (
            f"{USWTDB}?t_state=eq.TX&select={','.join(COLUMNS)}"
            f"&order=case_id.asc&limit={PAGE}&offset={offset}"
        )
        page = json.loads(fetch(url, f"turbines_{offset:06d}.json", refresh))
        rows.extend(page)
        print(f"  fetched {len(rows):,} turbines", file=sys.stderr)
        if len(page) < PAGE:
            break
        offset += PAGE
    return rows


def impute_years(rows: list[dict]) -> tuple[int, int]:
    """Fill a missing commission year from the median year of its own wind farm.

    ~100 Texas records carry no p_year. Nearly all belong to a project whose
    other turbines are dated, so the project median is a defensible fill and it
    keeps those turbines on the timeline instead of silently dropping them.
    Anything still unknown is excluded from the map and reported in the UI.
    """
    by_project: dict[str, list[int]] = defaultdict(list)
    for r in rows:
        if r.get("p_year") and r.get("p_name"):
            by_project[r["p_name"]].append(int(r["p_year"]))

    imputed = unknown = 0
    for r in rows:
        if r.get("p_year"):
            r["_year_src"] = "reported"
            continue
        peers = by_project.get(r.get("p_name") or "")
        if peers:
            r["p_year"] = int(statistics.median(peers))
            r["_year_src"] = "imputed"
            imputed += 1
        else:
            r["_year_src"] = "unknown"
            unknown += 1
    return imputed, unknown


def num(value, digits: int = 1):
    """Round to a sane precision, preserving None rather than inventing a zero."""
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return round(f, digits) if digits else int(f)


def build_turbines(rows: list[dict]) -> tuple[dict, list[dict]]:
    """Slim GeoJSON. Short keys because 19k features pay for every byte."""
    features = []
    mapped = []
    for r in rows:
        if r["_year_src"] == "unknown":
            continue
        if r.get("xlong") is None or r.get("ylat") is None:
            continue
        props = {
            "y": int(r["p_year"]),                 # commission year
            "c": num(r.get("t_cap"), 0),           # turbine capacity, kW
            "h": num(r.get("t_hh")),               # hub height, m
            "r": num(r.get("t_rd")),               # rotor diameter, m
            "t": num(r.get("t_ttlh")),             # total tip height, m
            "m": r.get("t_manu") or "Unknown",     # manufacturer
            "mo": r.get("t_model") or "",          # model
            "p": r.get("p_name") or "",            # project / wind farm
            "f": r.get("t_fips") or "",            # county FIPS
            "co": (r.get("t_county") or "").replace(" County", ""),
        }
        if r.get("t_retrofit"):
            props["rf"] = 1
        if r["_year_src"] == "imputed":
            props["yi"] = 1
        features.append({
            "type": "Feature",
            "geometry": {
                "type": "Point",
                # 5 decimals ~= 1 m; plenty for turbine pads, half the bytes.
                "coordinates": [round(float(r["xlong"]), 5), round(float(r["ylat"]), 5)],
            },
            "properties": props,
        })
        mapped.append(r)
    return {"type": "FeatureCollection", "features": features}, mapped


def build_counties(rows: list[dict], refresh: bool) -> tuple[dict, dict]:
    """Texas counties with joined all-time turbine statistics.

    Per-year cumulative values are deliberately NOT baked in here. The UI lets
    you filter by manufacturer and capacity, and a precomputed rollup would go
    stale the moment a filter is applied -- so the client recomputes county
    totals from the turbine features it already has (src/stats.js). These
    properties are the unfiltered all-time context shown alongside.
    """
    raw = json.loads(fetch(COUNTIES_URL, "us_counties.json", refresh))

    stats: dict[str, dict] = defaultdict(
        lambda: {"n": 0, "mw": 0.0, "first": None, "last": None, "hh": [], "projects": set()}
    )
    for r in rows:
        fips = r.get("t_fips")
        if not fips:
            continue
        s = stats[fips]
        mw = (float(r["t_cap"]) / 1000.0) if r.get("t_cap") else 0.0
        year = int(r["p_year"])
        s["n"] += 1
        s["mw"] += mw
        s["first"] = year if s["first"] is None else min(s["first"], year)
        s["last"] = year if s["last"] is None else max(s["last"], year)
        if r.get("t_hh"):
            s["hh"].append(float(r["t_hh"]))
        if r.get("p_name"):
            s["projects"].add(r["p_name"])

    features = []
    for feat in raw["features"]:
        fips = feat.get("id") or feat["properties"].get("GEO_ID", "")[-5:]
        if not fips.startswith(TX_FIPS):
            continue
        s = stats.get(fips)
        props = {
            "fips": fips,
            "name": feat["properties"].get("NAME", ""),
            "n": s["n"] if s else 0,
            "mw": round(s["mw"], 1) if s else 0.0,
            "first": s["first"] if s else None,
            "last": s["last"] if s else None,
            "hh": round(statistics.mean(s["hh"]), 1) if s and s["hh"] else None,
            "projects": len(s["projects"]) if s else 0,
        }
        features.append({"type": "Feature", "id": int(fips), "geometry": feat["geometry"], "properties": props})

    features.sort(key=lambda f: -f["properties"]["mw"])
    return {"type": "FeatureCollection", "features": features}, stats


def build_summary(rows: list[dict], counties: dict, imputed: int, unknown: int) -> dict:
    """Statewide rollups the UI reads directly -- no client-side aggregation."""
    per_year: dict[int, dict] = defaultdict(lambda: {"n": 0, "mw": 0.0})
    manufacturers: Counter = Counter()
    manu_mw: dict[str, float] = defaultdict(float)
    projects: dict[str, dict] = {}
    hub_by_year: dict[int, list[float]] = defaultdict(list)

    for r in rows:
        year = int(r["p_year"])
        mw = (float(r["t_cap"]) / 1000.0) if r.get("t_cap") else 0.0
        per_year[year]["n"] += 1
        per_year[year]["mw"] += mw
        manu = r.get("t_manu") or "Unknown"
        manufacturers[manu] += 1
        manu_mw[manu] += mw
        if r.get("t_hh"):
            hub_by_year[year].append(float(r["t_hh"]))
        name = r.get("p_name")
        if name:
            p = projects.setdefault(name, {"name": name, "n": 0, "mw": 0.0, "year": year, "county": (r.get("t_county") or "").replace(" County", "")})
            p["n"] += 1
            p["mw"] += mw
            p["year"] = min(p["year"], year)

    years = sorted(per_year)
    timeline = []
    cum_n = 0
    cum_mw = 0.0
    for y in range(years[0], years[-1] + 1):
        cum_n += per_year[y]["n"]
        cum_mw += per_year[y]["mw"]
        timeline.append({
            "year": y,
            "added": per_year[y]["n"],
            "addedMw": round(per_year[y]["mw"], 1),
            "cumulative": cum_n,
            "cumulativeMw": round(cum_mw, 1),
            "medianHubHeight": round(statistics.median(hub_by_year[y]), 1) if hub_by_year[y] else None,
        })

    tallest = max(rows, key=lambda r: float(r["t_ttlh"] or 0))
    biggest = max(rows, key=lambda r: float(r["t_cap"] or 0))
    top_counties = [
        {k: v for k, v in f["properties"].items() if k not in ("cum", "cumN")}
        for f in counties["features"][:12]
        if f["properties"]["n"] > 0
    ]

    return {
        "generated": "see README -- rebuild with scripts/build_data.py",
        "source": "U.S. Wind Turbine Database (USGS/LBNL/ACP), Texas subset",
        "turbines": len(rows),
        "totalMw": round(sum(v["mw"] for v in per_year.values()), 1),
        "counties": sum(1 for f in counties["features"] if f["properties"]["n"] > 0),
        "projects": len(projects),
        "yearMin": years[0],
        "yearMax": years[-1],
        "imputedYears": imputed,
        "unknownYears": unknown,
        "timeline": timeline,
        "manufacturers": [
            {"name": m, "n": n, "mw": round(manu_mw[m], 1)}
            for m, n in manufacturers.most_common(8)
        ],
        "topCounties": top_counties,
        "topProjects": sorted(
            ({**p, "mw": round(p["mw"], 1)} for p in projects.values()),
            key=lambda p: -p["mw"],
        )[:10],
        "records": {
            "tallest": {
                "project": tallest.get("p_name"),
                "county": (tallest.get("t_county") or "").replace(" County", ""),
                "tipHeight": num(tallest.get("t_ttlh")),
                "hubHeight": num(tallest.get("t_hh")),
                "year": int(tallest["p_year"]),
            },
            "largest": {
                "project": biggest.get("p_name"),
                "county": (biggest.get("t_county") or "").replace(" County", ""),
                "capacityKw": num(biggest.get("t_cap"), 0),
                "model": biggest.get("t_model"),
                "year": int(biggest["p_year"]),
            },
        },
    }


def write(path: Path, payload: dict, minify: bool = True) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, separators=(",", ":") if minify else None, indent=None if minify else 2)
    path.write_text(text)
    raw_kb = len(text) / 1024
    gz_kb = len(gzip.compress(text.encode())) / 1024
    print(f"  wrote {path.relative_to(ROOT)}  {raw_kb:,.0f} KB  ({gz_kb:,.0f} KB gzipped)")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true", help="bypass the local API cache")
    args = ap.parse_args()

    print("Fetching USWTDB Texas turbines...", file=sys.stderr)
    rows = fetch_turbines(args.refresh)

    imputed, unknown = impute_years(rows)
    print(f"  {imputed} commission years imputed from project median, {unknown} still unknown")

    turbines, mapped = build_turbines(rows)
    counties, _ = build_counties(mapped, args.refresh)
    summary = build_summary(mapped, counties, imputed, unknown)

    write(OUT / "turbines.geojson", turbines)
    write(OUT / "counties.geojson", counties)
    write(OUT / "summary.json", summary, minify=False)

    print(
        f"\n{summary['turbines']:,} turbines mapped  |  {summary['totalMw']:,.0f} MW  |  "
        f"{summary['counties']} counties  |  {summary['yearMin']}-{summary['yearMax']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
