"""Development server for the app, with caching turned off.

`python -m http.server` sends only `Last-Modified`. With no `Cache-Control` the
browser is entitled to guess how long a file stays fresh - the usual guess is a
tenth of its age - and it may then serve its cached copy without asking the
server at all. For a file edited minutes ago that guess is often "long enough",
so a reload quietly runs yesterday's code.

That bites hard here because everything is loaded as an ES module: the browser
can decide independently for each one, so you end up running a mix of old and
new files and reasonably conclude the change did not work. It is not obvious
from the page, and there is nothing in the console to say so.

This sends `no-store` on everything instead, so every reload fetches. Slower,
and exactly what you want while editing.

    python serve.py           # http://localhost:8778
    python serve.py 8080      # somewhere else

Files are served from this script's own folder, so it can be started from
anywhere. For a real deployment do the opposite of this - see README.md.
"""
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = 8778


class NoStore(SimpleHTTPRequestHandler):
    """Everything, every time."""

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    root = os.path.dirname(os.path.abspath(__file__))
    os.chdir(root)
    server = ThreadingHTTPServer(("", port), NoStore)
    print(f"serving {root}")
    print(f"  http://localhost:{port}   (no-store: every reload refetches)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
