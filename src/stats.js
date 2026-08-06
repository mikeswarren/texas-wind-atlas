/**
 * Client-side rollups over the turbine features.
 *
 * Why not precompute these in the ETL: the UI filters by manufacturer and by
 * minimum capacity. A baked-in rollup would silently disagree with the map the
 * moment a filter is on -- the stat tiles would report all 19,380 turbines
 * while the map drew 3,784. Recomputing costs ~2 ms over 19k features, which
 * is cheap enough to do on every filter change and worth it for numbers that
 * are always true of what's on screen.
 *
 * Recomputed on FILTER change only. Moving the year scrubber just indexes into
 * the arrays this produces, so scrubbing stays allocation-free.
 */

import { P } from './layers.js'

/**
 * Median from a value->count histogram. Hub heights take only ~100 distinct
 * values across the whole state, so walking the histogram beats re-sorting a
 * growing array once per year.
 */
function medianFromHistogram(hist, total) {
  if (!total) return null
  const keys = [...hist.keys()].sort((a, b) => a - b)
  const half = total / 2
  let seen = 0
  let lower = null
  for (const k of keys) {
    seen += hist.get(k)
    if (total % 2 === 1) {
      if (seen > half) return k
    } else {
      if (lower === null && seen >= half) lower = k
      if (seen > half) return lower === k ? k : (lower + k) / 2
    }
  }
  return keys[keys.length - 1]
}

/**
 * @param {Array} features  turbine GeoJSON features
 * @param {{manufacturer: string, minCap: number}} filters
 * @param {number} yearMin
 * @param {number} yearMax
 */
export function buildIndex(features, filters, yearMin, yearMax) {
  const span = yearMax - yearMin + 1
  const addedN = new Int32Array(span)
  const addedMw = new Float64Array(span)
  const hubsByYear = Array.from({ length: span }, () => [])

  /** fips (int) -> Float64Array of cumulative MW by year index */
  const countyMw = new Map()
  const countyN = new Map()

  let matched = 0
  for (const f of features) {
    const p = f.properties
    if (filters.manufacturer !== 'all' && p[P.manu] !== filters.manufacturer) continue
    const cap = p[P.cap] || 0
    if (filters.minCap > 0 && cap < filters.minCap) continue

    const i = p[P.year] - yearMin
    if (i < 0 || i >= span) continue
    matched++
    addedN[i] += 1
    addedMw[i] += cap / 1000
    if (p[P.hub]) hubsByYear[i].push(p[P.hub])

    const fips = Number(p[P.fips])
    if (fips) {
      let mw = countyMw.get(fips)
      if (!mw) {
        mw = new Float64Array(span)
        countyMw.set(fips, mw)
        countyN.set(fips, new Int32Array(span))
      }
      mw[i] += cap / 1000
      countyN.get(fips)[i] += 1
    }
  }

  // Turn per-year buckets into running totals, in place.
  for (const arr of countyMw.values()) {
    for (let i = 1; i < span; i++) arr[i] += arr[i - 1]
  }
  for (const arr of countyN.values()) {
    for (let i = 1; i < span; i++) arr[i] += arr[i - 1]
  }

  // Median hub height is cumulative-to-date, not just the year's new machines:
  // "the median turbine standing in 1999 sat at 65 m, in 2025 at 100 m" is the
  // story, and a year with no installs would otherwise report nothing.
  const hist = new Map()
  let histTotal = 0
  const perYear = []
  let cumN = 0
  let cumMw = 0
  for (let i = 0; i < span; i++) {
    cumN += addedN[i]
    cumMw += addedMw[i]
    for (const h of hubsByYear[i]) {
      hist.set(h, (hist.get(h) || 0) + 1)
      histTotal++
    }

    let counties = 0
    for (const arr of countyN.values()) if (arr[i] > 0) counties++

    perYear.push({
      year: yearMin + i,
      added: addedN[i],
      addedMw: addedMw[i],
      cumulative: cumN,
      cumulativeMw: cumMw,
      medianHub: medianFromHistogram(hist, histTotal),
      counties,
    })
  }

  return {
    yearMin,
    yearMax,
    perYear,
    countyMw,
    countyN,
    matched,
    total: features.length,
    maxAddedMw: Math.max(...addedMw),
  }
}

export const fmt = {
  int: (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-US')),
  mw: (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-US')),
  one: (n) => (n == null ? '—' : n.toFixed(1)),
}
