/**
 * Live surface wind at Texas airports, from NOAA's aviation weather API.
 *
 * WHY A PROXY
 * aviationweather.gov sends no Access-Control-Allow-Origin, so a browser fetch
 * straight to it is refused. The edge Caddy re-serves /api/data/* from our own
 * origin under /wx (see caddy-sites/map.caddy). No key is involved; the proxy
 * exists purely to satisfy the same-origin policy.
 *
 * WHAT "NEAR REAL-TIME" ACTUALLY MEANS
 * A METAR is issued once an hour, with a SPECI in between only when conditions
 * change materially. Observations in a typical cycle are anywhere from 3 to 60
 * minutes old. So this layer is *current*, not *live*, and every reading carries
 * its own age -- the freshness line and the popups both state it, because a wind
 * barb that silently ages into an hour-old reading is worse than no barb.
 * Polling faster than the issue cycle just re-downloads identical bytes, which
 * is why REFRESH_MS is 5 minutes and the edge caches for 2.
 *
 * WHAT COMES BACK
 * The roster in public/data/stations.json decides which stations are asked
 * about; positions come from the observation itself, so a station that moves or
 * is decommissioned needs no rebuild here. Fields are inconsistent in ways that
 * matter, and normalise() is where that is absorbed:
 *
 *   wdir   integer degrees | the string "VRB" | null | key absent entirely
 *   wgst   present only when the station is actually gusting
 *   wspd   knots, integer; 0 means calm
 *
 * Variable and calm winds have no direction to draw, so they are not drawn as
 * arrows -- they become hollow dots. Rendering "VRB" as an arrow pointing at 0°
 * would invent a north wind that the observation explicitly denies.
 */

const API = 'wx/api/data/metar'

/** Slower than this and the layer feels stale; faster and it is the same bytes. */
export const REFRESH_MS = 5 * 60 * 1000

/**
 * A reading older than this is called out rather than shown as current. Set
 * above the hourly issue cycle on purpose: a 55-minute-old METAR is simply the
 * current one, and a banner that fires on every normal observation trains people
 * to ignore it. Past 90 minutes the station has actually missed a cycle.
 */
const STALE_MINUTES = 90

/** Meteorological convention: wind direction is where the wind blows FROM. */
export const KT_TO_MS = 0.514444

/**
 * One request carries the whole roster (215 ids, ~1.2 KB of query string, ~92 KB
 * back). Chunked anyway: the upstream gateway 502s rather than truncating when a
 * query string grows, and one oversized URL taking the layer down statewide is a
 * worse failure than four requests.
 */
const CHUNK = 60

function chunk(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/**
 * Absorb the four shapes `wdir` arrives in. Returns null for anything that is
 * not a bearing, which is the signal to draw a dot instead of an arrow.
 */
function windDirection(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // 0 and 360 both appear; 360 is the conventional "due north", 0 is calm in
    // raw METAR text but the JSON feed uses it for north too. Fold to 0-359.
    return ((raw % 360) + 360) % 360
  }
  return null // "VRB", null, or the key was never there
}

function knots(raw) {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}

/**
 * Observation -> GeoJSON feature. Properties are kept short and flat because
 * they cross into the style as expression inputs.
 */
function toFeature(obs, roster) {
  const dir = windDirection(obs.wdir)
  const spd = knots(obs.wspd)
  if (spd === null || obs.lat == null || obs.lon == null) return null

  const station = roster.get(obs.icaoId)
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [obs.lon, obs.lat] },
    properties: {
      id: obs.icaoId,
      name: station ? station.name : (obs.name || obs.icaoId),
      // Priority thins the display at statewide zoom. Unranked stations sort to
      // the bottom so they never displace a hub.
      pri: station ? station.pri : 9,
      dir: dir === null ? -1 : dir, // -1 == variable or unreported
      vrb: dir === null ? 1 : 0,
      spd,
      gust: knots(obs.wgst) ?? 0,
      // Seconds, not a formatted string: the age has to be recomputed as the
      // clock moves without re-fetching.
      obs: obs.obsTime || 0,
      raw: obs.rawOb || '',
      temp: typeof obs.temp === 'number' ? obs.temp : null,
      cat: obs.fltCat || '',
    },
  }
}

/** Fetch every roster station's latest observation. */
export async function fetchMetars(roster, { base = '' } = {}) {
  const ids = [...roster.keys()]
  const batches = chunk(ids, CHUNK)

  const results = await Promise.allSettled(
    batches.map(async (batch) => {
      const res = await fetch(`${base}${API}?ids=${batch.join(',')}&format=json`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    })
  )

  const features = []
  let failed = 0
  for (const r of results) {
    if (r.status !== 'fulfilled') { failed += 1; continue }
    // A single bad batch must not blank the state. Partial data is drawn, and
    // the shortfall is reported rather than hidden.
    for (const obs of Array.isArray(r.value) ? r.value : []) {
      const f = toFeature(obs, roster)
      if (f) features.push(f)
    }
  }

  if (failed === batches.length) {
    throw new Error('the weather service did not respond')
  }

  return {
    collection: { type: 'FeatureCollection', features },
    partial: failed > 0,
    asked: ids.length,
  }
}

/** Roster array -> Map keyed by ICAO id, which is how observations join back. */
export function buildRoster(stations) {
  return new Map(stations.map((s) => [s.id, s]))
}

/** Minutes since an observation, from its epoch-seconds timestamp. */
export function ageMinutes(obsSeconds, now = Date.now()) {
  if (!obsSeconds) return null
  return Math.max(0, Math.round((now / 1000 - obsSeconds) / 60))
}

export function formatAge(minutes) {
  if (minutes === null) return 'time unknown'
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h}h ${m}m ago` : `${h}h ago`
}

/**
 * One sentence describing the whole layer's freshness, which is the only honest
 * way to label a field of readings taken at different times.
 */
export function freshnessLine(collection, { partial = false, now = Date.now() } = {}) {
  const feats = collection.features
  if (!feats.length) return 'No observations returned.'

  const ages = feats
    .map((f) => ageMinutes(f.properties.obs, now))
    .filter((a) => a !== null)
    .sort((a, b) => a - b)

  const reporting = feats.length
  const calm = feats.filter((f) => f.properties.spd === 0).length
  const vrb = feats.filter((f) => f.properties.vrb === 1 && f.properties.spd > 0).length

  const parts = [`${reporting} stations reporting`]
  if (ages.length) {
    const newest = ages[0]
    const oldest = ages[ages.length - 1]
    parts.push(
      newest === oldest
        ? `observed ${formatAge(newest)}`
        : `observed ${formatAge(newest)} to ${formatAge(oldest)}`
    )
    if (oldest > STALE_MINUTES) parts.push(`some stations have missed a cycle (${formatAge(oldest)})`)
  }
  if (calm) parts.push(`${calm} calm`)
  if (vrb) parts.push(`${vrb} variable`)
  if (partial) parts.push('partial — some stations did not answer')

  return `${parts.join(' · ')}.`
}

/** Knots to the m/s the turbine world speaks, for the popup. */
export function knotsToMs(kt) {
  return kt * KT_TO_MS
}
