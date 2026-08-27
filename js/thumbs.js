/**
 * Fresh thumbnails for the filmstrip.
 *
 * The slides carry thumbnails, but they are whatever Scene Viewer captured when
 * the slide was saved and they are baked into the item as JPEGs: several are
 * letterboxed to a different aspect than the filmstrip, so they show black bars
 * no amount of `object-fit` can crop away, and at least one was taken while the
 * renderer's near plane was still slicing the capture, so it is mostly blank.
 *
 * So they are re-taken here, from the live scene, at exactly the filmstrip's
 * aspect. That also means they benefit from the near-plane handling the rest of
 * the app uses, and that they follow the scene: re-author a slide upstream and
 * the picture in the strip is of the thing you actually saved.
 *
 * It runs on its own small offscreen SceneView rather than the one on screen,
 * because the alternative is flying the user's camera through five viewpoints
 * while they are trying to look at something.
 */

import WebScene from "@arcgis/core/WebScene.js";
import SceneView from "@arcgis/core/views/SceneView.js";
import { promoteVisibleAncestors, applySlideTo, settleView } from "./layertree.js";

/**
 * How long to give a viewpoint before capturing it regardless.
 *
 * `view.updating` cannot be relied on to ever go false: a Gaussian splat keeps
 * refining, and in this scene the flag sits true indefinitely. Waiting for
 * quiet as a *precondition* therefore skips every slide and bakes nothing.
 * So quiet is preferred and this is the fallback - generous, because this only
 * ever runs from tools/bake-thumbnails.py, where taking a minute is free.
 */
const SETTLE_MS = 20000;
/** applyTo returns before the layers it switched on have started loading. */
const SETTLE_LEAD_MS = 700;
/** How long `updating` has to stay false before the view counts as settled. */
const SETTLE_QUIET_MS = 2000;

/**
 * @param {object} o
 * @param {string} o.itemId       the web scene, loaded again for the offscreen view
 * @param {Array} o.slides        the slides to capture, in order
 * @param {HTMLElement} o.container  offscreen div, already sized to the target aspect
 * @param {(view) => void} [o.prepare]  applied to the offscreen view once it is ready
 * @param {(slide, dataUrl) => void} o.onCaptured  called per slide, as each lands
 */
export async function captureSlideThumbnails({ itemId, slides, container, prepare, onCaptured }) {
  let view = null;
  let dispose = null;
  try {
    view = new SceneView({
      container,
      map: new WebScene({ portalItem: { id: itemId } }),
      ui: { components: [] }
    });
    await view.when();
    dispose = prepare?.(view) ?? null;

    for (const slide of slides) {
      try {
        // A slide sets the camera, the environment and layer visibility, which
        // is exactly the picture the strip should be showing.
        await applySlideTo(slide, view, { animate: false });
        // Without this the stale slide lists hide the handheld captures behind
        // a group they were never told about, and the strip shows the drone
        // mesh where the thumbnail is meant to show the capture.
        promoteVisibleAncestors(view.map);

        // Quiet if it can be had, a long dwell if not. Baking from a view that
        // never reports itself idle is still worth doing - twenty seconds of
        // streaming gets the tiles - but say which happened, because a capture
        // taken without quiet is the one worth looking at before shipping.
        if (!await settleView(view, { quietMs: SETTLE_QUIET_MS, capMs: SETTLE_MS })) {
          console.warn(`[thumbs] "${slide.title?.text}" never went idle in ` +
            `${SETTLE_MS / 1000}s; capturing anyway - check this one`);
        }

        // Rendered at the stage's full size for detail, handed back at the size
        // the strip shows. Same aspect, so this scales rather than crops.
        const shot = await view.takeScreenshot({
          format: "jpg", quality: 88, width: 296, height: 164
        });
        if (shot?.dataUrl) {
          onCaptured(slide, shot.dataUrl);
        } else {
          // Was silent, which made a screenshot that came back empty look
          // exactly like a capture that never ran.
          console.warn(`[thumbs] "${slide.title?.text}" produced no image;`,
            "takeScreenshot returned", shot);
        }
      } catch (error) {
        // One awkward viewpoint should not cost the rest their pictures, and
        // the authored thumbnail is still there to fall back on - but say so,
        // or the only symptom is a thumbnail that quietly never changes.
        console.warn(`[thumbs] "${slide.title?.text}" kept its authored thumbnail:`, error);
      }
    }
  } catch (error) {
    console.warn("[thumbs] no offscreen view; the filmstrip keeps the item's thumbnails:", error);
  } finally {
    dispose?.();
    view?.destroy();
    container.replaceChildren();
  }
}
