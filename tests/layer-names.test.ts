import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  baseLayerName,
  sameBaseLayerName,
  uniqueLayerName,
} from "../packages/core/src/layer-names";

describe("uniqueLayerName", () => {
  it("keeps a name nothing else uses", () => {
    assert.equal(uniqueLayerName("Roads", ["Rivers"]), "Roads");
    assert.equal(uniqueLayerName("Roads", []), "Roads");
  });

  it("numbers a second copy from (2) and fills the lowest gap", () => {
    assert.equal(uniqueLayerName("Roads", ["Roads"]), "Roads (2)");
    assert.equal(uniqueLayerName("Roads", ["Roads", "Roads (2)"]), "Roads (3)");
    assert.equal(uniqueLayerName("Roads", ["Roads", "Roads (3)"]), "Roads (2)");
  });

  it("does not stack suffixes when a copy is copied", () => {
    assert.equal(uniqueLayerName("Roads (2)", ["Roads", "Roads (2)"]), "Roads (3)");
    assert.equal(uniqueLayerName("Roads (2)", ["Roads (2)"]), "Roads (3)");
  });

  it("accepts a Set as the taken names", () => {
    const taken = new Set(["Roads"]);
    assert.equal(uniqueLayerName("Roads", taken), "Roads (2)");
  });

  it("leaves a parenthesised word that is not a counter alone", () => {
    assert.equal(uniqueLayerName("Roads (editable)", ["Roads (editable)"]), "Roads (editable) (2)");
  });
});

describe("baseLayerName / sameBaseLayerName", () => {
  it("strips only a trailing numeric counter", () => {
    assert.equal(baseLayerName("Roads (2)"), "Roads");
    assert.equal(baseLayerName("Roads (12)"), "Roads");
    assert.equal(baseLayerName("Roads"), "Roads");
    assert.equal(baseLayerName("Roads (editable)"), "Roads (editable)");
  });

  it("matches a multi-layer file's entry to its renamed layer", () => {
    assert.ok(sameBaseLayerName("Roads", "Roads (2)"));
    assert.ok(sameBaseLayerName("Roads (3)", "Roads (2)"));
    assert.ok(!sameBaseLayerName("Roads", "Rivers"));
  });
});
