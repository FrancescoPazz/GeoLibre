import { getRuntimeEnvironment } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import {
  EMPTY_MICROZONATION_FILTERS,
  fetchMicrozonationDocuments,
  fetchMicrozonationProjects,
  filterMicrozonationRecords,
  formatMicrozonationDate,
  formatMicrozonationValue,
  geometryBBox,
  getMicrozonationConfig,
  microzonationDetailOf,
  microzonationRecordId,
  uniqueSorted,
  type MicrozonationConfig,
  type MicrozonationDetail,
  type MicrozonationDocument,
  type MicrozonationFilters,
  type MicrozonationProjects,
  type MicrozonationRecord,
} from "@geolibre/plugins";
import { Button } from "@geolibre/ui";
import { Activity, ExternalLink, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useDraggableCard } from "../../hooks/useDraggableCard";
import {
  closeMicrozonationPanel,
  isMicrozonationPanelVisible,
  subscribeMicrozonationPanel,
} from "../../lib/microzonation-panel";

const PANEL_WIDTH = 460;

/** The deployment's microzonation service, re-read when the runtime environment changes. */
export function useMicrozonationConfig(): MicrozonationConfig | undefined {
  const [config, setConfig] = useState(() => getMicrozonationConfig(getRuntimeEnvironment()));
  useEffect(() => {
    const refresh = () => setConfig(getMicrozonationConfig(getRuntimeEnvironment()));
    refresh();
    window.addEventListener("geolibre:runtime-env-change", refresh);
    return () => window.removeEventListener("geolibre:runtime-env-change", refresh);
  }, []);
  return config;
}

interface MicrozonationPanelProps {
  mapControllerRef: RefObject<MapEngine | null>;
}

/**
 * Seismic microzonation (Controls → Seismic microzonation, when the
 * deployment names the WFS service): search the municipalities' study
 * state by province, municipality, microzonation level and CLE, pick a
 * result to zoom to it and read its detail — general info, MS, CLE, civil
 * protection plan — and the study documents from the documents layer.
 */
export function MicrozonationPanel({ mapControllerRef }: MicrozonationPanelProps) {
  const open = useSyncExternalStore(
    subscribeMicrozonationPanel,
    isMicrozonationPanelVisible,
    isMicrozonationPanelVisible,
  );
  const config = useMicrozonationConfig();
  if (!open) return null;
  return <MicrozonationCard mapControllerRef={mapControllerRef} config={config} />;
}

function MicrozonationCard({
  mapControllerRef,
  config,
}: MicrozonationPanelProps & { config: MicrozonationConfig | undefined }) {
  const { t, i18n } = useTranslation();
  const { position, onDragStart } = useDraggableCard(PANEL_WIDTH);
  const [projects, setProjects] = useState<MicrozonationProjects | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<MicrozonationFilters>(EMPTY_MICROZONATION_FILTERS);
  const [results, setResults] = useState<MicrozonationRecord[] | null>(null);
  const [selected, setSelected] = useState<MicrozonationRecord | null>(null);
  const [detail, setDetail] = useState<MicrozonationDetail | null>(null);
  const [documents, setDocuments] = useState<MicrozonationDocument[]>([]);
  const [loadingDocuments, setLoadingDocuments] = useState(false);
  const [sort, setSort] = useState<{ key: keyof MicrozonationDocument; asc: boolean } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const configKey = config
    ? `${config.url}|${config.projectsLayerName}|${config.documentsLayerName ?? ""}|${config.outputFormat ?? ""}`
    : "";

  // Load every project once per configuration; the filters work on the list.
  useEffect(() => {
    abortRef.current?.abort();
    setProjects(null);
    setResults(null);
    setSelected(null);
    setDetail(null);
    setDocuments([]);
    setError(null);
    if (!config) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    fetchMicrozonationProjects(config, fetch, controller.signal)
      .then((loaded) => {
        if (controller.signal.aborted) return;
        setProjects(loaded);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const status = Number(cause instanceof Error ? cause.message : NaN);
        setError(
          Number.isFinite(status)
            ? t("toolbar.microzonation.errorApiStatus", { status })
            : t("toolbar.microzonation.errorLoadingList"),
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key carries every field the request depends on
  }, [configKey, t]);

  const records = useMemo(() => projects?.records ?? [], [projects]);
  const provinces = useMemo(() => uniqueSorted(records.map((r) => r.province)), [records]);
  const municipalities = useMemo(
    () =>
      uniqueSorted(
        (filters.province ? records.filter((r) => r.province === filters.province) : records).map(
          (r) => r.municipality,
        ),
      ),
    [records, filters.province],
  );
  const levelLabel = (value: string) =>
    value === "2" || value === "3" || value === "1"
      ? t(`toolbar.microzonation.level${value}` as "toolbar.microzonation.level2")
      : formatMicrozonationValue(value);
  const cleLabel = (value: string) =>
    value === "done"
      ? t("toolbar.microzonation.cleDone")
      : value === "no"
        ? t("toolbar.microzonation.cleNo")
        : formatMicrozonationValue(value);

  const search = () => {
    setResults(filterMicrozonationRecords(records, filters));
    setSelected(null);
    setDetail(null);
    setDocuments([]);
  };
  const clear = () => {
    setFilters(EMPTY_MICROZONATION_FILTERS);
    setResults(null);
    setSelected(null);
    setDetail(null);
    setDocuments([]);
  };
  const pick = (record: MicrozonationRecord) => {
    setSelected(record);
    if (projects) setDetail(microzonationDetailOf(projects.propertiesById, record));
    const geometry = record.id !== undefined ? projects?.geometryById.get(record.id) : undefined;
    const bbox = geometryBBox(geometry);
    if (bbox) mapControllerRef.current?.fitBounds(bbox);
    setDocuments([]);
    if (!config || record.id === undefined || !config.documentsLayerName) return;
    setLoadingDocuments(true);
    fetchMicrozonationDocuments(config, record.id)
      .then(setDocuments)
      .catch(() => setDocuments([]))
      .finally(() => setLoadingDocuments(false));
  };

  const sortedDocuments = useMemo(() => {
    if (!sort) return documents;
    return [...documents].sort((a, b) => {
      const x = a[sort.key] ?? "";
      const y = b[sort.key] ?? "";
      const cmp = String(x).localeCompare(String(y), i18n.language);
      return sort.asc ? cmp : -cmp;
    });
  }, [documents, sort, i18n.language]);
  const sortBy = (key: keyof MicrozonationDocument) =>
    setSort((s) => ({ key, asc: s?.key === key ? !s.asc : true }));

  const select = "h-7 w-full rounded-md border border-input bg-background px-2 text-xs";
  const th = "cursor-pointer whitespace-nowrap px-2 py-1 text-start font-medium";
  const td = "px-2 py-1 align-top";
  const section = "text-xs font-semibold";
  const detailRow = (label: string, value: string, pre = false) => (
    <tr key={label}>
      <td className="w-32 px-2 py-0.5 text-muted-foreground">{label}</td>
      <td className={`px-2 py-0.5 ${pre ? "whitespace-pre-line" : ""}`}>{value}</td>
    </tr>
  );

  return (
    <div
      className="absolute z-30 flex max-h-[85%] flex-col rounded-lg border border-border map-glass shadow-lg"
      style={{ left: position.x, top: position.y, width: PANEL_WIDTH }}
      role="dialog"
      aria-label={t("toolbar.microzonation.title")}
      data-testid="microzonation-panel"
    >
      <div
        className="flex cursor-grab items-center gap-2 rounded-t-lg border-b border-border bg-muted/40 px-3 py-2 active:cursor-grabbing"
        onPointerDown={onDragStart}
      >
        <Activity className="h-4 w-4 text-sky-500" />
        <span className="text-sm font-medium">{t("toolbar.microzonation.title")}</span>
        <Button
          variant="ghost"
          size="icon"
          className="ms-auto h-6 w-6"
          aria-label={t("toolbar.microzonation.close")}
          onClick={closeMicrozonationPanel}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="min-h-0 space-y-3 overflow-y-auto p-3 text-xs">
        {!config ? (
          <p className="text-muted-foreground">{t("toolbar.microzonation.unconfigured")}</p>
        ) : (
          <>
            <p className="text-muted-foreground">{t("toolbar.microzonation.body")}</p>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-0.5">
                {t("toolbar.microzonation.province")}
                <select
                  className={select}
                  value={filters.province}
                  onChange={(e) =>
                    setFilters((f) => ({ ...f, province: e.target.value, municipality: "" }))
                  }
                  data-testid="microzonation-province"
                >
                  <option value="">{t("toolbar.microzonation.all")}</option>
                  {provinces.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-0.5">
                {t("toolbar.microzonation.municipality")}
                <select
                  className={select}
                  value={filters.municipality}
                  onChange={(e) => setFilters((f) => ({ ...f, municipality: e.target.value }))}
                >
                  <option value="">{t("toolbar.microzonation.all")}</option>
                  {municipalities.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-0.5">
                {t("toolbar.microzonation.microzonation")}
                <select
                  className={select}
                  value={filters.microzonation}
                  onChange={(e) => setFilters((f) => ({ ...f, microzonation: e.target.value }))}
                >
                  <option value="">{t("toolbar.microzonation.all")}</option>
                  <option value="2">{t("toolbar.microzonation.level2")}</option>
                  <option value="3">{t("toolbar.microzonation.level3")}</option>
                </select>
              </label>
              <label className="flex flex-col gap-0.5">
                {t("toolbar.microzonation.cle")}
                <select
                  className={select}
                  value={filters.cle}
                  onChange={(e) => setFilters((f) => ({ ...f, cle: e.target.value }))}
                >
                  <option value="">{t("toolbar.microzonation.all")}</option>
                  <option value="done">{t("toolbar.microzonation.cleDone")}</option>
                  <option value="no">{t("toolbar.microzonation.cleNo")}</option>
                </select>
              </label>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                className="h-7 text-xs"
                onClick={search}
                disabled={loading || records.length === 0}
                data-testid="microzonation-search"
              >
                {t("toolbar.microzonation.search")}
              </Button>
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={clear}>
                {t("toolbar.microzonation.clear")}
              </Button>
            </div>
            {loading ? (
              <p className="text-muted-foreground">{t("toolbar.microzonation.loading")}</p>
            ) : null}
            {error ? (
              <p className="text-destructive" role="alert">
                {error}
              </p>
            ) : null}
            {results ? (
              <div className="space-y-1">
                <div className={section}>{t("toolbar.microzonation.results")}</div>
                {results.length === 0 ? (
                  <p className="text-muted-foreground">{t("toolbar.microzonation.noResults")}</p>
                ) : (
                  <div className="max-h-48 overflow-auto rounded-md border border-border">
                    <table className="w-full" data-testid="microzonation-results">
                      <thead className="sticky top-0 bg-muted/60">
                        <tr>
                          <th className={th}>{t("toolbar.microzonation.province")}</th>
                          <th className={th}>{t("toolbar.microzonation.municipality")}</th>
                          <th className={th}>{t("toolbar.microzonation.microzonation")}</th>
                          <th className={th}>{t("toolbar.microzonation.msOrdinance")}</th>
                          <th className={th}>{t("toolbar.microzonation.cle")}</th>
                          <th className={th}>{t("toolbar.microzonation.cleOrdinance")}</th>
                          <th className={th}>{t("toolbar.microzonation.municipalPlan")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {results.map((record) => {
                          const key = String(microzonationRecordId(record));
                          const isSelected =
                            selected !== null &&
                            microzonationRecordId(selected) === microzonationRecordId(record);
                          return (
                            <tr
                              key={key}
                              className={`cursor-pointer ${isSelected ? "bg-primary/15" : "odd:bg-muted/20 hover:bg-muted/40"}`}
                              onClick={() => pick(record)}
                            >
                              <td className={td}>{formatMicrozonationValue(record.province)}</td>
                              <td className={td}>
                                {formatMicrozonationValue(record.municipality)}
                              </td>
                              <td className={td}>{levelLabel(record.microzonation)}</td>
                              <td className={td}>{formatMicrozonationValue(record.msOrdinance)}</td>
                              <td className={td}>{cleLabel(record.cle)}</td>
                              <td className={td}>
                                {formatMicrozonationValue(record.cleOrdinance)}
                              </td>
                              <td className={td}>
                                {formatMicrozonationValue(record.municipalPlan)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ) : null}
            {detail ? (
              <div className="space-y-2" data-testid="microzonation-detail">
                <div className={section}>{t("toolbar.microzonation.detail")}</div>
                <div className="rounded-md border border-border p-2">
                  <div className="mb-1 font-medium">{t("toolbar.microzonation.generalInfo")}</div>
                  <table className="w-full">
                    <tbody>
                      {detailRow(
                        t("toolbar.microzonation.province"),
                        formatMicrozonationValue(detail.generalInfo.province),
                      )}
                      {detailRow(
                        t("toolbar.microzonation.municipality"),
                        formatMicrozonationValue(detail.generalInfo.municipality),
                      )}
                      {detailRow(
                        t("toolbar.microzonation.notes"),
                        formatMicrozonationValue(detail.generalInfo.notes),
                        true,
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="rounded-md border border-border p-2">
                  <div className="mb-1 font-medium">{t("toolbar.microzonation.microzonation")}</div>
                  <table className="w-full">
                    <tbody>
                      {detailRow(
                        t("toolbar.microzonation.microzonation"),
                        levelLabel(detail.microzonation.microzonation),
                      )}
                      {detailRow(
                        t("toolbar.microzonation.msOrdinance"),
                        formatMicrozonationValue(detail.microzonation.msOrdinance),
                      )}
                      {detailRow(
                        t("toolbar.microzonation.msValidation"),
                        formatMicrozonationValue(detail.microzonation.msValidation),
                      )}
                      {detailRow(
                        t("toolbar.microzonation.msStandard"),
                        formatMicrozonationValue(detail.microzonation.msStandard),
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="rounded-md border border-border p-2">
                  <div className="mb-1 font-medium">{t("toolbar.microzonation.cle")}</div>
                  <table className="w-full">
                    <tbody>
                      {detailRow(t("toolbar.microzonation.cle"), cleLabel(detail.cle.cle))}
                      {detailRow(
                        t("toolbar.microzonation.cleOrdinance"),
                        formatMicrozonationValue(detail.cle.cleOrdinance),
                      )}
                      {detailRow(
                        t("toolbar.microzonation.cleValidation"),
                        formatMicrozonationValue(detail.cle.cleValidation),
                      )}
                      {detailRow(
                        t("toolbar.microzonation.cleStandard"),
                        formatMicrozonationValue(detail.cle.cleStandard),
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="rounded-md border border-border p-2">
                  <div className="mb-1 font-medium">
                    {t("toolbar.microzonation.civilProtectionPlan")}
                  </div>
                  <table className="w-full">
                    <tbody>
                      {detailRow(
                        t("toolbar.microzonation.municipalPlan"),
                        formatMicrozonationValue(detail.civilProtectionPlan.municipalPlan),
                      )}
                      <tr>
                        <td className="w-32 px-2 py-0.5 text-muted-foreground">
                          {t("toolbar.microzonation.planLink")}
                        </td>
                        <td className="px-2 py-0.5">
                          {detail.civilProtectionPlan.link ? (
                            <a
                              className="inline-flex items-center gap-1 text-primary underline"
                              href={detail.civilProtectionPlan.link}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {t("toolbar.microzonation.open")}
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          ) : (
                            "-"
                          )}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                {config.documentsLayerName ? (
                  <div className="space-y-1">
                    <div className="font-medium">{t("toolbar.microzonation.documents")}</div>
                    {loadingDocuments ? (
                      <p className="text-muted-foreground">
                        {t("toolbar.microzonation.loadingDocuments")}
                      </p>
                    ) : documents.length === 0 ? (
                      <p className="text-muted-foreground">
                        {t("toolbar.microzonation.noDocuments")}
                      </p>
                    ) : (
                      <div className="max-h-48 overflow-auto rounded-md border border-border">
                        <table className="w-full" data-testid="microzonation-documents">
                          <thead className="sticky top-0 bg-muted/60">
                            <tr>
                              <th className={th} onClick={() => sortBy("typeDoc")}>
                                {t("toolbar.microzonation.docType")}
                              </th>
                              <th className={th} onClick={() => sortBy("desc")}>
                                {t("toolbar.microzonation.docDescription")}
                              </th>
                              <th className={th} onClick={() => sortBy("docFormat")}>
                                {t("toolbar.microzonation.docFormat")}
                              </th>
                              <th className={th} onClick={() => sortBy("startDate")}>
                                {t("toolbar.microzonation.docStart")}
                              </th>
                              <th className={th} onClick={() => sortBy("endDate")}>
                                {t("toolbar.microzonation.docEnd")}
                              </th>
                              <th className={th} />
                            </tr>
                          </thead>
                          <tbody>
                            {sortedDocuments.map((doc) => (
                              <tr key={doc.id} className="odd:bg-muted/20">
                                <td className={td}>{doc.typeDoc}</td>
                                <td className={td}>{doc.desc}</td>
                                <td className={td}>{doc.docFormat}</td>
                                <td className={td}>
                                  {formatMicrozonationDate(doc.startDate, i18n.language)}
                                </td>
                                <td className={td}>
                                  {formatMicrozonationDate(doc.endDate, i18n.language)}
                                </td>
                                <td className={td}>
                                  <a
                                    className="inline-flex items-center gap-1 text-primary underline"
                                    href={doc.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                  >
                                    {t("toolbar.microzonation.download")}
                                    <ExternalLink className="h-3 w-3" />
                                  </a>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            ) : null}
            {config.plansUrl ? (
              <a
                className="inline-flex items-center gap-1 text-primary underline"
                href={config.plansUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("toolbar.microzonation.municipalEmergencyPlans")}
                <ExternalLink className="h-3 w-3" />
              </a>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
