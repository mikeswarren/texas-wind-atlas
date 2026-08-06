/**
 * Palette, camera presets, and token resolution.
 *
 * Colors are not hand-picked. Two encoding jobs are in play:
 *
 *  - CATEGORICAL (identity, 2 slots): turbines already standing vs. turbines
 *    commissioned in the selected year. Validated all-pairs against both the
 *    panel surface (#1a1a19) and the basemap (#0d0d0d) under protanopia and
 *    deuteranopia -- worst pair dE 26.8 CVD / 31.8 normal vision. Two slots
 *    only, which is what keeps a map (where any two marks can touch) legal.
 *  - SEQUENTIAL (magnitude, one hue): county installed capacity, and turbine
 *    density in the heatmap. One blue hue, stepped light->dark, with the
 *    anchor flipped for a dark surface: near-zero recedes into the basemap and
 *    magnitude reads brighter.
 *
 * Manufacturer is deliberately NOT a color encoding. Eight manufacturers on a
 * map would need eight pairwise-distinct hues, which no ordering achieves; it
 * is a filter instead, and color stays on magnitude.
 */

/** Categorical slots (dark mode steps). */
export const SERIES = {
  standing: '#3987e5', // blue  -- turbines already built
  added: '#d95926',    // orange -- commissioned in the selected year
}

/** Sequential blue ramp, dark surface anchoring (near-zero -> bright). */
export const BLUE = {
  100: '#cde2fb', 150: '#b7d3f6', 200: '#9ec5f4', 250: '#86b6ef',
  300: '#6da7ec', 350: '#5598e7', 400: '#3987e5', 450: '#2a78d6',
  500: '#256abf', 550: '#1c5cab', 600: '#184f95', 650: '#104281',
  700: '#0d366b',
}

/** Chart chrome. Single committed dark look -- this is a night basemap. */
export const INK = {
  surface: '#1a1a19',
  plane: '#0d0d0d',
  primary: '#ffffff',
  secondary: '#c3c2b7',
  muted: '#898781',
  grid: '#2c2c2a',
  axis: '#383835',
  border: 'rgba(255,255,255,0.10)',
}

/**
 * Choropleth breaks, in MW of installed capacity per county.
 * Texas tops out at Nolan County (~2,259 MW), so the ramp is built for that
 * range rather than an even split that would waste most of its steps.
 */
export const MW_BREAKS = [
  { at: 0, color: '#161a1e' },     // no turbines -- recedes into the basemap
  { at: 1, color: BLUE[700] },
  { at: 100, color: BLUE[650] },
  { at: 300, color: BLUE[550] },
  { at: 600, color: BLUE[450] },
  { at: 1000, color: BLUE[350] },
  { at: 1600, color: BLUE[250] },
  { at: 2300, color: BLUE[100] },
]

/** Legend rows for the choropleth (label + swatch), coarser than the ramp. */
export const MW_LEGEND = [
  { label: 'none', color: '#161a1e' },
  { label: '1–100', color: BLUE[700] },
  { label: '100–300', color: BLUE[650] },
  { label: '300–600', color: BLUE[550] },
  { label: '600–1,000', color: BLUE[450] },
  { label: '1,000–1,600', color: BLUE[350] },
  { label: '1,600+', color: BLUE[200] },
]

/** Basemaps. Style switches force a full layer re-install -- see map.js. */
export const STYLES = {
  dark: { label: 'Dark', url: 'mapbox://styles/mapbox/dark-v11' },
  satellite: { label: 'Satellite', url: 'mapbox://styles/mapbox/satellite-streets-v12' },
  outdoors: { label: 'Terrain', url: 'mapbox://styles/mapbox/outdoors-v12' },
}

/** Camera presets. Pitch/bearing chosen per place, not copy-pasted. */
export const PLACES = [
  {
    id: 'statewide',
    label: 'Statewide',
    blurb: 'All 19,380 turbines across 102 counties.',
    camera: { center: [-99.6, 31.3], zoom: 5.2, pitch: 0, bearing: 0 },
  },
  {
    id: 'nolan',
    label: 'Sweetwater',
    blurb: 'Nolan County — 1,400 turbines, the densest wind cluster in Texas.',
    camera: { center: [-100.35, 32.36], zoom: 9.4, pitch: 55, bearing: -22 },
  },
  {
    id: 'panhandle',
    label: 'Panhandle',
    blurb: 'The post-2015 build-out along the Caprock Escarpment.',
    camera: { center: [-101.7, 34.6], zoom: 7.6, pitch: 45, bearing: 15 },
  },
  {
    id: 'coast',
    label: 'Gulf Coast',
    blurb: 'Kenedy and Willacy counties — sea-breeze wind, peaking on summer afternoons.',
    camera: { center: [-97.75, 26.65], zoom: 8.6, pitch: 50, bearing: 8 },
  },
  {
    id: 'ranchland',
    label: 'Tallest',
    blurb: 'Ranchland Wind, Callahan County — 200 m to blade tip, 6 MW per turbine.',
    camera: { center: [-99.36, 32.28], zoom: 11.6, pitch: 66, bearing: -40 },
  },
]

/**
 * Token resolution, in the priority order the expression below actually applies:
 *  1. ?token= in the URL  -- for a quick local try without touching files
 *  2. VITE_MAPBOX_TOKEN   -- baked in at build time from .env. Dev only: it
 *     outranks config.js and lands in an immutable, year-cached asset, so
 *     deploy.sh refuses to publish a bundle that contains one.
 *  3. window.MAPBOX_TOKEN -- set by /config.js, editable on the server with
 *     no rebuild, which is how the deployed site gets its token
 *  4. localStorage      -- a token pasted into the setup screen, this browser only
 */
export const TOKEN_STORAGE_KEY = 'twa:mapbox-token'

export function resolveToken() {
  let stored = ''
  try {
    stored = window.localStorage.getItem(TOKEN_STORAGE_KEY) || ''
  } catch {
    // Private-mode browsers can throw on localStorage; the other paths still work.
  }
  const url = new URLSearchParams(window.location.search).get('token')
  const build = import.meta.env.VITE_MAPBOX_TOKEN
  const runtime = typeof window !== 'undefined' ? window.MAPBOX_TOKEN : ''
  const token = (url || build || runtime || stored || '').trim()
  return token.startsWith('pk.') ? token : ''
}
