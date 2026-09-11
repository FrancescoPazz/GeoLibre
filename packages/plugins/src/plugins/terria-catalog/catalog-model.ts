/**
 * A catalog tree read from a TerriaJS "init" file.
 *
 * TerriaJS geoportals describe what they offer as a JSON tree of groups and
 * items — `{ "catalog": [ { "type": "group", "members": [...] }, ... ] }` —
 * with one `type` per data service (`wms`, `wmts`, `esri-mapServer`, ...).
 * The tree is a declaration: nothing is loaded until an item is opened. This
 * module reads that shape into a normalised tree the panel can walk, and
 * says which item types the host can open as layers; the file's other
 * fields (cameras, base maps, TerriaJS-only traits) are left alone.
 */

/** Item types the panel can add as a layer, with the service they map to. */
export const SUPPORTED_CATALOG_ITEM_TYPES = [
  "wms",
  "wmts",
  "esri-mapServer",
  "esri-mapServer-group",
  "geojson",
  "open-street-map",
] as const;

export type SupportedCatalogItemType = (typeof SUPPORTED_CATALOG_ITEM_TYPES)[number];

export interface CatalogGroup {
  kind: "group";
  id: string;
  name: string;
  description?: string;
  /** Open in the tree on first display (`isOpen` in the file). */
  isOpen: boolean;
  members: CatalogNode[];
}

export interface CatalogItem {
  kind: "item";
  id: string;
  name: string;
  /** The TerriaJS type, whether supported or not. */
  type: string;
  supported: boolean;
  url?: string;
  /** `layers` of a WMS / ArcGIS item, `layer` of a WMTS item: the sub-resource(s) to draw. */
  layers?: string;
  description?: string;
  attribution?: string;
  opacity?: number;
  /** Extra request parameters (`parameters` on a WMS item), e.g. a format. */
  parameters?: Record<string, string>;
  styles?: string;
  tileSize?: number;
  /** The file listed this item in its initial workbench. */
  inWorkbench: boolean;
}

export type CatalogNode = CatalogGroup | CatalogItem;

export interface TerriaCatalog {
  /** The tree; the file's `catalog` array. */
  roots: CatalogNode[];
  /** Ids the file asks to have on the map from the start (`workbench`). */
  workbench: string[];
  /** The file's `homeCamera`, as [west, south, east, north] degrees, if any. */
  homeExtent?: [number, number, number, number];
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Strip TerriaJS markdown/HTML `info` sections down to plain text for a tooltip. */
function descriptionOf(raw: Record<string, unknown>): string | undefined {
  const direct = str(raw.description);
  if (direct) return direct;
  const info = raw.info;
  if (Array.isArray(info)) {
    const parts = info
      .map((section) => (section && typeof section === "object" ? section : null))
      .map((section) => {
        const s = section as { name?: unknown; content?: unknown } | null;
        const content = str(s?.content);
        return content ? `${str(s?.name) ? `${str(s?.name)}: ` : ""}${content}` : null;
      })
      .filter((part): part is string => part !== null);
    if (parts.length) return parts.join("\n");
  }
  return str(raw.shortReport);
}

/** A stable id for a node without one: its path in the tree. */
function fallbackId(path: string, index: number): string {
  return `${path}/${index}`;
}

function parametersOf(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = String(value);
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function parseNode(
  raw: unknown,
  path: string,
  index: number,
  workbench: Set<string>,
): CatalogNode | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const type = str(r.type);
  if (!type) return null;
  const id = str(r.id) ?? fallbackId(path, index);
  const name = str(r.name) ?? id;
  if (type === "group") {
    // v8 files nest under `members`; the older v7 files this format grew out
    // of used `items`, and geoportals still carry some of those.
    const members = Array.isArray(r.members) ? r.members : Array.isArray(r.items) ? r.items : [];
    return {
      kind: "group",
      id,
      name,
      description: descriptionOf(r),
      isOpen: r.isOpen === true,
      members: members
        .map((member, i) => parseNode(member, id, i, workbench))
        .filter((node): node is CatalogNode => node !== null),
    };
  }
  const layers =
    str(r.layers) ??
    str(r.layer) ??
    (Array.isArray(r.layers) ? r.layers.map(String).join(",") : undefined);
  const tileWidth = num(r.tileWidth);
  return {
    kind: "item",
    id,
    name,
    type,
    supported: (SUPPORTED_CATALOG_ITEM_TYPES as readonly string[]).includes(type),
    url: str(r.url),
    layers,
    description: descriptionOf(r),
    attribution: str(r.attribution),
    opacity: num(r.opacity),
    parameters: parametersOf(r.parameters),
    styles: str(r.styles),
    tileSize: tileWidth,
    inWorkbench: workbench.has(id),
  };
}

/** Read a TerriaJS init document (already parsed from JSON) into a catalog tree. */
export function parseTerriaCatalog(document: unknown): TerriaCatalog {
  const doc = (document && typeof document === "object" ? document : {}) as Record<string, unknown>;
  const workbench = Array.isArray(doc.workbench)
    ? doc.workbench.filter((id): id is string => typeof id === "string")
    : [];
  const workbenchSet = new Set(workbench);
  const catalog = Array.isArray(doc.catalog) ? doc.catalog : [];
  const roots = catalog
    .map((node, i) => parseNode(node, "", i, workbenchSet))
    .filter((node): node is CatalogNode => node !== null);
  const home = doc.homeCamera as Record<string, unknown> | undefined;
  const west = num(home?.west);
  const south = num(home?.south);
  const east = num(home?.east);
  const north = num(home?.north);
  const homeExtent =
    west !== undefined && south !== undefined && east !== undefined && north !== undefined
      ? ([west, south, east, north] as [number, number, number, number])
      : undefined;
  return { roots, workbench, homeExtent };
}

/**
 * TerriaJS init files may carry `//` comments; strip them before parsing.
 * Only whole-line and trailing comments outside strings are removed.
 */
export function parseTerriaCatalogText(text: string): TerriaCatalog {
  return parseTerriaCatalog(JSON.parse(stripJsonComments(text)));
}

export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Every item in the tree, depth first. */
export function catalogItems(nodes: readonly CatalogNode[]): CatalogItem[] {
  const out: CatalogItem[] = [];
  const walk = (list: readonly CatalogNode[]) => {
    for (const node of list) {
      if (node.kind === "item") out.push(node);
      else walk(node.members);
    }
  };
  walk(nodes);
  return out;
}

/** Find a node by id anywhere in the tree. */
export function findCatalogNode(nodes: readonly CatalogNode[], id: string): CatalogNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.kind === "group") {
      const found = findCatalogNode(node.members, id);
      if (found) return found;
    }
  }
  return null;
}

/**
 * The tree narrowed to nodes whose name (or a group's descendants' names)
 * matches `query`, case-insensitively; an empty query returns the tree as is.
 */
export function filterCatalog(nodes: readonly CatalogNode[], query: string): CatalogNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...nodes];
  const matches = (node: CatalogNode): CatalogNode | null => {
    const nameHit = node.name.toLowerCase().includes(q);
    if (node.kind === "item") return nameHit ? node : null;
    const members = node.members
      .map(matches)
      .filter((child): child is CatalogNode => child !== null);
    if (members.length === 0 && !nameHit) return null;
    return {
      ...node,
      isOpen: true,
      members: nameHit && members.length === 0 ? node.members : members,
    };
  };
  return nodes.map(matches).filter((node): node is CatalogNode => node !== null);
}
