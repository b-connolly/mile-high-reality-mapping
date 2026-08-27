import * as reactiveUtils from "@arcgis/core/core/reactiveUtils.js";

/**
 * Small helpers for walking a web scene's layer tree, and for the two bits of
 * view timing that go with applying a slide.
 *
 * Layers are addressed by their *title path* - ["ArcGIS Reality", "3D Mesh"] -
 * rather than by layer id or object identity. The compare mode runs a second
 * copy of the same web scene, and a path is the one handle that means the same
 * thing in both of them.
 */

export const isGroup = (layer) => layer.type === "group";

/** Depth-first walk. `fn(layer, depth, titlePath)`. */
export function walkLayers(layers, fn, depth = 0, path = []) {
  layers.forEach((layer) => {
    const here = [...path, layer.title];
    fn(layer, depth, here);
    if (isGroup(layer)) walkLayers(layer.layers, fn, depth + 1, here);
  });
}

export function findByPath(map, path) {
  let list = map.layers;
  let found = null;
  for (const title of path ?? []) {
    found = list?.find((layer) => layer.title === title);
    if (!found) return null;
    list = found.layers;
  }
  return found;
}

/**
 * Set a layer and everything beneath it.
 *
 * Only writes where the value differs. Assigning `visible` re-enters the layer
 * view even when the value is unchanged, and on an integrated mesh or a splat
 * that means throwing away tiles that are already on screen and fetching them
 * again - which is what "the layers refresh for no reason" looks like.
 */
export function setBranch(layer, visible) {
  if (layer.visible !== visible) layer.visible = visible;
  if (isGroup(layer)) layer.layers.forEach((child) => setBranch(child, visible));
}

/**
 * Everything off, then these branches back on - each together with the groups
 * above it, because a visible layer inside a hidden group still draws nothing.
 *
 * Takes a list because one side of the compare is not necessarily one layer:
 * the handheld mesh is three of them, and they have to come up together or the
 * pane shows a third of the capture.
 *
 * Do not read a leaf's `visible` back and expect the truth. Two groups in this
 * scene use `visibilityMode: "exclusive"` - radio buttons, which the SDK keeps
 * to by refusing to switch off the last visible child - so after this runs, a
 * fully hidden branch can still contain a layer whose flag says visible. It
 * draws nothing, because the group above it is off. Anything that needs to know
 * what is actually on screen has to walk down from the root and AND the flags
 * together. Switching the target on last is deliberate for the same reason: it
 * leaves the exclusive group resolving in favour of what was asked for.
 */
export function showOnly(map, paths) {
  // Work out what should be on before touching anything. Hiding everything and
  // then switching the wanted layers back on writes false-then-true to layers
  // that were already correct, and each of those writes tears the layer view
  // down and rebuilds it: the capture blinks out and streams back in for no
  // reason. One pass, writing only the differences, leaves anything already in
  // the right state completely alone.
  const wanted = new Set();

  const addBranch = (layer) => {
    wanted.add(layer);
    if (isGroup(layer)) layer.layers.forEach(addBranch);
  };

  (paths ?? []).forEach((path) => {
    const target = findByPath(map, path);
    if (!target) return;
    addBranch(target);
    for (let parent = target.parent; parent && isGroup(parent); parent = parent.parent) {
      wanted.add(parent);
    }
  });

  walkLayers(map.layers, (layer) => {
    const on = wanted.has(layer);
    if (layer.visible !== on) layer.visible = on;
  });
}

/**
 * Make every group holding a visible leaf visible itself.
 *
 * A slide stores visibility as a list of layer ids, and anything not on the
 * list is switched off. That list goes stale the moment the scene is
 * re-grouped: adding the Broncos Stampede splat put the existing mesh inside a
 * new group, and because that group did not exist when the slides were saved,
 * no slide names it. Applying such a slide switches the mesh on and its new
 * parent off, and a visible layer inside a hidden group draws nothing - so the
 * slide silently stops showing the capture it was made for.
 *
 * Promoting the ancestors of a visible leaf can only ever make effective what
 * the slide already asked for: a hidden group whose children are all hidden is
 * untouched, and a hidden group with visible children was drawing nothing at
 * all, which is never what anybody meant.
 *
 * The real fix is to re-save the slides against the current scene. This just
 * means the app does not misrepresent them until somebody does.
 */
export function promoteVisibleAncestors(map) {
  walkLayers(map.layers, (layer) => {
    if (isGroup(layer) || !layer.visible) return;
    for (let parent = layer.parent; parent && isGroup(parent); parent = parent.parent) {
      parent.visible = true;
    }
  });
}

export function snapshotVisibility(map) {
  const state = [];
  walkLayers(map.layers, (layer, _depth, path) => state.push([path, layer.visible, layer.opacity]));
  return state;
}

export function restoreVisibility(map, state) {
  state.forEach(([path, visible, opacity]) => {
    const layer = findByPath(map, path);
    if (!layer) return;
    layer.visible = visible;
    layer.opacity = opacity;
  });
}

/**
 * Apply a slide, and carry on within a bounded time whether or not the SDK says
 * it has finished.
 *
 * `Slide.applyTo` resolves when its `goTo` completes - and in this scene that
 * promise does not always settle at all. A Gaussian splat keeps refining, the
 * view therefore never reports itself idle, and the promise is left pending
 * indefinitely. Everything written after `await slide.applyTo(...)` then simply
 * never runs, which is silent and looks exactly like the feature was never
 * built: the compare failed to open itself on the handheld slide, and the
 * thumbnail bake captured nothing, both for this one reason.
 *
 * The camera and the layer visibility are applied regardless - it is only the
 * completion signal that is unreliable - so the fix is to stop treating that
 * signal as load-bearing.
 */
export function applySlideTo(slide, view, options, budgetMs = 4000) {
  return Promise.race([
    Promise.resolve(slide.applyTo(view, options)).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, budgetMs))
  ]);
}

/**
 * Resolve once the view has stopped loading and stayed stopped, or once the cap
 * runs out - whichever comes first.
 *
 * Both halves matter. `updating` is not a single downward step: it dips false
 * in the gaps between one layer's requests and the next's, so resolving on the
 * first false returns while the scene is still half there. And it is not
 * guaranteed to go false at all - a Gaussian splat keeps refining, and in this
 * scene the flag can sit true indefinitely - so waiting for quiet as a
 * precondition would wait forever.
 *
 * @returns {Promise<boolean>} true if it genuinely went quiet, false if capped
 */
export function settleView(view, { quietMs = 1500, capMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const cap = setTimeout(() => finish(false), capMs);
    let quiet = null;
    let handle = null;

    function finish(ok) {
      clearTimeout(cap);
      clearTimeout(quiet);
      handle?.remove();
      resolve(ok);
    }

    handle = reactiveUtils.watch(() => view.updating, (updating) => {
      clearTimeout(quiet);
      if (!updating) quiet = setTimeout(() => finish(true), quietMs);
    }, { initial: true });
  });
}

/**
 * Resolve once the camera has stopped moving.
 *
 * "Have we arrived?" and "has it finished loading?" are different questions,
 * and conflating them is why the divider used to appear several seconds after
 * the flight ended - it was waiting on tiles, not on arrival. The camera is a
 * property that stops changing the moment the flight is over, whatever the
 * layers are still doing, so this answers the first question only.
 *
 * Capped, like everything else here: `goTo` can be interrupted, and a camera
 * somebody is still dragging never goes quiet.
 */
export function whenCameraStill(view, { quietMs = 400, capMs = 8000, startAfterMs = 350 } = {}) {
  return new Promise((resolve) => {
    let handle = null;
    let quiet = null;

    const finish = () => {
      clearTimeout(cap);
      clearTimeout(quiet);
      clearTimeout(begin);
      handle?.remove();
      resolve();
    };

    const cap = setTimeout(finish, capMs);
    // Not immediately: a flight asked for a moment ago has not necessarily
    // started moving the camera yet, and a camera that has not moved reads as
    // one that has finished. `startAfterMs` is how long to let it get going.
    const begin = setTimeout(() => {
      quiet = setTimeout(finish, quietMs);
      handle = reactiveUtils.watch(() => view.camera, () => {
        clearTimeout(quiet);
        quiet = setTimeout(finish, quietMs);
      });
    }, startAfterMs);
  });
}
