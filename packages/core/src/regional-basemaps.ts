/**
 * Raster basemaps for regions the default catalog does not serve well.
 *
 * Mainland China: GeoLibre's defaults (OpenFreeMap, Protomaps) and almost
 * every provider in the Basemaps control are hosted outside it with no
 * presence inside, so from there they range from slow to unreachable. These
 * entries are served from inside China and give those users a basemap that
 * loads.
 *
 * Emilia-Romagna: the region's own topographic database (DBTR) and its
 * orthophoto campaigns, which no global provider carries and which a regional
 * geoportal is expected to open on.
 *
 * The mechanism mirrors {@link PlanetaryBasemap}: `styleUrl` is a
 * `geolibre://regional-basemap/<id>` sentinel that the map controller's
 * `resolveMapStyle` expands into a raster style at apply time (it is not a
 * fetchable URL). A separate sentinel prefix from the planetary one keeps the
 * two apart, because selecting a planetary basemap also switches the project's
 * celestial body, which must not happen here.
 */

/**
 * The regions the pickers group these basemaps under. Each gets its own
 * heading and explanatory note inside the single "Regional" section, so a
 * future region slots in without the section itself becoming country-specific.
 */
export type RegionalBasemapRegionId = "china" | "emilia-romagna";

/**
 * A raster basemap for a region, rendered from XYZ (or TMS) tiles.
 */
export interface RegionalBasemap {
  id: string;
  /** Which region heading this basemap sits under. */
  region: RegionalBasemapRegionId;
  /**
   * Display name, in the language of the region the basemap serves. These are
   * Chinese-market services whose users know them by their Chinese names, and
   * the section heading already says which region they belong to, so the labels
   * are not translated the way UI strings are.
   */
  name: string;
  /**
   * The tile provider's brand name in Latin script ("Amap", "Tencent Maps"),
   * for messages read outside the region, such as the confirmation shown when
   * an opened project names this basemap. A proper noun, so not translated.
   */
  provider: string;
  /** Sentinel stored as the basemap style URL. */
  styleUrl: string;
  /** XYZ (or TMS, see {@link scheme}) tile template. */
  tileUrl: string;
  /**
   * An optional transparent overlay drawn above {@link tileUrl}, so a satellite
   * basemap can ship with its roads and labels burnt in as one selectable
   * basemap rather than something the user has to stack by hand.
   */
  overlayTileUrl?: string;
  /**
   * Opacity of {@link overlayTileUrl}, 0–1; absent means opaque. For an
   * overlay that is a full map rather than transparent labels — a
   * topographic map laid over an orthophoto — so both read through.
   */
  overlayOpacity?: number;
  /**
   * Tile row ordering. Tencent numbers rows from the bottom (**TMS**); Amap is
   * standard XYZ. Omit for XYZ; MapLibre defaults to `"xyz"` when absent.
   */
  scheme?: "tms";
  /** Max native zoom of the source (MapLibre overzooms beyond this). */
  maxZoom: number;
  /** Attribution shown on the map. */
  attribution: string;
  /**
   * True when the tiles are drawn in GCJ-02, the offset datum Chinese law
   * mandates for public map services. Neither GeoLibre nor MapLibre applies the
   * shift, so WGS84 data laid over these lands roughly 100 to 700 m off (see
   * docs/getting-started.md). Not every regional basemap is offset — Tianditu
   * publishes in CGCS2000 and lines up — so this records which are, rather than
   * leaving a caveat that applies to some entries implied by the region.
   */
  gcj02?: boolean;
}

export const REGIONAL_BASEMAP_SENTINEL_PREFIX = "geolibre://regional-basemap/";

const AMAP_ATTRIBUTION = '&copy; <a href="https://www.amap.com">高德地图 Amap</a>';
const TENCENT_ATTRIBUTION = '&copy; <a href="https://map.qq.com">腾讯地图 Tencent Maps</a>';

const sentinel = (id: string) => `${REGIONAL_BASEMAP_SENTINEL_PREFIX}${id}`;

// Amap serves each product from four numbered hosts; MapLibre takes a single
// template per source, so pin host 01. Browsers multiplex over HTTP/2, which
// makes the sharding a non-issue. `style` selects the product: 7 street, 6
// imagery, 8 roads-and-labels.
const AMAP_STREET_URL =
  "https://wprd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scl=1&style=7&x={x}&y={y}&z={z}";
const AMAP_SATELLITE_URL = "https://webst01.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}";
const AMAP_LABELS_URL = "https://webst01.is.autonavi.com/appmaptile?style=8&x={x}&y={y}&z={z}";

const tencentUrl = (styleId: number) =>
  `https://rt0.map.gtimg.com/tile?z={z}&x={x}&y={y}&styleid=${styleId}&scene=0`;

/**
 * Basemaps served from inside mainland China.
 *
 * Zoom limits are each source's probed maximum, so MapLibre overzooms (blurs)
 * rather than painting a placeholder: Amap's imagery returns a "no imagery"
 * tile rather than a 404 past zoom 18, and Tencent 400s past 19 with zoom 19
 * already blank.
 */
export const CHINA_BASEMAPS: readonly RegionalBasemap[] = [
  {
    id: "amap-street",
    region: "china",
    name: "高德地图",
    provider: "Amap",
    styleUrl: sentinel("amap-street"),
    tileUrl: AMAP_STREET_URL,
    maxZoom: 19,
    attribution: AMAP_ATTRIBUTION,
    gcj02: true,
  },
  {
    id: "amap-satellite",
    region: "china",
    name: "高德卫星",
    provider: "Amap",
    styleUrl: sentinel("amap-satellite"),
    tileUrl: AMAP_SATELLITE_URL,
    maxZoom: 18,
    attribution: AMAP_ATTRIBUTION,
    gcj02: true,
  },
  {
    id: "amap-hybrid",
    region: "china",
    name: "高德混合",
    provider: "Amap",
    styleUrl: sentinel("amap-hybrid"),
    tileUrl: AMAP_SATELLITE_URL,
    overlayTileUrl: AMAP_LABELS_URL,
    maxZoom: 18,
    attribution: AMAP_ATTRIBUTION,
    gcj02: true,
  },
  {
    id: "tencent-street",
    region: "china",
    name: "腾讯地图",
    provider: "Tencent Maps",
    styleUrl: sentinel("tencent-street"),
    tileUrl: tencentUrl(1),
    scheme: "tms",
    maxZoom: 18,
    attribution: TENCENT_ATTRIBUTION,
    gcj02: true,
  },
  {
    id: "tencent-dark",
    region: "china",
    name: "腾讯深色",
    provider: "Tencent Maps",
    styleUrl: sentinel("tencent-dark"),
    tileUrl: tencentUrl(4),
    scheme: "tms",
    maxZoom: 18,
    attribution: TENCENT_ATTRIBUTION,
    gcj02: true,
  },
];

// Emilia-Romagna publishes its cartography as cached ArcGIS map services in
// Web Mercator with the standard tile origin, so each is an ordinary XYZ set
// at `.../MapServer/tile/{z}/{y}/{x}` (row before column, the ArcGIS order).
// The region's own layers cover the region only; the old geoportal put CARTO
// Positron underneath each so the map does not go blank at the border, and
// that pairing is kept: Positron is the base, the regional layer the overlay.
const RER_CACHE = "https://servizigis.regione.emilia-romagna.it/arcgis/rest/services/cache";
const rerTiles = (service: string) => `${RER_CACHE}/${service}/MapServer/tile/{z}/{y}/{x}`;
const POSITRON_URL = "https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png";
const POSITRON_ATTRIBUTION =
  '&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const RER_ATTRIBUTION =
  '&copy; <a href="https://geoportale.regione.emilia-romagna.it">Regione Emilia-Romagna</a>';
const DBTR_WEB_URL = rerTiles("dbtr_wgs84wm");
const CGR_2018_URL = rerTiles("cgr2018_rgb_wgs84wm");

export const EMILIA_ROMAGNA_BASEMAPS: readonly RegionalBasemap[] = [
  {
    id: "rer-dbtr-web",
    region: "emilia-romagna",
    name: "DBTR webmap",
    provider: "Regione Emilia-Romagna",
    styleUrl: sentinel("rer-dbtr-web"),
    tileUrl: POSITRON_URL,
    overlayTileUrl: DBTR_WEB_URL,
    maxZoom: 19,
    attribution: `${RER_ATTRIBUTION} (DBTR) ${POSITRON_ATTRIBUTION}`,
  },
  {
    id: "rer-dbtr-ctr",
    region: "emilia-romagna",
    name: "DBTR CTR multiscala",
    provider: "Regione Emilia-Romagna",
    styleUrl: sentinel("rer-dbtr-ctr"),
    tileUrl: POSITRON_URL,
    overlayTileUrl: rerTiles("dbtr_ctrmultiscala_wgs84wm"),
    maxZoom: 23,
    attribution: `${RER_ATTRIBUTION} (DBTR CTR) ${POSITRON_ATTRIBUTION}`,
  },
  {
    id: "rer-ortofoto-agea-2020",
    region: "emilia-romagna",
    name: "Ortofoto AGEA 2020",
    provider: "Regione Emilia-Romagna",
    styleUrl: sentinel("rer-ortofoto-agea-2020"),
    tileUrl: POSITRON_URL,
    overlayTileUrl: rerTiles("agea2020_rgb_wgs84wm"),
    maxZoom: 23,
    attribution: `AGEA &copy; 2020, ${RER_ATTRIBUTION} ${POSITRON_ATTRIBUTION}`,
  },
  {
    id: "rer-ortofoto-cgr-2018",
    region: "emilia-romagna",
    name: "Ortofoto CGR 2018",
    provider: "Regione Emilia-Romagna",
    styleUrl: sentinel("rer-ortofoto-cgr-2018"),
    tileUrl: POSITRON_URL,
    overlayTileUrl: CGR_2018_URL,
    maxZoom: 23,
    attribution: `CGR SpA &copy; 2018, ${RER_ATTRIBUTION} ${POSITRON_ATTRIBUTION}`,
  },
  {
    id: "rer-ortofoto-agea-2011",
    region: "emilia-romagna",
    name: "Ortofoto AGEA 2011",
    provider: "Regione Emilia-Romagna",
    styleUrl: sentinel("rer-ortofoto-agea-2011"),
    tileUrl: POSITRON_URL,
    overlayTileUrl: rerTiles("agea2011_wgs84wm"),
    maxZoom: 19,
    attribution: `AGEA &copy; 2011, ${RER_ATTRIBUTION} ${POSITRON_ATTRIBUTION}`,
  },
  {
    // The DBTR at 70% over the 2018 orthophoto: the topographic map reads
    // through to the imagery, as the old geoportal composed it.
    id: "rer-dbtr-ortomap",
    region: "emilia-romagna",
    name: "DBTR ortomap",
    provider: "Regione Emilia-Romagna",
    styleUrl: sentinel("rer-dbtr-ortomap"),
    tileUrl: CGR_2018_URL,
    overlayTileUrl: DBTR_WEB_URL,
    overlayOpacity: 0.7,
    maxZoom: 19,
    attribution: `CGR SpA &copy; 2018, ${RER_ATTRIBUTION} (DBTR)`,
  },
];

/** Every regional basemap, across all regions. */
export const REGIONAL_BASEMAPS: readonly RegionalBasemap[] = [
  ...CHINA_BASEMAPS,
  ...EMILIA_ROMAGNA_BASEMAPS,
];

/**
 * The regional basemaps grouped for display, one entry per region. Both the New
 * Project and Change Basemap panels render this inside a single collapsible
 * "Regional" section, so adding a region is a change here rather than in two
 * dialogs.
 */
export const REGIONAL_BASEMAP_GROUPS: readonly {
  id: RegionalBasemapRegionId;
  basemaps: readonly RegionalBasemap[];
}[] = [
  { id: "china", basemaps: CHINA_BASEMAPS },
  { id: "emilia-romagna", basemaps: EMILIA_ROMAGNA_BASEMAPS },
];

/** Look up a regional basemap by its `geolibre://regional-basemap/<id>` sentinel. */
export function getRegionalBasemapByStyleUrl(
  styleUrl: string | undefined,
): RegionalBasemap | undefined {
  if (!styleUrl) return undefined;
  return REGIONAL_BASEMAPS.find((basemap) => basemap.styleUrl === styleUrl);
}

/** Look up a regional basemap by id. */
export function getRegionalBasemapById(id: string | undefined): RegionalBasemap | undefined {
  if (!id) return undefined;
  return REGIONAL_BASEMAPS.find((basemap) => basemap.id === id);
}

/** Whether a style URL is a regional-basemap sentinel, resolvable or not. */
export function isRegionalBasemapSentinel(styleUrl: string | undefined): boolean {
  return Boolean(styleUrl?.startsWith(REGIONAL_BASEMAP_SENTINEL_PREFIX));
}

/**
 * How the store treats a regional basemap that arrives without the user picking
 * it (a project file, share link, or startup restore naming one by its
 * `styleUrl`). The tiles come from servers in mainland China, so loading them
 * unasked sends the user's map requests there.
 *
 * - `"allow"`: apply it as is. This is the store default, so library consumers
 *   keep their behaviour; the desktop and web app switch to `"prompt"`.
 * - `"prompt"`: apply the default basemap and hold the regional one for the
 *   user to confirm (see {@link RegionalBasemapHold}).
 * - `"block"`: the deployment disabled regional basemaps. Always fall back to
 *   the default basemap, including when code sets one directly.
 */
export type RegionalBasemapPolicy = "allow" | "prompt" | "block";

/**
 * A regional basemap the store set aside when a project was loaded. The default
 * basemap renders in its place until the user answers (`"prompt"`), or for good
 * (`"blocked"`, which the app shows as a notice only).
 */
export interface RegionalBasemapHold {
  /** The regional sentinel the project asked for. */
  styleUrl: string;
  /** Why the default basemap is showing instead. */
  reason: "prompt" | "blocked";
}

/**
 * Decides which basemap a project load actually applies.
 *
 * Only a resolvable regional sentinel is gated. Every other style URL (and an
 * unknown regional id, which the map controller already replaces with the
 * default basemap) passes through untouched.
 *
 * @param styleUrl - The basemap style URL the project requests.
 * @param policy - The store's current {@link RegionalBasemapPolicy}.
 * @param fallbackStyleUrl - The basemap to apply instead (the default basemap).
 * @param trusted - True when the user already chose this basemap in this
 *   session (a template, an undo step, a duplicate), so `"prompt"` does not
 *   apply. `"block"` still does.
 * @returns The style URL to apply and, when it was replaced, why.
 */
export function gateRegionalBasemap(
  styleUrl: string,
  policy: RegionalBasemapPolicy,
  fallbackStyleUrl: string,
  trusted = false,
): { styleUrl: string; held?: RegionalBasemapHold["reason"] } {
  if (!getRegionalBasemapByStyleUrl(styleUrl)) return { styleUrl };
  if (policy === "block") return { styleUrl: fallbackStyleUrl, held: "blocked" };
  if (policy === "prompt" && !trusted) return { styleUrl: fallbackStyleUrl, held: "prompt" };
  return { styleUrl };
}
