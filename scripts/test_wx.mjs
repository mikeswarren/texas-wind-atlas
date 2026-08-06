/**
 * Exercise src/wx.js against recorded METAR shapes -- no network, no browser.
 *
 * The reason this file exists: `wdir` arrives from NOAA in four different
 * shapes, and three of them are not numbers. In one live Texas cycle the split
 * was 177 integers, 21 of the string "VRB", 3 nulls, and 3 observations with no
 * `wdir` key at all. Feed any of the last three into `icon-rotate` and Mapbox
 * coerces it to 0, drawing a confident north wind at a station that reported no
 * direction whatsoever -- silently, and only on those few stations, which is
 * exactly the class of bug nobody notices in a screenshot.
 *
 * `wgst` has the same trap in a milder form: the key is absent when a station is
 * not gusting, rather than present and zero.
 *
 * Prints one line on success. Pass -v for the full report.
 */
import { buildRoster, fetchMetars, freshnessLine, ageMinutes, formatAge, knotsToMs } from '../src/wx.js'

const VERBOSE = process.argv.includes('-v')
const out = []
const say = (...a) => out.push(a.join(' '))
let checks = 0
let fails = 0

function check(label, got, want) {
  checks += 1
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fails += 1
  say(`   ${ok ? 'ok  ' : 'FAIL'}  ${label}: got ${JSON.stringify(got)}${ok ? '' : ` want ${JSON.stringify(want)}`}`)
}

const NOW = 1786050000000 // fixed clock: ages must be asserted, not observed
const t = (minutesAgo) => Math.round(NOW / 1000) - minutesAgo * 60

const ROSTER = buildRoster([
  { id: 'KDFW', name: 'Dallas-Ft Worth Intl', lat: 32.9, lon: -97.0, pri: 0 },
  { id: 'KAMA', name: 'Amarillo Intl', lat: 35.2, lon: -101.7, pri: 2 },
  { id: 'KSNK', name: 'Snyder Winston Fld', lat: 32.7, lon: -100.9, pri: 5 },
  { id: 'K6R3', name: 'Cleveland Muni', lat: 30.4, lon: -95.0, pri: 9 },
  { id: 'KMAF', name: 'Midland Intl', lat: 31.9, lon: -102.2, pri: 1 },
])

// One observation per real-world shape, values taken from a live cycle.
const CYCLE = [
  { icaoId: 'KDFW', lat: -97.0 * 0 + 32.9, lon: -97.0, wdir: 170, wspd: 11, wgst: 18, obsTime: t(5), rawOb: 'METAR KDFW 061953Z 17011G18KT', temp: 37.2, fltCat: 'VFR' },
  { icaoId: 'KAMA', lat: 35.2, lon: -101.7, wdir: 'VRB', wspd: 4, obsTime: t(12), rawOb: 'METAR KAMA VRB04KT' },
  { icaoId: 'KSNK', lat: 32.7, lon: -100.9, wdir: null, wspd: 0, obsTime: t(50), rawOb: 'METAR KSNK 00000KT' },
  { icaoId: 'K6R3', lat: 30.4, lon: -95.0, /* no wdir key at all */ wspd: 3, obsTime: t(62), rawOb: 'METAR K6R3' },
  { icaoId: 'KMAF', lat: 31.9, lon: -102.2, wdir: 360, wspd: 21, obsTime: t(5), rawOb: 'METAR KMAF 36021KT' },
]

// Swap in a fetch that replays the cycle, so the whole path from HTTP response
// to GeoJSON is exercised without a network.
function stubFetch(plan) {
  let call = 0
  globalThis.fetch = async () => {
    const step = plan[Math.min(call++, plan.length - 1)]
    if (step === 'fail') throw new Error('network down')
    if (typeof step === 'number') return { ok: false, status: step }
    return { ok: true, json: async () => step }
  }
}

say('1. every wdir shape survives normalisation')
stubFetch([CYCLE])
const { collection, partial } = await fetchMetars(ROSTER)
const by = Object.fromEntries(collection.features.map((f) => [f.properties.id, f.properties]))

check('numeric bearing kept', by.KDFW.dir, 170)
check('numeric bearing is not variable', by.KDFW.vrb, 0)
check('"VRB" becomes dir -1', by.KAMA.dir, -1)
check('"VRB" flagged variable', by.KAMA.vrb, 1)
check('null wdir becomes dir -1', by.KSNK.dir, -1)
check('null wdir flagged variable', by.KSNK.vrb, 1)
check('missing wdir key becomes dir -1', by.K6R3.dir, -1)
check('missing wdir key flagged variable', by.K6R3.vrb, 1)
check('360 stays 360-folded to 0', by.KMAF.dir, 0)

say('\n2. gusts are absent, not zero, when a station is not gusting')
check('gusting station keeps its gust', by.KDFW.gust, 18)
check('non-gusting station reports 0', by.KAMA.gust, 0)

say('\n3. the roster supplies name and priority, the observation supplies position')
check('name from roster', by.KDFW.name, 'Dallas-Ft Worth Intl')
check('priority from roster', by.K6R3.pri, 9)
check('geometry from observation', collection.features[0].geometry.coordinates, [-97, 32.9])

say('\n4. the layer filters can separate arrows from dots')
// metar-wind draws spd > 0 AND vrb == 0; metar-calm draws the rest. Every
// feature must land in exactly one of the two, or a station vanishes.
const arrows = collection.features.filter((f) => f.properties.spd > 0 && f.properties.vrb === 0)
const dots = collection.features.filter((f) => f.properties.spd === 0 || f.properties.vrb === 1)
check('arrows + dots covers every feature', arrows.length + dots.length, collection.features.length)
check('no feature is in both', arrows.filter((f) => dots.includes(f)).length, 0)
check('arrows are the two directed winds', arrows.map((f) => f.properties.id).sort(), ['KDFW', 'KMAF'])

say('\n5. ages are computed, never assumed fresh')
check('5 minutes', ageMinutes(t(5), NOW), 5)
check('62 minutes', ageMinutes(t(62), NOW), 62)
check('missing timestamp', ageMinutes(0, NOW), null)
check('format under an hour', formatAge(47), '47 min ago')
check('format over an hour', formatAge(62), '1h 2m ago')
check('format exact hour', formatAge(120), '2h ago')

say('\n6. the freshness line states the range and the caveats')
const line = freshnessLine(collection, { now: NOW })
check('counts reporting stations', line.includes('5 stations reporting'), true)
check('reports the newest and oldest', line.includes('observed 5 min ago to 1h 2m ago'), true)
check('counts calm separately', line.includes('1 calm'), true)
check('counts variable separately', line.includes('2 variable'), true)
// A 62-minute-old METAR is the current one -- the cycle is hourly. Warning here
// would fire on almost every normal observation and train people to ignore it.
check('does NOT cry stale at 62 min', line.includes('missed a cycle'), false)
const stale = { features: [{ properties: { obs: t(140), spd: 9, vrb: 0 } }] }
check('does warn once a cycle is actually missed', freshnessLine(stale, { now: NOW }).includes('missed a cycle'), true)

say('\n7. a partial failure degrades instead of blanking the map')
stubFetch([CYCLE, 'fail'])
const many = buildRoster(Array.from({ length: 120 }, (_, i) => ({
  id: `K${String(i).padStart(3, '0')}`, name: `Station ${i}`, lat: 31, lon: -99, pri: 5,
})))
const mixed = await fetchMetars(many)
check('kept the batch that answered', mixed.collection.features.length > 0, true)
check('flagged as partial', mixed.partial, true)
check('says so in the line', freshnessLine(mixed.collection, { partial: mixed.partial, now: NOW }).includes('partial'), true)

say('\n8. a total failure throws rather than showing an empty state as real')
stubFetch(['fail'])
let threw = false
try { await fetchMetars(ROSTER) } catch { threw = true }
check('every batch failing throws', threw, true)
stubFetch([503])
threw = false
try { await fetchMetars(ROSTER) } catch { threw = true }
check('an HTTP error is a failure, not empty data', threw, true)

say('\n9. knots convert to the unit the turbine world uses')
check('11 kt in m/s', Number(knotsToMs(11).toFixed(2)), 5.66)
check('0 kt', knotsToMs(0), 0)

say('\n10. no observations is stated, not rendered as calm')
check('empty collection', freshnessLine({ features: [] }, { now: NOW }), 'No observations returned.')

check('partial flag is false on a clean fetch', partial, false)

if (fails || VERBOSE) {
  console.log(out.join('\n'))
  console.log(`\n${fails === 0 ? 'ALL CHECKS PASS' : `${fails} FAILURE(S)`}`)
} else {
  console.log(`METAR normalisation OK — ${checks} checks passed.`)
}
process.exit(fails === 0 ? 0 : 1)
