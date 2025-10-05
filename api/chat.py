from http.server import BaseHTTPRequestHandler
import json, os
from openai import OpenAI

# Allowed origins (CORS)
ALLOWED = [s.strip() for s in os.getenv("ALLOWED_ORIGINS", "*").split(",")]
ALLOW_ALL = "*" in ALLOWED

# Default model
MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

# Initialize OpenAI client
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

def _cors_headers(origin: str):
    """Return proper CORS headers based on origin."""
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
        """Handle preflight CORS request."""
        origin = self.headers.get("origin", "")
        self.send_response(204)
        for k, v in _cors_headers(origin).items():
            self.send_header(k, v)
        self.end_headers()

    def do_POST(self):
        """Handle main chat request."""
        origin = self.headers.get("origin", "")

        try:
            # Read request body
            length = int(self.headers.get("content-length", "0"))
            raw = self.rfile.read(length) if length > 0 else b"{}"
            data = json.loads(raw.decode() or "{}")

            # Extract parameters
            msg = (data.get("message") or "").strip()
            sys = data.get("system") or "You are StatGPT, a helpful assistant for sports data insights."
            mdl = data.get("model") or MODEL

            # Missing message check
            if not msg:
                body = json.dumps({"error": "message is required"}).encode()
                self.send_response(400)
            else:
                # Generate completion (no temperature param)
                completion = client.chat.completions.create(
                    model=mdl,
                    messages=[
                        {"role": "system", "content": sys},
                        {"role": "user", "content": msg},
                    ],
                )

                reply = (completion.choices[0].message.content or "").strip()
                body = json.dumps({"reply": reply, "model": mdl}).encode()
                self.send_response(200)

        except Exception as e:
            # Handle server errors gracefully
            body = json.dumps({"error": "server error", "detail": str(e)}).encode()
            self.send_response(500)

        # Send headers + body
        for k, v in _cors_headers(origin).items():
            self.send_header(k, v)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
