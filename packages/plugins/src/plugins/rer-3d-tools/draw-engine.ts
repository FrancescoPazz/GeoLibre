import type {
  Cartesian2,
  Cartesian3,
  Entity,
  ScreenSpaceEventHandler,
  TerrainProvider,
} from "@cesium/engine";
import type { CesiumSceneHandle } from "@geolibre/map";
import {
  angleArc,
  circleRing,
  computeMeasures,
  formatDegrees,
  formatMeters,
  formatSquareMeters,
  geodesicInterpolate,
  geodesicMeters,
  insertTolerance,
  nearestPathPoint,
  nearestSegment,
  verticesCentroid,
  type DrawGeometry,
  type DrawMeasures,
  type DrawMode,
  type PathHit,
} from "./draw-geometry";
import {
  fromLngLatAlt,
  pickGroundPosition,
  toLngLatAlt,
  type LngLatAlt,
} from "./line-of-sight-geometry";

type CesiumNs = CesiumSceneHandle["Cesium"];

export interface DrawOptions {
  /** Drape the line on the terrain rather than drawing straight chords between vertices. */
  clampToGround: boolean;
  /** Show the distance, area, angle and radius labels on the map. */
  showLabels: boolean;
}

export const DEFAULT_DRAW_OPTIONS: DrawOptions = Object.freeze({
  clampToGround: true,
  showLabels: true,
});

/** How many vertices a mode takes before further clicks are ignored. */
const MAX_POINTS: Partial<Record<DrawMode, number>> = { angle: 3, circle: 2 };

const ID = "geolibre-draw";
const VERTEX_ID = `${ID}-vertex-`;

const VERTEX_COLOR = "#0ea5e9";
const FIRST_VERTEX_COLOR = "#f59e0b";
const LINE_COLOR = "#0ea5e9";
const FILL_ALPHA = 0.25;
/** The other paths of a multi-path measurement: the same blue, thinner and dimmer. */
const BACKGROUND_LINE_ALPHA = 0.45;
/** How close, in screen pixels, the pointer has to be to a path to hover it. */
export const HOVER_TOLERANCE_PIXELS = 10;
const LABEL_FILL = "#ffffff";
const LABEL_OUTLINE = "#0f172a";
const LABEL_FONT = "13px sans-serif";

/**
 * Drawing on the Cesium globe: the vertices of one figure, the entities that
 * show it, and the pointer handling that edits it.
 *
 * Five modes share one engine. A click adds a vertex — or inserts one when it
 * lands on an existing segment — a click on the first vertex closes a polygon,
 * an angle stops taking vertices at three, a circle at two (its second vertex
 * tracks the pointer until it is clicked). Any vertex can be dragged; camera
 * navigation is suspended for the duration so the globe does not pan under
 * the drag. Every change re-derives the measures and redraws the entities
 * — they are few, and one path for "state changed" beats patching properties.
 *
 * The figure is kept as ground positions in degrees, never as entities, so
 * it can be rebuilt on a fresh globe after a renderer swap and stored in the
 * project file as plain data.
 */
export class CesiumDrawing {
  private mode: DrawMode = "line";
  private points: LngLatAlt[] = [];
  private closed = false;
  /** Circle only: the pointer's ground position while the radius is unlocked. */
  private preview: LngLatAlt | null = null;
  private dragging: { index: number; restoreInputs: () => void } | null = null;
  private entities: Entity[] = [];
  /** The hover marker (a profile sample under the pointer), kept apart from the figure. */
  private marker: Entity | null = null;
  /** The inactive paths of a multi-path measurement, drawn but not editable. */
  private background: DrawGeometry[] = [];
  private backgroundEntities: Entity[] = [];
  /** Where along the figure the pointer last was, so hover fires only on change. */
  private lastHover: PathHit | null = null;
  private onHover: ((hit: PathHit | null) => void) | null = null;
  private readonly handler: ScreenSpaceEventHandler;
  private readonly previousCursor: string;
  private destroyed = false;

  constructor(
    private readonly handle: CesiumSceneHandle,
    private options: DrawOptions,
    private readonly onChange: (geometry: DrawGeometry, measures: DrawMeasures) => void,
  ) {
    const { Cesium: C, viewer } = handle;
    this.previousCursor = viewer.canvas.style.cursor;
    viewer.canvas.style.cursor = "crosshair";
    this.handler = new C.ScreenSpaceEventHandler(viewer.canvas);
    this.handler.setInputAction(
      (m: { position: Cartesian2 }) => this.onLeftDown(m.position),
      C.ScreenSpaceEventType.LEFT_DOWN,
    );
    this.handler.setInputAction(
      (m: { endPosition: Cartesian2 }) => this.onMouseMove(m.endPosition),
      C.ScreenSpaceEventType.MOUSE_MOVE,
    );
    this.handler.setInputAction(() => this.onLeftUp(), C.ScreenSpaceEventType.LEFT_UP);
    this.handler.setInputAction(
      (m: { position: Cartesian2 }) => this.onLeftClick(m.position),
      C.ScreenSpaceEventType.LEFT_CLICK,
    );
  }

  /** Whether this drawing is bound to `viewer` and still usable. */
  drives(viewer: CesiumSceneHandle["viewer"]): boolean {
    return !this.destroyed && this.handle.viewer === viewer && !viewer.isDestroyed();
  }

  /** Whether the globe this drawing is bound to still exists. */
  isLive(): boolean {
    return this.live();
  }

  /** The terrain the globe is currently drawing, for sampling heights along the figure. */
  getTerrainProvider(): TerrainProvider | undefined {
    return this.handle.viewer.isDestroyed() ? undefined : this.handle.viewer.terrainProvider;
  }

  getGeometry(): DrawGeometry {
    return { mode: this.mode, points: this.points.map((p) => ({ ...p })), closed: this.closed };
  }

  getMeasures(): DrawMeasures {
    return computeMeasures(this.handle.Cesium, this.getGeometry());
  }

  /** Switch mode, discarding the current figure. */
  setMode(mode: DrawMode): void {
    if (mode === this.mode && this.points.length === 0) return;
    this.mode = mode;
    this.clear();
  }

  setOptions(patch: Partial<DrawOptions>): void {
    this.options = { ...this.options, ...patch };
    this.redraw();
    this.redrawBackground();
  }

  /**
   * Be told when the pointer moves along the figure (a line or polygon with
   * two or more vertices): the segment and fraction under it, or `null` once
   * it leaves. Fires only on change.
   */
  setHoverListener(listener: ((hit: PathHit | null) => void) | null): void {
    this.onHover = listener;
    this.lastHover = null;
  }

  /** The other paths of a multi-path measurement, shown thin and dim behind the active one. */
  setBackgroundFigures(figures: DrawGeometry[]): void {
    this.background = figures.map((g) => ({ ...g, points: g.points.map((p) => ({ ...p })) }));
    this.redrawBackground();
  }

  /** Replace the figure (a project restore, or an edit from the panel). */
  setGeometry(geometry: DrawGeometry): void {
    this.mode = geometry.mode;
    const max = MAX_POINTS[geometry.mode];
    this.points = geometry.points.slice(0, max ?? geometry.points.length).map((p) => ({ ...p }));
    this.closed = geometry.mode === "polygon" && geometry.closed && this.points.length >= 3;
    this.preview = null;
    this.endDrag();
    this.redraw();
    this.notify();
  }

  clear(): void {
    this.points = [];
    this.closed = false;
    this.preview = null;
    this.endDrag();
    this.redraw();
    this.notify();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.endDrag();
    const { viewer } = this.handle;
    if (!viewer.isDestroyed()) {
      this.removeEntities();
      this.removeBackgroundEntities();
      this.setMarker(null);
      viewer.canvas.style.cursor = this.previousCursor;
      this.handle.requestRender();
    }
    if (!this.handler.isDestroyed()) this.handler.destroy();
  }

  // --- pointer handling -----------------------------------------------------

  private live(): boolean {
    return !this.destroyed && !this.handle.viewer.isDestroyed();
  }

  private ground(position: Cartesian2): LngLatAlt | null {
    const picked = pickGroundPosition(this.handle.Cesium, this.handle.viewer, position);
    return picked ? toLngLatAlt(this.handle.Cesium, picked) : null;
  }

  /** The index of one of this drawing's vertices under the pointer, if any. */
  private vertexAt(position: Cartesian2): number | null {
    const picked = this.handle.scene.pick(position) as { id?: { id?: unknown } } | undefined;
    const id = picked?.id?.id;
    if (typeof id !== "string" || !id.startsWith(VERTEX_ID)) return null;
    const index = Number(id.slice(VERTEX_ID.length));
    return Number.isInteger(index) && index >= 0 && index < this.points.length ? index : null;
  }

  private onLeftDown(position: Cartesian2): void {
    if (!this.live() || this.dragging) return;
    const index = this.vertexAt(position);
    if (index === null) return;
    const controller = this.handle.scene.screenSpaceCameraController;
    const previous = controller.enableInputs;
    controller.enableInputs = false;
    this.dragging = {
      index,
      restoreInputs: () => {
        if (this.live()) controller.enableInputs = previous;
      },
    };
  }

  private onMouseMove(position: Cartesian2): void {
    if (!this.live()) return;
    if (this.dragging) {
      const ground = this.ground(position);
      if (!ground) return;
      this.points[this.dragging.index] = ground;
      this.redraw();
      this.notify();
      return;
    }
    if (this.mode === "circle" && this.points.length === 1) {
      const ground = this.ground(position);
      if (!ground) return;
      this.preview = ground;
      this.redraw();
      return;
    }
    this.trackHover(position);
  }

  /** Report the point of the figure under the pointer, if any, when it changes. */
  private trackHover(position: Cartesian2): void {
    if (!this.onHover) return;
    let hit: PathHit | null = null;
    if ((this.mode === "line" || this.mode === "polygon") && this.points.length >= 2) {
      const ground = this.ground(position);
      if (ground) {
        hit = nearestPathPoint(
          this.handle.Cesium,
          this.points,
          fromLngLatAlt(this.handle.Cesium, ground),
          Math.max(1, this.metersPerPixel() * HOVER_TOLERANCE_PIXELS),
          this.mode === "polygon" && this.closed,
        );
      }
    }
    const previous = this.lastHover;
    if (
      (hit === null && previous === null) ||
      (hit && previous && hit.segment === previous.segment && hit.t === previous.t)
    ) {
      return;
    }
    this.lastHover = hit;
    this.onHover(hit);
  }

  private onLeftUp(): void {
    if (!this.dragging) return;
    this.endDrag();
    this.notify();
  }

  private endDrag(): void {
    const drag = this.dragging;
    this.dragging = null;
    drag?.restoreInputs();
  }

  private onLeftClick(position: Cartesian2): void {
    if (!this.live() || this.dragging) return;
    const vertex = this.vertexAt(position);
    if (vertex !== null) {
      // The first vertex closes a polygon; any other vertex is just a vertex.
      if (this.mode === "polygon" && vertex === 0 && this.points.length >= 3 && !this.closed) {
        this.closed = true;
        this.redraw();
        this.notify();
      }
      return;
    }
    const ground = this.ground(position);
    if (!ground) return;
    const { Cesium: C } = this.handle;

    if (this.mode === "circle") {
      if (this.points.length >= 2) {
        // A third click starts a new circle at the new centre.
        this.points = [ground];
      } else {
        this.points.push(ground);
      }
      this.preview = null;
      this.redraw();
      this.notify();
      return;
    }

    if (this.mode !== "point") {
      const insert = nearestSegment(
        C,
        this.points,
        fromLngLatAlt(C, ground),
        insertTolerance(this.metersPerPixel()),
        this.mode === "polygon" && this.closed,
      );
      if (insert) {
        this.points.splice(insert.insertAt, 0, ground);
        this.redraw();
        this.notify();
        return;
      }
    }

    const max = MAX_POINTS[this.mode];
    if (max !== undefined && this.points.length >= max) return;
    if (this.mode === "polygon" && this.closed) return;
    this.points.push(ground);
    this.redraw();
    this.notify();
  }

  /**
   * Place (or remove, with `null`) the marker that shows where along the
   * figure the pointer is on the profile chart.
   */
  setMarker(point: LngLatAlt | null): void {
    const { Cesium: C, viewer } = this.handle;
    if (viewer.isDestroyed()) return;
    if (this.marker) {
      viewer.entities.remove(this.marker);
      this.marker = null;
    }
    if (point) {
      this.marker = viewer.entities.add({
        id: `${ID}-marker`,
        position: fromLngLatAlt(C, point),
        point: {
          pixelSize: 10,
          color: C.Color.fromCssColorString(FIRST_VERTEX_COLOR),
          outlineColor: C.Color.WHITE,
          outlineWidth: 2,
          heightReference: C.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
    this.handle.requestRender();
  }

  /**
   * Ground metres covered by one screen pixel at the camera's height, so the
   * insert tolerance (and the profile's sampling step) follow the zoom. Zero
   * for an orthographic frustum, which leaves the length-based rules on
   * their own.
   */
  metersPerPixel(): number {
    const { camera, canvas } = this.handle;
    const fovy = (camera.frustum as { fovy?: number }).fovy;
    const height = camera.positionCartographic?.height;
    const pixels = canvas.clientHeight || canvas.height;
    if (!fovy || !height || !pixels) return 0;
    return (2 * height * Math.tan(fovy / 2)) / pixels;
  }

  private notify(): void {
    this.onChange(this.getGeometry(), this.getMeasures());
  }

  // --- entities --------------------------------------------------------------

  private removeEntities(): void {
    const { viewer } = this.handle;
    if (!viewer.isDestroyed()) for (const entity of this.entities) viewer.entities.remove(entity);
    this.entities = [];
  }

  private removeBackgroundEntities(): void {
    const { viewer } = this.handle;
    if (!viewer.isDestroyed())
      for (const entity of this.backgroundEntities) viewer.entities.remove(entity);
    this.backgroundEntities = [];
  }

  /** The inactive paths: one thin, dim line each (a closed polygon as its ring), no vertices or labels. */
  private redrawBackground(): void {
    this.removeBackgroundEntities();
    const { Cesium: C, viewer } = this.handle;
    if (viewer.isDestroyed()) return;
    this.background.forEach((figure, index) => {
      if (figure.mode === "point" || figure.mode === "circle" || figure.mode === "angle") return;
      if (figure.points.length < 2) return;
      const ring =
        figure.mode === "polygon" && figure.closed
          ? [...figure.points, figure.points[0]]
          : figure.points;
      this.backgroundEntities.push(
        viewer.entities.add({
          id: `${ID}-background-${index}`,
          polyline: {
            positions: ring.map((p) => fromLngLatAlt(C, p)),
            width: 2,
            clampToGround: this.options.clampToGround,
            material: C.Color.fromCssColorString(LINE_COLOR).withAlpha(BACKGROUND_LINE_ALPHA),
          },
        }),
      );
    });
    this.handle.requestRender();
  }

  private redraw(): void {
    this.removeEntities();
    const { Cesium: C, viewer } = this.handle;
    if (viewer.isDestroyed()) return;
    const cart = (p: LngLatAlt) => fromLngLatAlt(C, p);
    const add = (entity: Parameters<typeof viewer.entities.add>[0]) => {
      this.entities.push(viewer.entities.add(entity));
    };
    const point = (id: string, position: Cartesian3, color: string) =>
      add({
        id,
        position,
        point: {
          pixelSize: 12,
          color: C.Color.fromCssColorString(color),
          outlineColor: C.Color.WHITE,
          outlineWidth: 2,
          heightReference: C.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    const line = (id: string, positions: Cartesian3[], width = 4) =>
      add({
        id,
        polyline: {
          positions,
          width,
          clampToGround: this.options.clampToGround,
          material: C.Color.fromCssColorString(LINE_COLOR),
        },
      });
    const label = (id: string, position: Cartesian3, text: string) => {
      if (!this.options.showLabels || !text) return;
      add({
        id,
        position,
        label: {
          text,
          font: LABEL_FONT,
          style: C.LabelStyle.FILL_AND_OUTLINE,
          fillColor: C.Color.fromCssColorString(LABEL_FILL),
          outlineColor: C.Color.fromCssColorString(LABEL_OUTLINE),
          outlineWidth: 3,
          pixelOffset: new C.Cartesian2(0, -14),
          heightReference: C.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    };

    const points = this.points;
    const measures = this.getMeasures();

    if (this.mode === "circle") {
      const center = points[0];
      const edge = points[1] ?? this.preview;
      if (center) point(`${VERTEX_ID}0`, cart(center), FIRST_VERTEX_COLOR);
      if (center && edge) {
        const radius = geodesicMeters(C, center, edge);
        if (radius > 0) {
          line(`${ID}-circle`, circleRing(C, center, radius).map(cart), 3);
          line(`${ID}-radius`, [cart(center), cart(edge)], 2);
          label(
            `${ID}-radius-label`,
            cart(geodesicInterpolate(C, center, edge, 0.5)),
            formatMeters(radius),
          );
          label(`${ID}-circle-label`, cart(center), formatSquareMeters(Math.PI * radius * radius));
        }
        if (points[1]) point(`${VERTEX_ID}1`, cart(edge), VERTEX_COLOR);
      }
      this.handle.requestRender();
      return;
    }

    if (this.mode !== "point" && points.length >= 2) {
      const ring = this.closed ? [...points, points[0]] : points;
      line(`${ID}-line`, ring.map(cart));
      if (this.mode === "polygon" && this.closed && points.length >= 3) {
        add({
          id: `${ID}-fill`,
          polygon: {
            hierarchy: new C.PolygonHierarchy(points.map(cart)),
            material: C.Color.fromCssColorString(LINE_COLOR).withAlpha(FILL_ALPHA),
            heightReference: C.HeightReference.CLAMP_TO_GROUND,
            perPositionHeight: false,
          },
        });
        const centroid = verticesCentroid(points);
        if (centroid && measures.areaSqm !== null) {
          label(`${ID}-area-label`, cart(centroid), formatSquareMeters(measures.areaSqm));
        }
      }
      if (this.mode === "angle" && points.length === 3) {
        const arc = angleArc(C, cart(points[0]), cart(points[1]), cart(points[2]));
        if (arc.length > 1) line(`${ID}-arc`, arc, 2);
        if (measures.angleDeg !== null) {
          label(`${ID}-angle-label`, cart(points[1]), formatDegrees(measures.angleDeg));
        }
      }
      if (this.mode !== "angle") {
        ring.slice(1).forEach((b, i) => {
          const a = ring[i];
          const meters = measures.segmentMeters[i];
          if (meters === undefined) return;
          label(`${ID}-label-${i}`, cart(geodesicInterpolate(C, a, b, 0.5)), formatMeters(meters));
        });
      }
    }
    points.forEach((p, i) =>
      point(`${VERTEX_ID}${i}`, cart(p), i === 0 ? FIRST_VERTEX_COLOR : VERTEX_COLOR),
    );
    this.handle.requestRender();
  }
}
