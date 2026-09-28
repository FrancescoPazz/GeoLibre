import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { act, fireEvent, render, screen } from "./helpers/dom";
import { createElement } from "react";
import type { TerrainProfile } from "../packages/plugins/src/plugins/rer-3d-tools/terrain-profile";

const { Measure3dProfileChart } =
  await import("../apps/geolibre-desktop/src/components/panels/Measure3dProfileChart");
const { Measure3dPanel } =
  await import("../apps/geolibre-desktop/src/components/panels/Measure3dPanel");
const { openMeasure3dPanel, restoreMeasure3d } =
  await import("../packages/plugins/src/plugins/rer-3d-tools/measure-3d");

const profile: TerrainProfile = {
  samples: [
    { lng: 0, lat: 0, alt: 100, distanceM: 0 },
    { lng: 0.1, lat: 0, alt: 220, distanceM: 10 },
    { lng: 0.2, lat: 0, alt: 100, distanceM: 20 },
  ],
  stopIndex: [0, 2],
  segmentGeodeticM: [0, 20],
  segmentAirM: [0, 20],
  segmentGroundM: [0, 20],
  totalGeodeticM: 20,
  totalAirM: 20,
  totalGroundM: 20,
  minAlt: 100,
  maxAlt: 220,
  samplingStepM: 10,
  detailed: true,
};

describe("3D Measure profile chart", () => {
  it("zooms at the cursor without leaking chart gestures to the map", () => {
    let mapWheelEvents = 0;
    let mapPointerEvents = 0;
    render(
      createElement(
        "div",
        {
          onWheel: () => {
            mapWheelEvents += 1;
          },
          onPointerDown: () => {
            mapPointerEvents += 1;
          },
        },
        createElement(Measure3dProfileChart, { profile, hover: null }),
      ),
    );
    const chart = screen.getByTestId("measure-3d-chart");
    let wheelCanceled = true;
    act(() => {
      wheelCanceled = fireEvent.wheel(chart, { deltaY: -350, clientX: 148 });
    });
    assert.equal(wheelCanceled, false, "the chart cancels the browser/map default wheel action");

    const beforePan = Number(chart.getAttribute("data-viewport-start"));
    const end = Number(chart.getAttribute("data-viewport-end"));
    assert.equal(chart.isConnected, true, document.body.innerHTML);
    assert.notEqual(chart.getAttribute("data-viewport-start"), null, chart.outerHTML);
    assert.ok(end - beforePan < 20, `wheel-in narrows the visible profile (${beforePan}–${end})`);
    assert.equal(mapWheelEvents, 0, "wheel input does not reach the map");
    assert.equal(chart.isConnected, true, "the chart remains mounted after zooming");

    fireEvent.pointerDown(chart, { button: 0, pointerId: 1, clientX: 148 });
    fireEvent.pointerMove(chart, { pointerId: 1, clientX: 80 });
    fireEvent.pointerUp(chart, { pointerId: 1, clientX: 80 });
    assert.ok(
      Number(chart.getAttribute("data-viewport-start")) > beforePan,
      "dragging left pans later",
    );
    assert.equal(mapPointerEvents, 0, "chart panning does not reach the map");
  });

  it("keeps section collapse state when the panel body is minimized and restored", () => {
    act(() => openMeasure3dPanel({} as never));
    render(createElement(Measure3dPanel));

    const drawSection = screen.getByRole("button", {
      name: "Draw and options",
    });
    fireEvent.click(drawSection);
    assert.equal(drawSection.getAttribute("aria-expanded"), "false");

    const minimize = screen.getByRole("button", { name: "Collapse panel" });
    fireEvent.click(minimize);
    assert.equal(minimize.getAttribute("aria-expanded"), "false");
    fireEvent.click(screen.getByRole("button", { name: "Expand panel" }));
    assert.equal(drawSection.getAttribute("aria-expanded"), "false");

    act(() => restoreMeasure3d({} as never, undefined));
  });
});
