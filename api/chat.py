from http.server import BaseHTTPRequestHandler
import json, os
from openai import OpenAI

ALLOWED = [s.strip() for s in os.getenv("ALLOWED_ORIGINS", "*").split(",")]
ALLOW_ALL = "*" in ALLOWED
MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

def _cors_headers(origin: str):
    h = {
        "content-type": "application/json",
        "access-control-allow-methods": "POST, OPTIONS",
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

    def do_POST(self):
        origin = self.headers.get("origin", "")
        try:
            length = int(self.headers.get("content-length", "0"))
            raw = self.rfile.read(length) if length > 0 else b"{}"
            data = json.loads(raw.decode() or "{}")
            msg = (data.get("message") or "").strip()
            sys = data.get("system") or "You are StatGPT, a helpful assistant for sports data insights."
            mdl = data.get("model") or MODEL
            if not msg:
                body = json.dumps({"error": "message is required"}).encode()
                self.send_response(400)
            else:
                completion = client.chat.completions.create(
                    model=mdl, temperature=0.4,
                    messages=[{"role":"system","content":sys},{"role":"user","content":msg}]
                )
                reply = (completion.choices[0].message.content or "").strip()
                body = json.dumps({"reply": reply, "model": mdl}).encode()
                self.send_response(200)
        except Exception as e:
            body = json.dumps({"error": "server error", "detail": str(e)}).encode()
            self.send_response(500)

        for k, v in _cors_headers(origin).items():
            self.send_header(k, v)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
