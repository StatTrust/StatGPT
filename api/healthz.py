from http.server import BaseHTTPRequestHandler
import json, os

ALLOWED = [s.strip() for s in os.getenv("ALLOWED_ORIGINS", "*").split(",")]
ALLOW_ALL = "*" in ALLOWED

def _cors_headers(origin: str):
    h = {
        "content-type": "application/json",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
    }
    if ALLOW_ALL or not origin or origin in ALLOWED:
        h["access-control-allow-origin"] = origin or "*"
    return h

class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        origin = self.headers.get("origin", "")
        self.send_response(204)
        for k, v in _cors_headers(origin).items():
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self):
        origin = self.headers.get("origin", "")
        body = json.dumps({"ok": True}).encode()
        self.send_response(200)
        for k, v in _cors_headers(origin).items():
            self.send_header(k, v)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
