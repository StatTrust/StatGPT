from http.server import BaseHTTPRequestHandler
import json
import os

ALLOWED = [s.strip() for s in os.getenv("ALLOWED_ORIGINS", "*").split(",")]
ALLOW_ALL = "*" in ALLOWED

def _cors_headers(origin: str) -> dict[str, str]:
    headers = {
        "content-type": "application/json",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "content-type",
    }
    if ALLOW_ALL or not origin or origin in ALLOWED:
        headers["access-control-allow-origin"] = origin or "*"
    return headers

class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        origin = self.headers.get("origin", "")
        for k, v in _cors_headers(origin).items():
            self.send_header(k, v)
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        origin = self.headers.get("origin", "")
        body = json.dumps({"ok": True}).encode("utf-8")
        self.send_response(200)
        for k, v in _cors_headers(origin).items():
            self.send_header(k, v)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
