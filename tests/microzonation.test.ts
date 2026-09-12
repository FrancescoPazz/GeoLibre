import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
  microzonationWfsUrl,
  normalizeCleStatus,
  normalizeMicrozonationDetail,
  normalizeMicrozonationLevel,
  normalizeMicrozonationRecord,
  uniqueSorted,
  type MicrozonationRecord,
} from "../packages/plugins/src/plugins/microzonation";

// Parity with the fork's MicrozonationSpec: the same normalizations of the
// regions' WFS fields, the same filters, the same request.

const CONFIG = {
  url: "https://geosrv.example.org/geoserver/wfs",
  projectsLayerName: "rer:stato_progetti",
  documentsLayerName: "rer:documenti",
};

const record = (extra: Partial<MicrozonationRecord>): MicrozonationRecord => ({
  province: "",
  municipality: "",
  microzonation: "no",
  msOrdinance: "",
  cle: "no",
  cleOrdinance: "",
  municipalPlan: "",
  ...extra,
});

describe("microzonation: normalization", () => {
  it("formats values, dates, levels and CLE status as the old panel did", () => {
    assert.equal(formatMicrozonationValue(null), "-");
    assert.equal(formatMicrozonationValue(""), "-");
    assert.equal(formatMicrozonationValue(0), "0");
    assert.equal(formatMicrozonationValue(false), "false");
    assert.equal(formatMicrozonationDate(), "-");
    assert.equal(
      formatMicrozonationDate("2023-04-05"),
      new Date("2023-04-05").toLocaleDateString("it-IT"),
    );
    assert.equal(formatMicrozonationDate("not a date"), "not a date");
    assert.equal(normalizeMicrozonationLevel(3), "3");
    assert.equal(normalizeMicrozonationLevel(" 2 "), "2");
    assert.equal(normalizeMicrozonationLevel("4"), "no");
    assert.equal(normalizeMicrozonationLevel(undefined), "no");
    assert.equal(normalizeCleStatus(" s "), "done");
    assert.equal(normalizeCleStatus("N"), "no");
    assert.equal(normalizeCleStatus(null), "no");
  });

  it("sorts distinct values with Italian collation and dropping empties", () => {
    assert.deepEqual(uniqueSorted(["Rimini", "Bologna", "Rimini"]), ["Bologna", "Rimini"]);
    assert.deepEqual(uniqueSorted(["Bologna", undefined, ""]), ["Bologna"]);
    assert.deepEqual(uniqueSorted(["Zola", "Àlbaro", "bologna"]), ["Àlbaro", "bologna", "Zola"]);
  });

  it("identifies a record by the service id or a composite key", () => {
    assert.equal(microzonationRecordId(record({ id: 42 })), 42);
    assert.equal(
      microzonationRecordId(
        record({ province: "BO", municipality: "Bologna", microzonation: "2", cle: "done" }),
      ),
      "BO-Bologna-2-done",
    );
    assert.equal(microzonationRecordId({}), "---");
  });

  it("maps the service fields onto the record and the detail", () => {
    const props = {
      id_stato_progetto: 7,
      prov: "BO",
      comune: "Bologna",
      cod_istat: 0,
      note: "n",
      microzonazione: "2",
      ordinanza: "O1",
      convalidato: "sì",
      mzs_standard: "4.2",
      microzonazione_info: "info",
      cle_convalida: "S",
      cle_ordinanza: "O2",
      cle_standard: "3.1",
      piano_prot_civile: "P",
      link_ppc_comune: "https://example.org/ppc",
    };
    assert.deepEqual(normalizeMicrozonationRecord(props), {
      id: 7,
      province: "BO",
      municipality: "Bologna",
      microzonation: "2",
      msOrdinance: "O1",
      cle: "done",
      cleOrdinance: "O2",
      municipalPlan: "P",
    });
    assert.equal(
      normalizeMicrozonationRecord({ gid: 99 }).id,
      99,
      "gid when there is no project id",
    );
    const empty = normalizeMicrozonationRecord({});
    assert.equal(empty.province, "");
    assert.equal(empty.microzonation, "no");
    assert.equal(empty.cle, "no");
    const detail = normalizeMicrozonationDetail(props);
    assert.deepEqual(detail.generalInfo, {
      province: "BO",
      municipality: "Bologna",
      istatCode: "0",
      notes: "n",
    });
    assert.equal(detail.microzonation.microzonation, "2");
    assert.equal(detail.cle.cle, "done");
    assert.deepEqual(detail.civilProtectionPlan, {
      municipalPlan: "P",
      link: "https://example.org/ppc",
    });
    assert.equal(normalizeMicrozonationDetail({}).generalInfo.istatCode, "");
    const cached = new Map<string | number, Record<string, unknown>>([[7, props]]);
    assert.equal(
      microzonationDetailOf(cached, record({ id: 7 })).generalInfo.municipality,
      "Bologna",
    );
    assert.equal(
      microzonationDetailOf(cached, record({ id: 8 })).microzonation.microzonation,
      "no",
    );
  });

  it("filters records by each field and all of them together", () => {
    const records = [
      record({ id: 1, province: "BO", municipality: "Bologna", microzonation: "2", cle: "done" }),
      record({ id: 2, province: "BO", municipality: "Imola", microzonation: "2", cle: "no" }),
      record({ id: 3, province: "RN", municipality: "Rimini", microzonation: "3", cle: "done" }),
    ];
    const ids = (filters: Partial<typeof EMPTY_MICROZONATION_FILTERS>) =>
      filterMicrozonationRecords(records, { ...EMPTY_MICROZONATION_FILTERS, ...filters }).map(
        (r) => r.id,
      );
    assert.deepEqual(ids({}), [1, 2, 3]);
    assert.deepEqual(ids({ province: "RN" }), [3]);
    assert.deepEqual(ids({ municipality: "Imola" }), [2]);
    assert.deepEqual(ids({ microzonation: "3" }), [3]);
    assert.deepEqual(ids({ cle: "no" }), [2]);
    assert.deepEqual(ids({ province: "BO", cle: "done" }), [1]);
    assert.deepEqual(ids({ province: "RN", municipality: "Bologna" }), []);
  });

  it("boxes a geometry of any depth", () => {
    assert.equal(geometryBBox(undefined), undefined);
    assert.equal(geometryBBox({ type: "GeometryCollection", geometries: [] }), undefined);
    assert.deepEqual(geometryBBox({ type: "Point", coordinates: [11, 44] }), [11, 44, 11, 44]);
    assert.deepEqual(
      geometryBBox({
        type: "Polygon",
        coordinates: [
          [
            [11, 44],
            [12, 44],
            [12, 45],
            [11, 45],
            [11, 44],
          ],
        ],
      }),
      [11, 44, 12, 45],
    );
    assert.deepEqual(
      geometryBBox({
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [11, 44],
              [12, 44],
              [12, 45],
            ],
          ],
          [
            [
              [12.5, 43.5],
              [12.5, 44],
            ],
          ],
        ],
      }),
      [11, 43.5, 12.5, 45],
    );
    assert.equal(geometryBBox({ type: "LineString", coordinates: [] }), undefined);
  });
});

describe("microzonation: service", () => {
  it("reads the deployment's configuration, in the old geoportal's spelling too", () => {
    assert.equal(getMicrozonationConfig({}), undefined);
    assert.equal(
      getMicrozonationConfig({ MICROZONATION_URL: "https://x/wfs" }),
      undefined,
      "no layer",
    );
    assert.equal(
      getMicrozonationConfig({ MICROZONATION_URL: "ftp://x", MICROZONATION_TYPENAME: "a" }),
      undefined,
    );
    assert.deepEqual(
      getMicrozonationConfig({
        VITE_MICROZONATION_URL: "https://x/wfs",
        VITE_MICROZONATION_TYPENAME: "qmap:stato",
        VITE_MICROZONATION_OUTPUT_FORMAT: "application/json",
        VITE_MICROZONATION_PLANS_URL: "https://x/plans",
      }),
      {
        url: "https://x/wfs",
        projectsLayerName: "qmap:stato",
        documentsLayerName: undefined,
        outputFormat: "application/json",
        plansUrl: "https://x/plans",
      },
    );
    assert.equal(
      getMicrozonationConfig({
        MICROZONATION_URL: "https://x/wfs",
        MICROZONATION_PROJECTS_LAYER: "p",
        MICROZONATION_DOCUMENTS_LAYER: "d",
      })?.documentsLayerName,
      "d",
    );
  });

  it("requests the projects layer as GeoJSON in EPSG:4326 and indexes the answer", async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      urls.push(String(input));
      return new Response(
        JSON.stringify({
          features: [
            {
              id: "stato.1",
              properties: {
                id_stato_progetto: 1,
                prov: "BO",
                comune: "Bologna",
                microzonazione: 3,
              },
              geometry: { type: "Point", coordinates: [11.3, 44.5] },
            },
            { properties: { prov: "RN", comune: "Rimini" } },
          ],
        }),
        { status: 200 },
      );
    };
    const result = await fetchMicrozonationProjects(CONFIG, fetchImpl);
    const params = new URL(urls[0]).searchParams;
    assert.equal(params.get("service"), "WFS");
    assert.equal(params.get("request"), "GetFeature");
    assert.equal(params.get("typeName"), "rer:stato_progetti");
    assert.equal(params.get("outputFormat"), "application/json");
    assert.equal(params.get("srsName"), "EPSG:4326");
    assert.equal(result.records.length, 2);
    assert.equal(result.records[0].municipality, "Bologna");
    assert.equal(result.records[0].microzonation, "3");
    assert.equal(result.propertiesById.get(1)?.prov, "BO");
    assert.deepEqual(result.geometryById.get(1), { type: "Point", coordinates: [11.3, 44.5] });
    assert.equal(
      result.records[1].id,
      undefined,
      "a record without an id is listed but not indexed",
    );
    assert.equal(result.propertiesById.size, 1);
  });

  it("asks the documents layer for one project and skips documents without a link", async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      urls.push(String(input));
      return new Response(
        JSON.stringify({
          features: [
            {
              id: "doc.1",
              properties: {
                link: "https://x/a.pdf",
                tipo_documento: "Relazione",
                descrizione_file: "R",
                validita_inizio: "2020-01-01",
                validita_fine: null,
              },
            },
            { id: "doc.2", properties: { link: "", tipo_documento: "x" } },
          ],
        }),
        { status: 200 },
      );
    };
    const docs = await fetchMicrozonationDocuments(CONFIG, 1, fetchImpl);
    assert.equal(new URL(urls[0]).searchParams.get("CQL_FILTER"), "id_stato_progetto=1");
    assert.equal(new URL(urls[0]).searchParams.get("typeName"), "rer:documenti");
    assert.deepEqual(docs, [
      {
        id: "doc.1",
        url: "https://x/a.pdf",
        typeDoc: "Relazione",
        desc: "R",
        docFormat: "pdf",
        startDate: "2020-01-01",
        endDate: undefined,
      },
    ]);
    assert.deepEqual(
      await fetchMicrozonationDocuments({ ...CONFIG, documentsLayerName: undefined }, 1, fetchImpl),
      [],
    );
    assert.deepEqual(await fetchMicrozonationDocuments(CONFIG, undefined, fetchImpl), []);
    assert.equal(urls.length, 1, "neither case asked the service");
  });

  it("reports an HTTP failure by status, as the old panel did", async () => {
    const fetchImpl: typeof fetch = async () => new Response("", { status: 503 });
    await assert.rejects(fetchMicrozonationProjects(CONFIG, fetchImpl), /503/);
    assert.equal(
      microzonationWfsUrl({ ...CONFIG, url: "https://x/wfs?token=t" }).startsWith(
        "https://x/wfs?token=t&service=WFS",
      ),
      true,
    );
  });
});
