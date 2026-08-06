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

const state = {
  year: 2025,
  yearMin: 1999,
  yearMax: 2025,
  mode: 'turbines',        // turbines | counties
  turbineRender: 'density', // density | points | clusters
  countyRender: 'flat',     // flat | extruded
  styleKey: 'dark',
  terrain: false,
  manufacturer: 'all',
  minCap: 0,
  playing: false,
}

let map = null
let data = { turbines: null, counties: null, summary: null }
let index = null
let timeline = null
let dashboard = null
let clusterDirty = true
let playTimer = null

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
  const [turbines, counties, summary] = await Promise.all([
    get('turbines.geojson'),
    get('counties.geojson'),
    get('summary.json'),
  ])
  return { turbines, counties, summary }
}

/* ------------------------------------------------------------- map layers */

function install() {
  installLayers(map, {
    turbines: data.turbines,
    counties: data.counties,
    year: state.year,
    filter: turbineFilter(state),
  })
  installTerrain(map, state.terrain)
}

/** Layer visibility for the current mode -- one place, so nothing goes stale. */
function syncVisibility() {
  const turbines = state.mode === 'turbines'
  const vis = {
    'turbine-heat': turbines && state.turbineRender === 'density',
    'turbine-point': turbines && state.turbineRender !== 'clusters',
    'cluster-circle': turbines && state.turbineRender === 'clusters',
    'cluster-count': turbines && state.turbineRender === 'clusters',
    'cluster-point': turbines && state.turbineRender === 'clusters',
    'county-fill': !turbines && state.countyRender === 'flat',
    'county-3d': !turbines && state.countyRender === 'extruded',
    'county-line': !turbines,
  }
  for (const [id, on] of Object.entries(vis)) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none')
  }
  if (turbines && state.turbineRender === 'clusters' && clusterDirty) refreshClusters()
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
    if (state.mode === 'turbines' && state.turbineRender === 'clusters') refreshClusters()
    if (repaintCounties) paintCounties()
  }

  document.getElementById('year-out').textContent = state.year
  document.getElementById('year-range').value = state.year
  updateStats(index, state.year)
  timeline.update(index, state.year)
  renderLegend(state.mode, state.year)
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

function syncConditionalControls() {
  for (const node of document.querySelectorAll('[data-when]')) {
    node.hidden = node.dataset.when !== state.mode
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

function wireControls() {
  segmented('mode-toggle', 'mode', () => {
    syncConditionalControls()
    syncVisibility()
    renderLegend(state.mode, state.year)
    // The 3D choropleth is unreadable straight down; give it a camera to live in.
    if (state.mode === 'counties' && state.countyRender === 'extruded' && map.getPitch() < 20) {
      map.easeTo({ pitch: 50, duration: 800 })
    }
  })

  segmented('turbine-render', 'turbineRender', syncVisibility)

  segmented('county-render', 'countyRender', () => {
    syncVisibility()
    if (state.countyRender === 'extruded' && map.getPitch() < 20) {
      map.easeTo({ pitch: 50, duration: 800 })
    }
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

function pickCounty(fips) {
  const feature = data.counties.features.find((f) => f.id === Number(fips))
  if (!feature || !map) return
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

  fillManufacturers()
  fillNotes()
  syncConditionalControls()

  map = new mapboxgl.Map({
    container: 'map',
    style: STYLES.dark.url,
    ...PLACES[0].camera,
    maxZoom: 16,
    attributionControl: true,
    // Texas only -- no reason to let the camera wander to the Pacific.
    maxBounds: [[-115, 21], [-83, 41]],
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
