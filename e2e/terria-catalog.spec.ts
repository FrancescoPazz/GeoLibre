import { expect, test, type Page } from "@playwright/test";
import { layerRow, waitForMap } from "./helpers";

// The Catalog plugin reads a TerriaJS init file and adds its entries as
// layers through the host API. The unit tests cover the tree and the plugin
// against a fake host; this is the check that the real panel, the real
// Layers panel and the real store agree: a click adds a layer, another click
// removes it, and the tree marks the state in between.

const CATALOG_URL = "https://catalog.test/init/catalogo.json";

const CATALOG = {
  catalog: [
    {
      type: "group",
      id: "root",
      name: "Catalogo di prova",
      members: [
        {
          type: "group",
          id: "topo",
          name: "Cartografia",
          members: [
            {
              type: "wms",
              id: "ctr",
              name: "Carta tecnica 1:250.000",
              url: "https://catalog.test/wms/ctr250",
              layers: "Ctr250c",
            },
            {
              type: "czml",
              id: "track",
              name: "Tracciato (non supportato)",
              url: "https://catalog.test/track.czml",
            },
          ],
        },
      ],
    },
  ],
};

async function serveCatalog(page: Page): Promise<void> {
  await page.route("https://catalog.test/**", async (route) => {
    const url = route.request().url();
    if (url === CATALOG_URL) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(CATALOG),
      });
      return;
    }
    // Tiles: the layer only has to exist, not to draw anything.
    await route.fulfill({ status: 204 });
  });
}

async function openCatalogPanel(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await page.getByRole("menuitem", { name: "Catalog", exact: true }).click();
  await page.getByPlaceholder("Catalog URL (TerriaJS init JSON)").fill(CATALOG_URL);
  await page.getByRole("button", { name: "Load", exact: true }).click();
}

test("a catalog entry adds a layer on click and removes it on the next", async ({ page }) => {
  await serveCatalog(page);
  await waitForMap(page);
  await openCatalogPanel(page);

  // The single root group is unwrapped; its child group needs opening.
  const group = page.locator('[data-catalog-group="topo"]');
  await expect(group).toBeVisible();
  await group.click();
  const item = page.locator('[data-catalog-item="ctr"]');
  await expect(item).toBeVisible();
  await expect(item).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator('[data-catalog-item="track"]')).toContainText("Not supported here");

  await item.click();
  await expect(item).toHaveAttribute("aria-pressed", "true");
  // The Catalog panel shares the Layers rail: expand Layers to see the row,
  // then come back to the catalog.
  await page.getByRole("button", { name: "Expand Layers" }).click();
  await expect(layerRow(page, "Carta tecnica 1:250.000")).toBeVisible();
  await page.getByRole("button", { name: "Expand Catalog" }).click();

  await expect(item).toBeVisible();
  await item.click();
  await expect(item).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Expand Layers" }).click();
  await expect(layerRow(page, "Carta tecnica 1:250.000")).toHaveCount(0);
});

test("a catalog that cannot be loaded says so and stays listed", async ({ page }) => {
  await page.route("https://catalog.test/**", (route) => route.fulfill({ status: 404, body: "" }));
  await waitForMap(page);
  await openCatalogPanel(page);
  await expect(page.getByText("Could not load the catalog at").first()).toBeVisible();
});
