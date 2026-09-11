import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getBranding, isBrandAssetUrl } from "@geolibre/core";

describe("getBranding", () => {
  it("is empty without any brand variable", () => {
    assert.deepEqual(getBranding({}), {});
  });

  it("reads name, logo, link, favicon and accent in either spelling, trimmed", () => {
    assert.deepEqual(
      getBranding({
        BRAND_NAME: " Geoportale ",
        VITE_BRAND_LOGO_URL: "/branding/logo.svg",
        BRAND_LOGO_LINK: "https://example.org/",
        VITE_BRAND_FAVICON_URL: "https://cdn.example.org/favicon.ico",
        BRAND_ACCENT_COLOR: "#519AC2",
      }),
      {
        name: "Geoportale",
        logoUrl: "/branding/logo.svg",
        logoLink: "https://example.org/",
        faviconUrl: "https://cdn.example.org/favicon.ico",
        accentColor: "#519ac2",
      },
    );
  });

  it("drops values that are not what the field wants", () => {
    assert.deepEqual(
      getBranding({
        BRAND_LOGO_URL: "javascript:alert(1)",
        BRAND_LOGO_LINK: "/relative-is-not-a-link",
        BRAND_FAVICON_URL: "data:image/png;base64,AAAA",
        BRAND_ACCENT_COLOR: "blue",
      }),
      {},
    );
    assert.deepEqual(getBranding({ BRAND_ACCENT_COLOR: "#abc" }), {});
  });
});

describe("isBrandAssetUrl", () => {
  it("accepts http(s) and same-site paths, nothing else", () => {
    assert.equal(isBrandAssetUrl("https://example.org/logo.png"), true);
    assert.equal(isBrandAssetUrl("http://example.org/logo.png"), true);
    assert.equal(isBrandAssetUrl("/logo.png"), true);
    assert.equal(isBrandAssetUrl("./logo.png"), true);
    assert.equal(isBrandAssetUrl("branding/logo.png"), true);
    assert.equal(isBrandAssetUrl("javascript:alert(1)"), false);
    assert.equal(isBrandAssetUrl("data:image/svg+xml,<svg/>"), false);
    assert.equal(isBrandAssetUrl("file:///etc/passwd"), false);
  });
});
