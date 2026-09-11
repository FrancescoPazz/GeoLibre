import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  RER_DEFAULT_SEARCH_EXTENT,
  RER_GEOCODER_ENDPOINT,
  geocodeForward,
  geocodeReverse,
  getGeocodingProvider,
  parseRerRecords,
  rerAddressUrl,
  rerCredentials,
  rerGeocodingProvider,
  rerHandleBody,
  rerHandleUrl,
  resetRerGeocoderSessions,
  setGeocodingFetch,
  type GeocoderConfig,
  type RerAddressRecord,
} from "@geolibre/core";

// The fork's RerSearchProviderSpec, re-run against the GeoLibre provider: the
// same recordset fixtures and the same expectations on names, positions,
// ordering, de-duplication and the session handle.

const SERVICE_URL = "https://servizigis.regione.emilia-romagna.it/normalizzatore";

function record(overrides: Partial<RerAddressRecord> = {}): RerAddressRecord {
  return {
    sTRADARIO_ID: "1",
    cIVICO_X: "",
    cENTR_X: "11.34",
    cIVICO_Y: "",
    cENTR_Y: "44.49",
    dUG: "VIA",
    dENOMINAZIONE: "INDIPENDENZA",
    dESCRIZIONE_CIVICO: "",
    cOMUNE: "BOLOGNA",
    pROVINCIA: "BO",
    gR_AFFIDABILITA: "1",
    ...overrides,
  };
}

const CONFIG: GeocoderConfig = {
  providerId: "rer",
  forwardEndpoint: SERVICE_URL,
  reverseEndpoint: SERVICE_URL,
  apiKey: "user:secret",
};

interface Call {
  url: string;
  message: string | null;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/**
 * A fake service: answers GetHandle with a handle and address searches with
 * `records`, recording every call. `handleValid` decides whether a search
 * with the current handle gets a recordset or an empty error payload.
 */
function mockService(
  records: RerAddressRecord[] | (() => RerAddressRecord[]),
  options: { handles?: string[]; rejectHandle?: (handle: string) => boolean } = {},
) {
  const calls: Call[] = [];
  const handles = options.handles ?? ["a-handle"];
  let issued = 0;
  const fake: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const message = new URL(url).searchParams.get("message");
    calls.push({ url, message, body, headers });
    if (message === "GetHandle") {
      const handle = handles[Math.min(issued, handles.length - 1)];
      issued += 1;
      return new Response(
        JSON.stringify({ getHandleOutput: { getHandleOutputParams: { p_Handle: handle } } }),
        { status: 200 },
      );
    }
    if (message === "Norm_Indirizzo_Unico_Area") {
      const params = body.Norm_Indirizzo_Unico_AreaInputParams as { p_Handle: string };
      if (options.rejectHandle?.(params.p_Handle)) {
        return new Response(JSON.stringify({ error: "invalid handle" }), { status: 200 });
      }
      const rows = typeof records === "function" ? records() : records;
      return new Response(
        JSON.stringify({
          norm_Indirizzo_Unico_AreaOutput: {
            norm_Indirizzo_Unico_AreaOutputRecordsetArray: rows,
          },
        }),
        { status: 200 },
      );
    }
    return new Response("", { status: 404 });
  };
  setGeocodingFetch(fake);
  return { calls, handleRequests: () => calls.filter((c) => c.message === "GetHandle").length };
}

beforeEach(() => resetRerGeocoderSessions());
afterEach(() => {
  setGeocodingFetch(null);
  resetRerGeocoderSessions();
});

describe("RER geocoder provider", () => {
  it("is registered, forward-only, with the public eGeoCoding endpoint", () => {
    const provider = getGeocodingProvider("rer");
    assert.equal(provider, rerGeocodingProvider);
    assert.equal(provider.forward, true);
    assert.equal(provider.reverse, false);
    assert.equal(provider.acceptsApiKey, true);
    assert.equal(provider.requiresApiKey, false);
    assert.equal(provider.defaultForwardEndpoint, RER_GEOCODER_ENDPOINT);
  });

  it("builds the handle and address urls from the configured url", () => {
    assert.equal(
      rerHandleUrl(SERVICE_URL),
      `${SERVICE_URL}?serviceType=DBServices&serviceName=Normalizzatore&message=GetHandle`,
    );
    assert.equal(
      rerAddressUrl(SERVICE_URL),
      `${SERVICE_URL}?serviceType=DBServices&serviceName=Normalizzatore&message=Norm_Indirizzo_Unico_Area`,
    );
    assert.equal(rerGeocodingProvider.buildForwardUrl(CONFIG, "x", {}), rerAddressUrl(SERVICE_URL));
  });

  it("splits the API key into the service credentials", () => {
    assert.deepEqual(rerCredentials("user:se:cret"), { username: "user", password: "se:cret" });
    assert.deepEqual(rerCredentials("user"), { username: "user", password: "" });
    assert.equal(rerCredentials(""), null);
    assert.equal(rerCredentials(undefined), null);
    assert.deepEqual(rerHandleBody(rerCredentials("u:p")), {
      GetHandleInputParams: { p_Username: "u", p_Userpassword: "p" },
    });
    assert.deepEqual(rerHandleBody(null), { GetHandleInputParams: {} });
  });
});

describe("parseRerRecords", () => {
  it("builds a display name from street, town and province", () => {
    const results = parseRerRecords([record()]);
    assert.equal(results.length, 1);
    assert.equal(results[0].displayName, "VIA INDIPENDENZA, BOLOGNA, BO");
  });

  it("appends the house number when the record has one", () => {
    const results = parseRerRecords([
      record({ cIVICO_X: "11.35", cIVICO_Y: "44.5", dESCRIZIONE_CIVICO: "10" }),
    ]);
    assert.equal(results[0].displayName, "VIA INDIPENDENZA 10, BOLOGNA, BO");
  });

  it("uses the street centroid when there is no house number", () => {
    const [result] = parseRerRecords([record()]);
    assert.equal(result.lat, 44.49);
    assert.equal(result.lon, 11.34);
  });

  it("uses the house number coordinates when present", () => {
    const [result] = parseRerRecords([record({ cIVICO_X: "11.35", cIVICO_Y: "44.5" })]);
    assert.equal(result.lat, 44.5);
    assert.equal(result.lon, 11.35);
  });

  it("drops records without usable coordinates instead of placing them at 0°,0°", () => {
    // The fork kept such rows at lat/lon 0 with a click that did nothing; a
    // row nobody can go to is left out of the list instead.
    assert.deepEqual(parseRerRecords([record({ cENTR_X: "not a number", cENTR_Y: "" })]), []);
    assert.deepEqual(parseRerRecords([record({ cENTR_X: "", cENTR_Y: "" })]), []);
  });

  it("carries the reliability rank as the score, the most reliable being 0", () => {
    const results = parseRerRecords([
      record({ sTRADARIO_ID: "1", gR_AFFIDABILITA: "0" }),
      record({ sTRADARIO_ID: "2", gR_AFFIDABILITA: "1" }),
      record({ sTRADARIO_ID: "3", gR_AFFIDABILITA: "" }),
    ]);
    assert.deepEqual(
      results.map((r) => r.score),
      [0, 1, null],
    );
  });

  it("sorts results by ascending reliability rank", () => {
    const results = parseRerRecords([
      record({ sTRADARIO_ID: "3", dENOMINAZIONE: "TERZA", gR_AFFIDABILITA: "9" }),
      record({ sTRADARIO_ID: "1", dENOMINAZIONE: "PRIMA", gR_AFFIDABILITA: "0" }),
      record({ sTRADARIO_ID: "2", dENOMINAZIONE: "SECONDA", gR_AFFIDABILITA: "5" }),
    ]);
    assert.deepEqual(
      results.map((r) => r.displayName),
      ["VIA PRIMA, BOLOGNA, BO", "VIA SECONDA, BOLOGNA, BO", "VIA TERZA, BOLOGNA, BO"],
    );
  });

  it("keeps only the first record for each street id", () => {
    const results = parseRerRecords([
      record({ sTRADARIO_ID: "1", dENOMINAZIONE: "PRIMA", gR_AFFIDABILITA: "0" }),
      record({ sTRADARIO_ID: "1", dENOMINAZIONE: "DUPLICATA", gR_AFFIDABILITA: "5" }),
    ]);
    assert.equal(results.length, 1);
    assert.equal(results[0].displayName, "VIA PRIMA, BOLOGNA, BO");
  });

  it("tolerates a malformed recordset", () => {
    assert.deepEqual(parseRerRecords(undefined), []);
    assert.deepEqual(parseRerRecords([null, 3, "x"]), []);
    assert.deepEqual(rerGeocodingProvider.parseForward({ nope: true }), []);
  });
});

describe("search", () => {
  it("returns the parsed locations", async () => {
    mockService([record(), record({ sTRADARIO_ID: "2", dENOMINAZIONE: "RIZZOLI" })]);
    const matches = await geocodeForward("indipendenza", { config: CONFIG });
    assert.equal(matches.length, 2);
    assert.equal(matches[0].displayName, "VIA INDIPENDENZA, BOLOGNA, BO");
    assert.equal(matches[1].displayName, "VIA RIZZOLI, BOLOGNA, BO");
  });

  it("logs in once and reuses the handle across searches", async () => {
    const service = mockService([record()]);
    await geocodeForward("indipendenza", { config: CONFIG });
    await geocodeForward("rizzoli", { config: CONFIG });
    assert.equal(service.handleRequests(), 1);
    const login = service.calls[0];
    assert.equal(login.message, "GetHandle");
    assert.deepEqual(login.body, {
      GetHandleInputParams: { p_Username: "user", p_Userpassword: "secret" },
    });
    assert.equal(login.headers["content-type"], "application/json");
    assert.equal(login.headers.soapaction, rerHandleUrl(SERVICE_URL));
  });

  it("sends the current view as the search area, WGS84, civic-number reference", async () => {
    const service = mockService([]);
    await geocodeForward("indipendenza", {
      config: CONFIG,
      bbox: [11.2, 44.4, 11.5, 44.6],
    });
    const search = service.calls.find((c) => c.message === "Norm_Indirizzo_Unico_Area");
    assert.ok(search);
    assert.deepEqual(search.body, {
      Norm_Indirizzo_Unico_AreaInputParams: {
        p_Indirizzo: "indipendenza",
        p_Tipo_Coord: "WGS84",
        p_Rif_Geo_Civ: "ECIV",
        p_Handle: "a-handle",
        p_minx: "11.2",
        p_miny: "44.4",
        p_maxx: "11.5",
        p_maxy: "44.6",
      },
    });
  });

  it("falls back to the whole region when the caller has no view", async () => {
    const service = mockService([]);
    await geocodeForward("indipendenza", { config: CONFIG });
    const search = service.calls.find((c) => c.message === "Norm_Indirizzo_Unico_Area");
    const params = search?.body.Norm_Indirizzo_Unico_AreaInputParams as Record<string, string>;
    assert.equal(params.p_minx, String(RER_DEFAULT_SEARCH_EXTENT[0]));
    assert.equal(params.p_maxy, String(RER_DEFAULT_SEARCH_EXTENT[3]));
  });

  it("honours the result limit", async () => {
    mockService([
      record({ sTRADARIO_ID: "1" }),
      record({ sTRADARIO_ID: "2" }),
      record({ sTRADARIO_ID: "3" }),
    ]);
    const matches = await geocodeForward("via", { config: CONFIG, limit: 2 });
    assert.equal(matches.length, 2);
  });

  it("reports nothing found as an empty list", async () => {
    mockService([]);
    assert.deepEqual(await geocodeForward("nowhere", { config: CONFIG }), []);
  });

  it("does not call the service for whitespace-only text", async () => {
    const service = mockService([record()]);
    assert.deepEqual(await geocodeForward("   ", { config: CONFIG }), []);
    assert.equal(service.calls.length, 0);
  });

  it("logs in again when the service stops accepting the handle", async () => {
    const service = mockService([record()], {
      handles: ["stale", "fresh"],
      rejectHandle: (handle) => handle === "stale",
    });
    const matches = await geocodeForward("indipendenza", { config: CONFIG });
    assert.equal(matches.length, 1);
    assert.equal(service.handleRequests(), 2);
    const searches = service.calls.filter((c) => c.message === "Norm_Indirizzo_Unico_Area");
    assert.deepEqual(
      searches.map(
        (c) => (c.body.Norm_Indirizzo_Unico_AreaInputParams as { p_Handle: string }).p_Handle,
      ),
      ["stale", "fresh"],
    );
  });

  it("gives up after one retry, and does not keep a failed login", async () => {
    mockService([record()], { handles: ["bad"], rejectHandle: () => true });
    await assert.rejects(
      geocodeForward("indipendenza", { config: CONFIG }),
      /no address recordset/,
    );

    let logins = 0;
    setGeocodingFetch(async (input) => {
      const message = new URL(String(input)).searchParams.get("message");
      if (message === "GetHandle") {
        logins += 1;
        return new Response("", { status: 401 });
      }
      return new Response("{}", { status: 200 });
    });
    resetRerGeocoderSessions();
    await assert.rejects(geocodeForward("indipendenza", { config: CONFIG }), /HTTP 401/);
    await assert.rejects(geocodeForward("indipendenza", { config: CONFIG }), /HTTP 401/);
    assert.equal(logins, 2, "a rejected login is retried on the next search, not cached");
  });

  it("answers reverse geocoding with null rather than calling the service", async () => {
    const service = mockService([record()]);
    assert.equal(await geocodeReverse(11.34, 44.49, { config: CONFIG }), null);
    assert.equal(service.calls.length, 0);
  });
});
