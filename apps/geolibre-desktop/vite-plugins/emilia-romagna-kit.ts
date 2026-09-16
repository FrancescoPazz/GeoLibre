/**
 * Serve the Emilia-Romagna deployment kit under the same URL prefixes Docker
 * mounts into nginx (`/init`, `/projects`, `/branding`) so `npm run dev` can
 * load `VITE_CATALOG_URLS=/init/catalogo-rapido.json` without compose.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { Connect, Plugin, ViteDevServer } from "vite";

const CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".gif": "image/gif",
};

export interface KitMount {
  /** URL prefix with a leading slash, no trailing slash (e.g. `/init`). */
  urlPrefix: string;
  /** Absolute directory on disk. */
  rootDir: string;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Resolve a request under `urlPrefix` to a file inside `rootDir`, or null when
 * the path escapes the root or is not a regular file.
 */
export function resolveKitFile(urlPath: string, mount: KitMount): string | null {
  if (urlPath !== mount.urlPrefix && !urlPath.startsWith(`${mount.urlPrefix}/`)) {
    return null;
  }
  const relative = urlPath.slice(mount.urlPrefix.length).replace(/^\/+/, "");
  if (!relative || relative.includes("\0")) return null;
  const candidate = path.resolve(mount.rootDir, relative);
  const rootResolved = path.resolve(mount.rootDir);
  if (candidate !== rootResolved && !candidate.startsWith(`${rootResolved}${path.sep}`)) {
    return null;
  }
  const stat = statSync(candidate, { throwIfNoEntry: false });
  return stat?.isFile() ? candidate : null;
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

export function kitStaticMiddleware(mounts: KitMount[]): Connect.NextHandleFunction {
  return (req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }
    const pathname = safeDecodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    for (const mount of mounts) {
      if (!existsSync(mount.rootDir)) continue;
      const filePath = resolveKitFile(pathname, mount);
      if (!filePath) continue;
      const size = statSync(filePath).size;
      res.statusCode = 200;
      res.setHeader("content-type", contentTypeFor(filePath));
      res.setHeader("content-length", String(size));
      res.setHeader("cache-control", "no-cache");
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      createReadStream(filePath).pipe(res);
      return;
    }
    next();
  };
}

function attachKitMiddleware(server: { middlewares: Connect.Server }, mounts: KitMount[]): void {
  // Register early so kit assets are not swallowed by the SPA fallback.
  server.middlewares.use(kitStaticMiddleware(mounts));
}

/** Absolute mounts for the three kit folders Docker exposes. */
export function emiliaRomagnaKitMounts(kitRoot: string): KitMount[] {
  return [
    { urlPrefix: "/init", rootDir: path.join(kitRoot, "init") },
    { urlPrefix: "/projects", rootDir: path.join(kitRoot, "projects") },
    { urlPrefix: "/branding", rootDir: path.join(kitRoot, "branding") },
  ];
}

/**
 * Dev/preview static mounts for `deploy/emilia-romagna/{init,projects,branding}`.
 *
 * @param kitRoot - Absolute path to `deploy/emilia-romagna`.
 */
export function emiliaRomagnaKit(kitRoot: string): Plugin {
  const mounts = emiliaRomagnaKitMounts(kitRoot);

  return {
    name: "geolibre-emilia-romagna-kit",
    configureServer(server: ViteDevServer) {
      attachKitMiddleware(server, mounts);
    },
    configurePreviewServer(server) {
      attachKitMiddleware(server, mounts);
    },
  };
}
