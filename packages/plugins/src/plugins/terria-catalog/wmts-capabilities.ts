/**
 * Just enough of a WMTS GetCapabilities document to turn a layer name into
 * an XYZ tile template: the layer's REST `ResourceURL` (or a KVP GetTile
 * request when the server offers none), its default style, and a tile
 * matrix set in Web Mercator whose matrices are numbered like zoom levels.
 *
 * Deliberately string-based rather than a DOM parse, so it runs the same in
 * the browser and under Node tests; capabilities documents are regular
 * enough for that.
 */

export interface WmtsLayerInfo {
  identifier: string;
  title: string;
  /** Style identifier, the default one when the document marks it. */
  style: string;
  formats: string[];
  tileMatrixSets: string[];
  /** REST tile templates, keyed by format. */
  resourceUrls: Record<string, string>;
}

export interface WmtsTileMatrixSetInfo {
  identifier: string;
  supportedCrs: string;
  /** TileMatrix identifiers in document order. */
  matrices: string[];
}

export interface WmtsCapabilities {
  layers: WmtsLayerInfo[];
  tileMatrixSets: WmtsTileMatrixSetInfo[];
  /** The GetTile KVP endpoint advertised in OperationsMetadata, if any. */
  getTileUrl?: string;
}

const tag = (name: string) =>
  new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, "g");

function firstText(block: string, name: string): string | undefined {
  const match = tag(name).exec(block);
  if (!match) return undefined;
  return decodeEntities(match[1].replace(/<[^>]*>/g, "").trim()) || undefined;
}

function allText(block: string, name: string): string[] {
  const out: string[] = [];
  for (const match of block.matchAll(tag(name))) {
    const text = decodeEntities(match[1].replace(/<[^>]*>/g, "").trim());
    if (text) out.push(text);
  }
  return out;
}

function allBlocks(block: string, name: string): string[] {
  return [...block.matchAll(tag(name))].map((m) => m[1]);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** Read the parts of a WMTS capabilities document this module uses. */
export function parseWmtsCapabilities(xml: string): WmtsCapabilities {
  const layers: WmtsLayerInfo[] = [];
  // Layers are the <Layer> children of <Contents>; the document has no other
  // <Layer> elements, but the Contents block is used anyway to be safe.
  const contents = firstBlock(xml, "Contents") ?? xml;
  for (const block of allBlocks(contents, "Layer")) {
    const identifier = firstText(block, "Identifier");
    if (!identifier) continue;
    // The default style when the document marks one, else the first listed.
    let style = "default";
    let firstStyle: string | undefined;
    for (const match of block.matchAll(
      /<(?:[\w-]+:)?Style\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?Style>/g,
    )) {
      const id = firstText(match[2], "Identifier") ?? "default";
      firstStyle ??= id;
      if (/isDefault="true"/.test(match[1])) {
        firstStyle = id;
        break;
      }
    }
    if (firstStyle) style = firstStyle;
    const resourceUrls: Record<string, string> = {};
    for (const match of block.matchAll(/<(?:[\w-]+:)?ResourceURL\b([^>]*)\/?>/g)) {
      const attrs = match[1];
      const format = /format="([^"]*)"/.exec(attrs)?.[1];
      const template = /template="([^"]*)"/.exec(attrs)?.[1];
      const resourceType = /resourceType="([^"]*)"/.exec(attrs)?.[1];
      if (template && format && (resourceType === undefined || resourceType === "tile")) {
        resourceUrls[format] = decodeEntities(template);
      }
    }
    layers.push({
      identifier,
      title: firstText(block, "Title") ?? identifier,
      style,
      formats: allText(block, "Format"),
      tileMatrixSets: allBlocks(block, "TileMatrixSetLink").map(
        (link) => firstText(link, "TileMatrixSet") ?? "",
      ),
      resourceUrls,
    });
  }
  const tileMatrixSets: WmtsTileMatrixSetInfo[] = [];
  for (const block of allBlocks(contents, "TileMatrixSet")) {
    // A TileMatrixSetLink also contains a <TileMatrixSet> text element; a real
    // set has <TileMatrix> children.
    const matrices = allBlocks(block, "TileMatrix").map((m) => firstText(m, "Identifier") ?? "");
    if (!matrices.length) continue;
    const identifier = firstText(block, "Identifier");
    if (!identifier) continue;
    tileMatrixSets.push({
      identifier,
      supportedCrs: firstText(block, "SupportedCRS") ?? "",
      matrices,
    });
  }
  const getTile =
    /<(?:[\w-]+:)?Operation\b[^>]*name="GetTile"[\s\S]*?<\/(?:[\w-]+:)?Operation>/.exec(xml)?.[0];
  const getTileUrl = getTile
    ? (/<(?:[\w-]+:)?Get\b[^>]*href="([^"]*)"/.exec(getTile)?.[1] ?? undefined)
    : undefined;
  return {
    layers,
    tileMatrixSets,
    getTileUrl: getTileUrl ? decodeEntities(getTileUrl) : undefined,
  };
}

function firstBlock(xml: string, name: string): string | undefined {
  return allBlocks(xml, name)[0];
}

const WEB_MERCATOR = /3857|900913|3785|GoogleMapsCompatible|default028mm/i;

/** Whether a tile matrix set is in Web Mercator with zoom-numbered matrices. */
function usableMatrixSet(set: WmtsTileMatrixSetInfo): boolean {
  if (!WEB_MERCATOR.test(`${set.identifier} ${set.supportedCrs}`)) return false;
  return set.matrices.every((m, i) => m === String(i));
}

/**
 * The XYZ tile template for `layerName`, preferring the layer's REST
 * `ResourceURL` and a Web Mercator matrix set whose matrices are numbered
 * 0..n (so `{TileMatrix}` is `{z}`), falling back to a KVP GetTile request.
 * Null when the layer is not in the document or no matrix set fits.
 */
export function wmtsTileTemplate(
  capabilities: WmtsCapabilities,
  layerName: string,
  serviceUrl: string,
): { template: string; format: string; maxZoom: number } | null {
  const layer = capabilities.layers.find((l) => l.identifier === layerName);
  if (!layer) return null;
  const sets = capabilities.tileMatrixSets.filter(
    (set) => layer.tileMatrixSets.includes(set.identifier) && usableMatrixSet(set),
  );
  // GoogleMapsCompatible over ArcGIS's default028mm: same grid, but the former
  // is what every other client asks for.
  const set =
    sets.find((s) => /GoogleMapsCompatible/i.test(s.identifier)) ??
    sets.find((s) => /3857|900913/.test(s.supportedCrs)) ??
    sets[0];
  if (!set) return null;
  const maxZoom = set.matrices.length - 1;
  const format =
    Object.keys(layer.resourceUrls).find((f) => /png/i.test(f)) ??
    Object.keys(layer.resourceUrls)[0] ??
    layer.formats.find((f) => /png/i.test(f)) ??
    layer.formats[0] ??
    "image/png";
  const resource = layer.resourceUrls[format];
  if (resource) {
    const template = resource
      .replace(/\{Style\}/gi, layer.style)
      .replace(/\{TileMatrixSet\}/gi, set.identifier)
      .replace(/\{TileMatrix\}/gi, "{z}")
      .replace(/\{TileRow\}/gi, "{y}")
      .replace(/\{TileCol\}/gi, "{x}");
    return { template, format, maxZoom };
  }
  const base = capabilities.getTileUrl ?? serviceUrl;
  const url = new URL(base);
  url.searchParams.set("SERVICE", "WMTS");
  url.searchParams.set("REQUEST", "GetTile");
  url.searchParams.set("VERSION", "1.0.0");
  url.searchParams.set("LAYER", layer.identifier);
  url.searchParams.set("STYLE", layer.style);
  url.searchParams.set("TILEMATRIXSET", set.identifier);
  url.searchParams.set("FORMAT", format);
  // URLSearchParams would percent-encode the braces MapLibre substitutes.
  const template = `${url.toString()}&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}`;
  return { template, format, maxZoom };
}

/** The GetCapabilities URL for a WMTS service endpoint. */
export function wmtsCapabilitiesUrl(serviceUrl: string): string {
  const url = new URL(serviceUrl);
  url.searchParams.set("service", "WMTS");
  url.searchParams.set("version", "1.0.0");
  url.searchParams.set("request", "GetCapabilities");
  return url.toString();
}
