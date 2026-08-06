/**
 * Validate every source and layer against the official Mapbox style spec.
 *
 * There is no browser in this project's CI, and a bad expression in a paint
 * property fails silently at runtime (Mapbox logs and drops the layer). This
 * catches those statically. Run with `npm run validate`.
 */

import { validate } from '@mapbox/mapbox-gl-style-spec'
import { sourceSpecs, layerSpecs, turbineFilter } from '../src/layers.js'

const style = {
  version: 8,
  name: 'texas-wind-atlas',
  // The real basemap styles supply these; a bare test style must declare them
  // or every symbol layer trips a false "text-field requires glyphs" error.
  glyphs: 'mapbox://fonts/mapbox/{fontstack}/{range}.pbf',
  sprite: 'mapbox://sprites/mapbox/dark-v11',
  sources: sourceSpecs(),
  layers: [
    // The sky layer is added separately at runtime; include it here too.
    {
      id: 'sky',
      type: 'sky',
      paint: {
        'sky-type': 'atmosphere',
        'sky-atmosphere-sun': [0.0, 88.0],
        'sky-atmosphere-sun-intensity': 6,
      },
    },
    ...layerSpecs({
      year: 2025,
      filter: turbineFilter({ year: 2025, manufacturer: 'all', minCap: 0 }),
    }),
  ],
}

// Exercise the filter builder's other branches too -- they are swapped in at
// runtime by setFilter, so they need to be valid style-spec expressions.
const filterCases = [
  { year: 2010, manufacturer: 'all', minCap: 0 },
  { year: 2010, manufacturer: 'GE Wind', minCap: 0 },
  { year: 2010, manufacturer: 'all', minCap: 2000 },
  { year: 2010, manufacturer: 'Vestas', minCap: 3000 },
]
filterCases.forEach((c, i) => {
  style.layers.push({
    id: `filter-case-${i}`,
    type: 'circle',
    source: 'turbines',
    filter: turbineFilter(c),
    paint: { 'circle-radius': 3 },
  })
})

const errors = validate(style)

if (errors.length) {
  console.error(`\n${errors.length} style-spec error(s):\n`)
  for (const e of errors) console.error(`  ${e.message}`)
  process.exit(1)
}

const real = style.layers.filter((l) => !l.id.startsWith('filter-case-'))
console.log(
  `Style spec OK — ${Object.keys(style.sources).length} sources, ${real.length} layers, ` +
  `${filterCases.length} filter permutations.`
)
