import { getRuntimeEnvironment } from "@geolibre/core";
import type { Geometry, Position } from "geojson";

/**
 * Seismic microzonation (Emilia-Romagna and Marche civil protection): the
 * state of every municipality's microzonation study (MS) and emergency
 * limit condition (CLE) analysis, read from a WFS layer of the region's
 * GeoServer, with the study documents on a second layer keyed by project.
 * The service field names are the regions' own (`prov`, `comune`,
 * `microzonazione`, `cle_convalida`, …) and are normalized here once; the
 * panel is the app's.
 */

export interface MicrozonationRecord {
  id?: string | number;
  province: string;
  municipality: string;
  /** `"1"`, `"2"`, `"3"` (the study level) or `"no"`. */
  microzonation: string;
  msOrdinance: string;
  /** `"done"` or `"no"`. */
  cle: string;
  cleOrdinance: string;
  municipalPlan: string;
}

export interface MicrozonationDetail {
  generalInfo: { province: string; municipality: string; istatCode: string; notes: string };
  microzonation: {
    microzonation: string;
    msOrdinance: string;
    msValidation: string;
    msStandard: string;
    microzonationInfo: string;
  };
  cle: { cle: string; cleOrdinance: string; cleValidation: string; cleStandard: string };
  civilProtectionPlan: { municipalPlan: string; link: string };
}

export interface MicrozonationDocument {
  id: string;
  url: string;
  typeDoc: string;
  desc: string;
  docFormat: string;
  startDate: string;
  endDate?: string;
}

export interface MicrozonationFilters {
  province: string;
  municipality: string;
  microzonation: string;
  cle: string;
}

export interface MicrozonationConfig {
  /** The WFS endpoint. */
  url: string;
  /** The projects layer (`typeName`), one feature per municipality's study state. */
  projectsLayerName: string;
  /** The documents layer, filtered by `id_stato_progetto`; absent means no documents. */
  documentsLayerName?: string;
  outputFormat?: string;
  /** A page listing the municipal emergency plans, linked from the panel. */
  plansUrl?: string;
}

export interface MicrozonationProjects {
  records: MicrozonationRecord[];
  propertiesById: Map<string | number, Record<string, unknown>>;
  geometryById: Map<string | number, Geometry>;
}

export const EMPTY_MICROZONATION_FILTERS: MicrozonationFilters = {
  province: "",
  municipality: "",
  microzonation: "",
  cle: "",
};

function envValue(env: Record<string, string | undefined>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[`VITE_${name}`] ?? env[name];
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

/**
 * The deployment's microzonation service: `MICROZONATION_URL` plus the
 * projects layer as `MICROZONATION_PROJECTS_LAYER` — or `MICROZONATION_TYPENAME`,
 * the spelling of the old geoportal's config — with the optional documents
 * layer, output format and plans page. Undefined without an http(s) URL and
 * a projects layer.
 */
export function getMicrozonationConfig(
  env: Record<string, string | undefined> = getRuntimeEnvironment(),
): MicrozonationConfig | undefined {
  const url = envValue(env, "MICROZONATION_URL");
  const projectsLayerName = envValue(env, "MICROZONATION_PROJECTS_LAYER", "MICROZONATION_TYPENAME");
  if (!url || !/^https?:\/\//i.test(url) || !projectsLayerName) return undefined;
  const plansUrl = envValue(env, "MICROZONATION_PLANS_URL");
  return {
    url,
    projectsLayerName,
    documentsLayerName: envValue(env, "MICROZONATION_DOCUMENTS_LAYER"),
    outputFormat: envValue(env, "MICROZONATION_OUTPUT_FORMAT"),
    plansUrl: plansUrl && /^https?:\/\//i.test(plansUrl) ? plansUrl : undefined,
  };
}

/** A dash for what the service left empty, the text otherwise. */
export function formatMicrozonationValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}

/** An ISO date the Italian way (`d/m/yyyy`), a dash for none, other text as is. */
export function formatMicrozonationDate(value?: string, locale = "it-IT"): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(locale);
}

export function normalizeMicrozonationLevel(value: unknown): string {
  const s = String(value ?? "").trim();
  return s === "1" || s === "2" || s === "3" ? s : "no";
}

export function normalizeCleStatus(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase() === "S"
    ? "done"
    : "no";
}

/** Distinct non-empty values, sorted with Italian collation. */
export function uniqueSorted(values: ReadonlyArray<string | undefined>): string[] {
  return Array.from(new Set(values.filter((v): v is string => Boolean(v)))).sort((a, b) =>
    a.localeCompare(b, "it"),
  );
}

export function microzonationRecordId(record: Partial<MicrozonationRecord>): string | number {
  return (
    record.id ??
    `${record.province ?? ""}-${record.municipality ?? ""}-${record.microzonation ?? ""}-${record.cle ?? ""}`
  );
}

export function filterMicrozonationRecords(
  records: readonly MicrozonationRecord[],
  filters: MicrozonationFilters,
): MicrozonationRecord[] {
  return records.filter(
    (r) =>
      (!filters.province || r.province === filters.province) &&
      (!filters.municipality || r.municipality === filters.municipality) &&
      (!filters.microzonation || r.microzonation === filters.microzonation) &&
      (!filters.cle || r.cle === filters.cle),
  );
}

const text = (value: unknown): string =>
  value === null || value === undefined ? "" : String(value);

export function normalizeMicrozonationRecord(
  properties: Record<string, unknown> | null | undefined,
): MicrozonationRecord {
  const p = properties ?? {};
  const id = p.id_stato_progetto ?? p.gid;
  return {
    id: typeof id === "number" || typeof id === "string" ? id : undefined,
    province: text(p.prov),
    municipality: text(p.comune),
    microzonation: normalizeMicrozonationLevel(p.microzonazione),
    msOrdinance: text(p.ordinanza),
    cle: normalizeCleStatus(p.cle_convalida),
    cleOrdinance: text(p.cle_ordinanza),
    municipalPlan: text(p.piano_prot_civile),
  };
}

export function normalizeMicrozonationDetail(
  properties: Record<string, unknown> | null | undefined,
): MicrozonationDetail {
  const p = properties ?? {};
  return {
    generalInfo: {
      province: text(p.prov),
      municipality: text(p.comune),
      istatCode: text(p.cod_istat),
      notes: text(p.note),
    },
    microzonation: {
      microzonation: normalizeMicrozonationLevel(p.microzonazione),
      msOrdinance: text(p.ordinanza),
      msValidation: text(p.convalidato),
      msStandard: text(p.mzs_standard),
      microzonationInfo: text(p.microzonazione_info),
    },
    cle: {
      cle: normalizeCleStatus(p.cle_convalida),
      cleOrdinance: text(p.cle_ordinanza),
      cleValidation: text(p.cle_convalida),
      cleStandard: text(p.cle_standard),
    },
    civilProtectionPlan: {
      municipalPlan: text(p.piano_prot_civile),
      link: text(p.link_ppc_comune),
    },
  };
}

function normalizeDocument(
  feature: { id?: unknown; properties?: Record<string, unknown> | null },
  index: number,
): MicrozonationDocument | undefined {
  const p = feature.properties ?? {};
  const url = text(p.link).trim();
  if (!url) return undefined;
  const end = p.validita_fine;
  return {
    id: text(feature.id ?? p.descrizione_file ?? index),
    url,
    typeDoc: formatMicrozonationValue(p.tipo_documento),
    desc: formatMicrozonationValue(p.descrizione_file),
    docFormat: url.split(".").pop() ?? "",
    startDate: formatMicrozonationValue(p.validita_inizio),
    endDate: end !== null && end !== undefined && end !== "" ? String(end) : undefined,
  };
}

/** The detail of a record from the properties cached for it (empty when none). */
export function microzonationDetailOf(
  propertiesById: ReadonlyMap<string | number, Record<string, unknown>>,
  record: MicrozonationRecord,
): MicrozonationDetail {
  const props = record.id !== undefined ? propertiesById.get(record.id) : undefined;
  return normalizeMicrozonationDetail(props);
}

function flatten(coords: unknown, out: Position[]): void {
  if (!Array.isArray(coords) || coords.length === 0) return;
  if (typeof coords[0] === "number") {
    out.push(coords as Position);
    return;
  }
  for (const item of coords) flatten(item, out);
}

/** `[west, south, east, north]` of a geometry, or undefined without coordinates. */
export function geometryBBox(
  geometry: Geometry | null | undefined,
): [number, number, number, number] | undefined {
  if (!geometry || !("coordinates" in geometry)) return undefined;
  const points: Position[] = [];
  flatten(geometry.coordinates, points);
  if (points.length === 0) return undefined;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lon, lat] of points) {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return [west, south, east, north];
}

/** A WFS 1.0.0 GetFeature URL for a layer as GeoJSON in EPSG:4326. */
export function microzonationWfsUrl(
  config: MicrozonationConfig,
  layerName = config.projectsLayerName,
  extra: Record<string, string | undefined> = {},
): string {
  const params = new URLSearchParams({
    service: "WFS",
    version: "1.0.0",
    request: "GetFeature",
    typeName: layerName,
    outputFormat: config.outputFormat ?? "application/json",
    srsName: "EPSG:4326",
  });
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== "") params.set(key, value);
  }
  return `${config.url}${config.url.includes("?") ? "&" : "?"}${params.toString()}`;
}

async function fetchFeatureCollection(
  url: string,
  fetchImpl: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<
  Array<{ id?: unknown; properties?: Record<string, unknown> | null; geometry?: Geometry | null }>
> {
  const response = await fetchImpl(url, { signal });
  if (!response.ok) throw new Error(String(response.status));
  const json = (await response.json()) as { features?: unknown };
  return Array.isArray(json.features) ? (json.features as never[]) : [];
}

/** Every project of the projects layer, normalized and indexed by record id. */
export async function fetchMicrozonationProjects(
  config: MicrozonationConfig,
  fetchImpl: typeof globalThis.fetch = fetch,
  signal?: AbortSignal,
): Promise<MicrozonationProjects> {
  const features = await fetchFeatureCollection(microzonationWfsUrl(config), fetchImpl, signal);
  const records: MicrozonationRecord[] = [];
  const propertiesById = new Map<string | number, Record<string, unknown>>();
  const geometryById = new Map<string | number, Geometry>();
  for (const feature of features) {
    const props = feature.properties ?? {};
    const record = normalizeMicrozonationRecord(props);
    records.push(record);
    if (record.id !== undefined) {
      propertiesById.set(record.id, props);
      if (feature.geometry) geometryById.set(record.id, feature.geometry);
    }
  }
  return { records, propertiesById, geometryById };
}

/** The documents of a project, from the documents layer; none without one. */
export async function fetchMicrozonationDocuments(
  config: MicrozonationConfig,
  projectId: string | number | undefined,
  fetchImpl: typeof globalThis.fetch = fetch,
  signal?: AbortSignal,
): Promise<MicrozonationDocument[]> {
  const layer = config.documentsLayerName?.trim();
  if (!layer || projectId === undefined) return [];
  const url = microzonationWfsUrl(config, layer, {
    CQL_FILTER: `id_stato_progetto=${String(projectId)}`,
  });
  const features = await fetchFeatureCollection(url, fetchImpl, signal);
  return features
    .map((feature, index) => normalizeDocument(feature, index))
    .filter((doc): doc is MicrozonationDocument => doc !== undefined);
}
