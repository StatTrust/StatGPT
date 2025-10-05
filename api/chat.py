import json, os
from openai import OpenAI

ALLOWED = [s.strip() for s in os.getenv("ALLOWED_ORIGINS", "*").split(",")]
ALLOW_ALL = "*" in ALLOWED
MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

def _cors_headers(origin):
    allow = "*" if ALLOW_ALL or not origin or origin in ALLOWED else ""
    h = {
        "content-type": "application/json",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
    }
    if allow:
        h["access-control-allow-origin"] = allow
    return h

def handler(request):
    method = request.get("method")
    origin = ""
    headers = request.get("headers") or {}
    for k,v in headers.items():
        if k.lower() == "origin":
            origin = v
            break

    if method == "OPTIONS":
        return {"statusCode": 204, "headers": _cors_headers(origin), "body": ""}

    if method != "POST":
        return {"statusCode": 405, "headers": {"content-type": "application/json"}, "body": json.dumps({"error": "method not allowed"})}

    try:
        raw = request.get("body") or "{}"
        if isinstance(raw, (bytes, bytearray)):
            raw = raw.decode("utf-8", "ignore")
        data = json.loads(raw)
        msg = (data.get("message") or "").strip()
        sys = data.get("system") or "You are StatGPT, a helpful assistant for sports data insights."
        mdl = data.get("model") or MODEL
        if not msg:
            return {"statusCode": 400, "headers": _cors_headers(origin), "body": json.dumps({"error": "message is required"})}

        completion = client.chat.completions.create(
            model=mdl,
            temperature=0.4,
            messages=[{"role":"system","content":sys},{"role":"user","content":msg}]
        )
        reply = (completion.choices[0].message.content or "").strip()
        return {"statusCode": 200, "headers": _cors_headers(origin), "body": json.dumps({"reply": reply, "model": mdl})}
    except Exception as e:
        return {"statusCode": 500, "headers": _cors_headers(origin), "body": json.dumps({"error": "server error", "detail": str(e)})}
