import { expect, test } from "@playwright/test";
import { waitForMap } from "./helpers";

// The 3D tools live under the Controls menu and stay reachable while the 2D
// map is primary: each panel opens, says it needs the globe, and closes again.
// The deployment-configured items (coordinate converter) are absent when the
// build carries no service for them.

async function openControlsItem(page: Parameters<typeof waitForMap>[0], item: string) {
  await page.getByRole("button", { name: "Controls", exact: true }).click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

test("3D Measure opens from Controls and explains that it needs the globe", async ({ page }) => {
  await waitForMap(page);
  await openControlsItem(page, "3D Measure");
  const panel = page.getByTestId("measure-3d-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("measure-3d-hint")).toContainText("3D globe");
  await panel.getByRole("button", { name: "Close" }).click();
  await expect(panel).toHaveCount(0);
});

test("Line of Sight, Globe clipping and Elevation bands open and close the same way", async ({
  page,
}) => {
  await waitForMap(page);
  for (const [item, testId] of [
    ["Line of Sight", "line-of-sight-panel"],
    ["Globe clipping", "globe-clipping-panel"],
    ["Elevation bands", "elevation-bands-panel"],
  ] as const) {
    await openControlsItem(page, item);
    const panel = page.getByTestId(testId);
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Close" }).click();
    await expect(panel).toHaveCount(0);
  }
});

test("the coordinate converter is offered only when a conversion service is configured", async ({
  page,
}) => {
  await waitForMap(page);
  await page.getByRole("button", { name: "Controls", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "3D Measure", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Coordinate converter" })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("the tools bind to a globe in a grid pane while the 2D map stays primary", async ({
  page,
}) => {
  // The engine chunk is large and software-rendered here; see cesium-globe.spec.
  test.setTimeout(180_000);
  await waitForMap(page);
  await openControlsItem(page, "Line of Sight");
  const hint = page.getByTestId("line-of-sight-panel").getByText("3D globe");
  await expect(hint).toBeVisible();

  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: "Split View" }).click();
  await page.getByRole("menuitemradio", { name: "Two columns" }).click();
  await expect(page.getByTestId("map-grid")).toBeVisible();
  await page.getByRole("button", { name: "Show map 2 as a 3D globe" }).click();
  await expect(page.getByTestId("cesium-canvas").locator("canvas")).toBeVisible({
    timeout: 60_000,
  });

  // The pane's globe is registered once its engine is ready and the open
  // panel re-binds to it: the hint turns into the first instruction.
  await expect(
    page.getByTestId("line-of-sight-panel").getByText("Click the observer point on the globe."),
  ).toBeVisible({ timeout: 60_000 });

  // And lets go of it when the pane returns to a 2D map.
  await page.getByRole("button", { name: "Show map 2 as a 2D map" }).click();
  await expect(page.getByTestId("line-of-sight-panel").getByText("3D globe")).toBeVisible({
    timeout: 30_000,
  });
});
