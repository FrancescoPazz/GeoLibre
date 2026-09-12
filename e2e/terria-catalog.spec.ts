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

// A geojson entry with queryableProperties: adding it puts Query data in
// the Controls menu, and the panel seeds one filter per property, counts
// the matching features and narrows them when a filter is answered.
const QUERY_CATALOG = {
  catalog: [
    {
      type: "geojson",
      id: "interventi",
      name: "Interventi",
      url: "https://catalog.test/interventi.json",
      queryableProperties: [
        { propertyName: "tipo", propertyLabel: "Tipo", propertyType: "enum", canAggregate: true },
        {
          propertyName: "comune",
          propertyLabel: "Comune",
          propertyType: "enum",
          canAggregate: true,
        },
        {
          propertyName: "costo",
          propertyLabel: "Costo",
          propertyType: "number",
          propertyMeasureUnit: "€",
          sumOnAggregation: true,
        },
      ],
    },
  ],
};

const INTERVENTI = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [11.3, 44.5] },
      properties: { tipo: "strada", comune: "Bologna", costo: 100 },
    },
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [11.4, 44.6] },
      properties: { tipo: "ponte", comune: "Imola", costo: 300 },
    },
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [11.5, 44.7] },
      properties: { tipo: "strada", comune: "Imola", costo: 50 },
    },
  ],
};

test("a queryable catalog layer opens the Query data panel with its filters and counts", async ({
  page,
}) => {
  await page.route("https://catalog.test/**", async (route) => {
    const url = route.request().url();
    const body =
      url === CATALOG_URL ? QUERY_CATALOG : url.endsWith("interventi.json") ? INTERVENTI : null;
    if (body) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
      return;
    }
    await route.fulfill({ status: 204 });
  });
  await waitForMap(page);
  await openCatalogPanel(page);
  const item = page.locator('[data-catalog-item="interventi"]');
  await expect(item).toBeVisible();
  await item.click();
  await expect(item).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Controls", exact: true }).click();
  await page.getByRole("menuitem", { name: "Query data", exact: true }).click();
  const panel = page.getByTestId("query-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("query-matching")).toHaveText("3 of 3 features match");
  // One quick filter per property was seeded: the enums as pick-lists.
  const filters = panel.getByTestId("quick-filter");
  await expect(filters).toHaveCount(3);
  await panel.getByTestId("query-chart-model").selectOption("pivot");
  await expect(page.getByTestId("query-pivot")).toContainText("strada");
  await expect(page.getByTestId("query-pivot")).toContainText("ponte");
  await filters
    .first()
    .getByRole("checkbox", { name: /strada/ })
    .check();
  await expect(page.getByTestId("query-matching")).toHaveText("2 of 3 features match");
  // Grouping by the filtered property is no longer offered; the next one is,
  // and the pivot aggregates only the matching features.
  await expect(panel.getByTestId("query-aggregate-by")).toHaveValue("comune");
  await expect(page.getByTestId("query-pivot")).toContainText("Bologna");
  await expect(page.getByTestId("query-pivot")).toContainText("Imola");
  await expect(page.getByTestId("query-pivot")).not.toContainText("ponte");
});
