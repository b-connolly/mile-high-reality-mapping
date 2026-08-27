/**
 * Mile High Reality Capture Explorer
 *
 * ArcGIS Maps SDK for JavaScript 5.x, loaded as ES modules straight from the
 * CDN through the import map in index.html. No build step and nothing to
 * authenticate: the web scene and every layer in it are public.
 *
 * The interface is a button naming the capture on screen and a button that puts
 * two of them either side of a divider - and while that divider is up, each
 * half names and changes itself. The scene's saved views run along the bottom.
 * Zoom, compass, home, measure and about are the view's own controls.
 */

import esriConfig from "@arcgis/core/config.js";
import WebScene from "@arcgis/core/WebScene.js";
import SceneView from "@arcgis/core/views/SceneView.js";

import { Swipe3D } from "./swipe3d.js";
import { manageNearPlane } from "./nearplane.js";
import { captureSlideThumbnails } from "./thumbs.js";
import * as reactiveUtils from "@arcgis/core/core/reactiveUtils.js";
import {
  walkLayers, findByPath, setBranch, showOnly, applySlideTo, settleView,
  whenCameraStill
} from "./layertree.js";

/**
 * Must name the same release as the import map in index.html.
 *
 * This is the CDN's *asset* root, which is not the same tree as the module
 * root. `@arcgis/core/assets` looks like the obvious choice and serves the
 * translations, but it has no `esri/widgets/support/components/assets` - the
 * Calcite icons and message bundles the widgets draw with - so every icon in
 * zoom, compass and the measurement tools 404s and logs "calcite plus (s) icon
 * failed to load". `https://js.arcgis.com/5.1` carries the complete tree.
 */
esriConfig.assetsPath = "https://js.arcgis.com/5.1";

const ITEM_ID = "95d6646e8daf47b3930a501eb8422fd4";

/**
 * How close the camera may get before the renderer starts slicing the capture
 * away. See nearplane.js - the short version is that the near plane is derived
 * from the far plane, the far plane has to reach the horizon, and the result
 * sits about 10 m in front of the camera, which is further away than the
 * statues are tall. Ground level is the plaza at Empower Field.
 */
const CLIP = {
  enabled: true,
  ground: 1582.5,   // plaza level in metres; altitude is measured from here
  margin: 12,       // near sits at a twelfth of the height above the plaza
  near: 0.05,       // metres; never closer than this
  far: 6000,        // metres; never shorter, so the city stays in view
  release: 1.6,     // hysteresis before handing back to the renderer
  maxRatio: 20000   // never spend more depth precision than the SDK does
};

const $ = (id) => document.getElementById(id);

/**
 * The measurement widgets are the deepest imports in the app - the pair alone
 * drags in the symbol and unit graphs - and on a first load neither is on
 * screen. Fetched on the first click instead, and kept as a promise so a second
 * click while the first is in flight waits on that request rather than starting
 * another.
 */
let measureKit = null;
const loadMeasureKit = () => (measureKit ??= Promise.all([
  import("@arcgis/core/widgets/DirectLineMeasurement3D.js"),
  import("@arcgis/core/widgets/AreaMeasurement3D.js")
]).then(([line, area]) => ({ Distance: line.default, Area: area.default })));

/* ------------------------------------------------------------------ scene -- */

const scene = new WebScene({ portalItem: { id: ITEM_ID } });

// The default UI is kept and moved out of the pane's way once the view is up.
// Naming components here instead - `ui: { components: [...] }` - throws on
// construction in 5.1.20 as soon as the list includes "attribution".
const view = new SceneView({ container: "viewDiv", map: scene });

const swipe = new Swipe3D({
  itemId: ITEM_ID,
  baseView: view,
  stage: $("stage"),
  container: $("compareDiv"),
  bar: $("swipeBar"),
  handle: $("swipeHandle"),
  labelLeft: $("swipeLeftLabel"),
  labelRight: $("swipeRightLabel"),
  // The mirror is a separate scene with its own layer objects, so both the
  // near-plane handling and the modifications have to be applied to it as well
  // - otherwise the two halves clip differently and the seam opens up.
  prepare: (mirror) => {
    adoptModifications(mirror.map);
    window.__swipeView = mirror;   // debugging handle, like __view
    return manageNearPlane(mirror, CLIP);
  }
});

/* --------------------------------------------------------------- captures -- */

/**
 * The four captures: two surveys, each reconstructed two ways.
 *
 * Both distinctions matter, and which one you care about depends on what you
 * are asking. Drone against handheld answers "what did walking it buy us";
 * mesh against splat answers "what did each reconstruction keep". Since either
 * side of the divider can be any of the four, both questions - and the
 * diagonals - are one menu away.
 *
 * Each is however many layers the scene uses for it: "Handheld Meshes" is
 * three. The branches are found by what they are called rather than by where
 * they sit, so re-grouping the scene upstream does not need this file edited.
 */
const BRANCHES = [
  { role: "Drone", match: /reality|drone|aerial/i },
  { role: "Handheld", match: /pix4d|catch|handheld|terrestrial/i }
];

/** Mesh before splat; with drone before handheld, this is the order listed. */
const KINDS = [
  { type: "integrated-mesh", Drone: "Drone Mesh", Handheld: "Handheld Meshes" },
  { type: "gaussian-splat", Drone: "Drone Gaussian Splat", Handheld: "Handheld Gaussian Splat" }
];

/** [{ key, label, role, type, paths }] - built from the scene on load. */
let captures = [];

function deriveCaptures() {
  const groups = scene.layers.filter((l) => l.type === "group").toArray();
  const taken = new Set();
  const found = [];

  BRANCHES.forEach((branch, index) => {
    const group = groups.find((g) => branch.match.test(g.title) && !taken.has(g))
      ?? groups.filter((g) => !taken.has(g))[index];
    if (!group) return;
    taken.add(group);

    KINDS.forEach((kind) => {
      const paths = [];
      walkLayers(group.layers, (layer, _depth, path) => {
        if (layer.type === kind.type) paths.push([group.title, ...path]);
      });
      // A capture the scene cannot fill is not offered at all.
      if (paths.length) {
        found.push({
          key: `${branch.role}:${kind.type}`,
          label: kind[branch.role],
          role: branch.role,
          type: kind.type,
          paths
        });
      }
    });
  });

  return found;
}

/* ------------------------------------------------------------------- menu -- */

/**
 * One menu implementation, three menus: the capture button in the dock, and one
 * on each side of the divider. They all offer the same four and differ only in
 * what they do with the answer.
 */
const menus = [];

function makeMenu(button, host, chosen, onPick) {
  host.replaceChildren();
  captures.forEach((capture) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "menu__item";
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", "false");

    const tick = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    tick.setAttribute("class", "menu__tick");
    tick.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#ico-check");
    tick.append(use);

    const name = document.createElement("span");
    name.textContent = capture.label;

    item.append(tick, name);
    item.addEventListener("click", () => {
      closeMenus();
      onPick(capture);
    });
    host.append(item);
  });

  const menu = { button, host, chosen, paint() {
    [...host.children].forEach((item, index) => {
      item.setAttribute("aria-selected", String(captures[index] === chosen()));
    });
  } };

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const open = host.hidden;
    closeMenus();
    if (open) {
      host.hidden = false;
      button.setAttribute("aria-expanded", "true");
      menu.paint();
    }
  });
  host.addEventListener("click", (event) => event.stopPropagation());

  menus.push(menu);
  return menu;
}

function closeMenus() {
  menus.forEach(({ button, host }) => {
    host.hidden = true;
    button.setAttribute("aria-expanded", "false");
  });
}

// Anywhere else closes them, including a click on the scene.
document.addEventListener("click", closeMenus);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenus();
});

/* ------------------------------------------------------------------- dock -- */

/**
 * What you are looking at, in one control - until you compare, at which point
 * each side of the divider names and changes itself, and the dock is left with
 * only the button that ends it.
 */
let current = null;

const captureBtn = $("captureBtn");
const compareBtn = $("compareBtn");

/** Which capture is on each side while comparing. */
const sides = { left: null, right: null };

function showCapture(capture) {
  current = capture;
  showOnly(scene, capture?.paths);
  paint();
}

function paint() {
  const comparing = swipe.active;
  const on = captures.filter(captureIsOn);

  // The list can put more than one capture on screen, so the pill reports what
  // is there rather than what was last picked - a label naming one capture
  // while three are drawn is the control lying about the scene.
  $("captureLabel").textContent = comparing || on.length === 1
    ? (on[0] ?? current)?.label ?? ""
    : on.length === 0 ? "Nothing shown" : `${on.length} captures`;
  captureBtn.hidden = comparing;

  captureRows.forEach(({ capture, toggle }) => {
    toggle.checked = captureIsOn(capture);
    // While comparing, the two sides decide what is drawn; these would only be
    // fighting them.
    toggle.disabled = comparing;
  });
  $("capturesLocked").hidden = !comparing;
  compareBtn.setAttribute("aria-pressed", String(comparing));
  compareBtn.disabled = captures.length < 2;
  compareBtn.title = comparing ? "Stop comparing" : "Compare two captures side by side";
  menus.forEach((menu) => menu.paint());
}

compareBtn.addEventListener("click", () => {
  // Touched by hand, so it is no longer the slide's to take away.
  compareFromSlide = false;
  if (swipe.active) stopCompare();
  else startCompare();
});

/* ------------------------------------------------------------ the captures -- */

/**
 * The capture list, in the view's own control stack.
 *
 * Four switches, matching the four the pill offers: the same things, reachable
 * two ways. The pill answers "show me this one and nothing else", which is how
 * you move around; the list answers "and that one as well", which is how you
 * see a handheld capture sitting inside the aerial one.
 *
 * "Handheld Meshes" is one switch over three layers, because the handheld
 * survey is three separate subjects that sit apart - the Stampede sculpture and
 * two statue groups - and nobody thinks of them as three things.
 */
const layersCard = $("layersCard");
const captureList = $("captureList");
const captureRows = [];

/** Is any layer of this capture on screen - it, and every group above it? */
function captureIsOn(capture) {
  return capture.paths.some((path) => {
    let layer = findByPath(scene, path);
    if (!layer) return false;
    for (; layer; layer = layer.parent) {
      if (layer.visible === false) return false;
    }
    return true;
  });
}

function setCaptureOn(capture, on) {
  capture.paths.forEach((path) => {
    const layer = findByPath(scene, path);
    if (!layer) return;
    setBranch(layer, on);
    if (!on) return;
    for (let parent = layer.parent; parent && parent.type === "group"; parent = parent.parent) {
      if (!parent.visible) parent.visible = true;
    }
  });
  paint();
}

function buildCaptureList() {
  captureList.replaceChildren();
  captureRows.length = 0;

  captures.forEach((capture) => {
    const row = document.createElement("label");
    row.className = "capture";

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.className = "switch";
    toggle.addEventListener("change", () => setCaptureOn(capture, toggle.checked));

    const name = document.createElement("span");
    name.className = "capture__name";
    name.textContent = capture.label;

    row.append(toggle, name);
    captureList.append(row);
    captureRows.push({ capture, toggle });
  });

  // The pill, the slides and the compare all write straight to the layers, so
  // the switches follow the scene rather than the scene following the switches.
  walkLayers(scene.layers, (layer) => {
    reactiveUtils.watch(() => layer.visible, paint);
  });
}

function showLayers(show) {
  layersCard.hidden = !show;
  layersButtons.forEach((b) => b.setAttribute("aria-pressed", String(show)));
}

/* ---------------------------------------------------------------- compare -- */

/**
 * Opens on the pairing the current capture suggests: the same reconstruction
 * from the other survey, drone on the left. Either side can then be changed to
 * any of the four, which is where the diagonals - handheld mesh against
 * handheld splat, say - come from.
 */
function openingPair() {
  const drone = captures.find((c) => c.role === "Drone" && c.type === current?.type);
  const handheld = captures.find((c) => c.role === "Handheld" && c.type === current?.type);
  return {
    left: drone ?? current ?? captures[0],
    right: handheld ?? captures.find((c) => c !== (drone ?? current)) ?? captures.at(-1)
  };
}

const startCompare = () => startCompareFrom(current);

async function startCompareFrom(from) {
  if (captures.length < 2) return;
  current = from ?? current;
  const pair = openingPair();

  // Comparing wants each capture as it was published. The authored clips are
  // what makes them sit together as one scene, which is the opposite of what
  // the divider is for - and a drone mesh with a hole cut where the handheld
  // capture goes has nothing to compare against.
  setModifications(false);
  sides.left = pair.left;
  sides.right = pair.right;

  await swipe.start(sides.left, sides.right);
  paint();
}

function setSide(side, capture) {
  sides[side] = capture;
  swipe.left = sides.left;
  swipe.right = sides.right;
  swipe.applySides();
  // The pill takes its name from the left, so leaving the compare leaves you
  // looking at the half you were reading.
  if (side === "left") current = capture;
  paint();
}

function stopCompare() {
  compareFromSlide = false;
  swipe.stop();

  // Back to the scene as authored: both meshes, cut to fit each other by the
  // modifications, which together are the one composite of the two surveys.
  // That is the thing worth looking at once you have stopped holding the two
  // apart - and the capture list is right there to change it.
  //
  // This is decided rather than restored. Putting back whatever was visible
  // before meant landing on a single splat, which is not where anybody wants to
  // be let go of after a comparison.
  const meshes = captures.filter((c) => c.type === "integrated-mesh");
  if (meshes.length) {
    showOnly(scene, meshes.flatMap((c) => c.paths));
    current = meshes[0];
  }
  setModifications(true);
  paint();
}

/* ------------------------------------------------------ mesh modifications -- */

/**
 * The scene author's clip, mask and replace polygons.
 *
 * Every integrated mesh carries some: the drone mesh has 17, cutting holes and
 * flattening ground where the handheld captures are dropped in, and each
 * handheld mesh is clipped back to its own subject. They are what makes the two
 * surveys sit together as one scene.
 *
 * They are **off by default here**, because this app is for looking at the
 * captures rather than at the composite: with them applied, swiping onto the
 * statues shows a drone mesh with a hole exactly where the thing you wanted to
 * compare against used to be. The button in the view's control stack puts them
 * back for anyone who wants to see the scene as authored.
 *
 * Off means `layer.modifications = null`; the authored value is kept aside in a
 * WeakMap rather than re-fetched.
 */
const authoredModifications = new WeakMap();

/** Are the authored modifications currently applied? */
let modificationsOn = false;

const modsButtons = [];

async function rememberModifications(map) {
  const layers = [];
  walkLayers(map.layers, (layer) => layers.push(layer));
  // A layer only has its modifications once it has loaded them.
  await Promise.all(layers.map((layer) => layer.load().catch(() => null)));
  layers.forEach((layer) => {
    if (layer.modifications) authoredModifications.set(layer, layer.modifications);
  });
}

function applyModifications(map, applied) {
  walkLayers(map.layers, (layer) => {
    const authored = authoredModifications.get(layer);
    if (!authored) return;
    const wanted = applied ? authored : null;
    // Assigning this re-tessellates the mesh even when nothing changed, so the
    // capture drops out and reloads. Only write a real change.
    if (layer.modifications !== wanted) layer.modifications = wanted;
  });
}

/** Scene-wide: whichever views are up at the time. */
function setModifications(applied) {
  modificationsOn = applied;
  applyModifications(scene, applied);
  if (swipe.view) applyModifications(swipe.view.map, applied);
  modsButtons.forEach((button) => {
    button.setAttribute("aria-pressed", String(applied));
    button.title = applied
      ? "Mesh modifications on — the captures are clipped to fit each other"
      : "Mesh modifications off — each capture as it was published";
  });
}

/** Remember what a newly built view was authored with, then match the app. */
function adoptModifications(map) {
  return rememberModifications(map).then(() => applyModifications(map, modificationsOn));
}

/* ---------------------------------------------------------------- measure -- */

/**
 * Measure is armed from the view's own control stack and lands in a small card,
 * so it costs nothing on screen until somebody wants it. It is the only tool
 * left: the elevation profile went, because a scene about how two captures
 * compare is not a scene anybody profiles.
 */
const measureCard = $("measureCard");
const measureHost = $("measureHost");
const measureButtons = [...document.querySelectorAll(".seg")];
let measurement = null;

async function setMeasure(kind) {
  measurement?.destroy();
  measurement = null;
  measureHost.replaceChildren();
  measureButtons.forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.measure === kind));
  });
  if (!kind) return;

  const kit = await loadMeasureKit();
  const host = document.createElement("div");
  measureHost.append(host);
  const Widget = kind === "area" ? kit.Area : kit.Distance;
  measurement = new Widget({ view, container: host });
}

measureButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const pressed = button.getAttribute("aria-pressed") === "true";
    setMeasure(pressed ? null : button.dataset.measure);
  });
});

function showMeasure(show) {
  measureCard.hidden = !show;
  // Leaving it open with a tool armed would go on swallowing clicks on the scene.
  if (!show) setMeasure(null);
}

$("measureClose").addEventListener("click", () => showMeasure(false));
$("layersClose").addEventListener("click", () => showLayers(false));

/* ----------------------------------------------------------------- slides -- */

const filmTrack = $("filmTrack");
// Opened by Views; the strip is not on screen until it is asked for.
/** slide -> its <img>, so a re-baked thumbnail knows where to go. */
const slideThumbs = new Map();

function buildFilmstrip() {
  const slides = scene.presentation?.slides;
  if (!slides?.length) return;

  // Shown first, then filled: images created inside a hidden container start
  // out deferred, which is how they ended up never loading at all.
  $("film").hidden = false;

  slides.forEach((slide) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "slide";
    button.setAttribute("role", "listitem");

    // Baked by tools/bake-thumbnails.py and keyed by slide id, so reordering
    // the slides cannot shuffle the pictures. A slide added since the last bake
    // has no file; the error handler drops back to the thumbnail stored on the
    // slide itself, which is merely dated rather than missing.
    const thumb = document.createElement("img");
    thumb.alt = "";
    // Not lazy. The strip is built while its container is still `hidden`, and an
    // image created inside a hidden element never becomes "near the viewport",
    // so the browser defers it and does not reliably come back to it when the
    // container is shown - the strip renders as black boxes. There are two of
    // them, twenty kilobytes each, already on disk: laziness buys nothing here.
    thumb.loading = "eager";
    thumb.addEventListener("error", () => {
      if (thumb.dataset.fellBack) return;      // the authored one failed too
      thumb.dataset.fellBack = "1";
      thumb.src = slide.thumbnail.url;
    });
    thumb.src = `./assets/slides/${encodeURIComponent(slide.id)}.jpg`;
    slideThumbs.set(slide, thumb);

    const caption = document.createElement("span");
    caption.className = "slide__cap";
    caption.textContent = slide.title.text;

    button.append(thumb, caption);
    button.addEventListener("click", () => applySlide(slide, button));
    filmTrack.append(button);
  });

}

/**
 * The slide that is about the two surveys being the same thing twice, and so
 * brings the divider up with it.
 *
 * Matched by id first because that survives a rename - this slide has been
 * called several things already - and by title as a fallback.
 */
const COMPARE_SLIDE = { id: "1a0258da51d-slide-2", title: /handheld/i };

const opensCompare = (slide) =>
  slide.id === COMPARE_SLIDE.id || COMPARE_SLIDE.title.test(slide.title?.text ?? "");

/**
 * True while the divider on screen was brought up by a slide. Only an automatic
 * compare is taken away again on the way out; one somebody started themselves
 * is theirs to end.
 */
let compareFromSlide = false;

/** The slide most recently asked for, so slower work can tell it is stale. */
let currentSlide = null;

/**
 * A slide moves the camera. What is drawn stays whatever the pill says.
 *
 * Slides carry their own layer visibility, and honouring it fought everything
 * else: it could put three captures on screen at once while the pill named one,
 * and it wrote over a compare that was running. Separating the two - the strip
 * chooses where you are standing, the pill chooses what you are looking at -
 * means neither can surprise you, and a compare survives a change of view.
 */
async function applySlide(slide, button) {
  currentSlide = slide;
  filmTrack.querySelectorAll(".slide").forEach((el) => {
    el.setAttribute("aria-current", String(el === button));
  });

  // Leaving the slide that brought the divider up puts it away at once: there
  // is nothing to wait for, and leaving it would go on deciding what is drawn.
  if (!opensCompare(slide) && swipe.active && compareFromSlide) stopCompare();

  // Not awaited. `slide.applyTo` writes its camera and its layer visibility
  // straight away and then animates; its promise is the part that cannot be
  // trusted to settle. The camera coming to rest is the honest signal that the
  // slide has arrived, and it does not wait on a single tile.
  applySlideTo(slide, view, { animate: true, speedFactor: 0.5 }, 6000);
  await whenCameraStill(view, { quietMs: 500, capMs: 9000 });
  if (currentSlide !== slide) return;

  // Put back what the slide switched around on its way past.
  if (swipe.active) swipe.applySides();
  else if (current) showOnly(scene, current.paths);

  // The divider follows the landing, not the loading. The second view is warm,
  // so it costs nothing to show; both halves go on sharpening behind it.
  if (opensCompare(slide) && !swipe.active) {
    const splat = captures.find((c) => c.role === "Drone" && c.type === "gaussian-splat");
    await startCompareFrom(splat ?? current ?? captures[0]);
    compareFromSlide = true;
  }
}

$("viewsBtn");
viewsBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  const open = viewsBtn.getAttribute("aria-expanded") !== "true";
  viewsBtn.setAttribute("aria-expanded", String(open));
  filmTrack.hidden = !open;
});

/**
 * Re-take the filmstrip pictures from the live scene. Only under
 * `?thumbs=refresh`, which is what tools/bake-thumbnails.py drives; a normal
 * load shows the baked files and generates nothing.
 */
let refreshing = null;
function refreshThumbnails() {
  const slides = scene.presentation?.slides;
  if (refreshing || !slides?.length) return;
  console.info(`[thumbs] re-taking ${slides.length} thumbnails; ` +
    "save them with tools/bake-thumbnails.py to make them the shipped set");
  refreshing = captureSlideThumbnails({
    itemId: ITEM_ID,
    slides: slides.toArray(),
    container: $("thumbDiv"),
    prepare: (thumbView) => {
      adoptModifications(thumbView.map);
      window.__thumbView = thumbView;   // debugging handle, like __view
      return manageNearPlane(thumbView, CLIP);
    },
    onCaptured: (slide, dataUrl) => {
      const img = slideThumbs.get(slide);
      if (img) img.src = dataUrl;
      window.__thumbCount = (window.__thumbCount ?? 0) + 1;
    }
  });
}

/* ------------------------------------------------------------------- home -- */

/** Where the scene author left the camera; captured before anything moves it. */
let homeViewpoint = null;

/**
 * Home belongs with zoom, tilt and compass, so it goes into the view's own UI.
 * The SDK's Home widget is deprecated in 5.x; this is the same thing as a node,
 * wearing the SDK's own button classes so it matches the widgets it sits under.
 */
function addViewButton(templateId, onPress, index) {
  const button = $(templateId).content.firstElementChild.cloneNode(true);
  button.addEventListener("click", () => onPress(button));
  button.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") { onPress(button); event.preventDefault(); }
  });
  view.ui.add(button, index == null ? "top-right" : { position: "top-right", index });
  return button;
}

const layersButtons = [];

function addViewButtons() {
  // Home goes in at index 0, above zoom, tilt and compass: it is where you go
  // to start again, not one of the fine adjustments.
  addViewButton("tplHome", () => {
    if (homeViewpoint) view.goTo(homeViewpoint, { speedFactor: 0.6 });
  }, 0);
  layersButtons.push(addViewButton("tplLayers", () => showLayers(layersCard.hidden)));
  addViewButton("tplMeasure", () => showMeasure(measureCard.hidden));
  modsButtons.push(addViewButton("tplMods", () => setModifications(!modificationsOn)));
  addViewButton("tplAbout", () => showSplash(true));
}

/* ----------------------------------------------------------------- splash -- */

function showSplash(show) {
  $("splash").hidden = !show;
  if (show) $("splashEnter").focus();
}

$("splashEnter").addEventListener("click", () => {
  showSplash(false);
  // Build the second view now, off screen, so the first compare is instant and
  // silent instead of a capture streaming in while somebody watches.
  swipe.warm().catch((error) => console.warn("[compare] could not warm:", error));
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("splash").hidden) showSplash(false);
});

/* ------------------------------------------------------------------ start -- */

view.when()
  .then(async () => {
    await scene.load();

    homeViewpoint = view.viewpoint.clone();

    // Two groups in this scene are authored "exclusive" - radio buttons, where
    // switching one child on switches its sibling off. Reasonable authoring,
    // and fatal here: "Mesh" is every mesh in the scene, and an exclusive group
    // will not let the drone mesh and the handheld mesh inside it be on at the
    // same time. Overridden in memory; the saved scene is untouched.
    walkLayers(scene.layers, (layer) => {
      if (layer.type === "group") layer.visibilityMode = "independent";
    });

    manageNearPlane(view, CLIP);
    captures = deriveCaptures();
    // Three menus over the same four captures: the dock, and one per side.
    makeMenu(captureBtn, $("captureMenu"), () => current, showCapture);
    makeMenu($("leftPick"), $("leftMenu"), () => sides.left, (c) => setSide("left", c));
    makeMenu($("rightPick"), $("rightMenu"), () => sides.right, (c) => setSide("right", c));
    buildCaptureList();

    showCapture(captures.find((c) => c.role === "Drone" && c.type === "gaussian-splat")
      ?? captures[0]);

    buildFilmstrip();

    // Out from under the pane. Attribution stays where the SDK puts it.
    view.ui.move(["zoom", "navigation-toggle", "compass"], "top-right");
    addViewButtons();

    // Off the critical path. Reading the authored polygons means loading every
    // layer, which cost over a second of somebody's wait for the sake of a
    // button they have not reached yet. The default is off either way, so the
    // scene is already right; this only makes the toggle able to put them back.
    rememberModifications(scene).then(() => setModifications(false));

    // A debugging handle, and only that - nothing in the app reads it. It is
    // the only way to get at the layers from a console or a test.
    window.__view = view;

    // Open the door now.
    //
    // This used to wait for the first pass of tiles to land, so the reveal was
    // not a grey stadium. But `view.updating` does not reliably go false here -
    // a Gaussian splat keeps refining - so the wait was never the tile pass, it
    // was the whole 25-second cap, every single load, in front of a scene that
    // had been perfectly usable for most of it.
    //
    // The scene is navigable the moment the view is ready. Detail keeps
    // arriving either way, and it arrives whether somebody is watching a
    // loading screen or flying around in it, so there is nothing to gain by
    // holding them out. The note says more is coming; the button no longer
    // pretends it is not ready.
    const enter = $("splashEnter");
    enter.disabled = false;
    enter.textContent = "Explore the scene";

    const note = $("splashNote");
    const settled = "Built with the ArcGIS Maps SDK for JavaScript";
    note.textContent = "Detail is still arriving — it keeps sharpening while you look";
    settleView(view, { quietMs: 1500, capMs: 60000 })
      .then(() => { note.textContent = settled; });

    if (new URLSearchParams(location.search).get("thumbs") === "refresh") {
      refreshThumbnails();
    }
  })
  .catch((error) => {
    console.error(error);
    const enter = $("splashEnter");
    enter.textContent = "The scene could not be loaded";
    enter.disabled = true;
  });
