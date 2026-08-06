/**
 * Client-side rollups over the turbine features.
 *
 * Why not precompute these in the ETL: the UI filters by manufacturer and by
 * minimum capacity. A baked-in rollup would silently disagree with the map the
 * moment a filter is on -- the stat tiles would report all 19,380 turbines
 * while the map drew 3,784. Recomputing costs a few ms over 19k features, which
 * is cheap enough to do on every filter change and worth it for numbers that
 * are always true of what's on screen.
 *
 * Recomputed on FILTER change only. Moving the year scrubber just indexes into
 * the arrays this produces, so scrubbing stays allocation-free -- which is what
 * lets the whole analytics dashboard follow the scrubber at 60fps.
 *
 * EVERY series here is cumulative-to-year ("what was standing at the end of
 * year Y"), except `added`/`addedMw`, which are per-year flows. Mixing the two
 * in one chart is the fastest way to publish a wrong number, so the two kinds
 * are named differently on purpose.
 */

import { P } from './layers.js'

/**
 * Nameplate-capacity classes, in kW. Boundaries follow the actual technology
 * generations in the Texas fleet (1.5 MW GE workhorse, 2 MW class, the post-2018
 * 2.5-3 MW machines, and the 4 MW+ units) rather than an even split.
 */
export const CAP_BUCKETS = [
  { label: '<1.0', lo: 0, hi: 1000 },
  { label: '1.0–1.5', lo: 1000, hi: 1500 },
  { label: '1.5–2.0', lo: 1500, hi: 2000 },
  { label: '2.0–2.5', lo: 2000, hi: 2500 },
  { label: '2.5–3.0', lo: 2500, hi: 3000 },
  { label: '3.0–4.0', lo: 3000, hi: 4000 },
  { label: '4.0+', lo: 4000, hi: Infinity },
]

function bucketOf(kw) {
  for (let i = 0; i < CAP_BUCKETS.length; i++) {
    if (kw >= CAP_BUCKETS[i].lo && kw < CAP_BUCKETS[i].hi) return i
  }
  return CAP_BUCKETS.length - 1
}

/**
 * Median from a value->count histogram. Hub heights and rotor diameters take
 * only ~100 distinct values across the whole state, so walking the histogram
 * beats re-sorting a growing array once per year.
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

/** Running total in place. */
function cumulate(arr) {
  for (let i = 1; i < arr.length; i++) arr[i] += arr[i - 1]
  return arr
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
  const rotorsByYear = Array.from({ length: span }, () => [])

  /** fips (int) -> Float64Array of cumulative MW by year index */
  const countyMw = new Map()
  const countyN = new Map()
  /** county display name, for the ranked-county chart */
  const countyName = new Map()

  /** manufacturer -> per-year flows, cumulated below */
  const manuMw = new Map()
  const manuN = new Map()

  /** capacity class -> per-year flows, cumulated below */
  const bucketN = CAP_BUCKETS.map(() => new Int32Array(span))
  const bucketMw = CAP_BUCKETS.map(() => new Float64Array(span))

  /** project -> earliest matching year index, so a project counts once */
  const projectFirst = new Map()

  let matched = 0
  for (const f of features) {
    const p = f.properties
    if (filters.manufacturer !== 'all' && p[P.manu] !== filters.manufacturer) continue
    const cap = p[P.cap] || 0
    if (filters.minCap > 0 && cap < filters.minCap) continue

    const i = p[P.year] - yearMin
    if (i < 0 || i >= span) continue
    matched++
    const mw = cap / 1000
    addedN[i] += 1
    addedMw[i] += mw
    if (p[P.hub]) hubsByYear[i].push(p[P.hub])
    if (p[P.rotor]) rotorsByYear[i].push(p[P.rotor])

    const b = bucketOf(cap)
    bucketN[b][i] += 1
    bucketMw[b][i] += mw

    const manu = p[P.manu] || 'Unknown'
    if (!manuMw.has(manu)) {
      manuMw.set(manu, new Float64Array(span))
      manuN.set(manu, new Int32Array(span))
    }
    manuMw.get(manu)[i] += mw
    manuN.get(manu)[i] += 1

    const project = p[P.project]
    if (project) {
      const prev = projectFirst.get(project)
      if (prev === undefined || i < prev) projectFirst.set(project, i)
    }

    const fips = Number(p[P.fips])
    if (fips) {
      let arr = countyMw.get(fips)
      if (!arr) {
        arr = new Float64Array(span)
        countyMw.set(fips, arr)
        countyN.set(fips, new Int32Array(span))
        countyName.set(fips, p[P.county] || String(fips))
      }
      arr[i] += mw
      countyN.get(fips)[i] += 1
    }
  }

  // Per-year flows -> cumulative standing totals.
  for (const arr of countyMw.values()) cumulate(arr)
  for (const arr of countyN.values()) cumulate(arr)
  for (const arr of manuMw.values()) cumulate(arr)
  for (const arr of manuN.values()) cumulate(arr)
  for (const arr of bucketN) cumulate(arr)
  for (const arr of bucketMw) cumulate(arr)

  // Projects standing by year: count each project at its first matching year.
  const projectsByYear = new Int32Array(span)
  for (const first of projectFirst.values()) projectsByYear[first] += 1
  cumulate(projectsByYear)

  // Median hub height and rotor diameter are cumulative-to-date, not just the
  // year's new machines: "the median turbine standing in 1999 sat at 65 m, in
  // 2025 at 100 m" is the story, and a year with no installs would otherwise
  // report nothing at all.
  const hubHist = new Map()
  const rotorHist = new Map()
  let hubTotal = 0
  let rotorTotal = 0
  const perYear = []
  let cumN = 0
  let cumMw = 0
  for (let i = 0; i < span; i++) {
    cumN += addedN[i]
    cumMw += addedMw[i]
    for (const h of hubsByYear[i]) {
      hubHist.set(h, (hubHist.get(h) || 0) + 1)
      hubTotal++
    }
    for (const r of rotorsByYear[i]) {
      rotorHist.set(r, (rotorHist.get(r) || 0) + 1)
      rotorTotal++
    }

    let counties = 0
    for (const arr of countyN.values()) if (arr[i] > 0) counties++

    perYear.push({
      year: yearMin + i,
      added: addedN[i],
      addedMw: addedMw[i],
      cumulative: cumN,
      cumulativeMw: cumMw,
      medianHub: medianFromHistogram(hubHist, hubTotal),
      medianRotor: medianFromHistogram(rotorHist, rotorTotal),
      // Fleet-average machine size. The single clearest read on the technology
      // shift: 0.9 MW in 1999, ~2.3 MW by 2025.
      avgMw: cumN ? cumMw / cumN : null,
      projects: projectsByYear[i],
      counties,
    })
  }

  return {
    yearMin,
    yearMax,
    perYear,
    countyMw,
    countyN,
    countyName,
    manuMw,
    manuN,
    bucketN,
    bucketMw,
    matched,
    total: features.length,
    maxAddedMw: Math.max(...addedMw),
    maxCumMw: cumMw,
  }
}

/* ------------------------------------------------- year-slice derived views */

/** Rank a Map<key, cumulative-array> at one year. Returns all rows, sorted. */
function rankAt(map, i, nameOf = (k) => String(k)) {
  const rows = []
  for (const [key, arr] of map) {
    const value = arr[i]
    if (value > 0) rows.push({ key, label: nameOf(key), value })
  }
  return rows.sort((a, b) => b.value - a.value)
}

/**
 * Top-N ranked rows plus a separate summary of the remainder.
 *
 * The tail is returned OUTSIDE `rows` on purpose. Texas has 102 wind counties and
 * the 92 outside the top 10 hold ~69% of all capacity, so folding them into an
 * eleventh bar made that bar the longest thing on the chart and squashed every
 * real county into a sliver -- the ranking became unreadable in service of a row
 * nobody was ranking. The tail is reported as a caption instead: the total is
 * still fully disclosed (never a silent truncation), it just doesn't set the
 * length scale.
 */
export function topWithOther(map, i, limit, nameOf) {
  const all = rankAt(map, i, nameOf)
  const total = all.reduce((s, r) => s + r.value, 0)
  if (all.length <= limit) return { rows: all, total, other: null }
  const tail = all.slice(limit)
  return {
    rows: all.slice(0, limit),
    total,
    other: { count: tail.length, value: tail.reduce((s, r) => s + r.value, 0) },
  }
}

export function rankedCounties(index, i, limit) {
  return topWithOther(index.countyMw, i, limit, (fips) => `${index.countyName.get(fips)} County`)
}

export function rankedManufacturers(index, i, limit) {
  return topWithOther(index.manuMw, i, limit, (name) => name)
}

/**
 * Share of installed capacity held by the top N counties -- a plain
 * concentration read. Texas wind is far more concentrated than "102 counties"
 * suggests, and this is the number that says so.
 */
export function topShare(index, i, n = 5) {
  const rows = rankAt(index.countyMw, i)
  if (!rows.length) return null
  const total = rows.reduce((s, r) => s + r.value, 0)
  if (!total) return null
  const head = rows.slice(0, n).reduce((s, r) => s + r.value, 0)
  return head / total
}

/** Capacity-class distribution at one year. */
export function capacityMix(index, i) {
  return CAP_BUCKETS.map((b, k) => ({
    label: b.label,
    value: index.bucketN[k][i],
    mw: index.bucketMw[k][i],
  }))
}

export const fmt = {
  int: (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-US')),
  mw: (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-US')),
  /**
   * Compact form for axis ticks only. A tick reading "40,000" needs ~40px of
   * gutter; "40k" needs 16px, and the axis is the one place where the exact
   * digits are not the point (the direct label and the tooltip carry those).
   */
  k: (n) => {
    if (n == null) return '—'
    const a = Math.abs(n)
    if (a >= 1000) {
      const v = n / 1000
      return `${Number.isInteger(v) ? v : v.toFixed(1)}k`
    }
    return String(Math.round(n))
  },
  one: (n) => (n == null ? '—' : n.toFixed(1)),
  two: (n) => (n == null ? '—' : n.toFixed(2)),
  pct: (n) => (n == null ? '—' : `${(n * 100).toFixed(0)}%`),
  /** Signed delta for stat tiles, in the tile's own unit. */
  delta: (n, unit = '') => {
    if (n == null || !isFinite(n)) return null
    if (Math.abs(n) < 0.005) return `no change${unit ? ` ${unit}` : ''}`
    const sign = n > 0 ? '+' : '−'
    const mag = Math.abs(n) >= 100 ? Math.round(Math.abs(n)).toLocaleString('en-US') : Math.abs(n).toFixed(2)
    return `${sign}${mag}${unit ? ` ${unit}` : ''}`
  },
}
