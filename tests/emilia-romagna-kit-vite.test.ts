import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  emiliaRomagnaKitMounts,
  kitStaticMiddleware,
  resolveKitFile,
} from "../apps/geolibre-desktop/vite-plugins/emilia-romagna-kit";

const KIT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../deploy/emilia-romagna",
);

describe("emilia-romagna kit vite mounts", () => {
  it("resolves catalogo-rapido.json under /init and rejects path escape", () => {
    const mounts = emiliaRomagnaKitMounts(KIT_ROOT);
    const init = mounts.find((m) => m.urlPrefix === "/init");
    assert.ok(init);
    const file = resolveKitFile("/init/catalogo-rapido.json", init);
    assert.equal(file, path.join(KIT_ROOT, "init", "catalogo-rapido.json"));
    assert.equal(resolveKitFile("/init/../projects/geoportale.geolibre.json", init), null);
    assert.equal(resolveKitFile("/init/", init), null);
    assert.equal(resolveKitFile("/deploy/emilia-romagna/init/catalogo-rapido.json", init), null);
  });

  it("serves the catalog JSON over the kit middleware", async () => {
    const mounts = emiliaRomagnaKitMounts(KIT_ROOT);
    const middleware = kitStaticMiddleware(mounts);
    const server = http.createServer((req, res) => {
      middleware(req, res, () => {
        res.statusCode = 404;
        res.end("missing");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      const response = await fetch(`http://127.0.0.1:${port}/init/catalogo-rapido.json`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /application\/json/);
      const body = await response.text();
      assert.equal(body, readFileSync(path.join(KIT_ROOT, "init", "catalogo-rapido.json"), "utf8"));
      const miss = await fetch(
        `http://127.0.0.1:${port}/deploy/emilia-romagna/init/catalogo-rapido.json`,
      );
      assert.equal(miss.status, 404);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
