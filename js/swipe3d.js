/**
 * A swipe divider for 3D.
 *
 * The SDK ships a Swipe widget, but it is a MapView widget: it works by asking
 * 2D layer views to clip themselves, and a SceneView has nothing to answer
 * with. So the swipe here is built the way it has to be in 3D - a second
 * SceneView on a second copy of the same web scene, stacked over the first and
 * cut away with `clip-path`, its camera slaved to the base view.
 *
 * The second view is kept **warm**: built once, shortly after the app is up,
 * and then left alive and rendering with the divider parked off the right-hand
 * edge so none of it is on screen. Building it on demand meant a fresh scene
 * streaming in from nothing at the moment somebody asked to compare, which is
 * exactly when they are looking - the capture visibly flashed in. Warm, the
 * divider simply appears over tiles that arrived minutes ago.
 *
 * The top view takes no pointer events (see .view--compare in the CSS), so
 * every drag, zoom and click still lands on the base view. The right half is a
 * passenger; it only ever mirrors.
 */

import WebScene from "@arcgis/core/WebScene.js";
import SceneView from "@arcgis/core/views/SceneView.js";
import * as reactiveUtils from "@arcgis/core/core/reactiveUtils.js";
import { showOnly } from "./layertree.js";

/** Divider position that puts the whole mirror off screen. */
const PARKED = 100;

export class Swipe3D {
  constructor({ itemId, baseView, stage, container, bar, handle, labelLeft, labelRight, prepare }) {
    Object.assign(this, { itemId, baseView, stage, container, bar, handle, labelLeft, labelRight, prepare });
    this.view = null;
    this.left = null;
    this.right = null;
    this.position = 50;
    this.showing = false;
    this.cameraWatch = null;
    this.unprepare = null;
    this.warming = null;
    this.#attachHandle();
  }

  /** Is the divider on screen? Not the same as "is the second view built". */
  get active() {
    return this.showing;
  }

  /**
   * Build the second view and let it start streaming, without showing any of
   * it. Safe to call more than once; concurrent calls share the one build.
   */
  warm() {
    if (this.view) return Promise.resolve();
    if (this.warming) return this.warming;

    this.warming = (async () => {
      this.setPosition(PARKED);          // clipped away before it can be seen
      this.container.hidden = false;

      this.view = new SceneView({
        container: this.container,
        map: new WebScene({ portalItem: { id: this.itemId } }),
        camera: this.baseView.camera,
        ui: { components: [] }
      });

      await this.view.when();
      this.#matchEnvironment();
      this.unprepare = this.prepare?.(this.view) ?? null;
      // Show the right-hand selection now, so those tiles are the ones warming.
      this.applySides();

      // One way only: the base view is the one being driven.
      this.cameraWatch = reactiveUtils.watch(
        () => this.baseView.camera,
        (camera) => { if (this.view) this.view.camera = camera; }
      );
    })();

    try {
      return this.warming;
    } finally {
      this.warming.finally(() => { this.warming = null; });
    }
  }

  /** Bring the divider on screen. */
  async start(left, right) {
    this.left = left;
    this.right = right;
    await this.warm();
    // Before applySides, which only touches the base view while showing.
    this.showing = true;
    this.applySides();
    this.bar.hidden = false;
    this.setPosition(50);
  }

  /** Park the divider again. The view stays built, so coming back is instant. */
  stop() {
    this.showing = false;
    this.bar.hidden = true;
    this.setPosition(PARKED);
  }

  /** Full teardown. Nothing calls this yet; here so the view is not unownable. */
  destroy() {
    this.stop();
    this.cameraWatch?.remove();
    this.cameraWatch = null;
    this.unprepare?.();
    this.unprepare = null;
    this.view?.destroy();
    this.view = null;
    this.container.replaceChildren();
    this.container.hidden = true;
  }

  /**
   * Put `left` in the base view and `right` in the mirror. Each side is one of
   * the captures - `{ label, paths }` - so a side is however many layers that
   * capture happens to be, and the chip beside the divider names the capture.
   *
   * The base view is only touched while the divider is actually up: parking the
   * mirror must not go on dictating what the main view shows.
   */
  applySides() {
    if (this.showing) showOnly(this.baseView.map, this.left?.paths);
    if (this.view) showOnly(this.view.map, this.right?.paths);
    this.labelLeft.textContent = this.left?.label ?? "";
    this.labelRight.textContent = this.right?.label ?? "";
  }

  setPosition(percent) {
    this.position = Math.min(PARKED, Math.max(0, percent));
    this.stage.style.setProperty("--swipe", `${this.position}%`);
    this.handle.setAttribute("aria-valuenow", String(Math.round(this.position)));
  }

  /**
   * Slides carry an environment as well as a camera, and the two scenes are
   * separate objects, so the mirror has to be told about it or the halves end
   * up lit at different times of day.
   */
  #matchEnvironment() {
    const from = this.baseView.environment;
    const to = this.view?.environment;
    if (!from || !to) return;
    try {
      to.atmosphereEnabled = from.atmosphereEnabled;
      to.starsEnabled = from.starsEnabled;
      if (from.lighting?.date && to.lighting) {
        to.lighting.date = from.lighting.date;
        to.lighting.directShadowsEnabled = from.lighting.directShadowsEnabled;
      }
      if (from.weather?.clone) to.weather = from.weather.clone();
    } catch {
      /* Cosmetic only - a mismatch is not worth failing the compare over. */
    }
  }

  #attachHandle() {
    let dragging = false;

    const track = (event) => {
      if (!dragging) return;
      const box = this.stage.getBoundingClientRect();
      const percent = ((event.clientX - box.left) / box.width) * 100;
      this.setPosition(Math.min(98, Math.max(2, percent)));
    };

    this.handle.addEventListener("pointerdown", (event) => {
      dragging = true;
      this.handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    this.handle.addEventListener("pointermove", track);
    this.handle.addEventListener("pointerup", (event) => {
      dragging = false;
      this.handle.releasePointerCapture(event.pointerId);
    });
    this.handle.addEventListener("pointercancel", () => { dragging = false; });

    this.handle.addEventListener("keydown", (event) => {
      const step = event.shiftKey ? 10 : 2;
      const next = event.key === "ArrowLeft" ? this.position - step
        : event.key === "ArrowRight" ? this.position + step
          : null;
      if (next == null) return;
      this.setPosition(Math.min(98, Math.max(2, next)));
      event.preventDefault();
    });

    // Double-click snaps back to the middle - quicker than dragging there.
    this.handle.addEventListener("dblclick", () => this.setPosition(50));
  }
}
