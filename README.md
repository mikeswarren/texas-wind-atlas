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

The time scrubber animates the build-out from 1999 to 2025. Turbines
commissioned in the selected year are highlighted, so pressing play shows
Texas wind arriving county by county.

## Data

- **Turbines** — [U.S. Wind Turbine Database][uswtdb] (USGS, LBNL and ACP),
  Texas subset, public domain. Pulled live from the public PostgREST API.
- **County boundaries** — U.S. Census cartographic boundary files.

Rebuild the datasets with:

```bash
npm run data          # cached; add -- --refresh to re-pull from USGS
```

`scripts/build_data.py` (standard library only) writes three files into
`public/data/`:

| File | Contents |
| --- | --- |
| `turbines.geojson` | One point per turbine, short property keys — 4.2 MB raw, 182 KB gzipped |
| `counties.geojson` | 254 Texas counties with all-time joined statistics |
| `summary.json` | Statewide rollups, manufacturer list, records |

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

## Development

```bash
npm install
cp .env.example .env       # paste your Mapbox token
npm run dev                # http://127.0.0.1:5178
```

Other scripts:

```bash
npm run validate           # check every layer against the Mapbox style spec
npm run build              # production build into dist/
./scripts/deploy.sh        # validate, build, pre-compress, publish
```

`npm run validate` is worth knowing about. There is no browser in this
project's test path, and Mapbox drops a layer property with only a console
warning when an expression is malformed — so the layer definitions are kept as
pure data in `src/layers.js` and run through the official style-spec validator.
It caught a real bug during development: a `["zoom"]` expression nested inside
a `case`, which is illegal and would have silently killed the turbine stroke.

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

`deploy.sh` pre-compresses the data files and Caddy serves them with
`precompressed gzip`, so the 4.2 MB turbine feed goes over the wire as 182 KB
without re-gzipping on every cold request. The deploy also preserves whatever
token is already live in `config.js`, so publishing never takes the map down.

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
