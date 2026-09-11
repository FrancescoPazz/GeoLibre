import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deploymentGeocodingPreference,
  isDefaultGeocodingPreference,
} from "../apps/geolibre-desktop/src/lib/deployment-geocoder";

describe("isDefaultGeocodingPreference", () => {
  it("is true only for untouched Nominatim with no key, endpoints or email", () => {
    assert.equal(isDefaultGeocodingPreference({ providerId: "nominatim", apiKeys: {} }), true);
    assert.equal(
      isDefaultGeocodingPreference({ providerId: "nominatim", apiKeys: { mapbox: "" } }),
      true,
    );
    assert.equal(isDefaultGeocodingPreference({ providerId: "rer", apiKeys: {} }), false);
    assert.equal(
      isDefaultGeocodingPreference({ providerId: "nominatim", apiKeys: { nominatim: "k" } }),
      false,
    );
    assert.equal(
      isDefaultGeocodingPreference({
        providerId: "nominatim",
        apiKeys: {},
        forwardEndpoint: "https://nominatim.example.org/search",
      }),
      false,
    );
    assert.equal(
      isDefaultGeocodingPreference({ providerId: "nominatim", apiKeys: {}, email: "me@x.org" }),
      false,
    );
  });
});

describe("deploymentGeocodingPreference", () => {
  it("is null when the deployment names no provider", () => {
    assert.equal(deploymentGeocodingPreference({}, {}), null);
    assert.equal(deploymentGeocodingPreference({ VITE_GEOCODER_API_KEY: "k" }, {}), null);
  });

  it("builds the preference the deployment names, key under the provider id", () => {
    assert.deepEqual(
      deploymentGeocodingPreference(
        {
          VITE_GEOCODER_PROVIDER: "rer",
          VITE_GEOCODER_API_KEY: "user:secret",
          VITE_GEOCODER_ENDPOINT: "https://proxy.example.org/egeocoding",
        },
        {},
      ),
      {
        providerId: "rer",
        apiKeys: { rer: "user:secret" },
        forwardEndpoint: "https://proxy.example.org/egeocoding",
        reverseEndpoint: undefined,
        email: undefined,
      },
    );
  });

  it("prefers the deployment over the build, and falls back to the build", () => {
    assert.equal(
      deploymentGeocodingPreference(
        { VITE_GEOCODER_PROVIDER: "cartociudad" },
        { VITE_GEOCODER_PROVIDER: "rer" },
      )?.providerId,
      "cartociudad",
    );
    assert.equal(
      deploymentGeocodingPreference({}, { VITE_GEOCODER_PROVIDER: "rer" })?.providerId,
      "rer",
    );
    assert.equal(
      deploymentGeocodingPreference({ VITE_GEOCODER_PROVIDER: "bogus" }, {})?.providerId,
      "nominatim",
      "an unknown provider normalises to the default",
    );
  });
});
