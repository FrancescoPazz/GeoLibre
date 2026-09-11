import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CRS_CONVERSIONS,
  ED50_ETRS89_WKT,
  MONTE_MARIO_ETRS89_WKT,
  WGS84_EPSG,
  conversionsForInput,
  convertCoordinates,
  formatConverted,
  getCoordsConverterUrl,
  inputXY,
  parseCoordinateInput,
  parseProjectedPoint,
  projectRequestUrl,
  type CrsConversion,
} from "@geolibre/core";

// The coordinate converter of the old geoportal's CoordsPanel: the same
// thirty pairs, the same NTv2 GEOGTRANs, the same input reading and result
// formatting — with the request built once, correctly, instead of by
// permuting coordinate order and direction until something parsed.

const SERVICE =
  "https://gis.example.org/arcgis/rest/services/Utilities/Geometry/GeometryServer/project";

const find = (from: number, to: number): CrsConversion => {
  const c = CRS_CONVERSIONS.find((x) => x.from === from && x.to === to);
  assert.ok(c, `no conversion ${from} → ${to}`);
  return c;
};

describe("CRS_CONVERSIONS", () => {
  it("offers fifteen systems, each paired with WGS84 in both directions", () => {
    assert.equal(CRS_CONVERSIONS.length, 30);
    const locals = new Set(CRS_CONVERSIONS.map((c) => (c.from === WGS84_EPSG ? c.to : c.from)));
    assert.deepEqual(
      [...locals].sort((a, b) => a - b),
      [
        3003, 3004, 4230, 4258, 4265, 5659, 6706, 7791, 7792, 23032, 23033, 25832, 25833, 32632,
        32633,
      ],
    );
    for (const epsg of locals) {
      const into = find(WGS84_EPSG, epsg);
      const outOf = find(epsg, WGS84_EPSG);
      assert.equal(into.transformForward, false, `into ${epsg} applies the datum shift backward`);
      assert.equal(outOf.transformForward, true);
      assert.equal(into.wkt, outOf.wkt);
      assert.equal(
        into.label,
        `EPSG:4326 WGS84 → EPSG:${epsg} ${outOf.label.split(" → ")[0].replace(`EPSG:${epsg} `, "")}`,
      );
    }
  });

  it("names the NTv2 grids for Monte Mario and ED50, and none for ETRS89, RDN2008 and WGS84 UTM", () => {
    for (const epsg of [3003, 3004, 4265, 5659])
      assert.equal(find(WGS84_EPSG, epsg).wkt, MONTE_MARIO_ETRS89_WKT);
    for (const epsg of [4230, 23032, 23033])
      assert.equal(find(WGS84_EPSG, epsg).wkt, ED50_ETRS89_WKT);
    for (const epsg of [4258, 25832, 25833, 6706, 7791, 7792, 32632, 32633]) {
      assert.equal(find(WGS84_EPSG, epsg).wkt, undefined);
    }
    assert.match(MONTE_MARIO_ETRS89_WKT, /RER_AD400_MM_ETRS89_V1A/);
    assert.match(ED50_ETRS89_WKT, /RER_ED50_ETRS89_GPS7_K2/);
  });

  it("drops the WGS84-origin pairs for projected input", () => {
    assert.equal(conversionsForInput(true).length, 30);
    const projected = conversionsForInput(false);
    assert.equal(projected.length, 15);
    assert.ok(projected.every((c) => c.from !== WGS84_EPSG));
  });
});

describe("parseCoordinateInput", () => {
  it("reads two numbers split by comma, semicolon or space", () => {
    assert.deepEqual(parseCoordinateInput("44.49, 11.34"), {
      first: 44.49,
      second: 11.34,
      cartographic: true,
    });
    assert.deepEqual(parseCoordinateInput("683000;4928000"), {
      first: 683000,
      second: 4928000,
      cartographic: false,
    });
    assert.deepEqual(parseCoordinateInput("  683000   4928000  "), {
      first: 683000,
      second: 4928000,
      cartographic: false,
    });
  });

  it("calls a pair cartographic unless neither number could be a latitude or longitude", () => {
    assert.equal(parseCoordinateInput("44.49, 11.34")?.cartographic, true);
    assert.equal(
      parseCoordinateInput("11.34, 4928000")?.cartographic,
      true,
      "first could still be a longitude",
    );
    assert.equal(
      parseCoordinateInput("683000, 44.49")?.cartographic,
      true,
      "second could still be a latitude",
    );
    assert.equal(parseCoordinateInput("683000, 4928000")?.cartographic, false);
  });

  it("rejects anything that is not two finite numbers", () => {
    assert.equal(parseCoordinateInput(""), null);
    assert.equal(parseCoordinateInput("44.49"), null);
    assert.equal(parseCoordinateInput("north, east"), null);
    assert.equal(parseCoordinateInput("Infinity, 1"), null);
  });

  it("sends cartographic input as lon,lat and projected input as x,y", () => {
    assert.deepEqual(inputXY({ first: 44.49, second: 11.34, cartographic: true }), {
      x: 11.34,
      y: 44.49,
    });
    assert.deepEqual(inputXY({ first: 683000, second: 4928000, cartographic: false }), {
      x: 683000,
      y: 4928000,
    });
  });
});

describe("projectRequestUrl", () => {
  it("builds the project request with the GEOGTRAN when asked, an empty one otherwise", () => {
    const conversion = find(WGS84_EPSG, 3003);
    const withGrid = new URL(projectRequestUrl(SERVICE, conversion, { x: 11.34, y: 44.49 }, true));
    assert.equal(withGrid.searchParams.get("inSR"), "4326");
    assert.equal(withGrid.searchParams.get("outSR"), "3003");
    assert.equal(withGrid.searchParams.get("geometries"), "11.34,44.49");
    assert.deepEqual(JSON.parse(withGrid.searchParams.get("transformation") ?? ""), {
      wkt: MONTE_MARIO_ETRS89_WKT,
    });
    assert.equal(withGrid.searchParams.get("transformForward"), "false");
    assert.equal(withGrid.searchParams.get("f"), "json");

    const without = new URL(projectRequestUrl(SERVICE, conversion, { x: 11.34, y: 44.49 }, false));
    assert.equal(without.searchParams.get("transformation"), "{}");
    const plain = new URL(
      projectRequestUrl(SERVICE, find(25832, WGS84_EPSG), { x: 1, y: 2 }, true),
    );
    assert.equal(plain.searchParams.get("transformation"), "{}", "no grid for ETRS89");
    assert.equal(plain.searchParams.get("transformForward"), "true");
  });
});

describe("parseProjectedPoint / formatConverted", () => {
  it("formats degrees to six decimals as lat, lon and metres to four as x, y", () => {
    assert.deepEqual(formatConverted(11.3412345678, 44.4912345678), {
      x: 11.341235,
      y: 44.491235,
      cartographic: true,
      text: "44.491235, 11.341235",
    });
    assert.deepEqual(formatConverted(683123.45678, 4928123.45678), {
      x: 683123.4568,
      y: 4928123.4568,
      cartographic: false,
      text: "683123.4568, 4928123.4568",
    });
  });

  it("reads the point from the shapes a project answer can take", () => {
    assert.equal(
      parseProjectedPoint({ geometries: [{ x: 683000, y: 4928000 }] })?.text,
      "683000.0000, 4928000.0000",
    );
    assert.equal(
      parseProjectedPoint({ geometry: { x: "11,34", y: "44,49" } })?.text,
      "44.490000, 11.340000",
    );
    assert.equal(
      parseProjectedPoint({ features: [{ geometry: [11.34, 44.49] }] })?.text,
      "44.490000, 11.340000",
    );
    assert.equal(parseProjectedPoint({ geometries: [] }), null);
    assert.equal(parseProjectedPoint({ geometries: [{ x: "NaN", y: 1 }] }), null);
    assert.equal(parseProjectedPoint({ error: { message: "nope" } }), null);
  });
});

describe("convertCoordinates", () => {
  const input = parseCoordinateInput("44.49, 11.34")!;

  it("asks once with the grid and returns the projected point", async () => {
    const urls: URL[] = [];
    const fake: typeof globalThis.fetch = async (u) => {
      urls.push(new URL(String(u)));
      return new Response(JSON.stringify({ geometries: [{ x: 1683000.1234, y: 4928000.5678 }] }), {
        status: 200,
      });
    };
    const result = await convertCoordinates(SERVICE, find(WGS84_EPSG, 3003), input, fake);
    assert.equal(result.text, "1683000.1234, 4928000.5678");
    assert.equal(result.cartographic, false);
    assert.equal(urls.length, 1);
    assert.equal(urls[0].searchParams.get("geometries"), "11.34,44.49");
    assert.ok(urls[0].searchParams.get("transformation")?.includes("GEOGTRAN"));
  });

  it("retries without the grid when the server rejects it, and surfaces the server's message when both fail", async () => {
    const urls: URL[] = [];
    const rejectsGrid: typeof globalThis.fetch = async (u) => {
      const url = new URL(String(u));
      urls.push(url);
      if (url.searchParams.get("transformation") !== "{}") {
        return new Response(
          JSON.stringify({ error: { code: 400, message: "Invalid transformation" } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ geometries: [{ x: 11.34, y: 44.49 }] }), {
        status: 200,
      });
    };
    const result = await convertCoordinates(
      SERVICE,
      find(3003, WGS84_EPSG),
      parseCoordinateInput("1683000, 4928000")!,
      rejectsGrid,
    );
    assert.equal(result.text, "44.490000, 11.340000");
    assert.equal(urls.length, 2);

    const alwaysFails: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { message: "Invalid or missing input parameters." } }), {
        status: 200,
      });
    await assert.rejects(
      convertCoordinates(SERVICE, find(WGS84_EPSG, 3003), input, alwaysFails),
      /Invalid or missing input parameters/,
    );
    const http500: typeof globalThis.fetch = async () => new Response("", { status: 500 });
    await assert.rejects(
      convertCoordinates(SERVICE, find(WGS84_EPSG, 25832), input, http500),
      /HTTP 500/,
    );
  });
});

describe("getCoordsConverterUrl", () => {
  it("accepts an http(s) service url in either spelling and nothing else", () => {
    assert.equal(getCoordsConverterUrl({}), undefined);
    assert.equal(getCoordsConverterUrl({ COORDS_CONVERTER_URL: ` ${SERVICE} ` }), SERVICE);
    assert.equal(getCoordsConverterUrl({ VITE_COORDS_CONVERTER_URL: SERVICE }), SERVICE);
    assert.equal(getCoordsConverterUrl({ VITE_COORDS_CONVERTER_URL: "ftp://x" }), undefined);
    assert.equal(getCoordsConverterUrl({ VITE_COORDS_CONVERTER_URL: "not a url" }), undefined);
  });
});
