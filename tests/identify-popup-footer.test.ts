import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import {
  createIdentifyPopupElement,
  formatPopupCoordinates,
  resolveIdentifyPopupFooter,
  type IdentifyPopupExtras,
} from "../packages/map/src/feature-popup";
import { featureExportFileStem } from "../apps/geolibre-desktop/src/lib/vector-export";

// The popup footer the geoportal's users know: the clicked coordinate with
// a copy button, the ground height there, and the feature's own download.

const original = {
  window: globalThis.window,
  document: globalThis.document,
};
const clipboard: { writeText?: (text: string) => Promise<void> } = {};
afterEach(() => {
  Object.assign(globalThis, original);
  delete clipboard.writeText;
});
// `navigator` is a getter on globalThis in Node: swap its clipboard instead.
Object.defineProperty(globalThis.navigator, "clipboard", {
  configurable: true,
  get: () => clipboard,
});

function dom() {
  const { window, document } = parseHTML("<html><body></body></html>");
  Object.assign(globalThis, { window, document });
  return document;
}

const LABELS = {
  copyCoordinates: "Copy",
  copied: "Copied",
  download: "Download",
  height: "h",
  heightSeaLevel: "h (m.s.l.)",
};

describe("resolveIdentifyPopupFooter", () => {
  it("is nothing without extras, and coordinates only without a feature", () => {
    assert.equal(resolveIdentifyPopupFooter(undefined, null, "l", null), undefined);
    const extras: IdentifyPopupExtras = {
      labels: LABELS,
      downloadFeature: () => true,
    };
    const footer = resolveIdentifyPopupFooter(
      extras,
      { lng: 11, lat: 44, alt: null },
      "l",
      null,
      3,
    );
    assert.ok(footer);
    assert.deepEqual(footer.location, { lng: 11, lat: 44 });
    assert.equal(footer.onDownload, undefined, "a tiles-mode hit has no feature to save");
  });

  it("refers the height to sea level through the host, or hides it while the geoid is not ready", () => {
    const base: IdentifyPopupExtras = { labels: LABELS };
    let footer = resolveIdentifyPopupFooter(base, { lng: 11, lat: 44, alt: 100 }, "l", null);
    assert.deepEqual(footer?.location, { lng: 11, lat: 44, alt: 100, seaLevel: false });
    const msl: IdentifyPopupExtras = {
      labels: LABELS,
      adjustHeight: (_lng, _lat, alt) => ({ alt: alt - 46.5, seaLevel: true }),
    };
    footer = resolveIdentifyPopupFooter(msl, { lng: 11, lat: 44, alt: 100 }, "l", null);
    assert.deepEqual(footer?.location, { lng: 11, lat: 44, alt: 53.5, seaLevel: true });
    const pending: IdentifyPopupExtras = { labels: LABELS, adjustHeight: () => null };
    footer = resolveIdentifyPopupFooter(pending, { lng: 11, lat: 44, alt: 100 }, "l", null);
    assert.deepEqual(footer?.location, { lng: 11, lat: 44 });
  });

  it("hands the feature and its id to the download", () => {
    const calls: unknown[] = [];
    const extras: IdentifyPopupExtras = {
      labels: LABELS,
      downloadFeature: (layerId, feature, id) => {
        calls.push([layerId, feature.properties, id]);
        return true;
      },
    };
    const feature = { type: "Feature" as const, geometry: null, properties: { a: 1 } };
    const footer = resolveIdentifyPopupFooter(extras, null, "roads", feature, "f7");
    footer?.onDownload?.();
    assert.deepEqual(calls, [["roads", { a: 1 }, "f7"]]);
  });
});

describe("the popup footer element", () => {
  it("shows the coordinate and height, copies on click, and offers the download", async () => {
    const document = dom();
    const copied: string[] = [];
    clipboard.writeText = async (text: string) => void copied.push(text);
    let downloads = 0;
    const root = createIdentifyPopupElement("Roads", { name: "A1" }, 7, {
      footer: {
        location: { lng: 11.123456, lat: 44.654321, alt: 53.56, seaLevel: true },
        labels: LABELS,
        onDownload: () => {
          downloads += 1;
        },
      },
    });
    document.body.appendChild(root);
    const footer = root.querySelector(".geolibre-identify-popup-footer");
    assert.ok(footer);
    const text = footer.querySelector("span")?.textContent ?? "";
    assert.ok(text.startsWith("44.65432, 11.12346"), text);
    assert.ok(text.includes("h (m.s.l.) 53.6 m"), text);
    const copy = footer.querySelector<HTMLButtonElement>(".geolibre-identify-popup-copy");
    assert.ok(copy);
    assert.equal(copy.title, "Copy");
    copy.dispatchEvent(new (globalThis.window as Window).Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(copied, ["44.65432, 11.12346, 53.6 m"]);
    const download = footer.querySelector<HTMLButtonElement>(".geolibre-identify-popup-download");
    assert.ok(download);
    assert.equal(download.textContent, "Download");
    download.dispatchEvent(new (globalThis.window as Window).Event("click", { bubbles: true }));
    assert.equal(downloads, 1);
  });

  it("leaves the popup alone when there is neither a location nor a download", () => {
    dom();
    const root = createIdentifyPopupElement("Roads", {}, undefined, {
      footer: { labels: LABELS },
    });
    assert.equal(root.querySelector(".geolibre-identify-popup-footer"), null);
  });

  it("formats coordinates lat-first to 5 decimals, height to 1", () => {
    assert.equal(formatPopupCoordinates(11.123456789, 44.1), "44.10000, 11.12346");
    assert.equal(formatPopupCoordinates(11, 44, 12.34), "44.00000, 11.00000, 12.3 m");
    assert.equal(formatPopupCoordinates(11, 44, null), "44.00000, 11.00000");
  });
});

describe("featureExportFileStem", () => {
  it("joins the layer and the feature id, without repeating a suffix or keeping an extension", () => {
    assert.equal(featureExportFileStem("roads", 12), "roads_12");
    assert.equal(featureExportFileStem("roads_12", 12), "roads_12");
    assert.equal(featureExportFileStem("roads-12", "12"), "roads-12");
    assert.equal(featureExportFileStem("tracks.gpx", "a b"), "tracks_a-b");
    assert.equal(featureExportFileStem("roads", undefined), "roads");
    assert.equal(featureExportFileStem("roads_", ""), "roads");
    assert.equal(featureExportFileStem("12", 12), "12");
  });
});
