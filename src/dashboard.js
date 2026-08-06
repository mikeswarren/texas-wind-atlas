/**
 * The analytics dashboard: a KPI strip plus five charts, in a drawer under the map.
 *
 * The one rule that matters here: EVERY number in this drawer is derived from the
 * same `index` the map is drawing, at the same selected year, under the same
 * filters. There is no second source of truth and no precomputed total that could
 * drift. Filter to Vestas and the dashboard is a Vestas dashboard -- headline
 * capacity, rankings, distribution, and technology curves all move together.
 *
 * Cross-filtering runs one way on purpose: clicking a manufacturer bar sets the
 * global manufacturer filter, and clicking a county flies the map there. Clicking
 * a bar does NOT introduce a second, chart-local filter -- one filter set scopes
 * the whole view, which is why the slice line in the header can describe the state
 * of every chart in one sentence.
 */

import {
  createAreaChart, createLineChart, createRankedBars, createHistogram,
  sparkline, renderTable,
} from './charts.js'
import { SERIES } from './config.js'
import {
  fmt, capacityMix, rankedCounties, rankedManufacturers, topShare, CAP_BUCKETS,
} from './stats.js'

const COUNTY_LIMIT = 10
const MANU_LIMIT = 7

/** Stat-tile definitions. `pick` reads one year's row; `series` feeds the spark. */
const TILES = [
  {
    id: 'capacity',
    label: 'Installed capacity',
    unit: 'MW',
    hero: true,
    pick: (r) => r.cumulativeMw,
    value: (v) => fmt.mw(v),
    delta: (v) => fmt.delta(v, 'MW'),
  },
  {
    id: 'turbines',
    label: 'Turbines standing',
    pick: (r) => r.cumulative,
    value: (v) => fmt.int(v),
    delta: (v) => fmt.delta(v),
  },
  {
    id: 'avg',
    label: 'Average machine',
    unit: 'MW',
    pick: (r) => r.avgMw,
    value: (v) => fmt.two(v),
    delta: (v) => fmt.delta(v, 'MW'),
  },
  {
    id: 'projects',
    label: 'Wind projects',
    pick: (r) => r.projects,
    value: (v) => fmt.int(v),
    delta: (v) => fmt.delta(v),
  },
  {
    id: 'counties',
    label: 'Counties with wind',
    pick: (r) => r.counties,
    value: (v) => fmt.int(v),
    delta: (v) => fmt.delta(v),
  },
]

export function createDashboard({ onPickManufacturer, onPickCounty }) {
  const root = document.getElementById('dash')
  const slice = document.getElementById('dash-slice')
  const kpiRow = document.getElementById('kpi-row')
  const grid = document.getElementById('dash-grid')
  const toggleBtn = document.getElementById('dash-toggle')
  const tableBtn = document.getElementById('dash-table')

  let tableMode = false
  let last = null // { index, year, state } -- replayed when the drawer opens

  /* --------------------------------------------------------------- scaffold */

  kpiRow.innerHTML = TILES.map((t) => `
    <div class="kpi${t.hero ? ' kpi-hero' : ''}">
      <span class="kpi-label">${t.label}</span>
      <span class="kpi-value" id="kpi-${t.id}">—</span>
      ${t.unit ? `<span class="kpi-unit">${t.unit}</span>` : ''}
      <div class="kpi-foot">
        <span class="kpi-delta" id="kpi-${t.id}-d"></span>
        <span class="kpi-spark" id="kpi-${t.id}-s"></span>
      </div>
    </div>`).join('') + `
    <div class="kpi">
      <span class="kpi-label">Top 5 counties</span>
      <span class="kpi-value" id="kpi-share">—</span>
      <span class="kpi-unit">of capacity</span>
      <div class="kpi-foot">
        <span class="kpi-delta" id="kpi-share-d"></span>
        <span class="kpi-spark" id="kpi-share-s"></span>
      </div>
    </div>`

  const CARDS = [
    {
      id: 'cumulative',
      title: 'Cumulative installed capacity',
      note: 'MW standing, 1999–2025',
      tall: true,
    },
    {
      id: 'manufacturers',
      title: 'Capacity by manufacturer',
      note: `top ${MANU_LIMIT} · click to filter`,
    },
    {
      id: 'counties',
      title: 'Capacity by county',
      note: `top ${COUNTY_LIMIT} · click to zoom`,
    },
    {
      id: 'technology',
      title: 'Fleet technology',
      note: 'median, metres',
      legend: [
        { name: 'Hub height', color: SERIES.standing },
        { name: 'Rotor diameter', color: SERIES.added },
      ],
      tall: true,
    },
    {
      id: 'mix',
      title: 'Fleet by machine size',
      note: 'turbines standing, MW class',
      tall: true,
    },
  ]

  grid.innerHTML = CARDS.map((c) => `
    <section class="card${c.tall ? ' card-tall' : ''}" aria-label="${c.title}">
      <header class="card-head">
        <h3>${c.title}</h3>
        <span class="card-note">${c.note}</span>
      </header>
      ${c.legend ? `<div class="card-legend">${c.legend.map((l) =>
        `<span class="legend-item"><span class="c-key" style="background:${l.color}"></span>${l.name}</span>`).join('')}</div>` : ''}
      <div class="card-plot" id="plot-${c.id}"></div>
      <div class="card-table" id="table-${c.id}" hidden></div>
    </section>`).join('')

  const plot = (id) => document.getElementById(`plot-${id}`)
  const tableBox = (id) => document.getElementById(`table-${id}`)

  const charts = {
    cumulative: createAreaChart(plot('cumulative'), {
      unit: 'MW', format: fmt.mw, tickFormat: fmt.k,
    }),
    technology: createLineChart(plot('technology'), {
      series: [
        { name: 'Hub height', color: SERIES.standing },
        { name: 'Rotor diameter', color: SERIES.added },
      ],
      unit: 'm',
      format: fmt.int,
    }),
    manufacturers: createRankedBars(plot('manufacturers'), {
      unit: 'MW', format: fmt.mw, noun: 'manufacturers',
      onPick: (row) => onPickManufacturer(row.key),
    }),
    counties: createRankedBars(plot('counties'), {
      unit: 'MW', format: fmt.mw, noun: 'counties',
      onPick: (row) => onPickCounty(row.key),
    }),
    mix: createHistogram(plot('mix'), {
      unit: 'turbines', format: fmt.int, tickFormat: fmt.k,
    }),
  }

  /* ----------------------------------------------------------------- update */

  /**
   * Top-5 concentration for every year. Recomputed per update rather than cached
   * against the index: it is ~27 sorts of ~100 rows, which is far cheaper than
   * the bookkeeping needed to invalidate a cache correctly.
   */
  function shareSeries(index) {
    return index.perYear.map((_, i) => topShare(index, i, 5))
  }

  function update(index, year, state) {
    last = { index, year, state }
    if (root.hidden) return

    const i = year - index.yearMin
    const row = index.perYear[i]
    const prev = i > 0 ? index.perYear[i - 1] : null
    if (!row) return

    /* slice line -- what every chart below is scoped to */
    const bits = [`Through <b>${year}</b>`]
    bits.push(state.manufacturer === 'all' ? 'all manufacturers' : `<b>${state.manufacturer}</b>`)
    bits.push(state.minCap > 0 ? `≥ <b>${(state.minCap / 1000).toFixed(2)} MW</b> each` : 'any machine size')
    const pct = index.total ? ((index.matched / index.total) * 100).toFixed(1) : '0'
    slice.innerHTML = `${bits.join(' · ')} — ${fmt.int(row.cumulative)} of ${fmt.int(index.total)} turbines standing
      <span class="slice-dim">(filter matches ${pct}% of the fleet)</span>`

    /* KPI strip */
    for (const t of TILES) {
      const v = t.pick(row)
      document.getElementById(`kpi-${t.id}`).textContent = t.value(v)
      const dEl = document.getElementById(`kpi-${t.id}-d`)
      if (prev && v != null && t.pick(prev) != null) {
        const d = v - t.pick(prev)
        dEl.textContent = `${t.delta(d)} vs ${year - 1}`
        dEl.className = `kpi-delta${d > 0 ? ' up' : d < 0 ? ' down' : ''}`
      } else {
        dEl.textContent = prev ? '' : 'first year'
        dEl.className = 'kpi-delta'
      }
      document.getElementById(`kpi-${t.id}-s`).innerHTML =
        sparkline(index.perYear.map(t.pick), i)
    }

    const shares = shareSeries(index)
    const share = shares[i]
    document.getElementById('kpi-share').textContent = share == null ? '—' : fmt.pct(share)
    const shareD = document.getElementById('kpi-share-d')
    if (prev && share != null && shares[i - 1] != null) {
      const d = (share - shares[i - 1]) * 100
      shareD.textContent = `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d).toFixed(1)} pts vs ${year - 1}`
      shareD.className = 'kpi-delta'
    } else {
      shareD.textContent = ''
    }
    document.getElementById('kpi-share-s').innerHTML = sparkline(shares, i)

    /* charts */
    charts.cumulative.update({
      points: index.perYear.map((r) => ({
        label: String(r.year),
        value: r.cumulativeMw,
        note: `${fmt.int(r.cumulative)} turbines · ${fmt.mw(r.addedMw)} MW added that year`,
      })),
      at: i,
    })

    charts.technology.update({
      labels: index.perYear.map((r) => String(r.year)),
      values: [
        index.perYear.map((r) => r.medianHub),
        index.perYear.map((r) => r.medianRotor),
      ],
      at: i,
    })

    const manu = rankedManufacturers(index, i, MANU_LIMIT)
    charts.manufacturers.update(manu)

    const counties = rankedCounties(index, i, COUNTY_LIMIT)
    charts.counties.update(counties)

    const mix = capacityMix(index, i)
    charts.mix.update({
      bins: mix.map((b) => ({ label: b.label, value: b.value, note: `${fmt.mw(b.mw)} MW` })),
    })

    if (tableMode) renderTables(index, i, { manu, counties, mix, shares })
  }

  /* ------------------------------------------------------------ table twins */

  function renderTables(index, i, { manu, counties, mix }) {
    tableBox('cumulative').innerHTML = renderTable(
      ['Year', 'MW standing', 'MW added', 'Turbines'],
      index.perYear.slice(0, i + 1).reverse().map((r) => [
        r.year, fmt.mw(r.cumulativeMw), fmt.mw(r.addedMw), fmt.int(r.cumulative),
      ])
    )
    tableBox('technology').innerHTML = renderTable(
      ['Year', 'Median hub (m)', 'Median rotor (m)', 'Avg machine (MW)'],
      index.perYear.slice(0, i + 1).reverse().map((r) => [
        r.year, fmt.one(r.medianHub), fmt.one(r.medianRotor), fmt.two(r.avgMw),
      ])
    )
    // The table view is the place where the tail is a row like any other, so the
    // column really does sum to the total.
    const withTail = (ranked, noun) => {
      const rows = ranked.rows.map((r) => [
        r.label, fmt.mw(r.value), ranked.total ? fmt.pct(r.value / ranked.total) : '—',
      ])
      if (ranked.other) {
        rows.push([
          `Other (${ranked.other.count} ${noun})`, fmt.mw(ranked.other.value),
          ranked.total ? fmt.pct(ranked.other.value / ranked.total) : '—',
        ])
      }
      rows.push(['Total', fmt.mw(ranked.total), '100%'])
      return rows
    }
    tableBox('manufacturers').innerHTML = renderTable(
      ['Manufacturer', 'MW', 'Share'], withTail(manu, 'manufacturers')
    )
    tableBox('counties').innerHTML = renderTable(
      ['County', 'MW', 'Share'], withTail(counties, 'counties')
    )
    const mixTotal = mix.reduce((s, b) => s + b.value, 0)
    tableBox('mix').innerHTML = renderTable(
      ['Machine size (MW)', 'Turbines', 'MW', 'Share'],
      mix.map((b) => [
        b.label, fmt.int(b.value), fmt.mw(b.mw), mixTotal ? fmt.pct(b.value / mixTotal) : '—',
      ])
    )
  }

  function setTableMode(on) {
    tableMode = on
    tableBtn.textContent = on ? 'Chart view' : 'Table view'
    tableBtn.setAttribute('aria-pressed', String(on))
    for (const c of CARDS) {
      plot(c.id).hidden = on
      tableBox(c.id).hidden = !on
    }
    if (last) update(last.index, last.year, last.state)
  }

  /* ---------------------------------------------------------------- opening */

  function setOpen(on) {
    root.hidden = !on
    toggleBtn.setAttribute('aria-expanded', String(on))
    toggleBtn.classList.toggle('on', on)
    document.getElementById('app').classList.toggle('dash-open', on)
    // Deep-linkable, but with replaceState rather than a hash assignment: a
    // toggle is not a navigation and should not stack up history entries.
    try {
      const url = on ? '#analytics' : window.location.pathname + window.location.search
      window.history.replaceState(null, '', url)
    } catch { /* file:// and sandboxed frames disallow this; harmless */ }
    // Charts drawn while the drawer was hidden measured 0px; replaying the last
    // state redraws them at their real size.
    if (on && last) update(last.index, last.year, last.state)
  }

  toggleBtn.addEventListener('click', () => setOpen(root.hidden))
  document.getElementById('dash-close').addEventListener('click', () => setOpen(false))
  tableBtn.addEventListener('click', () => setTableMode(!tableMode))
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !root.hidden) setOpen(false)
  })

  if (window.location.hash === '#analytics') setOpen(true)

  return { update, setOpen, isOpen: () => !root.hidden }
}
