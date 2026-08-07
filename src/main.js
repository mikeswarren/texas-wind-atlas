/**
 * Texas Wind Atlas -- application shell.
 *
 * Responsibilities: resolve a token, load the three datasets, own the UI state,
 * and keep the map, the stat tiles, the timeline, and the legend showing the
 * same numbers at all times.
 *
 * The one structural thing worth knowing: switching basemap styles throws away
 * every source, layer, and feature-state the style held. `install()` is
 * therefore idempotent and re-runs on each `style.load`, and `applyAll()`
 * replays the entire UI state onto the fresh style.
 */

import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import './style.css'

import { resolveToken, TOKEN_STORAGE_KEY, STYLES, PLACES } from './config.js'
import { P, installLayers, installTerrain, setHighlightYear, turbineFilter } from './layers.js'
import { buildIndex, fmt } from './stats.js'
import { createTimeline, updateStats, renderLegend } from './panel.js'
import { createDashboard } from './dashboard.js'
import { createSplitters } from './splitters.js'
import {
  REFRESH_MS, buildRoster, fetchMetars, freshnessLine, ageMinutes, formatAge, knotsToMs,
} from './wx.js'

const state = {
  year: 2025,
  yearMin: 1999,
  yearMax: 2025,
  // Independent layer toggles, not an exclusive view mode. Turbines over the
  // county choropleth is a legitimate thing to want to look at, and the old
  // Turbines|Counties switch made it unreachable.
  layers: { turbines: true, counties: false, boundary: true },
  turbineRender: 'density', // density | points | clusters
  countyRender: 'flat',     // flat | extruded
  styleKey: 'dark',
  terrain: false,
  manufacturer: 'all',
  minCap: 0,
  playing: false,
  wind: false,
}

let map = null
let data = { turbines: null, counties: null, texas: null, summary: null }
let index = null
let timeline = null
let dashboard = null
let clusterDirty = true
let playTimer = null
let roster = null        // ICAO id -> baked station record
let wind = null          // last successful poll, kept across style switches
let windTimer = null
let windAgeTimer = null
let windLoading = false

/* ------------------------------------------------------------------ setup */

function showSetup(message) {
  const setup = document.getElementById('setup')
  setup.hidden = false
  if (message) {
    const note = setup.querySelector('.setup-note')
    note.textContent = message
    note.style.color = '#e66767'
  }
}

function wireSetup() {
  const input = document.getElementById('setup-token')
  const go = document.getElementById('setup-go')
  const submit = () => {
    const value = input.value.trim()
    if (!value.startsWith('pk.')) {
      input.style.borderColor = '#e66767'
      input.placeholder = 'A public token starts with "pk."'
      return
    }
    try {
      window.localStorage.setItem(TOKEN_STORAGE_KEY, value)
    } catch {
      // Fall back to a query param if storage is unavailable.
      window.location.search = `?token=${encodeURIComponent(value)}`
      return
    }
    window.location.reload()
  }
  go.addEventListener('click', submit)
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit() })
}

/* ------------------------------------------------------------------- data */

async function loadData() {
  const base = import.meta.env.BASE_URL
  const get = async (name) => {
    const res = await fetch(`${base}data/${name}`)
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`)
    return res.json()
  }
  const [turbines, summary, texas] = await Promise.all([
    get('turbines.geojson'),
    get('summary.json'),
    // The state outline is reference geometry, so it is optional the way the
    // station roster below is: losing it costs a border, not the map. It rides
    // in this batch rather than after it because install() wants it -- fetched
    // afterwards it would add a serial round trip before the first paint.
    get('texas.geojson').catch(() => null),
  ])
  // counties.geojson is NOT fetched here. The authoritative Texas county
  // boundaries are 182 KB gzipped -- as much as all 19,380 turbines -- and the
  // county layer starts switched off, so loading it at boot would charge every
  // visitor for a layer most never turn on. ensureCounties() pulls it the first
  // time the layer is enabled. Nothing else needs it: the dashboard's county
  // rankings are built from the turbine records' own county fields, not from
  // this file.
  // The station roster is optional on purpose. It only feeds the live wind
  // overlay, so a missing or unreadable stations.json costs that one control --
  // it must never stop 19,380 turbines from drawing.
  let stations = null
  try {
    stations = (await get('stations.json')).stations
  } catch {
    stations = null
  }
  return { turbines, counties: null, texas, summary, stations }
}

/**
 * Fetch the county boundaries the first time the layer is switched on, then
 * feed the already-installed (empty) source and paint the year into it.
 *
 * Idempotent and safe to call concurrently: the in-flight promise is cached, so
 * toggling the layer twice quickly issues one request. A failure leaves
 * data.counties null and is retried on the next toggle rather than latched.
 */
let countiesPending = null
function ensureCounties() {
  if (data.counties) return Promise.resolve(data.counties)
  if (countiesPending) return countiesPending
  const base = import.meta.env.BASE_URL
  countiesPending = fetch(`${base}data/counties.geojson`)
    .then((res) => {
      if (!res.ok) throw new Error(`counties.geojson: HTTP ${res.status}`)
      return res.json()
    })
    .then((geo) => {
      data.counties = geo
      const src = map && map.getSource('counties')
      if (src) src.setData(geo)
      paintCountiesWhenReady()
      return geo
    })
    .catch((err) => {
      console.error(err)
      return null
    })
    .finally(() => { countiesPending = null })
  return countiesPending
}

/* ------------------------------------------------------------- map layers */

function install() {
  installLayers(map, {
    turbines: data.turbines,
    counties: data.counties,
    texas: data.texas,
    year: state.year,
    filter: turbineFilter(state),
    metar: wind ? wind.collection : null,
  })
  installTerrain(map, state.terrain)
}

/**
 * Layer visibility, in one place so nothing goes stale.
 *
 * Every entry is `layer is on AND this is the rendering it asked for`. The
 * turbine and county groups no longer exclude each other -- each reads its own
 * toggle, so any combination the layer list can express actually draws.
 */
function syncVisibility() {
  const L = state.layers
  const vis = {
    'turbine-heat': L.turbines && state.turbineRender === 'density',
    'turbine-point': L.turbines && state.turbineRender !== 'clusters',
    'cluster-circle': L.turbines && state.turbineRender === 'clusters',
    'cluster-count': L.turbines && state.turbineRender === 'clusters',
    'cluster-point': L.turbines && state.turbineRender === 'clusters',
    'county-fill': L.counties && state.countyRender === 'flat',
    'county-3d': L.counties && state.countyRender === 'extruded',
    'county-line': L.counties,
    'state-line': L.boundary,
    // Wind describes right now rather than a selected year, so it overlays
    // whatever else is on.
    'metar-wind': state.wind,
    'metar-calm': state.wind,
  }
  for (const [id, on] of Object.entries(vis)) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none')
  }
  if (L.turbines && state.turbineRender === 'clusters' && clusterDirty) refreshClusters()
}

/**
 * The clustered source can't reuse the filter expression: clustering happens at
 * load time in a worker, so a filtered view means re-feeding the source with
 * the matching subset and letting it re-cluster.
 */
function refreshClusters() {
  const src = map.getSource('turbines-clustered')
  if (!src) return
  const features = data.turbines.features.filter((f) => {
    const p = f.properties
    if (p[P.year] > state.year) return false
    if (state.manufacturer !== 'all' && p[P.manu] !== state.manufacturer) return false
    if (state.minCap > 0 && (p[P.cap] || 0) < state.minCap) return false
    return true
  })
  src.setData({ type: 'FeatureCollection', features })
  clusterDirty = false
}

/** Push this year's county totals into feature-state so the choropleth repaints. */
function paintCounties() {
  // Not an error: the boundaries load on demand, so until the layer has been
  // switched on there is nothing to paint. Reported as done so the retry
  // listener below unsubscribes instead of waiting for a source that is empty
  // on purpose.
  if (!data.counties) return true
  if (!map.getSource('counties') || !map.isSourceLoaded('counties')) return false
  const i = state.year - state.yearMin
  for (const f of data.counties.features) {
    const id = f.id
    const mwArr = index.countyMw.get(id)
    const nArr = index.countyN.get(id)
    map.setFeatureState(
      { source: 'counties', id },
      { mw: mwArr ? mwArr[i] : 0, n: nArr ? nArr[i] : 0 }
    )
  }
  return true
}

/** feature-state needs a loaded source; retry once the source reports ready. */
function paintCountiesWhenReady() {
  if (paintCounties()) return
  const onData = (e) => {
    if (e.sourceId === 'counties' && map.isSourceLoaded('counties')) {
      if (paintCounties()) map.off('sourcedata', onData)
    }
  }
  map.on('sourcedata', onData)
}

/* -------------------------------------------------------------- UI update */

/** The map only accepts layer calls once a style is up; the panel always can. */
function mapReady() {
  return map && map.isStyleLoaded()
}

function applyYear({ repaintCounties = true } = {}) {
  if (mapReady()) {
    const filter = turbineFilter(state)
    for (const id of ['turbine-heat', 'turbine-point']) {
      if (map.getLayer(id)) map.setFilter(id, filter)
    }
    setHighlightYear(map, state.year)

    clusterDirty = true
    if (state.layers.turbines && state.turbineRender === 'clusters') refreshClusters()
    if (repaintCounties) paintCounties()
  }

  document.getElementById('year-out').textContent = state.year
  document.getElementById('year-range').value = state.year
  updateStats(index, state.year)
  timeline.update(index, state.year)
  renderLegend(state, state.year)
  // The dashboard reads the same index at the same year, so it can never
  // disagree with the map or the tiles.
  if (dashboard) dashboard.update(index, state.year, state)
}

/** Filters changed -- the whole index is stale, so rebuild and replay. */
function applyFilters() {
  index = buildIndex(data.turbines.features, state, state.yearMin, state.yearMax)
  const count = document.getElementById('filter-count')
  if (state.manufacturer === 'all' && state.minCap === 0) {
    count.textContent = `All ${fmt.int(index.total)} turbines in view.`
  } else {
    const pct = ((index.matched / index.total) * 100).toFixed(1)
    count.textContent = `${fmt.int(index.matched)} of ${fmt.int(index.total)} turbines match (${pct}%).`
  }
  applyYear()
}

/** Everything the current state implies, replayed onto a freshly loaded style. */
function applyAll() {
  install()
  syncVisibility()
  applyYear({ repaintCounties: false })
  paintCountiesWhenReady()
}

/* ---------------------------------------------------------------- popups */

const popup = new mapboxgl.Popup({ closeButton: true, maxWidth: '290px', offset: 12 })

/* ------------------------------------------------------------- live wind */

function windStatus(text, tone = '') {
  const el = document.getElementById('wind-status')
  el.textContent = text
  el.dataset.tone = tone
  el.hidden = !text
}

function pushWind() {
  const source = map && map.getSource('metar')
  if (source && wind) source.setData(wind.collection)
}

/**
 * Poll once. Failures leave the previous reading on the map rather than
 * blanking it -- an hour-old wind field that says so beats an empty one.
 */
async function refreshWind({ manual = false } = {}) {
  if (!state.wind || windLoading || !roster) return
  windLoading = true
  if (!wind || manual) windStatus('Fetching observations…')

  try {
    wind = await fetchMetars(roster, { base: import.meta.env.BASE_URL })
    pushWind()
    windStatus(freshnessLine(wind.collection, { partial: wind.partial }))
  } catch (err) {
    windStatus(
      wind
        ? `Could not refresh — showing the last reading. ${freshnessLine(wind.collection, { partial: wind.partial })}`
        : `Live wind unavailable: ${err.message}.`,
      'warn'
    )
  } finally {
    windLoading = false
  }
}

/**
 * Ages are recomputed on a timer of their own. The observations do not change
 * between polls, but their age does, and a line reading "observed 3 min ago"
 * that is really 8 minutes old is the exact failure this layer is meant to
 * avoid.
 */
function startWind() {
  refreshWind({ manual: true })
  clearInterval(windTimer)
  clearInterval(windAgeTimer)
  windTimer = setInterval(refreshWind, REFRESH_MS)
  windAgeTimer = setInterval(() => {
    if (state.wind && wind && !windLoading) {
      windStatus(freshnessLine(wind.collection, { partial: wind.partial }))
    }
  }, 60 * 1000)
}

function stopWind() {
  clearInterval(windTimer)
  clearInterval(windAgeTimer)
  windTimer = windAgeTimer = null
  windStatus('')
}

/** Compass point for a bearing, because "SSW" reads faster than "197°". */
function compass(deg) {
  const points = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
  return points[Math.round(deg / 22.5) % 16]
}

function windPopup(feature) {
  const p = feature.properties
  const age = ageMinutes(p.obs)
  const ms = knotsToMs(p.spd)

  const direction = p.vrb
    ? 'Variable'
    : `From ${compass(p.dir)} ${String(p.dir).padStart(3, '0')}°`
  const speed = p.spd === 0
    ? 'Calm'
    : `${p.spd} kt (${ms.toFixed(1)} m/s)${p.gust ? ` · gusting ${p.gust} kt` : ''}`

  const rows = [
    ['Wind', direction],
    ['Speed', speed],
    ['Observed', formatAge(age)],
  ]
  if (p.temp !== null && p.temp !== undefined) rows.push(['Temperature', `${p.temp} °C`])
  if (p.cat) rows.push(['Flight category', p.cat])

  return `
    <p class="pop-title">${p.name}</p>
    <p class="pop-sub">${p.id} · surface wind</p>
    <dl class="pop-grid">
      ${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}
    </dl>
    ${p.raw ? `<p class="pop-raw">${p.raw}</p>` : ''}
    <p class="pop-flag">Direction is where the wind blows <b>from</b>; the arrow flies with it.
      METARs are issued hourly, so this reading is current, not live.</p>`
}

function turbinePopup(feature) {
  const p = feature.properties
  const rows = [
    ['Commissioned', p[P.year] + (p[P.yearImputed] ? ' *' : '')],
    ['Capacity', p[P.cap] ? `${(p[P.cap] / 1000).toFixed(2)} MW` : '—'],
    ['Hub height', p[P.hub] ? `${p[P.hub]} m` : '—'],
    ['Rotor diameter', p[P.rotor] ? `${p[P.rotor]} m` : '—'],
    ['Height to tip', p[P.tip] ? `${p[P.tip]} m` : '—'],
    ['Manufacturer', p[P.manu] || '—'],
    ['Model', p[P.model] || '—'],
  ]
  const flags = []
  if (p[P.retrofit]) flags.push('Retrofitted since installation.')
  if (p[P.yearImputed]) flags.push('* Commission year taken from the project median — this record had none.')

  return `
    <p class="pop-title">${p[P.project] || 'Unnamed project'}</p>
    <p class="pop-sub">${p[P.county] || '—'} County, Texas</p>
    <dl class="pop-grid">
      ${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}
    </dl>
    ${flags.length ? `<p class="pop-flag">${flags.join('<br>')}</p>` : ''}`
}

function wireMapInteractions() {
  const badge = document.getElementById('map-badge')

  for (const layer of ['turbine-point', 'cluster-point']) {
    map.on('click', layer, (e) => {
      popup.setLngLat(e.features[0].geometry.coordinates.slice())
        .setHTML(turbinePopup(e.features[0]))
        .addTo(map)
    })
    map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer' })
    map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = '' })
  }

  for (const layer of ['metar-wind', 'metar-calm']) {
    map.on('click', layer, (e) => {
      popup.setLngLat(e.features[0].geometry.coordinates.slice())
        .setHTML(windPopup(e.features[0]))
        .addTo(map)
    })
    map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer' })
    map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = '' })
  }

  // Clicking a cluster zooms to the level where it breaks apart.
  map.on('click', 'cluster-circle', (e) => {
    const feature = e.features[0]
    map.getSource('turbines-clustered').getClusterExpansionZoom(
      feature.properties.cluster_id,
      (err, zoom) => {
        if (err) return
        map.easeTo({ center: feature.geometry.coordinates, zoom: zoom + 0.4, duration: 700 })
      }
    )
  })
  map.on('mouseenter', 'cluster-circle', (e) => {
    map.getCanvas().style.cursor = 'pointer'
    const p = e.features[0].properties
    badge.innerHTML = `<b>${fmt.int(p.point_count)}</b> turbines · <b>${fmt.mw(p.kw / 1000)}</b> MW<br>
      <span style="color:#898781">Click to zoom in</span>`
    badge.hidden = false
  })
  map.on('mouseleave', 'cluster-circle', () => {
    map.getCanvas().style.cursor = ''
    badge.hidden = true
  })

  // County hover: highlight via feature-state, report the year's numbers.
  let hovered = null
  const clearHover = () => {
    if (hovered !== null) map.setFeatureState({ source: 'counties', id: hovered }, { hover: false })
    hovered = null
    badge.hidden = true
    map.getCanvas().style.cursor = ''
  }
  for (const layer of ['county-fill', 'county-3d']) {
    map.on('mousemove', layer, (e) => {
      const f = e.features[0]
      if (hovered !== null && hovered !== f.id) {
        map.setFeatureState({ source: 'counties', id: hovered }, { hover: false })
      }
      hovered = f.id
      map.setFeatureState({ source: 'counties', id: hovered }, { hover: true })
      map.getCanvas().style.cursor = 'pointer'

      const i = state.year - state.yearMin
      const mw = index.countyMw.get(f.id)?.[i] || 0
      const n = index.countyN.get(f.id)?.[i] || 0
      const p = f.properties
      badge.innerHTML = n
        ? `<b>${p.name} County</b><br>
           <b>${fmt.mw(mw)}</b> MW · <b>${fmt.int(n)}</b> turbines by ${state.year}<br>
           <span style="color:#898781">First turbine ${p.first} · ${p.projects} project${p.projects === 1 ? '' : 's'} all-time</span>`
        : `<b>${p.name} County</b><br><span style="color:#898781">No turbines by ${state.year}</span>`
      badge.hidden = false
    })
    map.on('mouseleave', layer, clearHover)
  }
}

/* --------------------------------------------------------------- controls */

function segmented(id, key, after) {
  const group = document.getElementById(id)
  group.addEventListener('click', (e) => {
    const btn = e.target.closest('button')
    if (!btn) return
    for (const b of group.querySelectorAll('button')) b.classList.toggle('on', b === btn)
    state[key] = btn.dataset.mode || btn.dataset.render || btn.dataset.style
    after()
  })
}

/** A layer's rendering sub-control is only meaningful while that layer is on. */
function syncConditionalControls() {
  for (const node of document.querySelectorAll('[data-when]')) {
    node.hidden = !state.layers[node.dataset.when]
  }
}

function stop() {
  state.playing = false
  clearInterval(playTimer)
  playTimer = null
  document.getElementById('play').classList.remove('playing')
}

function play() {
  if (state.year >= state.yearMax) state.year = state.yearMin
  state.playing = true
  document.getElementById('play').classList.add('playing')
  playTimer = setInterval(() => {
    if (state.year >= state.yearMax) return stop()
    state.year += 1
    applyYear()
  }, 620)
}

/** The 3D choropleth is unreadable straight down; give it a camera to live in. */
function pitchForExtrusion() {
  if (state.layers.counties && state.countyRender === 'extruded' && map.getPitch() < 20) {
    map.easeTo({ pitch: 50, duration: 800 })
  }
}

function wireControls() {
  // The layer list. Each checkbox owns one entry in state.layers, so adding a
  // layer is a checkbox with a data-layer attribute and nothing else.
  for (const box of document.querySelectorAll('[data-layer]')) {
    box.checked = !!state.layers[box.dataset.layer]
    box.addEventListener('change', () => {
      state.layers[box.dataset.layer] = box.checked
      // The county boundaries are the one layer whose data is not already in
      // memory; switching it on is what pays for them.
      if (box.dataset.layer === 'counties' && box.checked) ensureCounties()
      syncConditionalControls()
      syncVisibility()
      renderLegend(state, state.year)
      pitchForExtrusion()
    })
  }

  segmented('turbine-render', 'turbineRender', syncVisibility)

  segmented('county-render', 'countyRender', () => {
    syncVisibility()
    pitchForExtrusion()
  })

  segmented('style-toggle', 'styleKey', () => {
    // setStyle wipes sources, layers and feature-state; style.load replays them.
    map.setStyle(STYLES[state.styleKey].url)
  })

  document.getElementById('terrain-toggle').addEventListener('change', (e) => {
    state.terrain = e.target.checked
    // If the style is still loading, style.load replays this from state.
    if (mapReady()) installTerrain(map, state.terrain)
    if (state.terrain && map.getPitch() < 20) map.easeTo({ pitch: 55, duration: 900 })
  })

  document.getElementById('wind-toggle').addEventListener('change', (e) => {
    state.wind = e.target.checked
    syncVisibility()
    // Nothing is fetched until the layer is switched on: a visitor who never
    // asks for wind should not cost NOAA 215 stations' worth of requests, and
    // the poll would otherwise keep running behind a hidden layer.
    if (state.wind) startWind()
    else stopWind()
  })

  const range = document.getElementById('year-range')
  range.addEventListener('input', (e) => {
    stop()
    state.year = Number(e.target.value)
    applyYear()
  })

  document.getElementById('play').addEventListener('click', () => {
    state.playing ? stop() : play()
  })

  document.getElementById('manufacturer').addEventListener('change', (e) => {
    state.manufacturer = e.target.value
    applyFilters()
  })

  const cap = document.getElementById('cap-range')
  const capOut = document.getElementById('cap-out')
  cap.addEventListener('input', (e) => {
    state.minCap = Number(e.target.value)
    capOut.textContent = state.minCap === 0 ? 'any' : `${(state.minCap / 1000).toFixed(2)} MW`
  })
  cap.addEventListener('change', applyFilters)

  document.getElementById('reset-filters').addEventListener('click', () => {
    state.manufacturer = 'all'
    state.minCap = 0
    document.getElementById('manufacturer').value = 'all'
    cap.value = 0
    capOut.textContent = 'any'
    applyFilters()
  })
}

function wirePlaces() {
  const box = document.getElementById('places')
  const blurb = document.getElementById('place-blurb')
  for (const place of PLACES) {
    const btn = document.createElement('button')
    btn.textContent = place.label
    btn.addEventListener('click', () => {
      for (const b of box.querySelectorAll('button')) b.classList.toggle('on', b === btn)
      blurb.textContent = place.blurb
      map.flyTo({ ...place.camera, duration: 2400, essential: true, curve: 1.5 })
    })
    box.appendChild(btn)
  }
  blurb.textContent = PLACES[0].blurb
  box.querySelector('button').classList.add('on')
}

/**
 * Every manufacturer present in the data, not just the summary's top eight.
 *
 * summary.manufacturers is a top-N list for the ETL's own reporting; using it
 * here left 15 manufacturers (~480 turbines) with no way to be selected, and it
 * would desync the select the moment the dashboard cross-filtered to one of
 * them. The distinct list is derived from the features once at boot.
 */
function fillManufacturers() {
  const counts = new Map()
  for (const f of data.turbines.features) {
    const name = f.properties[P.manu] || 'Unknown'
    counts.set(name, (counts.get(name) || 0) + 1)
  }
  const select = document.getElementById('manufacturer')
  for (const [name, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    const option = document.createElement('option')
    option.value = name
    option.textContent = `${name} (${fmt.int(n)})`
    select.appendChild(option)
  }
}

/* --------------------------------------------------------- cross-filtering */

/** Bounds of a county polygon, for zooming out of the ranked-county chart. */
function featureBounds(feature) {
  const bounds = new mapboxgl.LngLatBounds()
  const walk = (coords) => {
    if (typeof coords[0] === 'number') bounds.extend(coords)
    else for (const c of coords) walk(c)
  }
  walk(feature.geometry.coordinates)
  return bounds
}

/**
 * Clicking a manufacturer bar drives the ONE global filter, and clicking the
 * already-selected one clears it. The chart is a control on the existing filter,
 * never a second chart-local filter -- that is what keeps every card in the
 * drawer describable by the single slice line in its header.
 */
function pickManufacturer(name) {
  state.manufacturer = state.manufacturer === name ? 'all' : name
  document.getElementById('manufacturer').value = state.manufacturer
  applyFilters()
}

/**
 * Zoom to a county picked from the analytics ranking.
 *
 * Has to await the boundaries: this is reachable with the county layer switched
 * off -- the ranking is built from the turbine records, not from the polygons --
 * and before this was lazy it could assume they were already in memory.
 */
async function pickCounty(fips) {
  const counties = await ensureCounties()
  if (!counties || !map) return
  const feature = counties.features.find((f) => f.id === Number(fips))
  if (!feature) return
  map.fitBounds(featureBounds(feature), { padding: 72, duration: 1500, pitch: 0, bearing: 0 })
}

function fillNotes() {
  const s = data.summary
  document.getElementById('data-notes').innerHTML =
    `${fmt.int(s.turbines)} turbines mapped. ${s.imputedYears} commission years were filled from
     the project median; ${s.unknownYears} records with no recoverable year are excluded.`
  const link = document.getElementById('source-link')
  link.href = 'https://energy.usgs.gov/uswtdb/'
  link.textContent = 'USWTDB'
}

/* -------------------------------------------------------- analytics drawer */

/**
 * The analytics start closed. The map is what people came for, and a half-height
 * panel of numbers on arrival buries it before anyone has asked a question.
 *
 * It opens by animating `grid-template-rows` on #map-wrap rather than by moving
 * the panel: the two lower tracks grow from 0, so the drawer's bottom edge stays
 * pinned to the window while its top edge travels upward -- which is what reads
 * as a slide-up. Moving the panel with a transform instead would slide it over
 * the map, and the map would then be sized for space it no longer has.
 *
 * Two things this has to get right:
 *
 *  - **Settle on a timer, not on `transitionend`.** Not every browser
 *    interpolates `grid-template-rows`, and under `prefers-reduced-motion` the
 *    transition is cut to 0.01ms. Where no transition runs, no event fires, and
 *    a listener-based cleanup would leave the resize pump running forever.
 *  - **Resize the map every frame while it moves.** Mapbox owns a canvas, not a
 *    layout box; without this the canvas keeps its old size and the basemap
 *    visibly stretches until the drawer lands.
 */
function wireDrawer() {
  const wrap = document.getElementById('map-wrap')
  const dash = document.getElementById('dash')
  const handle = document.querySelector('[data-split="dash"]')
  const openBtn = document.getElementById('dash-open')
  const hideBtn = document.getElementById('dash-hide')
  const SETTLE_MS = 460 // a little past the 0.4s transition in the stylesheet
  let frame = null
  let settle = null

  function stopPump() {
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
    wrap.classList.remove('dash-anim')
    if (map) map.resize()
  }

  function setOpen(next) {
    wrap.classList.add('dash-anim')
    wrap.classList.toggle('dash-closed', !next)
    openBtn.setAttribute('aria-expanded', String(next))
    // Closed, the drawer and its splitter leave the tab order and the
    // accessibility tree -- not merely the screen.
    dash.inert = !next
    handle.inert = !next
    if (next) dash.scrollTop = 0

    const pump = () => { if (map) map.resize(); frame = requestAnimationFrame(pump) }
    if (frame === null) frame = requestAnimationFrame(pump)
    clearTimeout(settle)
    settle = setTimeout(stopPump, SETTLE_MS)
  }

  // Move focus with the panel, so a keyboard user who opens the drawer is
  // already inside it and lands back on the trigger when it closes.
  openBtn.addEventListener('click', () => { setOpen(true); hideBtn.focus() })
  hideBtn.addEventListener('click', () => { setOpen(false); openBtn.focus() })

  // Match the closed class the markup already ships with.
  dash.inert = true
  handle.inert = true
}

/* ------------------------------------------------------------------- boot */

async function boot() {
  wireSetup()
  const token = resolveToken()
  if (!token) {
    document.getElementById('loading').classList.add('done')
    showSetup()
    return
  }

  mapboxgl.accessToken = token

  try {
    data = await loadData()
  } catch (err) {
    document.getElementById('loading').innerHTML =
      `<p>Could not load the turbine data.<br><small>${err.message}</small></p>`
    return
  }

  state.yearMin = data.summary.yearMin
  state.yearMax = data.summary.yearMax
  state.year = state.yearMax
  const range = document.getElementById('year-range')
  range.min = state.yearMin
  range.max = state.yearMax
  range.value = state.yearMax

  index = buildIndex(data.turbines.features, state, state.yearMin, state.yearMax)
  timeline = createTimeline(document.getElementById('timeline'), {
    onPick: (year) => { stop(); state.year = year; applyYear() },
  })
  dashboard = createDashboard({
    onPickManufacturer: pickManufacturer,
    onPickCounty: pickCounty,
  })
  // The charts re-draw themselves through their own ResizeObserver; the map does
  // not, so its canvas has to be told its container changed.
  createSplitters({ onResize: () => { if (map) map.resize() } })
  wireDrawer()

  fillManufacturers()
  fillNotes()
  syncConditionalControls()

  const windToggle = document.getElementById('wind-toggle')
  if (data.stations && data.stations.length) {
    roster = buildRoster(data.stations)
  } else {
    windToggle.disabled = true
    windToggle.closest('.check').title = 'Station roster unavailable — run `npm run data`'
  }

  map = new mapboxgl.Map({
    container: 'map',
    style: STYLES.dark.url,
    ...PLACES[0].camera,
    maxZoom: 16,
    attributionControl: true,
    // Texas and a margin -- still no wandering to the Pacific, but wide enough
    // that the box is not silently setting the zoom.
    //
    // maxBounds is not only a pan limit: Mapbox will not let the viewport show
    // more than the box, so it imposes a *zoom floor* that grows with the
    // window. The old [-115,21]..[-83,41] was 32deg across, which floors a
    // 1920x1080 window at z5.06 and a 1440p one at z5.57 -- so the statewide
    // preset's 5.2 was already being overridden on the larger of those, and any
    // attempt to open further out would have been quietly ignored rather than
    // applied. 40deg puts the floor below the preset on every common size up to
    // 1080p, and improves 1440p from 5.57 to 5.24 instead of leaving it stuck.
    maxBounds: [[-119, 19], [-79, 43]],
  })

  map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'top-right')
  map.addControl(new mapboxgl.ScaleControl({ unit: 'imperial' }), 'bottom-right')
  map.addControl(new mapboxgl.FullscreenControl(), 'top-right')

  map.on('error', (e) => {
    const status = e.error && e.error.status
    if (status === 401 || status === 403) {
      try { window.localStorage.removeItem(TOKEN_STORAGE_KEY) } catch { /* ignore */ }
      showSetup('That token was rejected by Mapbox (401). Check that it is a public "pk." token and that any URL restriction on it includes this domain.')
    }
  })

  map.on('style.load', () => {
    applyAll()
    wireMapInteractionsOnce()
  })

  map.once('idle', () => {
    document.getElementById('loading').classList.add('done')
  })

  wireControls()
  wirePlaces()
  applyFilters()
}

// Map event handlers bind to layer ids, which survive a style swap, so they
// must be registered exactly once rather than on every style.load.
let interactionsWired = false
function wireMapInteractionsOnce() {
  if (interactionsWired) return
  wireMapInteractions()
  interactionsWired = true
}

boot()
