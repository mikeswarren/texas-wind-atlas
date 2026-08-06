# Texas Wind Atlas

An interactive map of every utility-scale wind turbine in Texas — **19,380
turbines, 43,973 MW, 102 counties, 1999–2025** — built with Mapbox GL JS v3 on
open USGS data.

Live at <https://map.hitky.com>.

## What it demonstrates

Each of these is a distinct Mapbox GL technique, not a restatement of the same one:

| Technique | Where it shows up |
| --- | --- |
| Data-driven styling | Circle radius interpolated on both zoom and nameplate capacity |
| Heatmap layer | Capacity-weighted density surface below zoom 9.5 |
| Clustering | Alternate view with `clusterProperties` summing megawatts per cluster |
| `feature-state` | County choropleth repainted per year without re-uploading geometry |
| 3D extrusion | Counties extruded as capacity towers, height driven by feature-state |
| Terrain + sky | `raster-dem` terrain at 1.4× exaggeration with an atmosphere sky layer |
| Expression filters | Year, manufacturer, and capacity compiled into one `all` filter |
| Camera control | `flyTo` presets with per-place pitch and bearing |
| Style switching | Dark / satellite / terrain basemaps, with full layer re-installation |
| Popups & hover | Turbine detail popups, county hover via feature-state |
| Live data + collision | METAR wind arrows, rotated per feature, thinned by `symbol-sort-key` |

The time scrubber animates the build-out from 1999 to 2025. Turbines
commissioned in the selected year are highlighted, so pressing play shows
Texas wind arriving county by county.

## Data

- **Turbines** — [U.S. Wind Turbine Database][uswtdb] (USGS, LBNL and ACP),
  Texas subset, public domain. Pulled live from the public PostgREST API.
- **County boundaries** — U.S. Census cartographic boundary files.
- **Live wind** — NOAA [aviation weather][awc] METARs, fetched in the browser and
  never baked: a METAR is stale within the hour, so anything written to disk
  would ship already wrong. Only the station roster is built ahead of time.

Rebuild the datasets with:

```bash
npm run data                  # cached; add -- --refresh to re-pull from USGS
npm run data -- --clean       # drop the cache (~8 MB) and exit
```

Raw API pages are cached in `scripts/.cache/`, which is gitignored and does not
grow: page files are keyed by offset, so `--refresh` overwrites them in place
rather than stacking generations. Each run prints the cache's size and age so
the footprint is never a surprise.

`scripts/build_data.py` (standard library only) writes four files into
`public/data/`:

| File | Contents |
| --- | --- |
| `turbines.geojson` | One point per turbine, short property keys — 4.2 MB raw, 182 KB gzipped |
| `counties.geojson` | 254 Texas counties with all-time joined statistics |
| `summary.json` | Statewide rollups, manufacturer list, records |
| `stations.json` | 215 Texas METAR stations — the roster for the live wind layer |

### Two data-quality notes

The USWTDB Texas extract has 19,464 records, of which **100 carry no
commission year**. Rather than drop them silently:

- 16 were filled from the median year of the other turbines in the same wind
  farm, and are flagged with `yi: 1` — their popups say so.
- 84 had no recoverable year and are excluded from the map. The count is
  printed in the app footer.

Per-year county totals are **not** precomputed in the ETL. The UI filters by
manufacturer and capacity, and a baked-in rollup would disagree with the map
the moment a filter was applied — the tiles would report all 19,380 turbines
while the map drew 3,784. `src/stats.js` recomputes them client-side in ~17 ms.

## Live surface wind

A toggle in the map controls overlays current wind at Texas airports, from
NOAA's [aviation weather API][awc]. 215 stations are on the roster; a typical
cycle returns ~183 observations in under two seconds.

**It is current, not live, and the UI never pretends otherwise.** A METAR is
issued once an hour, with a SPECI in between only when conditions change
materially, so readings in one cycle range from a few minutes to about an hour
old. Every popup carries its observation's age, and the line under the toggle
states the whole field's range at once (`183 stations reporting · observed 6 min
ago to 32 min ago · 5 calm · 13 variable`). Polling is every five minutes —
faster re-downloads identical bytes — and the edge caches for two, so all
visitors together cost NOAA one request per two minutes rather than one each.

Three decisions are load-bearing:

- **The arrow is colourless.** Speed is arrow length. Blue means installed
  capacity everywhere else on this map, and a second magnitude in the same hue
  would read as the same quantity — so the live layer stays outside the colour
  system rather than adding a third scale to it.
- **Variable and calm winds are dots, not arrows.** `wdir` comes back as an
  integer, the string `"VRB"`, `null`, or with the key missing entirely — in one
  live cycle, 177 / 21 / 3 / 3. Mapbox coerces all three non-numbers to `0` in
  `icon-rotate`, which would draw a confident *north* wind at exactly the
  stations that reported no direction at all. `scripts/test_wx.mjs` pins all four
  shapes.
- **Decluttering is collision detection, not a zoom filter.** `zoom` is illegal
  inside a filter expression, so thinning 215 stations uses
  `icon-allow-overlap: false` with `symbol-sort-key` set to the station's NOAA
  priority (0 = major hub). Statewide you get the hubs; zooming in fills in the
  small fields continuously, with no pop at a breakpoint.

Arrows fly **with** the wind. METAR reports the direction it comes **from**, so
the icon is rotated a further 180° — the two readings are exact opposites, and
both the legend and every popup say which is which.

The API sends no `Access-Control-Allow-Origin`, so a browser fetch straight to it
is refused. The edge Caddy re-serves `/api/data/*` from this origin under `/wx`,
and `vite.config.js` mirrors that proxy for `npm run dev` — otherwise the layer
would work in production and fail only in development.

## Development

```bash
npm install
cp .env.example .env       # paste your Mapbox token
npm run dev                # http://127.0.0.1:5178
```

Other scripts:

```bash
npm run validate           # style spec + splitter and METAR regression tests
npm run build              # production build into dist/
./scripts/deploy.sh        # validate, build, pre-compress, publish
```

`npm run validate` is worth knowing about. There is no browser in this
project's test path, and Mapbox drops a layer property with only a console
warning when an expression is malformed — so the layer definitions are kept as
pure data in `src/layers.js` and run through the official style-spec validator.
It caught a real bug during development: a `["zoom"]` expression nested inside
a `case`, which is illegal and would have silently killed the turbine stroke.

## The analytics dashboard

A KPI strip and five charts sit under the map and are **always there** — no
button, no drawer, no open/closed state. The analysis is what the page is for, so
it renders on landing alongside the map; anything gated behind a control is a
feature most visitors never find. The split is a plain two-row CSS grid, so it is
laid out on first paint with no script, flash, or reflow.

The invariant that makes it worth having: **every number in the drawer is derived
from the same index the map is drawing, at the same selected year, under the same
filters.** There is no second source of truth and nothing precomputed that could
drift. Filter to Vestas and it becomes a Vestas dashboard — headline capacity,
both rankings, the size distribution, and the technology curves all move together,
and the header states the slice in one sentence.

| Card | Form | Why that form |
| --- | --- | --- |
| Cumulative installed capacity | area, one series | a stock over time; the per-year *flow* is its own chart in the sidebar, because putting both on shared axes would need two y-scales |
| Capacity by manufacturer | ranked bars, top 7 | click a bar to set the global manufacturer filter (click it again to clear) |
| Capacity by county | ranked bars, top 10 | click a row to zoom the map to that county |
| Fleet technology | two lines | median hub height and rotor diameter — legal on one axis only because both are metres |
| Fleet by machine size | histogram, 7 classes | the technology shift, as a distribution rather than an average |

Two decisions in there are load-bearing:

- **The tail is a caption, not a bar.** Texas has 102 wind counties and the 92
  outside the top 10 hold ~69% of all capacity. Folding them into an eleventh bar
  made that bar the longest thing on the chart and squashed every real county into
  a sliver, so the remainder is reported as a caption (`+ 89 more counties ·
  30,526 MW · 69% of total`) instead. Fully disclosed, but it doesn't set the
  length scale. The table view lists it as a row like any other and sums to 100%.
- **Category labels are measured, not estimated.** `Siemens Gamesa Renewable
  Energy` and `Glasscock County` overflowed a gutter sized by a character-count
  guess, and an over-long SVG label is silently cropped by the viewBox — the
  reader gets `newable Energy`. A shared canvas context measures the real string
  so the ellipsis lands where the text stops fitting; the full name stays in the
  tooltip, the `<title>`, and the table.

### Resizable layout

Both dividers are draggable — the sidebar/map edge and the map/analytics edge — so
how much of the window is map is the reader's call. The cursor changes to
`col-resize` / `row-resize` on hover, and each divider is a focusable
`role="separator"`: **arrow keys** nudge by 16px, **Shift+arrow** by 48px, **Home**
and **End** jump to the limits, and **double-click** restores the default. Sizes
persist per browser.

Each divider is a **grid track**, not an overlay — `#app` is
`var(--panel-w) var(--split) 1fr` and `#map-wrap` is `1fr var(--split) var(--dash-h)`
— so a drag is only ever "write one custom property" and the browser reflows the
grid. The track also draws the divider hairline, which is why `#panel` and `.dash`
carry no border of their own.

Three details in `src/splitters.js` are load-bearing, and `npm run validate`
regression-tests all of them (`scripts/test_splitters.mjs`, 20 checks against a DOM
stub — no browser needed):

- **The current size is measured from the pane, never read back from the custom
  property.** The defaults are viewport-relative (`--dash-h: 57vh`), and reading
  the property gives the *string* `"57vh"` — which `parseFloat` turns into `57`. A
  keyboard nudge computed from that collapses the panel to ~57px.
- **No px override is written until you actually resize something.** Publishing a
  measured value at boot would freeze the layout for visitors who never touch a
  divider, and an inline style would also beat the mobile `62vh` media query.
- **The analytics floor is 56px, not 0.** There is no button to bring the panel
  back, so the divider is the only handle and a 0px pane would be unhittable.

Mapbox does not notice a container resize on its own, so the drag calls
`map.resize()`; the charts already re-draw through their own `ResizeObserver`.

Every card has a **table view** (one toggle in the header), so no value is
reachable by hover alone. Colours are unchanged from the map's palette — two
validated categorical slots and one blue sequential ramp — because the only
two-series chart here happens to be two measures in the same unit.

## Getting a Mapbox token

Mapbox needs a public access token to serve map tiles. The free tier covers
**50,000 map loads a month** and requires no card to start.

1. Sign up at <https://account.mapbox.com/auth/signup/>.
2. On your account page, copy the **default public token** — it starts with `pk.`.
3. Give it to the app one of these ways:
   - **Local dev** — put it in `.env` as `VITE_MAPBOX_TOKEN=pk...`.
   - **Deployed** — edit `window.MAPBOX_TOKEN` in
     `/srv/sites/map.hitky.com/config.js`. That file is served uncached and read
     before the bundle, so the token changes with no rebuild and no redeploy.
   - **Just trying it** — open the site with no token configured and paste one
     into the setup screen; it is kept in that browser's localStorage only.

### Restrict the token before sharing the link

A public token is visible to anyone who opens the page — that is normal and
unavoidable for a browser map, and the protection is a URL restriction rather
than secrecy:

1. Go to <https://account.mapbox.com/access-tokens/> and open the token.
2. Under **URL restrictions**, add `https://map.hitky.com/*`.
3. Save. The token now only works from that origin, so a copied token is
   useless elsewhere and cannot run up your quota.

Also set a spending limit under **Billing** — pay-as-you-go pricing means a
runaway loop or an unexpected traffic spike bills real money past the free
tier.

If Mapbox rejects the token the app catches the 401 and returns to its setup
screen with an explanation, rather than showing an empty grey canvas.

## Deployment

The site is a static build behind the shared edge Caddy on this server
(see `~/claude/caddy-sites/README.md`):

- Routing: `~/claude/caddy-sites/map.caddy`
- Web root: `/srv/sites/map.hitky.com/`
- Publish: `./scripts/deploy.sh`, then `~/claude/edge/reload.sh` if routing changed

`map.caddy` also carries the `/wx` reverse proxy the live wind layer depends on.
That part is **not** shipped by `deploy.sh` — it is edge config, so a change
there needs `~/claude/edge/reload.sh` (validate-then-hot-reload, zero downtime).
A deploy without the reload leaves the toggle failing on CORS.

`deploy.sh` pre-compresses the data files and Caddy serves them with
`precompressed gzip`, so the 4.2 MB turbine feed goes over the wire as 182 KB
without re-gzipping on every cold request. The deploy also preserves whatever
token is already live in `config.js`, so publishing never takes the map down.

### Autodeploy

A push to `main` reaches the live site on its own, within about three minutes.
It is **pull-based** — nothing at GitHub can reach this server, and no deploy key
or SSH secret exists anywhere off the box:

```text
map-autodeploy.timer   every 3 min
  └─ map-autodeploy.service  (User=ubuntu, Type=oneshot)
       └─ /usr/local/bin/map-autodeploy      <- scripts/autodeploy-launcher.sh
            └─ snapshots scripts/autodeploy.sh to a temp file, runs the snapshot
                 ├─ git fetch; HEAD == origin/main ? exit
                 ├─ git reset --hard origin/main
                 ├─ npm ci                   <- only if package{,-lock}.json moved
                 └─ ./scripts/deploy.sh      <- validate, build, publish
```

It deploys from its own clone at `/srv/build/texas-wind-atlas`, never from a
developer's working copy, so an in-progress edit can neither be clobbered nor
accidentally shipped. Every deploy is therefore reproducible from a clean tree.

```bash
sudo journalctl -u map-autodeploy -n 40        # what it did, and when
systemctl list-timers map-autodeploy.timer     # when it next runs
sudo systemctl start map-autodeploy.service    # deploy now, don't wait
```

`scripts/autodeploy.sh` runs from a **temp-file snapshot**, because the script's
own `git reset --hard` would otherwise be able to rewrite the bytes bash had not
yet read. Taking the snapshot is the only job of
`scripts/autodeploy-launcher.sh`, the one installed file:

```bash
sudo install -m 755 scripts/autodeploy-launcher.sh /usr/local/bin/map-autodeploy
```

That launcher holds no project logic and should never need reinstalling again —
which is the point. An earlier version installed a copy of `autodeploy.sh`
itself, so every edit to the deploy logic silently did nothing until someone
remembered this command. Now `autodeploy.sh` is edited in the repo like anything
else and takes effect on the next run.

Because `deploy.sh` validates the style specs and builds before it publishes, a
push that breaks either one fails inside the timer and leaves the previous build
serving — the failure shows up in `journalctl`, not on the site.

### What is actually deployed

Every build writes `build.json` next to the bundle, and Caddy serves it
`no-store`:

```bash
curl -s https://map.hitky.com/build.json     # commit, subject, dirty flag, build time
```

Asset filenames are content hashes, so they cannot be compared against a commit
by eye — and a `dist/` built from a working copy differs from the deployed one
even at the same commit, because Vite compiles `VITE_MAPBOX_TOKEN` from your
`.env` into the bundle. `deploy.sh` refuses to publish a bundle with a token
compiled in: it would outrank `config.js` and sit in an asset cached `immutable`
for a year, so it could not be rotated without a rebuild. Build from a clean
clone (as autodeploy does) or pass `VITE_MAPBOX_TOKEN= ./scripts/deploy.sh`.

**DNS:** `map.hitky.com` must point at this server. hitky.com is
Cloudflare-proxied, and a brand-new orange-clouded hostname dead-locks its
first certificate issuance — grey-cloud the record for about two minutes, let
Caddy obtain the cert, then turn the proxy back on. Renewals do not have this
problem.

## Design notes

Colour is doing two jobs here, and they are kept separate:

- **Categorical (identity)** — blue for turbines already standing, orange for
  those commissioned in the selected year. Two slots, validated all-pairs under
  simulated protanopia and deuteranopia against both the panel and basemap
  surfaces (worst pair ΔE 26.8 CVD / 31.8 normal vision).
- **Sequential (magnitude)** — a single blue hue, stepped, for county capacity
  and for turbine density. The anchor is flipped for the dark basemap: near-zero
  recedes into the surface and magnitude reads brighter.

Manufacturer is deliberately a *filter*, not a colour encoding. Eight
manufacturers on a map would need eight pairwise-distinguishable hues, which no
ordering achieves at an accessible contrast floor.

The timeline shows one measure — megawatts added per year. Cumulative capacity
is a stat tile instead of a second line, because two measures of different
scale on shared axes means two y-scales, and that chart cannot be read
reliably.

[uswtdb]: https://energy.usgs.gov/uswtdb/
[awc]: https://aviationweather.gov/data/api/
