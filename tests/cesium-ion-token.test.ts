import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getCesiumIonToken,
  getCesiumTerrainAssetId,
  getElevationMeanSeaLevelDefault,
  getFeedbackTarget,
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

describe("getFeedbackTarget", () => {
  it("is unset without a configured channel, or with one that is not a page or an address", () => {
    assert.equal(getFeedbackTarget({}), undefined);
    assert.equal(getFeedbackTarget({ VITE_FEEDBACK_URL: "   " }), undefined);
    assert.equal(getFeedbackTarget({ VITE_FEEDBACK_URL: "javascript:alert(1)" }), undefined);
    assert.equal(getFeedbackTarget({ VITE_FEEDBACK_URL: "not a url" }), undefined);
    assert.equal(getFeedbackTarget({ VITE_FEEDBACK_URL: "mailto:" }), undefined);
  });

  it("keeps an http(s) page as a web target", () => {
    assert.deepEqual(getFeedbackTarget({ FEEDBACK_URL: "https://example.org/feedback " }), {
      kind: "web",
      href: "https://example.org/feedback",
    });
  });

  it("turns a mailto: address into a pre-addressed message with the subject filled in", () => {
    assert.deepEqual(
      getFeedbackTarget({
        VITE_FEEDBACK_URL: "mailto:mappe@example.org",
        VITE_FEEDBACK_SUBJECT: "Geoportale 3D — segnalazione",
      }),
      {
        kind: "mailto",
        href: "mailto:mappe@example.org?subject=Geoportale+3D+%E2%80%94+segnalazione",
      },
    );
    assert.deepEqual(getFeedbackTarget({ FEEDBACK_URL: "mappe@example.org" }), {
      kind: "mailto",
      href: "mailto:mappe@example.org",
    });
  });

  it("does not override a subject the address already carries", () => {
    assert.deepEqual(
      getFeedbackTarget({
        FEEDBACK_URL: "mailto:mappe@example.org?subject=Fixed&cc=x@example.org",
        FEEDBACK_SUBJECT: "Ignored",
      }),
      { kind: "mailto", href: "mailto:mappe@example.org?subject=Fixed&cc=x%40example.org" },
    );
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
