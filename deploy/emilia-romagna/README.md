# Geoportale Emilia-Romagna — deployment kit

A configuration-only deployment of the Regione Emilia-Romagna 3D geoportal on
GeoLibre: no fork, no code. Everything the portal is made of arrives as
environment variables of the prebuilt web image or as files mounted into its
docroot, so a change of catalog, branding or service endpoint is a restart,
not a rebuild.

```
deploy/emilia-romagna/
├── docker-compose.yml      the web image with every setting the portal needs
├── .env.example            the two credentials (copy to .env and fill in)
├── projects/
│   └── geoportale.geolibre.json   the start project: view, DBTR basemap
├── init/
│   └── catalogo-rapido.json       the catalog tree (TerriaJS init format)
└── branding/               put logo.svg and favicon.png here (not shipped)
```

## Run

```bash
cp .env.example .env        # then fill in the Ion token and the geocoder key
mkdir -p branding           # drop logo.svg and favicon.png in
docker compose up --build   # http://localhost:8080
```

The entrypoint validates every setting at start and refuses to boot on a value
that can never work (a colour that is not `#rrggbb`, a service that is not an
http(s) URL), naming the variable.

## Local `npm run dev` (no Docker)

The Vite dev server serves this kit at the same URL prefixes as the container
(`/init`, `/projects`, `/branding`). Point the app at those paths with `VITE_*`
vars in `apps/geolibre-desktop/.env` or `.env.local` (restart `npm run dev`
after editing env or after dropping branding assets):

```bash
# from the repo root
printf '%s\n' \
  'VITE_CATALOG_URLS=/init/catalogo-rapido.json' \
  'VITE_START_PROJECT_URL=/projects/geoportale.geolibre.json' \
  'VITE_BRAND_NAME=Geoportale Emilia-Romagna' \
  'VITE_BRAND_LOGO_URL=/branding/logo.svg' \
  'VITE_BRAND_LOGO_LINK=https://geoportale.regione.emilia-romagna.it/' \
  'VITE_BRAND_FAVICON_URL=/branding/favicon.png' \
  'VITE_BRAND_ACCENT_COLOR=#519ac2' \
  >> apps/geolibre-desktop/.env.local
# Logo and favicon are not shipped; place them here so /branding/... resolves:
#   deploy/emilia-romagna/branding/logo.svg
#   deploy/emilia-romagna/branding/favicon.png
npm run dev
```

Then open `http://127.0.0.1:5173/init/catalogo-rapido.json` — you should see
JSON, not the app shell. Use **`/init/catalogo-rapido.json`**, not a
repo-relative path such as `deploy/emilia-romagna/init/...` (that URL does not
exist under Vite). Name and accent apply from the env alone; logo and favicon
need the files under `branding/` (then `http://127.0.0.1:5173/branding/logo.svg`
works). Mirror any other compose `GEOLIBRE_*` settings you need as `VITE_*` in
the same file (Ion token, geocoder, …).

## What each part configures

| Setting                                                         | Feature                                                                                                                                                                                                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GEOLIBRE_BRAND_*`                                              | Name, crest and accent colour in the toolbar, page title and favicon                                                                                                                                                                                   |
| `GEOLIBRE_START_PROJECT_URL`                                    | The project every visitor opens on: the view over the region and the DBTR basemap. Edit `projects/geoportale.geolibre.json` (or save a project from the app and drop it here) to change what the portal starts with — layers, projection, plugin state |
| `GEOLIBRE_CATALOG_URLS`                                         | The catalog tree in the **Catalog** panel, opened by default. `init/catalogo-rapido.json` is the "catalogo rapido"; add the full tree as further files, comma separated                                                                                |
| `GEOLIBRE_CESIUM_TOKEN`, `GEOLIBRE_CESIUM_TERRAIN_ASSET_ID`     | The region's own terrain (Ion asset 2473055) under the 3D globe                                                                                                                                                                                        |
| `GEOLIBRE_ELEVATION_MEAN_SEA_LEVEL`                             | Heights above mean sea level (EGM96) in the 3D tools and the status bar                                                                                                                                                                                |
| `GEOLIBRE_GEOCODER_*`                                           | Address search through the region's eGeoCoding normaliser                                                                                                                                                                                              |
| `GEOLIBRE_WHERE_AM_I_*`                                         | The place name under the pointer in the status bar                                                                                                                                                                                                     |
| `GEOLIBRE_COORDS_CONVERTER_URL`                                 | Controls → Coordinate converter, on the region's GeometryServer (Monte Mario, ED50, ETRS89, RDN2008, UTM, with its NTv2 grids)                                                                                                                         |
| `GEOLIBRE_FEEDBACK_*`                                           | Help → Give feedback opens a pre-addressed e-mail                                                                                                                                                                                                      |
| `GEOLIBRE_LOGIN_SERVICE_URL`, `GEOLIBRE_USER_PROFILES`          | **Sign in** in the toolbar (HTTP Basic against GeoServer, session in memory only), which unlocks catalog entries with `allowedGroups`, carries the header to services with `useAuthentication`, and gates the query tools by profile                   |
| `GEOLIBRE_MICROZONATION_*`                                      | Controls → Seismic microzonation on the civil-protection WFS (studies, CLE, documents, emergency plans page)                                                                                                                                           |
| `GEOLIBRE_GLOBE_COLOR`, `_TRANSLUCENCY`, `_COLLISION_DETECTION` | The globe's base colour, a see-through globe (for the underground models) and the camera's terrain collision, as defaults the user can change in the terrain settings                                                                                  |
| `GEOLIBRE_RELATED_MAPS`                                         | Help → Related maps: the region's other portals, as a JSON list of `{ title, url, description }`                                                                                                                                                       |

The Emilia-Romagna basemaps (DBTR webmap, DBTR CTR, the AGEA/CGR orthophotos)
are built into the basemap picker's Regional section; the start project selects
the DBTR webmap. The 3D tools (3D measure with terrain profile and several
paths, line of sight, viewshed area, play path, globe clipping, elevation
bands) are the **3D Tools** plugin, under the Controls menu; a GPX track or
any line layer becomes a measure path — and a Play Path flight — from its row
menu in the Layers panel.

## Not covered here

- A same-origin proxy that injects the geocoder credentials (so the browser
  never sees them). The region's own map services send CORS headers, so no
  proxy is needed for the catalog.
- Server-side enforcement: as in the old geoportal, `allowedGroups` and the
  per-profile popup fields are applied in the browser; a service that must
  stay private has to check the Basic header itself.
- The full catalog tree: `init/catalogo-rapido.json` is the quick catalog;
  drop the production init files next to it and list them in
  `GEOLIBRE_CATALOG_URLS`.
