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

## What each part configures

| Setting                                                     | Feature                                                                                                                                                                                                                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GEOLIBRE_BRAND_*`                                          | Name, crest and accent colour in the toolbar, page title and favicon                                                                                                                                                                                   |
| `GEOLIBRE_START_PROJECT_URL`                                | The project every visitor opens on: the view over the region and the DBTR basemap. Edit `projects/geoportale.geolibre.json` (or save a project from the app and drop it here) to change what the portal starts with — layers, projection, plugin state |
| `GEOLIBRE_CATALOG_URLS`                                     | The catalog tree in the **Catalog** panel, opened by default. `init/catalogo-rapido.json` is the "catalogo rapido"; add the full tree as further files, comma separated                                                                                |
| `GEOLIBRE_CESIUM_TOKEN`, `GEOLIBRE_CESIUM_TERRAIN_ASSET_ID` | The region's own terrain (Ion asset 2473055) under the 3D globe                                                                                                                                                                                        |
| `GEOLIBRE_ELEVATION_MEAN_SEA_LEVEL`                         | Heights above mean sea level (EGM96) in the 3D tools and the status bar                                                                                                                                                                                |
| `GEOLIBRE_GEOCODER_*`                                       | Address search through the region's eGeoCoding normaliser                                                                                                                                                                                              |
| `GEOLIBRE_WHERE_AM_I_*`                                     | The place name under the pointer in the status bar                                                                                                                                                                                                     |
| `GEOLIBRE_COORDS_CONVERTER_URL`                             | Controls → Coordinate converter, on the region's GeometryServer (Monte Mario, ED50, ETRS89, RDN2008, UTM, with its NTv2 grids)                                                                                                                         |
| `GEOLIBRE_FEEDBACK_*`                                       | Help → Give feedback opens a pre-addressed e-mail                                                                                                                                                                                                      |

The Emilia-Romagna basemaps (DBTR webmap, DBTR CTR, the AGEA/CGR orthophotos)
are built into the basemap picker's Regional section; the start project selects
the DBTR webmap. The 3D tools (3D measure with terrain profile, line of sight,
play path, globe clipping, elevation bands) are the **3D Tools** plugin, under
the Controls menu.

## Not covered here

- A same-origin proxy that injects the geocoder credentials (so the browser
  never sees them). The region's own map services send CORS headers, so no
  proxy is needed for the catalog.
- A sign-in gate or per-group catalog visibility: see the migration analysis
  for what the old geoportal actually enforced.
- The full catalog tree, the query window and the in-app guides: they need
  the production init files and guide text, which are not in any repository.
