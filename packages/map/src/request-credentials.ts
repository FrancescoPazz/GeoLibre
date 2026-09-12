import type { GeoLibreLayer } from "@geolibre/core";

/**
 * Credential-bearing request headers a layer asks for (`source.requestHeaders`)
 * and where they may go.
 *
 * The globe has honoured `requestHeaders` through `Cesium.Resource` for a
 * while; the 2D map needs MapLibre's `transformRequest`, which sees every
 * URL the map fetches and has to decide per request. The decision is made
 * once per layer sync, as a host → headers table, so the per-request hook is
 * a lookup rather than a scan of the layer list.
 */

/**
 * Whether credential-bearing request headers may be sent to this URL.
 *
 * The scheme is read off a parsed URL rather than matched as a prefix, so an
 * unusually-cased `HTTPS://` from a hand-authored or MCP-generated project is
 * normalized instead of being misread as plaintext. A relative or unparseable
 * URL throws and is refused, matching `isAllowedPluginManifestUrl` in
 * `@geolibre/core`.
 */
export function allowsCredentials(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol === "https:") return true;
    // Loopback over http so a local dev tile server still works.
    return (
      protocol === "http:" &&
      (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

/** A layer's request headers, when it has any. */
export function layerRequestHeaders(
  layer: Pick<GeoLibreLayer, "source">,
): Record<string, string> | null {
  const raw = layer.source.requestHeaders;
  if (!raw || typeof raw !== "object") return null;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value) headers[name] = value;
  }
  return Object.keys(headers).length ? headers : null;
}

/** The absolute URLs a layer's tiles or service come from. */
export function layerRequestUrls(layer: Pick<GeoLibreLayer, "source" | "sourcePath">): string[] {
  const candidates: unknown[] = [
    ...(Array.isArray(layer.source.tiles) ? layer.source.tiles : []),
    layer.source.url,
    layer.sourcePath,
  ];
  const urls: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    try {
      if (new URL(candidate).host) urls.push(candidate);
    } catch {
      // A relative template or a custom protocol carries no host to key on.
    }
  }
  return urls;
}

/** The hosts a layer's tiles or service come from. */
export function layerRequestHosts(layer: Pick<GeoLibreLayer, "source" | "sourcePath">): string[] {
  return [...new Set(layerRequestUrls(layer).map((url) => new URL(url).host))];
}

/**
 * Request headers by host for every layer that carries some and whose
 * service allows credentials (https, or http on loopback). Two layers on one
 * host merge, the later one winning a clash — a session that authenticates
 * a whole server is the case this serves.
 */
export function requestHeadersByHost(
  layers: readonly Pick<GeoLibreLayer, "source" | "sourcePath">[],
): Map<string, Record<string, string>> {
  const byHost = new Map<string, Record<string, string>>();
  for (const layer of layers) {
    const headers = layerRequestHeaders(layer);
    if (!headers) continue;
    for (const url of layerRequestUrls(layer)) {
      if (!allowsCredentials(url)) continue;
      const { host } = new URL(url);
      byHost.set(host, { ...(byHost.get(host) ?? {}), ...headers });
    }
  }
  return byHost;
}

/**
 * The MapLibre `transformRequest` answer for `url`: the headers registered
 * for its host, provided the URL itself allows credentials (an https host
 * can be asked over plain http by a hand-edited template; that request gets
 * nothing). Undefined leaves the request alone.
 */
export function transformRequestWithHeaders(
  byHost: ReadonlyMap<string, Record<string, string>>,
  url: string,
): { url: string; headers: Record<string, string> } | undefined {
  if (byHost.size === 0) return undefined;
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return undefined;
  }
  const headers = byHost.get(host);
  if (!headers || !allowsCredentials(url)) return undefined;
  return { url, headers };
}
