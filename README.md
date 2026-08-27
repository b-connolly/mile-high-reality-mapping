# Mile High Reality Capture Explorer

Empower Field at Mile High, captured from the air and on foot, in one scene —
with a swipe for reading the two captures against each other.

- **Aerial** — flown with a Freefly Astro, processed in **ArcGIS Reality** into
  a textured 3D mesh and a Gaussian splat from the same flight.
- **Terrestrial** — the Broncos Stampede sculpture, the alumni statues and the
  Super Bowl monuments, walked and processed with **PIX4Dcatch**.

Both are hosted layers in ArcGIS Online, georeferenced into one public web
scene: [`95d6646e8daf47b3930a501eb8422fd4`][item].

[item]: https://arcgis.com/home/item.html?id=95d6646e8daf47b3930a501eb8422fd4

## Deploying

Copy the folder to any static host. There is no build step, no server side and
nothing to authenticate — the scene and every layer in it are public, and the
SDK is loaded from the ArcGIS CDN. Every path in the page is relative, so it
works from a subdirectory as well as from a root.

```
index.html
css/styles.css
js/*.js
assets/slides/*.jpg
```

Locally it still has to be served over HTTP rather than opened as a file,
because it loads ES modules:

```
python serve.py            # http://localhost:8778
```

`serve.py` is a dev convenience only — it sends `no-store` so an edit is never
masked by a cached module. Do not carry that behaviour to the real host; there
the files should be cached normally.

## What is in it

```
  ┌──────────────────────────┬────┐
  │ ◈ Drone Gaussian Splat ▾ │ ⇄  │        (full-bleed 3D scene)
  └──────────────────────────┴────┘

  ...and while comparing, each half names and changes itself:

           ┌────────────────────┐ │ ┌──────────────────────────┐
      ┌──┐ │ DRONE MESH       ▾ │ │ │ HANDHELD GAUSSIAN SPLAT ▾│
      │⇄ │ └────────────────────┘ │ └──────────────────────────┘
      └──┘                        ⇕ drag
                     ┌────────────────────────────────┐
                     │ VIEWS ⌄                        │
                     │ [img]  [img]  [img]            │
                     └────────────────────────────────┘
```

Four captures — **Drone Mesh**, **Drone Gaussian Splat**, **Handheld Meshes**,
**Handheld Gaussian Splat**. Two surveys, each reconstructed two ways.

- **The pill**, top left, names the one on screen. Click it, pick another.
- **⇄** puts two of them either side of a divider, opening on the same
  reconstruction from the other survey. The pill then steps aside, because each
  half of the screen names and changes itself — **either side can be any of the
  four**, so drone against handheld, mesh against splat, and the diagonals are
  all one click. Stopping leaves you looking at whatever was on the left.
- **A side shows exactly one capture**, never a composite. Two Gaussian splats
  occupying the same space would fight each other, and you would be looking at
  whichever happened to draw in front.
- **Views**, bottom centre, are the scene's slides. They move the camera and
  nothing else, so a view cannot surprise you and a compare survives one — with
  one exception: the handheld slide brings the divider up by itself once it has
  arrived, and puts it away on the way out. A compare you started yourself is
  left alone.
- **The view's own control stack**, top right, in order: **home** (above the map
  controls, because it is where you go to start again rather than a fine
  adjustment), zoom, tilt, compass, then **captures**, **measure**, **mesh
  modifications** and **about**.
- **Captures** opens a list of the same four as switches. The pill answers "show
  me this one and nothing else"; the list answers "and that one as well", which
  is how you see a handheld capture sitting inside the aerial one. With more
  than one on, the pill says how many rather than naming one and lying about the
  rest. The list is locked while the divider is up, because the two sides are
  deciding what is drawn.

"Handheld Meshes" is three layers, because the handheld survey is three separate
subjects — the Stampede sculpture and two statue groups — which sit apart and do
not overlap. Everything else is one layer.

```
index.html          shell, welcome screen, import map
css/styles.css      the whole UI; the SDK's dark theme underneath it
js/app.js           view, dock, side pickers, compare, slides, measure
js/swipe3d.js       the swipe — two synchronised SceneViews
js/nearplane.js     lets the camera get close without the capture being sliced
js/layertree.js     walking and addressing the scene's layer tree
js/thumbs.js        re-takes the filmstrip pictures (only under ?thumbs=refresh)
assets/slides/      the baked thumbnails, one per slide id
tools/              bake-thumbnails.py, which produces them
```

## Notes for whoever edits this next

**The swipe is two views, not the Swipe widget.** `esri/widgets/Swipe` is a
MapView widget — it works by asking 2D layer views to clip themselves, and a
SceneView has nothing to answer with. `swipe3d.js` runs a second SceneView on a
second copy of the same web scene, stacked over the first, cut away with
`clip-path`, camera slaved to the base view. The top view takes no pointer
events, so navigation, measurement and the profile all still read the one view
underneath. It is torn down when compare is switched off — the scene is
otherwise being rendered twice.

**`esriConfig.assetsPath` is `https://js.arcgis.com/5.1`**, not
`.../@arcgis/core/assets`. The obvious choice serves the translations but has no
`esri/widgets/support/components/assets`, where the Calcite icons and message
bundles the widgets draw with live — point it there and every icon in zoom,
compass and the measurement tools 404s with `calcite plus (s) icon failed to
load`. Keep it in step with the version in the import map in `index.html`.

**Do not name default UI components at construction.** `new SceneView({ ui: {
components: ["attribution"] } })` throws `Failed to execute 'appendChild' on
'Node'` in 5.1.20 and takes the whole view down. Move the default UI after the
view is ready instead: `view.ui.move([...], "top-right")`.

**`hidden` does not hide anything that sets `display`.** The attribute is only a
UA-level `display: none`, so any author rule setting `display` silently beats
it — and the tool panel is `display: flex`, which is why it sat on screen empty
from page load with a close button and nothing in it. `[hidden]:not(.splash) {
display: none !important }` near the top of the stylesheet settles it once for
everything; `.splash` is excluded because it fades rather than vanishing. Worth
remembering before adding another component that is toggled with `hidden`.

**Filmstrip thumbnails are baked files, not the slides' own.** The thumbnails
Scene Viewer stores on a slide are letterboxed to a different aspect than the
strip — black bars no `object-fit` can crop — and one was taken while the near
plane was still slicing the capture, so it was nearly blank. The strip instead
loads `assets/slides/<slide id>.jpg`, keyed by id so reordering the slides
cannot shuffle the pictures. A slide with no file falls back to its own
thumbnail, so adding one upstream degrades rather than breaks.

Re-bake after re-authoring the slides:

```
python serve.py                       # in one terminal
python tools/bake-thumbnails.py       # in another
```

That drives the app with `?thumbs=refresh`, which is the only thing that still
runs `thumbs.js` — a normal load generates nothing. The capture renders at
888×492 and scales to 296×164: level of detail is driven by screen-space error,
so rendering straight into a 296px viewport gets the coarsest tiles available
and returns a smear. It needs a real GPU; software rendering will not produce a
usable frame.

Two rules keep the captures honest, both learned the hard way. `view.updating`
is not a single downward step — it dips false in the gaps between one layer's
requests and the next's, and on a freshly created view it is false before any
work is queued — so `settle()` waits for it to stay false for two seconds rather
than resolving on the first dip. And a viewpoint that never goes quiet inside
`SETTLE_MS` is **skipped**, keeping whatever the strip already had: a dated
thumbnail beats a fresh one showing bare terrain where the stadium should be.

**`slide.applyTo()` may never resolve — do not await it bare.** Its promise
settles when the internal `goTo` completes, and in this scene it can stay
pending forever: a Gaussian splat keeps refining, so the view never reports
itself idle. Everything written after `await slide.applyTo(...)` then silently
never runs. That single cause broke two features that looked unrelated and
un-built — the compare would not open itself on the handheld slide, and the
thumbnail bake captured nothing. The camera and layer visibility are applied
regardless; only the completion signal is unreliable. `applySlideTo()` in
`layertree.js` races it against a time budget, and everything applies slides
through that.

**Never write a layer property that has not changed.** Assigning `visible` or
`modifications` re-enters the layer view even when the value is identical, and
on an integrated mesh or a splat that throws away tiles that are already on
screen and fetches them again. `showOnly()` therefore computes the wanted set
first and writes only differences, instead of hiding everything and switching
the wanted layers back on; `applyModifications()` compares before assigning.
Getting this wrong looks like "the layers refresh for no reason".

Related: modifications belong to integrated meshes and do nothing to a splat, so
compare only strips them when a pane is actually showing a mesh. The default
pairing is splat against splat, where stripping them would have reloaded four
meshes nobody can see.

**The loading curtain cannot wait on `view.updating`.** Same root cause: it can
stay true indefinitely, which left the welcome screen stuck on "Loading the
scene…" over a perfectly usable scene. It now races a 25-second cap.

**Slides go stale when the scene is re-grouped.** A slide stores visibility as
a list of layer ids and switches off anything not on it. Adding the Broncos
Stampede splat put the existing mesh inside a *new* group, which no existing
slide names — so applying one switched the mesh on and its new parent off, and
a visible layer inside a hidden group draws nothing. Slides 2–5 silently
stopped showing the handheld capture and showed the drone mesh's melted horses
instead. `promoteVisibleAncestors()` in `layertree.js` runs after every
`applyTo` and makes any group holding a visible leaf visible itself; it can
only ever make effective what the slide already asked for. **The real fix is to
re-save the slides in Scene Viewer against the current scene** — that would also
let them include the new splat, which no slide currently names, so it stays off
when you pick a view.

**Slides used to open the compare by themselves.** They no longer do, and the
machinery for it is gone: it needed a settle-and-wait before the divider could
appear, which meant either a divider over a camera still flying or a long pause
where nothing happened, and either way it was something the app did to you.
Compare is started by hand. `settleView()` survives in `layertree.js` because
the thumbnail bake still needs it.

**The second view is kept warm, not built on demand.** Building it when
somebody asked to compare meant a whole scene streaming in from nothing at the
one moment they were watching — the capture visibly flashed in. It is now built
shortly after the welcome screen is dismissed and left alive with the divider
parked at 100%, clipped away to nothing but *still composited*, so it goes on
streaming. `stop()` parks it again rather than destroying it, so returning is
instant. The parked container must never become `display: none`: a view that is
not composited stops rendering, and warming it then achieves nothing.

`applySides()` only touches the base view while the divider is actually up —
a parked mirror must not go on dictating what the main view shows — which means
`showing` has to be set *before* `applySides()` in `start()`.

**Superseded — see `deriveCaptures()`.** The compare menu is not the layer tree. The comparison is drone against
handheld, so the menu offers four things — drone splat, drone mesh, all handheld
splat, all handheld mesh — and each is a *set* of layers: the handheld mesh is
three of them and they have to come up together. The two branches are found by
matching their titles (`BRANCHES` in `app.js`) rather than by position, and the
options are then derived by layer type, so re-grouping upstream does not need
this file edited. The chip beside the divider names the capture — DRONE,
HANDHELD — not the product; which product it is, is what the panes are showing.

**A leaf's `visible` flag is not what is on screen.** Two groups in this scene
use `visibilityMode: "exclusive"` — radio buttons, which the SDK enforces by
refusing to switch off the last visible child. So after `showOnly()` a fully
hidden branch can still contain a layer whose flag reads `true`; it draws
nothing, because the group above it is off. Anything asking what is actually
drawn has to walk from the root and AND the flags together. This cost an hour of
chasing a bug that was not there.

**Load time is the SDK, not the app.** Measured from navigation: about 16
seconds pass before a single line of `app.js` runs. That is the browser walking
the SDK's ES module graph from the CDN — hundreds of files, each import
discovered only after its parent has been fetched and parsed. Everything this
app does — view ready, scene loaded, shell built — is roughly 6 seconds on the
end of it.

Nothing in this repository can fix that, because it is the CDN ES module
delivery the SDK itself warns about on every load: *"Only use ES modules from
ArcGIS CDN for testing."* **The fix is a build step** — `npm i @arcgis/core`
and Vite, which bundles the graph into a couple of files and typically takes
this to a few seconds. That is the one change that would actually move the
number, and it costs the no-build simplicity this app was asked to keep.

What has been done short of that: the welcome screen no longer waits for tiles
to settle before letting anybody in (it used to burn a 25-second cap every load,
because `view.updating` does not reliably go false here), reading the mesh
modifications moved off the critical path, and `modulepreload` hints start the
module graph resolving during HTML parse rather than after `app.js` is fetched.
Together those are worth a couple of seconds against a 16-second head start.

**The mirror is stacked over the whole base view, not just the half it shows.**
`.view--compare` is `z-index: 2` over a `.view` at `auto`, so everything inside
the base view — including its own control stack and the attribution — paints
underneath it. The controls do not stop working, because the mirror takes no
pointer events; they just vanish, which is worse, because nothing looks broken
until somebody goes to click what is no longer there. `#viewDiv .esri-ui` is
lifted to `z-index: 4` to sit clear of it. Anything else added inside the view
container needs the same treatment.

Related: the chips naming each side track the divider, so a far-left divider
used to slide the left one under the compare button. They sit below the dock row
now, which cannot collide at any divider position.

**Do not lazy-load images into a hidden container.** The filmstrip is built
before its container is shown, and an `<img loading="lazy">` created inside a
hidden element never becomes "near the viewport" — the browser defers it and
does not reliably come back when the container appears. The strip rendered as
black boxes with the files serving fine and no 404 anywhere: `src` set,
`naturalWidth` 0. The strip is now shown before it is filled, and the images are
`eager`. Two files, twenty kilobytes each, already on disk — laziness bought
nothing and cost the pictures.

**`.swipe` is `pointer-events: none`, so anything put inside it must opt back
in.** The bar covering the scene has to let drags through to the view
underneath, which means every control placed in it is inert until it says
otherwise. The side pickers shipped broken for exactly this reason: the chip had
`pointer-events: auto` and its menu did not, so the menu drew perfectly and
swallowed nothing — clicks went straight through to the scene. `.swipe__side`
now opts in for the chip and the menu together.

**Test UI with real mouse events, not `element.click()`.** That bug passed every
check I had, because `.click()` dispatches straight at the node: it ignores
`pointer-events`, hit-testing, and anything drawn over the top. Nothing that
only calls `.click()` can tell a working control from a decorative one. The
harness that catches it drives `Input.dispatchMouseEvent` at real coordinates
and asserts `document.elementFromPoint()` returns the menu item.

Two things make that harness fragile, and both cost an hour before being
understood. `Input.dispatchMouseEvent` does **not** reach a window parked
offscreen at `-3000,0` — the events go nowhere and every check fails in a way
that reads as a broken app, so that one test has to run on screen. And this
machine runs at `devicePixelRatio: 1.25`, and which coordinate space CDP wants
has not been consistent between runs, so each real click verifies its effect and
retries scaled by the ratio before giving up.

**One menu implementation, three menus.** The dock's capture button and the two
side pickers all offer the same four and differ only in what they do with the
answer — `makeMenu(button, host, chosen, onPick)` in `app.js`. Adding a fourth
menu is three arguments, not another copy.

**Mesh modifications follow the compare.** They come off when the divider goes
up and back on when it comes down, because those are opposite jobs: the authored
clip, mask and replace polygons are what make the two surveys sit together as
one scene, and a drone mesh with a hole cut where the handheld capture goes has
nothing left to compare against. The button in the control stack overrides
either way at any time. The authored values are kept in a `WeakMap`, never
re-fetched, and the setting reaches the second view too — including one built
after the setting changed.

**"Have we arrived?" is not "has it finished loading?"** The divider on the
handheld slide waits for the first and not the second, because the second is
several seconds later and that is a long time to sit on a viewpoint wondering
whether anything is going to happen. `whenCameraStill()` watches `view.camera`
stop changing, which happens the moment the flight ends whatever the layers are
still doing. Measured: the divider now lands about a second after the camera,
where it used to be six seconds after the click.

That also means `slide.applyTo()` is no longer awaited at all. It writes its
camera and its layer visibility immediately and then animates; only its promise
is untrustworthy, so the camera is watched instead of the promise being waited
on. `whenCameraStill` does not start watching for a moment (`startAfterMs`),
because a flight asked for a millisecond ago has not moved anything yet and a
camera that has not moved reads exactly like one that has finished.

**Near-plane clipping.** Walk up to the statues and the renderer starts slicing
them away about 10 m in front of the camera. `nearplane.js` spends the depth
precision differently at low altitude; it is applied to both views, or the two
halves of the swipe clip at different distances. `?clipdebug` gives a live
readout.

**Deprecated widgets.** `DirectLineMeasurement3D`, `AreaMeasurement3D` and
`ElevationProfile` are deprecated in 5.x in favour of the map components. They
work and they log a warning. They are used here because they live in
`@arcgis/core` alongside everything else and drop straight into a panel of our
own; migrating means adding `@arcgis/map-components` as a second bundle. `Home`
is deprecated too, so it is a node from a `<template>` wearing the SDK's own
button classes, added with `view.ui.add(node, "top-right")`.

**`window.__view`** is a debugging handle and only that — nothing in the app
reads it. It is the only way to reach the layers from a console or a test.

## Credits

Imagery and elevation from Esri and its partners. Aerial capture processed with
ArcGIS Reality; terrestrial capture with PIX4Dcatch. Built with the ArcGIS Maps
SDK for JavaScript 5.1.

## Known issue

`tools/bake-thumbnails.py` currently captures nothing — it drives the app,
the offscreen view builds, the loop runs to completion, and no image comes back.
The shipped thumbnails in `assets/slides` are correct for all three current
slides, so the filmstrip is unaffected; but a slide re-authored from here needs
this fixed, or its picture hand-placed. Not yet diagnosed beyond ruling out the
`applyTo` hang, which was a separate bug in the same area.

## Two things the scene does that the app deliberately overrides

**`visibilityMode: "exclusive"`.** Two groups are authored as radio buttons: switch
one child on and its sibling goes off. Reasonable authoring, and fatal to four
independent switches — turning Drone Mesh on would silently turn Drone Gaussian
Splat off. Every group is set to `"independent"` in memory at load. The saved
scene is untouched.

**Partial captures.** A capture reads "on" if *any* of its layers is drawing,
not all of them — the scene does not always have all three handheld meshes on
at once, and demanding all three made the switch say "off" while two of them
were plainly on screen. Switching it off then clears all of them.
