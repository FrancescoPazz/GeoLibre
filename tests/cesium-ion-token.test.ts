import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getCesiumIonToken,
  getCesiumTerrainAssetId,
  getElevationMeanSeaLevelDefault,
} from "@geolibre/core";

describe("getCesiumIonToken", () => {
  it("returns undefined when env is missing or empty", () => {
    assert.equal(getCesiumIonToken({}), undefined);
    assert.equal(getCesiumIonToken({ VITE_CESIUM_TOKEN: "" }), undefined);
    assert.equal(getCesiumIonToken({ VITE_CESIUM_TOKEN: "   " }), undefined);
    assert.equal(getCesiumIonToken({ CESIUM_TOKEN: "  " }), undefined);
  });

  it("returns the trimmed VITE_ token when set", () => {
    assert.equal(getCesiumIonToken({ VITE_CESIUM_TOKEN: "  ion.jwt.token  " }), "ion.jwt.token");
  });

  it("falls back to the bare CESIUM_TOKEN", () => {
    assert.equal(getCesiumIonToken({ CESIUM_TOKEN: "  bare-token  " }), "bare-token");
  });

  it("prefers VITE_CESIUM_TOKEN over the bare name", () => {
    assert.equal(
      getCesiumIonToken({
        VITE_CESIUM_TOKEN: "prefixed",
        CESIUM_TOKEN: "bare",
      }),
      "prefixed",
    );
  });

  it("falls back to the bare name when the VITE_ value is blank", () => {
    assert.equal(
      getCesiumIonToken({
        VITE_CESIUM_TOKEN: "   ",
        CESIUM_TOKEN: "bare",
      }),
      "bare",
    );
  });
});

describe("getCesiumTerrainAssetId", () => {
  it("returns undefined when env is missing or empty", () => {
    assert.equal(getCesiumTerrainAssetId({}), undefined);
    assert.equal(getCesiumTerrainAssetId({ VITE_CESIUM_TERRAIN_ASSET_ID: "" }), undefined);
    assert.equal(getCesiumTerrainAssetId({ VITE_CESIUM_TERRAIN_ASSET_ID: "   " }), undefined);
    assert.equal(getCesiumTerrainAssetId({ CESIUM_TERRAIN_ASSET_ID: "  " }), undefined);
  });

  it("returns the asset id as a number, trimming whitespace", () => {
    assert.equal(getCesiumTerrainAssetId({ VITE_CESIUM_TERRAIN_ASSET_ID: " 2473055 " }), 2473055);
  });

  it("falls back to the bare CESIUM_TERRAIN_ASSET_ID", () => {
    assert.equal(getCesiumTerrainAssetId({ CESIUM_TERRAIN_ASSET_ID: "754445" }), 754445);
  });

  it("prefers the VITE_ name, and falls back to the bare one when it is blank", () => {
    assert.equal(
      getCesiumTerrainAssetId({ VITE_CESIUM_TERRAIN_ASSET_ID: "1", CESIUM_TERRAIN_ASSET_ID: "2" }),
      1,
    );
    assert.equal(
      getCesiumTerrainAssetId({ VITE_CESIUM_TERRAIN_ASSET_ID: "  ", CESIUM_TERRAIN_ASSET_ID: "2" }),
      2,
    );
  });

  it("rejects values that are not a positive integer id", () => {
    for (const value of ["abc", "0", "-5", "12.5", "1e3x", "NaN"]) {
      assert.equal(
        getCesiumTerrainAssetId({ VITE_CESIUM_TERRAIN_ASSET_ID: value }),
        undefined,
        `expected ${JSON.stringify(value)} to be rejected`,
      );
    }
  });
});

describe("getElevationMeanSeaLevelDefault", () => {
  it("is off unless a deployment turns it on", () => {
    assert.equal(getElevationMeanSeaLevelDefault({}), false);
    assert.equal(getElevationMeanSeaLevelDefault({ VITE_ELEVATION_MEAN_SEA_LEVEL: "0" }), false);
    assert.equal(getElevationMeanSeaLevelDefault({ VITE_ELEVATION_MEAN_SEA_LEVEL: "no" }), false);
  });

  it("accepts 1, true and yes, in either name, trimmed and case-insensitive", () => {
    assert.equal(getElevationMeanSeaLevelDefault({ VITE_ELEVATION_MEAN_SEA_LEVEL: "1" }), true);
    assert.equal(
      getElevationMeanSeaLevelDefault({ VITE_ELEVATION_MEAN_SEA_LEVEL: " TRUE " }),
      true,
    );
    assert.equal(getElevationMeanSeaLevelDefault({ ELEVATION_MEAN_SEA_LEVEL: "yes" }), true);
  });
});
