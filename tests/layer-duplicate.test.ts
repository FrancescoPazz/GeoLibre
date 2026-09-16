import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, useAppStore, type GeoLibreLayer } from "@geolibre/core";

function layer(id: string, patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id,
    name: id,
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [11, 44] },
          properties: { a: 1 },
        },
      ],
    },
    ...patch,
  };
}

describe("duplicateLayer", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "Duplicate" });
  });

  it("adds an independent copy right after the original, named apart, and selects it", () => {
    const store = useAppStore.getState();
    store.addLayer(layer("Roads", { opacity: 0.4, groupId: "g1" }));
    store.addLayer(layer("Rivers"));
    const copyId = useAppStore.getState().duplicateLayer("Roads");
    assert.ok(copyId && copyId !== "Roads");
    const { layers, selectedLayerId } = useAppStore.getState();
    assert.deepEqual(
      layers.map((l) => l.name),
      ["Roads", "Roads (2)", "Rivers"],
    );
    const copy = layers[1];
    assert.equal(selectedLayerId, copy.id);
    assert.equal(copy.opacity, 0.4);
    assert.equal(copy.groupId, "g1");
    // A deep copy: the feature arrays and style objects are distinct.
    const original = layers[0];
    assert.notEqual(copy.geojson, original.geojson);
    assert.notEqual(copy.style, original.style);
    assert.deepEqual(copy.geojson, original.geojson);
  });

  it("copies the last layer to the end, and numbers a third copy (3)", () => {
    const store = useAppStore.getState();
    store.addLayer(layer("Roads"));
    useAppStore.getState().duplicateLayer("Roads");
    const second = useAppStore.getState().layers[1];
    useAppStore.getState().duplicateLayer(second.id);
    assert.deepEqual(
      useAppStore.getState().layers.map((l) => l.name),
      ["Roads", "Roads (2)", "Roads (3)"],
    );
  });

  it("refuses a missing layer and a plugin-owned native layer", () => {
    const store = useAppStore.getState();
    store.addLayer(layer("Native", { metadata: { externalNativeLayer: true } }));
    assert.equal(useAppStore.getState().duplicateLayer("nope"), null);
    assert.equal(useAppStore.getState().duplicateLayer("Native"), null);
    assert.equal(useAppStore.getState().layers.length, 1);
  });
});
