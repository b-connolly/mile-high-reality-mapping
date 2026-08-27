"""Bake the filmstrip thumbnails into assets/slides.

The app ships its thumbnails as files; this is what produces them. Run it after
re-authoring the slides in Scene Viewer, or after adding one - a slide with no
file falls back to the thumbnail Scene Viewer stored on it, which is usually
letterboxed and sometimes half-loaded, so it is worth re-baking.

It drives the app itself with `?thumbs=refresh`, which makes the app re-take
every picture from the live scene on an offscreen view, then writes each one to
assets/slides/<slide id>.jpg. Keyed by slide id rather than position, so
reordering the slides cannot silently shuffle the pictures.

Needs the dev server up and a real GPU - software rendering does not produce a
usable capture:

    python serve.py                       # in one terminal
    python tools/bake-thumbnails.py       # in another

Chrome runs with a real window, parked offscreen; it closes itself when done.
"""
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

import websocket

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
URL = "http://localhost:8778/index.html?thumbs=refresh"
PORT = 9240
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "assets", "slides")

profile = tempfile.mkdtemp(prefix="bake-")
proc = subprocess.Popen(
    [CHROME, f"--remote-debugging-port={PORT}", "--remote-allow-origins=*",
     f"--user-data-dir={profile}", "--no-first-run", "--no-default-browser-check",
     "--window-size=1500,950", "--window-position=-3000,0"],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

ws = None
for _ in range(120):
    try:
        for t in json.loads(urllib.request.urlopen(f"http://localhost:{PORT}/json").read()):
            if t["type"] == "page":
                ws = websocket.create_connection(t["webSocketDebuggerUrl"], timeout=120,
                                                 suppress_origin=True)
                break
    except Exception:
        pass
    if ws:
        break
    time.sleep(0.5)
if not ws:
    proc.terminate()
    raise SystemExit("could not attach - is serve.py running on 8778?")

mid = 0


def send(method, **params):
    global mid
    mid += 1
    ws.send(json.dumps({"id": mid, "method": method, "params": params}))
    while True:
        f = json.loads(ws.recv())
        if f.get("id") == mid:
            if "error" in f:
                raise RuntimeError(f"{method}: {f['error']}")
            return f.get("result", {})


def js(expression):
    r = send("Runtime.evaluate", expression=expression, returnByValue=True, awaitPromise=True)
    if r.get("exceptionDetails"):
        return "THREW " + str(r["exceptionDetails"].get("text"))
    return r["result"].get("value")


try:
    send("Runtime.enable")
    send("Page.navigate", url=URL)

    print("waiting for the scene")
    for _ in range(300):
        time.sleep(1)
        if js("document.getElementById('splashEnter').disabled === false") is True:
            break
    else:
        raise SystemExit("the app never finished loading")

    js("document.getElementById('splashEnter').click()")

    print("waiting for every thumbnail to be re-taken")
    total = js("document.querySelectorAll('#filmTrack .slide img').length")
    for _ in range(180):
        time.sleep(1)
        if js("window.__thumbCount ?? 0") == total:
            break
    got = js("window.__thumbCount ?? 0")
    print(f"  {got} of {total} captured")
    if got != total:
        raise SystemExit("not all slides captured - not baking a partial set")

    rows = js("""(() => {
      const slides = window.__view.map.presentation.slides.toArray();
      const imgs = [...document.querySelectorAll('#filmTrack .slide img')];
      return slides.map((s, i) => ({
        id: s.id, title: s.title.text, src: imgs[i] ? imgs[i].src : null }));
    })()""")

    os.makedirs(OUT, exist_ok=True)
    manifest = []
    for row in rows:
        if not row["src"] or not row["src"].startswith("data:image"):
            print(f"  SKIP {row['title']}: no captured image")
            continue
        raw = base64.b64decode(row["src"].split(",", 1)[1])
        name = f"{row['id']}.jpg"
        with open(os.path.join(OUT, name), "wb") as fh:
            fh.write(raw)
        manifest.append({"id": row["id"], "title": row["title"], "bytes": len(raw)})
        print(f"  wrote {name:<28} {len(raw):>7,} bytes   {row['title']}")

    print(f"\n{len(manifest)} thumbnails written to {OUT}")
finally:
    try:
        ws.close()
        proc.terminate()
        proc.wait(10)
    except Exception:
        pass
    shutil.rmtree(profile, ignore_errors=True)
