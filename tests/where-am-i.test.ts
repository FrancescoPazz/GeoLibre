import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  WHERE_AM_I_DEFAULT_ID_FIELD,
  createWhereAmIResolver,
  getWhereAmIConfig,
  lookupWhereAmI,
  whereAmIQueryUrl,
  type WhereAmIConfig,
  type WhereAmIPlace,
} from "@geolibre/core";

// The place-name lookup the status bar shows ("Where am I"): the two-step
// ArcGIS query of the old geoportal's MouseCoords.askWhereAmI, with the
// same field roles, plus the pointer resolver in front of it.

const FAST =
  "https://gis.example.org/rest/services/where/MapServer/0/query?spatialRel=esriSpatialRelIndexIntersects&outFields=OBJECTID,LOCALIZZAZ,DETTAGLIO&f=pjson";
const ACCURATE =
  "https://gis.example.org/rest/services/where/MapServer/0/query?spatialRel=esriSpatialRelIntersects&outFields=OBJECTID,LOCALIZZAZ,DETTAGLIO&f=pjson";

const CONFIG: WhereAmIConfig = {
  url: FAST,
  accurateUrl: ACCURATE,
  idField: "OBJECTID",
  field: "LOCALIZZAZ",
  detailField: "DETTAGLIO",
};

const BOLOGNA: [number, number] = [11.34, 44.49];

function feature(id: number, name: string, detail?: string) {
  return { attributes: { OBJECTID: id, LOCALIZZAZ: name, DETTAGLIO: detail } };
}

/** A fake service answering the fast and accurate queries, recording the URLs asked. */
function service(
  fast: unknown[],
  accurate: unknown[] = [],
): { fetch: typeof globalThis.fetch; calls: URL[] } {
  const calls: URL[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    const rel = url.searchParams.get("spatialRel");
    const body = { features: rel === "esriSpatialRelIntersects" ? accurate : fast };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { fetch: fetchImpl, calls };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("getWhereAmIConfig", () => {
  it("needs both a query url and a field, and only an http(s) url", () => {
    assert.equal(getWhereAmIConfig({}), undefined);
    assert.equal(getWhereAmIConfig({ VITE_WHERE_AM_I_URL: FAST }), undefined);
    assert.equal(getWhereAmIConfig({ WHERE_AM_I_FIELD: "LOCALIZZAZ" }), undefined);
    assert.equal(
      getWhereAmIConfig({ WHERE_AM_I_URL: "javascript:1", WHERE_AM_I_FIELD: "X" }),
      undefined,
    );
  });

  it("reads the full set, in either spelling, with the id field defaulting to OBJECTID", () => {
    assert.deepEqual(
      getWhereAmIConfig({ VITE_WHERE_AM_I_URL: ` ${FAST} `, WHERE_AM_I_FIELD: "LOCALIZZAZ" }),
      {
        url: FAST,
        accurateUrl: undefined,
        idField: WHERE_AM_I_DEFAULT_ID_FIELD,
        field: "LOCALIZZAZ",
        detailField: undefined,
      },
    );
    assert.deepEqual(
      getWhereAmIConfig({
        WHERE_AM_I_URL: FAST,
        WHERE_AM_I_ACCURATE_URL: ACCURATE,
        WHERE_AM_I_ID_FIELD: "FID",
        WHERE_AM_I_FIELD: "NAME",
        WHERE_AM_I_DETAIL_FIELD: "DETAIL",
      }),
      { url: FAST, accurateUrl: ACCURATE, idField: "FID", field: "NAME", detailField: "DETAIL" },
    );
  });
});

describe("whereAmIQueryUrl", () => {
  it("adds the point geometry and keeps the configured parameters", () => {
    const url = new URL(whereAmIQueryUrl(FAST, BOLOGNA));
    assert.equal(url.searchParams.get("geometry"), "11.34, 44.49");
    assert.equal(url.searchParams.get("f"), "pjson");
    assert.equal(url.searchParams.get("outFields"), "OBJECTID,LOCALIZZAZ,DETTAGLIO");
    assert.equal(url.searchParams.has("objectIds"), false);
  });

  it("restricts to the given ids", () => {
    const url = new URL(whereAmIQueryUrl(ACCURATE, BOLOGNA, [3, "7"]));
    assert.equal(url.searchParams.get("objectIds"), "3,7");
  });
});

describe("lookupWhereAmI", () => {
  it("takes the first fast match when there is one", async () => {
    const s = service([feature(1, "Bologna", "Comune di Bologna")]);
    assert.deepEqual(await lookupWhereAmI(CONFIG, BOLOGNA, s.fetch), {
      name: "Bologna",
      detail: "Comune di Bologna",
    });
    assert.equal(s.calls.length, 1);
  });

  it("asks the accurate query to choose among several fast matches", async () => {
    const s = service(
      [feature(1, "Bologna"), feature(2, "Casalecchio di Reno")],
      [feature(2, "Casalecchio di Reno")],
    );
    assert.deepEqual(await lookupWhereAmI(CONFIG, BOLOGNA, s.fetch), {
      name: "Casalecchio di Reno",
      detail: null,
    });
    assert.equal(s.calls.length, 2);
    assert.equal(s.calls[1].searchParams.get("objectIds"), "1,2");
    assert.equal(s.calls[1].searchParams.get("geometry"), "11.34, 44.49");
  });

  it("keeps the first fast match when several match but no accurate query is configured", async () => {
    const s = service([feature(1, "Bologna"), feature(2, "Casalecchio di Reno")]);
    const config = { ...CONFIG, accurateUrl: undefined };
    assert.deepEqual(await lookupWhereAmI(config, BOLOGNA, s.fetch), {
      name: "Bologna",
      detail: null,
    });
    assert.equal(s.calls.length, 1);
  });

  it("answers null off the service's coverage, for a blank name, or for a malformed body", async () => {
    assert.equal(await lookupWhereAmI(CONFIG, BOLOGNA, service([]).fetch), null);
    assert.equal(await lookupWhereAmI(CONFIG, BOLOGNA, service([feature(1, "  ")]).fetch), null);
    const broken: typeof globalThis.fetch = async () => new Response("{}", { status: 200 });
    assert.equal(await lookupWhereAmI(CONFIG, BOLOGNA, broken), null);
  });

  it("throws on an HTTP failure", async () => {
    const failing: typeof globalThis.fetch = async () => new Response("", { status: 503 });
    await assert.rejects(lookupWhereAmI(CONFIG, BOLOGNA, failing), /HTTP 503/);
  });
});

describe("createWhereAmIResolver", () => {
  it("waits for the pointer to settle, then emits the place, and answers repeats from the cache", async () => {
    const s = service([feature(1, "Bologna")]);
    const emitted: Array<WhereAmIPlace | null> = [];
    const resolver = createWhereAmIResolver({
      config: CONFIG,
      fetchImpl: s.fetch,
      emit: (p) => emitted.push(p),
      debounceMs: 5,
    });
    resolver.update([11.3401, 44.4901]);
    resolver.update([11.3402, 44.4902]);
    resolver.update(BOLOGNA);
    assert.equal(s.calls.length, 0, "nothing is asked while the pointer moves");
    await tick(20);
    assert.equal(s.calls.length, 1);
    assert.deepEqual(emitted, [{ name: "Bologna", detail: null }]);

    resolver.update([11.34004, 44.49004]);
    assert.equal(emitted.length, 2, "a spot within ~11 m of one already seen answers at once");
    await tick(20);
    assert.equal(s.calls.length, 1);
    resolver.dispose();
  });

  it("drops an answer for a spot the pointer has left, and emits null when it leaves the map", async () => {
    let release: (() => void) | null = null;
    const slow: typeof globalThis.fetch = (input) =>
      new Promise((resolve) => {
        release = () => {
          const url = new URL(String(input));
          const name = url.searchParams.get("geometry")?.startsWith("11.34,")
            ? "Bologna"
            : "Modena";
          resolve(new Response(JSON.stringify({ features: [feature(1, name)] }), { status: 200 }));
        };
      });
    const emitted: Array<WhereAmIPlace | null> = [];
    const resolver = createWhereAmIResolver({
      config: CONFIG,
      fetchImpl: slow,
      emit: (p) => emitted.push(p),
      debounceMs: 1,
    });
    resolver.update(BOLOGNA);
    await tick(10);
    const releaseBologna = release as (() => void) | null;
    resolver.update([10.92, 44.65]); // Modena, before Bologna answered
    await tick(10);
    releaseBologna?.();
    await tick(5);
    assert.deepEqual(emitted, [], "the stale Bologna answer is not shown over Modena");
    (release as (() => void) | null)?.();
    await tick(5);
    assert.deepEqual(emitted, [{ name: "Modena", detail: null }]);

    resolver.update(null);
    assert.deepEqual(emitted.at(-1), null);
    resolver.dispose();
  });

  it("does not cache a failed lookup, and stays quiet while disabled", async () => {
    let fail = true;
    let calls = 0;
    const flaky: typeof globalThis.fetch = async () => {
      calls += 1;
      return fail
        ? new Response("", { status: 500 })
        : new Response(JSON.stringify({ features: [feature(1, "Bologna")] }), { status: 200 });
    };
    let enabled = true;
    const emitted: Array<WhereAmIPlace | null> = [];
    const resolver = createWhereAmIResolver({
      config: CONFIG,
      fetchImpl: flaky,
      emit: (p) => emitted.push(p),
      isEnabled: () => enabled,
      debounceMs: 1,
    });
    resolver.update(BOLOGNA);
    await tick(10);
    assert.equal(calls, 1);
    assert.deepEqual(emitted, []);
    fail = false;
    resolver.update([11.35, 44.49]);
    resolver.update(BOLOGNA);
    await tick(10);
    assert.equal(calls, 2, "the failure was not remembered");
    assert.deepEqual(emitted, [{ name: "Bologna", detail: null }]);

    enabled = false;
    resolver.update([11.36, 44.49]);
    await tick(10);
    assert.equal(calls, 2);
    assert.deepEqual(emitted.at(-1), null);
    resolver.dispose();
  });
});
