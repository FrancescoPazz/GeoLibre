import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getCesiumIonToken,
  getCesiumTerrainAssetId,
  getElevationMeanSeaLevelDefault,
  getGlobeAppearanceDefaults,
  getRelatedMaps,
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

describe("getGlobeAppearanceDefaults", () => {
  it("is empty when nothing is set, so Cesium keeps its own defaults", () => {
    assert.deepEqual(getGlobeAppearanceDefaults({}), {});
  });

  it("reads a colour, a translucency flag or alpha, and a collision flag", () => {
    assert.deepEqual(
      getGlobeAppearanceDefaults({
        GLOBE_COLOR: "#1E2A3B",
        GLOBE_TRANSLUCENCY: "true",
        GLOBE_COLLISION_DETECTION: "0",
      }),
      { color: "#1e2a3b", translucency: 0.5, collisionDetection: false },
    );
    assert.deepEqual(getGlobeAppearanceDefaults({ VITE_GLOBE_TRANSLUCENCY: "0.3" }), {
      translucency: 0.3,
    });
    assert.deepEqual(getGlobeAppearanceDefaults({ GLOBE_TRANSLUCENCY: "no" }), {
      translucency: 1,
    });
    assert.deepEqual(getGlobeAppearanceDefaults({ VITE_GLOBE_COLLISION_DETECTION: "yes" }), {
      collisionDetection: true,
    });
  });

  it("ignores a colour that is not #rrggbb, an alpha out of range, and junk", () => {
    assert.deepEqual(
      getGlobeAppearanceDefaults({
        GLOBE_COLOR: "blue",
        GLOBE_TRANSLUCENCY: "7",
        GLOBE_COLLISION_DETECTION: "maybe",
      }),
      {},
    );
  });
});

describe("getRelatedMaps", () => {
  it("reads the JSON list, keeping only titled entries with an http(s) url", () => {
    const raw = JSON.stringify([
      {
        title: " Portale A ",
        url: "https://a.example/",
        description: " Sister portal ",
        imageUrl: "https://a.example/a.png",
      },
      { title: "No url", url: "ftp://x" },
      { url: "https://b.example/" },
      { title: "B", url: "http://b.example", imageUrl: "data:image/png;base64,xx" },
      "junk",
    ]);
    assert.deepEqual(getRelatedMaps({ RELATED_MAPS: raw }), [
      {
        title: "Portale A",
        url: "https://a.example/",
        description: "Sister portal",
        imageUrl: "https://a.example/a.png",
      },
      { title: "B", url: "http://b.example" },
    ]);
  });

  it("is empty when unset, malformed, or not an array", () => {
    assert.deepEqual(getRelatedMaps({}), []);
    assert.deepEqual(getRelatedMaps({ VITE_RELATED_MAPS: "{not json" }), []);
    assert.deepEqual(getRelatedMaps({ RELATED_MAPS: "{}" }), []);
  });
});
