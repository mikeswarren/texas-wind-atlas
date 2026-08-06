/**
 * Every source and layer in the atlas, plus the expressions that drive them.
 *
 * The specs are pure data, separate from the code that installs them, so the
 * whole set can be run through the official Mapbox style-spec validator with
 * no browser (`npm run validate`). A typo in a paint property or a malformed
 * expression fails there instead of silently dropping a layer at runtime.
 *
 * Everything here is also re-installable: switching basemap styles destroys the
 * style's sources, layers, and feature-state, so `installLayers` is safe to
 * call again against a fresh style.
 */

import { SERIES, MW_BREAKS, INK } from './config.js'

/** Turbine property keys, short in the GeoJSON to keep 19k features small. */
export const P = {
  year: 'y', cap: 'c', hub: 'h', rotor: 'r', tip: 't',
  manu: 'm', model: 'mo', project: 'p', fips: 'f', county: 'co',
  retrofit: 'rf', yearImputed: 'yi',
}

/**
 * County color and height come from feature-state, not from a property: the
 * value changes on every timeline tick, and feature-state repaints without
 * re-uploading 254 polygons.
 *
 * Note feature-state is legal in paint properties only -- never in `filter` or
 * in a layout property. Zero-capacity counties are therefore handled by the
 * ramp and by a zero height, not by filtering them out.
 */
export function countyColorExpr() {
  return [
    'interpolate', ['linear'], ['coalesce', ['feature-state', 'mw'], 0],
    ...MW_BREAKS.flatMap((b) => [b.at, b.color]),
  ]
}

/** Extruded "capacity towers" -- height in metres, tuned to Texas county size. */
export function countyHeightExpr() {
  return ['interpolate', ['linear'], ['coalesce', ['feature-state', 'mw'], 0], 0, 0, 2300, 60000]
}

/**
 * Turbine filter: everything commissioned up to `year`, narrowed by the
 * manufacturer and minimum-capacity controls.
 */
export function turbineFilter({ year, manufacturer, minCap }) {
  const clauses = [['<=', ['get', P.year], year]]
  if (manufacturer && manufacturer !== 'all') {
    clauses.push(['==', ['get', P.manu], manufacturer])
  }
  if (minCap > 0) {
    clauses.push(['>=', ['coalesce', ['get', P.cap], 0], minCap])
  }
  return clauses.length === 1 ? clauses[0] : ['all', ...clauses]
}

/** Radius grows with both zoom and turbine capacity -- a 6 MW machine reads bigger. */
function turbineRadiusExpr() {
  const byCap = (small, big) => [
    'interpolate', ['linear'], ['coalesce', ['get', P.cap], 1500], 600, small, 6000, big,
  ]
  return [
    'interpolate', ['linear'], ['zoom'],
    6, byCap(1.6, 3.2),
    9, byCap(2.6, 5.5),
    12, byCap(5, 11),
    15, byCap(9, 20),
  ]
}

/** Blue = standing, orange = commissioned in the selected year. */
function turbineColorExpr(year) {
  return ['case', ['==', ['get', P.year], year], SERIES.added, SERIES.standing]
}

/**
 * Zoom has to sit at the top level of a step/interpolate -- it is illegal
 * nested inside a `case`, and Mapbox drops the property with only a console
 * warning if you try. So the zoom ramp is outermost and the this-year test
 * happens inside each stop output.
 */
function turbineStrokeWidthExpr(year) {
  const isYear = ['==', ['get', P.year], year]
  return [
    'interpolate', ['linear'], ['zoom'],
    9, ['case', isYear, 1.6, 0],
    12, ['case', isYear, 1.6, 1],
  ]
}

function turbineStrokeColorExpr(year) {
  return ['case', ['==', ['get', P.year], year], '#ffffff', 'rgba(13,13,13,0.65)']
}

/** Source definitions. Real `data` is injected at install time. */
export function sourceSpecs() {
  const empty = { type: 'FeatureCollection', features: [] }
  return {
    turbines: { type: 'geojson', data: empty },
    'turbines-clustered': {
      type: 'geojson',
      data: empty,
      cluster: true,
      clusterRadius: 55,
      clusterMaxZoom: 13,
      // Aggregate capacity per cluster so a bubble can report MW, not just a count.
      clusterProperties: { kw: ['+', ['coalesce', ['get', P.cap], 0]] },
    },
    // promoteId is unnecessary: build_data.py writes a numeric feature id (the
    // county FIPS), so feature-state can address polygons directly.
    counties: { type: 'geojson', data: empty },
  }
}

export function layerSpecs({ year, filter }) {
  return [
    // ---- county choropleth -------------------------------------------------
    {
      id: 'county-fill',
      type: 'fill',
      source: 'counties',
      layout: { visibility: 'none' },
      paint: {
        'fill-color': countyColorExpr(),
        'fill-opacity': [
          'case',
          ['boolean', ['feature-state', 'hover'], false], 0.95,
          ['>', ['coalesce', ['feature-state', 'mw'], 0], 0], 0.78,
          0.35,
        ],
      },
    },
    {
      id: 'county-3d',
      type: 'fill-extrusion',
      source: 'counties',
      layout: { visibility: 'none' },
      paint: {
        'fill-extrusion-color': countyColorExpr(),
        'fill-extrusion-height': countyHeightExpr(),
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 0.85,
        'fill-extrusion-vertical-gradient': true,
      },
    },
    {
      id: 'county-line',
      type: 'line',
      source: 'counties',
      layout: { visibility: 'none' },
      paint: {
        'line-color': [
          'case',
          ['boolean', ['feature-state', 'hover'], false], INK.primary,
          'rgba(255,255,255,0.22)',
        ],
        'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 2, 0.6],
      },
    },

    // ---- turbine density ---------------------------------------------------
    // One-hue blue ramp; transparent at the low end so empty country reads empty.
    {
      id: 'turbine-heat',
      type: 'heatmap',
      source: 'turbines',
      maxzoom: 9.5,
      filter,
      paint: {
        // Bigger machines carry more weight, so the surface reads capacity
        // density rather than raw turbine count.
        'heatmap-weight': [
          'interpolate', ['linear'], ['coalesce', ['get', P.cap], 1500],
          600, 0.45, 3000, 0.8, 6000, 1,
        ],
        'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 4, 0.9, 9, 2.6],
        'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 4, 10, 7, 22, 9.5, 34],
        'heatmap-color': [
          'interpolate', ['linear'], ['heatmap-density'],
          0.00, 'rgba(13,54,107,0)',
          0.15, 'rgba(24,79,149,0.55)',
          0.35, '#256abf',
          0.55, '#3987e5',
          0.75, '#6da7ec',
          0.90, '#9ec5f4',
          1.00, '#cde2fb',
        ],
        'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 7.5, 0.9, 9.4, 0],
      },
    },

    // ---- individual turbines -----------------------------------------------
    {
      id: 'turbine-point',
      type: 'circle',
      source: 'turbines',
      minzoom: 7,
      filter,
      paint: {
        'circle-radius': turbineRadiusExpr(),
        'circle-color': turbineColorExpr(year),
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0.35, 9.5, 0.9],
        // A surface ring keeps overlapping marks separable at density.
        'circle-stroke-width': turbineStrokeWidthExpr(year),
        'circle-stroke-color': turbineStrokeColorExpr(year),
      },
    },

    // ---- clustered view (alternate to heat + points) ------------------------
    {
      id: 'cluster-circle',
      type: 'circle',
      source: 'turbines-clustered',
      filter: ['has', 'point_count'],
      layout: { visibility: 'none' },
      paint: {
        // Ordinal steps of the single blue hue -- more turbines reads brighter.
        'circle-color': [
          'step', ['get', 'point_count'],
          '#184f95', 25, '#256abf', 100, '#3987e5', 400, '#6da7ec', 1000, '#9ec5f4',
        ],
        'circle-radius': [
          'step', ['get', 'point_count'], 15, 25, 20, 100, 26, 400, 34, 1000, 44,
        ],
        'circle-opacity': 0.9,
        'circle-stroke-width': 1.5,
        'circle-stroke-color': 'rgba(13,13,13,0.75)',
      },
    },
    {
      id: 'cluster-count',
      type: 'symbol',
      source: 'turbines-clustered',
      filter: ['has', 'point_count'],
      layout: {
        visibility: 'none',
        'text-field': ['number-format', ['get', 'point_count'], {}],
        'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
        'text-size': 12,
        'text-allow-overlap': true,
      },
      paint: {
        'text-color': '#0d0d0d',
        'text-halo-color': 'rgba(255,255,255,0.55)',
        'text-halo-width': 0.8,
      },
    },
    {
      id: 'cluster-point',
      type: 'circle',
      source: 'turbines-clustered',
      filter: ['!', ['has', 'point_count']],
      layout: { visibility: 'none' },
      paint: {
        'circle-radius': turbineRadiusExpr(),
        'circle-color': turbineColorExpr(year),
        'circle-opacity': 0.9,
        'circle-stroke-width': 1,
        'circle-stroke-color': 'rgba(13,13,13,0.65)',
      },
    },
  ]
}

export function installLayers(map, { turbines, counties, year, filter }) {
  const sources = sourceSpecs()
  sources.turbines.data = turbines
  sources.counties.data = counties

  for (const [id, spec] of Object.entries(sources)) {
    if (!map.getSource(id)) map.addSource(id, spec)
  }

  // Insert everything beneath the basemap's own label layers so place names
  // stay readable on top of the data.
  const firstLabel = map.getStyle().layers.find(
    (l) => l.type === 'symbol' && l.layout && l.layout['text-field']
  )
  const before = firstLabel ? firstLabel.id : undefined

  for (const layer of layerSpecs({ year, filter })) {
    if (!map.getLayer(layer.id)) map.addLayer(layer, before)
  }
}

/** Repaint the "commissioned this year" highlight without touching the filter. */
export function setHighlightYear(map, year) {
  for (const id of ['turbine-point', 'cluster-point']) {
    if (!map.getLayer(id)) continue
    map.setPaintProperty(id, 'circle-color', turbineColorExpr(year))
    if (id === 'turbine-point') {
      map.setPaintProperty(id, 'circle-stroke-width', turbineStrokeWidthExpr(year))
      map.setPaintProperty(id, 'circle-stroke-color', turbineStrokeColorExpr(year))
    }
  }
}

/** Terrain + atmospheric sky. Re-added on every style load. */
export function installTerrain(map, enabled) {
  if (!map.getSource('mapbox-dem')) {
    map.addSource('mapbox-dem', {
      type: 'raster-dem',
      url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
      tileSize: 512,
      maxzoom: 14,
    })
  }
  if (!map.getLayer('sky')) {
    map.addLayer({
      id: 'sky',
      type: 'sky',
      paint: {
        'sky-type': 'atmosphere',
        'sky-atmosphere-sun': [0.0, 88.0],
        'sky-atmosphere-sun-intensity': 6,
      },
    })
  }
  // Texas relief is subtle; 1.4x exaggeration makes the Caprock read without
  // turning the Panhandle into the Alps.
  map.setTerrain(enabled ? { source: 'mapbox-dem', exaggeration: 1.4 } : null)
}
