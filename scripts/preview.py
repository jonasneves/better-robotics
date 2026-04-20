#!/usr/bin/env python3
"""Local dev server for the dashboard.

`python3 -m http.server` advertises HTTP/1.1 and lets Chrome's connection pool
keep connections alive after each request. When the dashboard loads ~30 module
files in parallel, Chrome's 6-per-origin HTTP/1.1 limit fills, some connections
stall keep-alive-style instead of closing cleanly, and the last few module
fetches end up stuck at (pending) indefinitely. Visible symptom: some .js
files show "pending" in DevTools' Network panel even though curl to the same
URL returns instantly.

Forcing HTTP/1.0 (which defaults to Connection: close) makes Chrome open a
fresh TCP connection per request. Slight per-request overhead on loopback
is negligible, and the stall-pattern disappears.
"""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import os
import sys


class NoKeepAliveHandler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.0"


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    root = sys.argv[2] if len(sys.argv) > 2 else "public"
    os.chdir(root)
    with ThreadingHTTPServer(("", port), NoKeepAliveHandler) as httpd:
        print(f"Serving {root}/ at http://localhost:{port}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print()


if __name__ == "__main__":
    main()
