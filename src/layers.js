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

/**
 * Live wind is drawn in one neutral ink, never in the blue ramp. Blue means
 * installed capacity everywhere else on this map, and a second magnitude
 * encoded in the same hue would read as the same quantity. Wind speed is
 * carried by arrow length instead, which leaves the colour system at its
 * existing two categorical slots plus one sequential ramp.
 */
export const WIND_INK = '#e8e6dc'
export const WIND_ARROW = 'wind-arrow'

/**
 * Arrow length by wind speed, in knots. The floor is deliberately well above
 * zero -- a 2 kt arrow still has to be visibly an arrow, pointing somewhere --
 * and the ceiling flattens past 35 kt so a single gale does not produce a mark
 * that covers a county.
 */
function windArrowSizeExpr() {
  const bySpeed = (small, big) => [
    'interpolate', ['linear'], ['get', 'spd'], 2, small, 35, big,
  ]
  return [
    'interpolate', ['linear'], ['zoom'],
    5, bySpeed(0.28, 0.6),
    8, bySpeed(0.38, 0.85),
    12, bySpeed(0.55, 1.25),
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
    // The state outline. One simplified MultiPolygon; see build_data.py.
    texas: { type: 'geojson', data: empty },
    // Live METARs. Starts empty on every style load and is filled by the first
    // fetch, so a style switch never blocks on the network.
    metar: { type: 'geojson', data: empty },
  }
}

/**
 * The wind arrow, drawn into a canvas rather than shipped as a sprite.
 *
 * It has to survive a basemap switch, which destroys every image in the style
 * along with the layers -- so it is regenerated in installLayers rather than
 * loaded once at boot. Generating it costs microseconds; a network round trip
 * for a sprite would race the style load and sometimes lose, leaving a symbol
 * layer with a missing image and no error beyond a console warning.
 *
 * A pale fill over a dark outline keeps it legible on the dark basemap and on
 * satellite imagery both, which is why it is not an SDF: an SDF is a single
 * colour by definition, and this mark needs two.
 */
export function makeWindArrow(pixelRatio = 2) {
  const w = 24
  const h = 34
  const canvas = document.createElement('canvas')
  canvas.width = w * pixelRatio
  canvas.height = h * pixelRatio
  const ctx = canvas.getContext('2d')
  ctx.scale(pixelRatio, pixelRatio)

  // Pointing north (up). icon-rotate turns it from there.
  ctx.beginPath()
  ctx.moveTo(12, 2)      // tip
  ctx.lineTo(19, 14)     // right barb
  ctx.lineTo(13.6, 12)
  ctx.lineTo(13.6, 31)   // shaft, right side
  ctx.lineTo(10.4, 31)
  ctx.lineTo(10.4, 12)   // shaft, left side
  ctx.lineTo(5, 14)      // left barb
  ctx.closePath()

  ctx.lineJoin = 'round'
  ctx.strokeStyle = 'rgba(13,13,13,0.85)'
  ctx.lineWidth = 2.4
  ctx.stroke()
  ctx.fillStyle = WIND_INK
  ctx.fill()

  return ctx.getImageData(0, 0, canvas.width, canvas.height)
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

    // ---- state outline -----------------------------------------------------
    // Reference geometry, not data: it says which shape you are looking at when
    // the map opens statewide. It is its own entry in the layer list, so
    // syncVisibility drives it like any other layer -- no `visibility` here,
    // because the default is visible and state.layers.boundary starts true.
    //
    // Drawn ABOVE the turbine and county layers, which is the usual order for a
    // reference boundary over a thematic surface -- underneath, the density
    // heatmap and the choropleth both wash it out along exactly the borders it
    // exists to draw. Crossing a few turbine dots at the state edge is the
    // cheaper trade.
    //
    // Weight matters more than subtlety here. At the statewide landing zoom an
    // earlier 0.7px/42% version computed to well under a pixel of faint grey and
    // was invisible against the basemap's own admin lines -- a layer nobody can
    // see is not a restrained layer, it is a broken one.
    {
      id: 'state-line',
      type: 'line',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      source: 'texas',
      paint: {
        'line-color': 'rgba(255,255,255,0.88)',
        // Zoom is top-level in the interpolate, which is the only place the
        // style spec allows it -- nesting ["zoom"] inside a case is illegal and
        // Mapbox drops the whole expression with nothing but a console warning.
        'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.6, 7, 2.4, 11, 3.4],
      },
    },

    // ---- live surface wind (METAR) -----------------------------------------
    // Last in the array, so wind draws over both the turbines and the county
    // choropleth: it is the only layer describing right now rather than history.
    {
      id: 'metar-calm',
      type: 'circle',
      source: 'metar',
      // Calm air and variable direction have no bearing to draw. An arrow at 0
      // degrees would invent a north wind the observation explicitly denies, so
      // these become hollow dots instead.
      filter: ['any', ['==', ['get', 'spd'], 0], ['==', ['get', 'vrb'], 1]],
      layout: { visibility: 'none' },
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 2.2, 9, 3.4, 13, 5],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-width': 1.2,
        'circle-stroke-color': WIND_INK,
        'circle-stroke-opacity': 0.85,
      },
    },
    {
      id: 'metar-wind',
      type: 'symbol',
      source: 'metar',
      filter: ['all', ['>', ['get', 'spd'], 0], ['==', ['get', 'vrb'], 0]],
      layout: {
        visibility: 'none',
        'icon-image': WIND_ARROW,
        // The arrow is drawn pointing north, and `dir` is the direction the wind
        // comes FROM -- so the icon is turned a further 180 degrees to fly with
        // the wind rather than into it. The popup states the convention in
        // words, because the two readings are exact opposites.
        'icon-rotate': ['+', ['get', 'dir'], 180],
        // Rotate with the map, not the viewport: a wind bearing is a fact about
        // the ground, so it has to survive a bearing change from flyTo.
        'icon-rotation-alignment': 'map',
        'icon-size': windArrowSizeExpr(),
        'icon-anchor': 'center',
        // Every station, at every zoom. Collision detection would hide the
        // arrows that lose a placement contest and reveal them on zoom, which
        // makes the field look like it is gaining stations when only the camera
        // moved -- and a wind field is read as a whole, so a partial one is the
        // wrong picture rather than a tidier one. There are ~183 of them; Texas
        // has room.
        'icon-allow-overlap': true,
        // Also true, or these arrows would still suppress the basemap's place
        // labels even while overlapping each other freely.
        'icon-ignore-placement': true,
        // No longer a thinning mechanism, since nothing is thinned. It still
        // sets draw order, so a major hub's arrow lands on top of a small
        // field's where the two overlap.
        'symbol-sort-key': ['get', 'pri'],
      },
      paint: {
        'icon-opacity': 0.95,
      },
    },
  ]
}

export function installLayers(map, { turbines, counties, texas, year, filter, metar }) {
  const sources = sourceSpecs()
  sources.turbines.data = turbines
  sources.counties.data = counties
  // Optional: the outline is context, so a failed fetch costs the border and
  // nothing else. Left empty, the layer draws nothing and everything else works.
  if (texas) sources.texas.data = texas
  // Re-seed with whatever the last poll returned, so a basemap switch does not
  // blank the wind for the five minutes until the next one.
  if (metar) sources.metar.data = metar

  for (const [id, spec] of Object.entries(sources)) {
    if (!map.getSource(id)) map.addSource(id, spec)
  }

  // Before the layers: a symbol layer whose icon is missing renders nothing and
  // says so only in the console.
  if (!map.hasImage(WIND_ARROW)) {
    map.addImage(WIND_ARROW, makeWindArrow(2), { pixelRatio: 2 })
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
