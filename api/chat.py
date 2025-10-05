from http.server import BaseHTTPRequestHandler
import json, os
from openai import OpenAI

ALLOWED = [s.strip() for s in os.getenv("ALLOWED_ORIGINS", "*").split(",")]
ALLOW_ALL = "*" in ALLOWED
MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

def _cors_headers(origin: str) -> dict[str, str]:
    headers = {
        "content-type": "application/json",
        "access-control-allow-methods": "POST, OPTIONS",
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

    def do_POST(self):
        origin = self.headers.get("origin", "")
        try:
            length = int(self.headers.get("content-length", "0"))
            raw = self.rfile.read(length) if length > 0 else b"{}"
            data = json.loads(raw.decode("utf-8") or "{}")

            message = (data.get("message") or "").strip()
            system = data.get("system") or "You are StatGPT, a helpful assistant for sports data insights."
            model = data.get("model") or MODEL

            if not message:
                body = json.dumps({"error": "message is required"}).encode("utf-8")
                self.send_response(400)
                for k, v in _cors_headers(origin).items():
                    self.send_header(k, v)
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return

            completion = client.chat.completions.create(
                model=model,
                temperature=0.4,
                messages=[{"role": "system", "content": system},
                          {"role": "user", "content": message}],
            )
            reply = (completion.choices[0].message.content or "").strip()
            body = json.dumps({"reply": reply, "model": model}).encode("utf-8")

            self.send_response(200)
            for k, v in _cors_headers(origin).items():
                self.send_header(k, v)
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        except Exception as e:
            body = json.dumps({"error": "server error", "detail": str(e)}).encode("utf-8")
            self.send_response(500)
            for k, v in _cors_headers(origin).items():
                self.send_header(k, v)
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
