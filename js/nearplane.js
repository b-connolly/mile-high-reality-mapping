/**
 * Let the camera get close to the handheld captures.
 *
 * THE PROBLEM. Walk up to the alumni statues and they start being sliced away
 * by an invisible plane a few metres in front of the camera. The same thing
 * happens in Scene Viewer on ArcGIS Online, which is the clue: it is not this
 * app, it is the renderer's near clipping plane, and it is deliberate.
 *
 * WHY IT HAPPENS. Depth is stored per pixel with finite precision, and how much
 * of that precision you get depends almost entirely on the ratio between the
 * far and the near plane, not on their absolute values. Push near towards zero
 * while far is at the horizon and the ratio explodes; surfaces a few
 * centimetres apart then round to the same depth value and flicker against each
 * other. So the SDK does not choose near freely. Measured in this scene, with
 * `clipDistance.mode` on its default "auto":
 *
 *     camera 2000 m out    near 10.2744    far 205488    far/near 2.0e+4
 *     camera  500 m out    near 10.2952    far 205904    far/near 2.0e+4
 *     camera  120 m out    near 10.3005    far 206009    far/near 2.0e+4
 *
 * near barely moves as the camera closes in, and the ratio is pinned to exactly
 * 20000. The far plane is what is being chosen - it has to reach the horizon,
 * so it sits around 206 km - and near is then simply far / 20000. That lands it
 * a little over 10 m out. Anything nearer is not drawn, which is precisely the
 * reported symptom.
 *
 * WHAT THIS DOES. It keeps the renderer's precision budget and spends it
 * differently: close to the ground it pulls both planes towards the camera
 * together, holding the same far:near ratio. At eye height near becomes about
 * 12 cm and far about 6 km, so the statue in front of you is drawn and what is
 * given up is scenery kilometres away.
 *
 * The renderer's own choice is the ceiling, so there is no threshold to cross.
 * Above roughly 120 m the two agree and the planes are handed back to "auto" -
 * every slide in the tour is well above that and is untouched.
 *
 * WHY ALTITUDE, AND NOT WHAT YOU ARE LOOKING AT. The first version measured the
 * distance to `view.center`, the point under the middle of the screen, which
 * reads better on paper: it is the thing you are trying to inspect. It also
 * made the zoom judder, and the reason is worth writing down. `view.center` is
 * obtained by hit-testing the drawn scene. Moving the clip planes changes what
 * is drawn, which changes `view.center`, which moves the clip planes - a loop,
 * running once per frame, engaging at exactly the distance where the trouble
 * was reported. Camera altitude is an input to rendering and never an output of
 * it, so it cannot feed back. Everything here worth walking up to stands on the
 * plaza anyway.
 *
 * Two further things keep it quiet. The near plane is quantised to octaves, so
 * it is rewritten only when it doubles or halves rather than on every frame of
 * a zoom; and the handover back to "auto" has hysteresis, so sitting near the
 * boundary cannot flip the far plane between 6 km and 206 km on alternate
 * frames.
 *
 * THE OTHER THING IN THE WAY, WHICH THIS CANNOT FIX. Clip planes are only half
 * of it. The SDK also clamps how near an interactive zoom may bring the camera
 * to the point it is zooming at - `minimumPoiDistance`, which the zoom handler
 * passes straight into its step function. Measured on this build it is a flat
 * 4 m, and it does not move:
 *
 *     near plane   8 m   4 m   1 m   0.25 m   0.0625 m
 *     min POI      4 m   4 m   4 m   4 m      4 m
 *
 * So it is not derived from the clip planes, and writing to it is ignored - it
 * is internal state, not part of `SceneViewConstraints`. Zoom towards a statue
 * and the camera stops four metres short while the wheel keeps asking for more:
 * momentum against a hard stop, which reads as the view fighting back rather
 * than as a limit. The way past it is not to zoom: `goTo` is not clamped, so a
 * scripted approach can put the camera where the wheel will not.
 *
 * Add `?clipdebug` to the URL for a live readout of all of it.
 */

import * as reactiveUtils from "@arcgis/core/core/reactiveUtils.js";

export function manageNearPlane(view, cfg) {
  const debug = new URLSearchParams(location.search).has("clipdebug");
  if (!cfg?.enabled && !debug) return () => {};
  const clip = view.constraints?.clipDistance;
  if (!clip) return () => {};

  // What the renderer asks for when left alone, remembered from the last frame
  // it was in charge of. Its ratio is its judgement about how much depth
  // precision this hardware has, and there is no reason to think we know
  // better - so it is read rather than assumed.
  let autoNear = 0;
  let ratio = cfg.maxRatio;
  let managing = false;
  let last = 0;
  const readout = debug ? panel(view) : null;

  /**
   * Height above the plaza, in metres. A pure input: nothing about the way the
   * scene is drawn can change it, which is the whole point of using it.
   */
  function altitude() {
    const z = view.camera?.position?.z;
    return Number.isFinite(z) ? Math.max(0, z - cfg.ground) : Infinity;
  }

  function apply() {
    if (clip.mode === "auto") {
      if (clip.near > 1e-4 && clip.far > clip.near) {
        autoNear = clip.near;
        ratio = Math.min(cfg.maxRatio, clip.far / clip.near);
      }
      managing = false;
    }
    const h = altitude();

    if (autoNear && cfg.enabled) {
      // Octaves. A near plane that slides continuously means a projection that
      // changes on every frame of a zoom; snapping it to doublings means the
      // planes are written a handful of times across the whole descent.
      const raw = Math.max(h / cfg.margin, 1e-6);
      const near = Math.max(cfg.near, 2 ** Math.round(Math.log2(raw)));

      if (managing && near > autoNear * cfg.release) {
        clip.mode = "auto";                 // back to the renderer's own choice
        managing = false;
        last = 0;
      } else if (near < autoNear && near !== last) {
        last = near;
        managing = true;
        // far first: assigning near shoves far out from under it if the two
        // cross, so in this order neither assignment fights the other.
        clip.far = Math.max(cfg.far, near * ratio);
        clip.near = near;
      }
    }

    readout?.(h, clip);
  }

  apply();
  // The camera only. Watching `view.center` as well is what closed the loop.
  const handle = reactiveUtils.watch(() => view.camera, apply);
  return () => { handle.remove(); readout?.remove(); };
}

/**
 * ?clipdebug - a live readout, so a judder can be read off rather than guessed
 * at. It also reports `minimumPoiDistance`, which is the SDK's own clamp on how
 * close a zoom may bring the camera to the point it is zooming at: if something
 * is pushing back at close range and it is not the clip planes, it is that.
 */
function panel(view) {
  const el = document.createElement("div");
  el.style.cssText = "position:fixed;right:8px;bottom:8px;z-index:99;padding:8px 10px;" +
    "background:rgba(8,10,14,.86);border:1px solid rgba(244,241,234,.16);border-radius:8px;" +
    "color:#9fe870;font:11px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre;pointer-events:none";
  document.body.appendChild(el);

  const fn = (h, clip) => {
    // Internal, so read defensively - it is not part of the public API and may
    // not exist on every build.
    let poi = "n/a";
    const d = view.state?.constraints?.minimumPoiDistance;
    if (typeof d === "number") poi = `${d.toFixed(3)} m`;
    el.textContent =
      `altitude   ${h.toFixed(2)} m\n` +
      `near       ${clip.near.toFixed(3)} m\n` +
      `far        ${clip.far.toFixed(0)} m\n` +
      `far/near   ${(clip.far / clip.near).toExponential(1)}\n` +
      `mode       ${clip.mode}\n` +
      `min POI    ${poi}`;
  };
  fn.remove = () => el.remove();
  return fn;
}
