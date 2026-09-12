import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  DEFAULT_LAYER_STYLE,
  GeoportalLoginError,
  USE_AUTHENTICATION_METADATA_KEY,
  basicAuthorization,
  canAccessGroups,
  createEmptyProject,
  getGeoportalLoginConfig,
  getGeoportalProfiles,
  getGeoportalSession,
  isFeatureAllowedByProfile,
  parseFirstGroup,
  parseProject,
  projectFromStore,
  serializeProject,
  setGeoportalSession,
  signInGeoportal,
  signOutGeoportal,
  subscribeGeoportalSession,
  type GeoLibreLayer,
} from "@geolibre/core";
import {
  allowsCredentials,
  layerRequestHosts,
  requestHeadersByHost,
  transformRequestWithHeaders,
} from "../packages/map/src/request-credentials";

// The geoportal's own sign-in (a Basic header checked against a GeoServer
// resource; the first <group> of the answer is the profile) and what hangs
// off it: group-restricted catalog members, per-profile features, and the
// Authorization header protected services are asked with — on the 2D map
// through MapLibre's request transform, and never in a saved project.

const LOGIN = { url: "https://gis.example.org/geoserver/rest/about/system-status" };
const PROFILES = JSON.stringify({
  Cittadino: { allowed: ["QueryData"], isAdmin: false },
  Admin: { allowed: [], isAdmin: true },
});

function geoserverXml(group?: string) {
  return `<?xml version="1.0"?><user><userName>x</userName>${group ? `<groups><group>${group}</group><group>other</group></groups>` : ""}</user>`;
}

afterEach(() => signOutGeoportal());

describe("sign-in", () => {
  it("builds a UTF-8 safe Basic header and reads the first group of the answer", () => {
    assert.equal(basicAuthorization("user", "pass"), `Basic ${btoa("user:pass")}`);
    assert.equal(
      basicAuthorization("città", "p"),
      `Basic ${Buffer.from("città:p", "utf8").toString("base64")}`,
    );
    assert.equal(parseFirstGroup(geoserverXml("Consultatore")), "Consultatore");
    assert.equal(parseFirstGroup(geoserverXml()), null);
    assert.equal(parseFirstGroup("<ns:group>Tecnico</ns:group>"), "Tecnico");
    assert.equal(parseFirstGroup("not xml"), null);
  });

  it("signs in on a 2xx answer, substituting <username> in the URL, and publishes the session", async () => {
    const asked: Array<{ url: string; auth: string | null }> = [];
    const fake: typeof globalThis.fetch = async (input, init) => {
      asked.push({ url: String(input), auth: new Headers(init?.headers).get("Authorization") });
      return new Response(geoserverXml("Cittadino"), { status: 200 });
    };
    let notified = 0;
    const unsubscribe = subscribeGeoportalSession(() => {
      notified += 1;
    });
    const session = await signInGeoportal(
      { url: "https://gis.example.org/geoserver/rest/security/usergroup/user/<username>.xml" },
      "mario rossi",
      "secret",
      fake,
    );
    unsubscribe();
    assert.equal(
      asked[0].url,
      "https://gis.example.org/geoserver/rest/security/usergroup/user/mario%20rossi.xml",
    );
    assert.equal(asked[0].auth, basicAuthorization("mario rossi", "secret"));
    assert.deepEqual(session, {
      username: "mario rossi",
      authorization: asked[0].auth,
      profile: "Cittadino",
    });
    assert.equal(getGeoportalSession(), session);
    assert.equal(notified, 1);
    signOutGeoportal();
    assert.equal(getGeoportalSession().authorization, null);
  });

  it("tells invalid credentials, a connection failure and other errors apart, leaving the session alone", async () => {
    const status =
      (code: number): typeof globalThis.fetch =>
      async () =>
        new Response("", { status: code });
    await assert.rejects(
      signInGeoportal(LOGIN, "u", "p", status(401)),
      (e: unknown) => e instanceof GeoportalLoginError && e.reason === "invalid-credentials",
    );
    await assert.rejects(
      signInGeoportal(LOGIN, "u", "p", status(403)),
      (e: unknown) => e instanceof GeoportalLoginError && e.reason === "invalid-credentials",
    );
    await assert.rejects(
      signInGeoportal(LOGIN, "u", "p", status(500)),
      (e: unknown) => e instanceof GeoportalLoginError && e.reason === "generic",
    );
    const down: typeof globalThis.fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    await assert.rejects(
      signInGeoportal(LOGIN, "u", "p", down),
      (e: unknown) => e instanceof GeoportalLoginError && e.reason === "connection",
    );
    assert.equal(getGeoportalSession().authorization, null);
  });

  it("reads the login endpoint and the profile definitions from the environment", () => {
    assert.equal(getGeoportalLoginConfig({}), undefined);
    assert.deepEqual(getGeoportalLoginConfig({ LOGIN_SERVICE_URL: ` ${LOGIN.url} ` }), LOGIN);
    assert.equal(getGeoportalLoginConfig({ VITE_LOGIN_SERVICE_URL: "ftp://x" }), undefined);
    assert.deepEqual(getGeoportalProfiles({}), {});
    assert.deepEqual(getGeoportalProfiles({ VITE_USER_PROFILES: PROFILES }), {
      Cittadino: { allowed: ["QueryData"], isAdmin: false },
      Admin: { allowed: [], isAdmin: true },
    });
    assert.deepEqual(getGeoportalProfiles({ USER_PROFILES: "{not json" }), {});
  });
});

describe("what the session gates", () => {
  it("allows every feature without profile definitions, and by profile with them", () => {
    const env = { VITE_USER_PROFILES: PROFILES };
    assert.equal(isFeatureAllowedByProfile("QueryData", {}), true, "no definitions: open");
    assert.equal(isFeatureAllowedByProfile("QueryData", env), false, "signed out: closed");
    setGeoportalSession({ username: "a", authorization: "Basic x", profile: "Cittadino" });
    assert.equal(isFeatureAllowedByProfile("QueryData", env), true);
    assert.equal(isFeatureAllowedByProfile("DownloadQueryData", env), false);
    setGeoportalSession({ username: "b", authorization: "Basic y", profile: "Admin" });
    assert.equal(isFeatureAllowedByProfile("DownloadQueryData", env), true, "admin: everything");
    setGeoportalSession({ username: "c", authorization: "Basic z", profile: "Unknown" });
    assert.equal(
      isFeatureAllowedByProfile("QueryData", env),
      false,
      "a group with no definition: nothing",
    );
  });

  it("opens unrestricted catalog members to everyone and restricted ones to a listed group", () => {
    assert.equal(canAccessGroups(undefined), true);
    assert.equal(canAccessGroups(["Tecnici"]), false);
    setGeoportalSession({ username: "a", authorization: "Basic x", profile: "Tecnici" });
    assert.equal(canAccessGroups(["Tecnici", "Admin"]), true);
    assert.equal(canAccessGroups(["Admin"]), false);
    setGeoportalSession({ username: "a", authorization: "Basic x", profile: null });
    assert.equal(canAccessGroups(["Tecnici"]), false, "signed in without a group is not a member");
  });
});

describe("request headers on the 2D map", () => {
  const layer = (over: Partial<GeoLibreLayer>): GeoLibreLayer => ({
    id: "l",
    name: "L",
    type: "wms",
    source: {},
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    ...over,
  });

  it("keys headers by the hosts a layer fetches from, https or loopback only", () => {
    assert.equal(allowsCredentials("https://gis.example.org/wms"), true);
    assert.equal(allowsCredentials("http://localhost:8080/wms"), true);
    assert.equal(allowsCredentials("http://gis.example.org/wms"), false);
    assert.equal(allowsCredentials("not a url"), false);
    assert.deepEqual(
      layerRequestHosts(
        layer({
          source: {
            tiles: ["https://a.example/{z}/{x}/{y}", "https://b.example/t"],
            url: "https://a.example/wms",
          },
          sourcePath: "https://c.example/x",
        }),
      ),
      ["a.example", "b.example", "c.example"],
    );
    const byHost = requestHeadersByHost([
      layer({
        source: { tiles: ["https://a.example/{z}"], requestHeaders: { Authorization: "Basic 1" } },
      }),
      layer({ source: { tiles: ["https://a.example/other"], requestHeaders: { "X-Extra": "y" } } }),
      layer({
        source: {
          tiles: ["http://plain.example/{z}"],
          requestHeaders: { Authorization: "Basic 2" },
        },
      }),
      layer({ source: { tiles: ["https://none.example/{z}"] } }),
    ]);
    assert.deepEqual([...byHost.keys()], ["a.example"]);
    assert.deepEqual(byHost.get("a.example"), { Authorization: "Basic 1", "X-Extra": "y" });
  });

  it("transforms only requests to a registered host, and only over https", () => {
    const byHost = new Map([["a.example", { Authorization: "Basic 1" }]]);
    assert.deepEqual(transformRequestWithHeaders(byHost, "https://a.example/1/2/3.png"), {
      url: "https://a.example/1/2/3.png",
      headers: { Authorization: "Basic 1" },
    });
    assert.equal(transformRequestWithHeaders(byHost, "https://b.example/1.png"), undefined);
    assert.equal(
      transformRequestWithHeaders(byHost, "http://a.example/1.png"),
      undefined,
      "plaintext never carries it",
    );
    assert.equal(transformRequestWithHeaders(byHost, "/relative"), undefined);
    assert.equal(transformRequestWithHeaders(new Map(), "https://a.example/1.png"), undefined);
  });

  it("is stripped from a saved project when the layer is authenticated by the session", () => {
    const project = createEmptyProject("p");
    project.layers = [
      layer({
        id: "protected",
        source: {
          url: "https://gis.example.org/wms",
          tiles: ["https://gis.example.org/wms?x"],
          requestHeaders: { Authorization: "Basic session" },
        },
        metadata: { [USE_AUTHENTICATION_METADATA_KEY]: true },
      }),
      layer({
        id: "own",
        source: {
          url: "https://other.example/wms",
          tiles: ["https://other.example/wms?x"],
          requestHeaders: { "X-Api-Key": "mine" },
        },
      }),
    ];
    const saved = parseProject(
      serializeProject(
        projectFromStore({
          projectName: project.name,
          mapView: project.mapView,
          basemapStyleUrl: project.basemapStyleUrl,
          basemapVisible: true,
          basemapOpacity: 1,
          layers: project.layers,
          preferences: project.preferences,
          metadata: {},
        }),
      ),
    );
    assert.equal(
      saved.layers[0].source.requestHeaders,
      undefined,
      "the session header is not saved",
    );
    assert.equal(saved.layers[0].metadata[USE_AUTHENTICATION_METADATA_KEY], true, "the flag is");
    assert.deepEqual(
      saved.layers[1].source.requestHeaders,
      { "X-Api-Key": "mine" },
      "a layer's own headers still are",
    );
  });
});
