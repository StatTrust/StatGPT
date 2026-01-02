# api/chat.py
import os
import json
import re
import urllib.request
import urllib.parse
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse

from openai import OpenAI

# ---------------------------
# Config
# ---------------------------
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "").strip()

# Default text model (kept as-is)
DEFAULT_MODEL = os.environ.get("OPENAI_MODEL", "gpt-5-mini").strip()

# Optional: separate model for vision (falls back to DEFAULT_MODEL if unset)
DEFAULT_VISION_MODEL = os.environ.get("OPENAI_VISION_MODEL", "").strip() or DEFAULT_MODEL

# Optional: if you store attachments in a public bucket/CDN, set this (ex: https://cdn.stat-trust.com/)
ATTACHMENTS_PUBLIC_BASE_URL = os.environ.get("ATTACHMENTS_PUBLIC_BASE_URL", "").strip().rstrip("/")

DEFAULT_SYSTEM = (
    os.environ.get(
        "STATGPT_SYSTEM",
        "You are StatGPT. Be concise, factual, and sports-savvy.",
    )
    .strip()
)

DEFAULT_MAX_TOKENS = int(os.environ.get("STATGPT_MAX_TOKENS", "1500"))
DEFAULT_TEMPERATURE = float(os.environ.get("STATGPT_TEMPERATURE", "0.3"))

# If you want to allow your router/server to call this with a shared secret:
# - Set STATGPT_SHARED_SECRET in Vercel env
# - Send header: x-stattrust-secret: <value>
SHARED_SECRET = os.environ.get("STATGPT_SHARED_SECRET", "").strip()

client = OpenAI(api_key=OPENAI_API_KEY)


def _safe_json_loads(s: str):
    try:
        return json.loads(s)
    except Exception:
        return None


def _get_kv_rest_config():
    """
    Supports both Upstash and Vercel KV env var names.
    Returns (rest_url, token) or (None, None).
    """
    candidates = [
        ("UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"),
        ("KV_REST_API_URL", "KV_REST_API_TOKEN"),
    ]
    for url_k, tok_k in candidates:
        rest_url = (os.environ.get(url_k) or "").strip().rstrip("/")
        token = (os.environ.get(tok_k) or "").strip()
        if rest_url and token:
            return rest_url, token
    return None, None


def _kv_hget(rest_url: str, token: str, key: str, field: str):
    try:
        k = urllib.parse.quote(str(key), safe="")
        f = urllib.parse.quote(str(field), safe="")
        url = f"{rest_url}/hget/{k}/{f}"
        req = urllib.request.Request(
            url,
            headers={"Authorization": f"Bearer {token}"},
            method="GET",
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            raw = resp.read().decode("utf-8", errors="ignore")
        data = _safe_json_loads(raw) or {}
        return data.get("result")
    except Exception:
        return None


def _coerce_to_input_parts(content):
    """
    Convert various message content formats into Responses API content parts.
    Supports:
      - string -> [{"type":"input_text","text":...}]
      - chat.completions style list parts -> convert ("text"/"image_url") to ("input_text"/"input_image")
      - already Responses-style parts -> pass through
    """
    if content is None:
        return []

    # Plain string
    if isinstance(content, str):
        return [{"type": "input_text", "text": content}]

    # Already list of parts
    if isinstance(content, list):
        parts = []
        for p in content:
            if isinstance(p, str):
                parts.append({"type": "input_text", "text": p})
                continue

            if not isinstance(p, dict):
                continue

            ptype = p.get("type")

            # Already Responses-style
            if ptype in ("input_text", "input_image", "input_file"):
                parts.append(p)
                continue

            # Chat Completions style
            if ptype == "text":
                parts.append({"type": "input_text", "text": p.get("text", "")})
                continue

            if ptype == "image_url":
                img = p.get("image_url") or {}
                if isinstance(img, dict):
                    url = img.get("url") or ""
                else:
                    url = str(img)
                if url:
                    parts.append({"type": "input_image", "image_url": url})
                continue

            # Unknown: best effort treat as text-ish
            if "text" in p and isinstance(p["text"], str):
                parts.append({"type": "input_text", "text": p["text"]})
                continue

        return parts

    # Dict (rare) -> best effort
    if isinstance(content, dict):
        if "text" in content and isinstance(content["text"], str):
            return [{"type": "input_text", "text": content["text"]}]
        # If it's already a part-like dict
        if content.get("type") in ("input_text", "input_image", "input_file"):
            return [content]

    return [{"type": "input_text", "text": str(content)}]


def _normalize_attachment(att: dict):
    """
    Normalize an attachment object into a Responses API input_image part when possible.
    Supports:
      - { url / image_url }
      - { dataUrl / data_url } (base64 data URL)
      - { base64 } (+mime) (raw base64 => convert to data URL)
      - { bytes_base64 } (+mime) (raw base64 => convert to data URL)
      - { key } (+ATTACHMENTS_PUBLIC_BASE_URL)
      - { file_id } => input_file
    """
    if not isinstance(att, dict):
        return None

    # File ID (Files API)
    file_id = att.get("file_id") or att.get("fileId")
    if isinstance(file_id, str) and file_id.strip():
        return {"type": "input_file", "file_id": file_id.strip()}

    # Direct URL
    url = att.get("image_url") or att.get("url")
    if isinstance(url, str) and url.strip():
        return {"type": "input_image", "image_url": url.strip()}

    # Data URL
    data_url = att.get("dataUrl") or att.get("data_url") or att.get("dataURL")
    if isinstance(data_url, str) and data_url.strip().startswith("data:"):
        return {"type": "input_image", "image_url": data_url.strip()}

    # Raw base64 (convert)
    b64 = att.get("bytes_base64") or att.get("base64") or att.get("b64")
    mime = (att.get("mime") or att.get("contentType") or "image/png").strip()
    if isinstance(b64, str) and b64.strip():
        # if it's already data URL-ish, keep
        if b64.strip().startswith("data:"):
            return {"type": "input_image", "image_url": b64.strip()}
        return {"type": "input_image", "image_url": f"data:{mime};base64,{b64.strip()}"}

    # Key -> public base url
    key = att.get("key")
    if isinstance(key, str) and key.strip() and ATTACHMENTS_PUBLIC_BASE_URL:
        # key may already include "attachments/..."
        return {"type": "input_image", "image_url": f"{ATTACHMENTS_PUBLIC_BASE_URL}/{key.strip().lstrip('/')}"}

    return None


def _extract_attachments(data: dict):
    """
    Accept both:
      - attachments: [ { ... } ]
      - attachment: { ... }  (or JSON string)
    Returns a list of normalized parts (input_image/input_file).
    """
    parts = []

    atts = data.get("attachments")
    if isinstance(atts, list):
        for a in atts:
            p = _normalize_attachment(a)
            if p:
                parts.append(p)

    att = data.get("attachment")
    if isinstance(att, str):
        maybe = _safe_json_loads(att)
        if isinstance(maybe, dict):
            att = maybe
    if isinstance(att, dict):
        p = _normalize_attachment(att)
        if p:
            parts.append(p)

    return parts


def normalize_confidence(reply: str) -> str:
    """
    Ensures the reply includes a final:
      Signal: ...
      Confidence: Low/Medium/High (NN%) ...

    IMPORTANT:
    - Do NOT get tricked by "Leg Confidence: 75%" lines.
    - Only treat a line that STARTS with Confidence: (optionally bolded) as the final confidence line.
    """
    if not reply:
        return reply

    # Ensure Signal exists somewhere (prefer line-start, optionally bolded)
    if not re.search(r"(?mi)^\s*(?:\*\*)?Signal(?:\*\*)?:\s*", reply):
        reply = reply.rstrip() + "\n\nSignal: See notes above"

    # Match ONLY line-start Confidence (optionally bolded), so we ignore "Leg Confidence:"
    conf_re = re.compile(
        r"(?mi)^(?P<prefix>\s*(?:\*\*)?Confidence(?:\*\*)?:\s*)(?P<body>.+)$"
    )
    matches = list(conf_re.finditer(reply))

    # If Confidence line is missing entirely, append a sensible default
    if not matches:
        reply = reply.rstrip() + "\nConfidence: Medium (60%)"
        return reply

    last = matches[-1]
    prefix = last.group("prefix")
    body = last.group("body").strip()

    # If final Confidence already has a %, leave it alone
    # (this is ONLY the final line-start Confidence, not per-leg)
    if re.search(r"\d{1,3}\s*%", body):
        return reply

    # Map tiers -> default % if model omitted the percent
    mapping = {
        "verylow": "25%",
        "low": "40%",
        "medium": "60%",
        "high": "75%",
        "veryhigh": "85%",
    }

    # If body starts with a tier word, inject "(NN%)" right after it, preserving the rest (e.g. "– blah blah")
    m = re.match(r"(Very\s*Low|Low|Medium|High|Very\s*High)\b(?P<tail>.*)$", body, re.I)
    if m:
        tier = m.group(1)
        tail = m.group("tail") or ""
        key = tier.lower().replace(" ", "")
        pct = mapping.get(key, "60%")
        new_line = f"{prefix}{tier} ({pct}){tail}"
    else:
        # Fallback if it's some weird format
        new_line = f"{prefix}{body} (60%)"

    # Replace ONLY the final confidence line
    reply = reply[: last.start()] + new_line + reply[last.end() :]
    return reply


class Handler(BaseHTTPRequestHandler):
    def _set_headers(self, status=200, content_type="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)

        # CORS (kept permissive)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type, Authorization, x-stattrust-secret",
        )
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_OPTIONS(self):
        self._set_headers(200, "text/plain")
        self.wfile.write(b"ok")

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path.endswith("/healthz") or parsed.path.endswith("/health"):
            self._set_headers(200, "application/json")
            self.wfile.write(json.dumps({"ok": True}).encode("utf-8"))
            return
        self._set_headers(404, "application/json")
        self.wfile.write(json.dumps({"error": "Not found"}).encode("utf-8"))

    def do_POST(self):
        # Optional shared-secret protection (does nothing unless you set STATGPT_SHARED_SECRET)
        if SHARED_SECRET:
            got = (self.headers.get("x-stattrust-secret") or "").strip()
            if got != SHARED_SECRET:
                self._set_headers(401, "application/json")
                self.wfile.write(json.dumps({"error": "Unauthorized"}).encode("utf-8"))
                return

        length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(length).decode("utf-8", errors="ignore")

        try:
            data = json.loads(raw_body) if raw_body else {}
        except Exception:
            self._set_headers(400, "application/json")
            self.wfile.write(json.dumps({"error": "Invalid JSON"}).encode("utf-8"))
            return

        try:
            model = (data.get("model") or DEFAULT_MODEL).strip()
            messages = data.get("messages") or []
            system = (data.get("system") or DEFAULT_SYSTEM).strip()
            temperature = float(data.get("temperature", DEFAULT_TEMPERATURE))
            max_tokens = int(data.get("max_tokens", DEFAULT_MAX_TOKENS))

            mode = (data.get("mode") or "").strip().lower()
            is_extract = mode in ("extract", "slip_extract", "vision_extract")

            # Attachments (new)
            attachment_parts = _extract_attachments(data)
            has_attachments = len(attachment_parts) > 0

            # If they didn't send messages, accept "message/userMessage/prompt/text" fields
            if not messages:
                prompt = (
                    data.get("message")
                    or data.get("userMessage")
                    or data.get("prompt")
                    or data.get("text")
                    or ""
                )
                if prompt:
                    messages = [{"role": "user", "content": prompt}]

            # ---- Inject compiled stats + slip JSON if present ----
            compiled_inline = data.get("compiledInline") or data.get("compiledText") or None
            if isinstance(compiled_inline, (dict, list)):
                compiled_inline = json.dumps(compiled_inline, ensure_ascii=False)

            # ✅ NEW: if compiledInline is missing, try compiledPointer (stored in KV as a hash with field "blob")
            if not compiled_inline:
                compiled_ptr = data.get("compiledPointer") or data.get("compiled_pointer") or None
                if isinstance(compiled_ptr, str) and compiled_ptr.strip():
                    rest_url, token = _get_kv_rest_config()
                    if not rest_url or not token:
                        raise Exception("compiledPointer provided but KV REST credentials are missing (set UPSTASH_REDIS_REST_URL/TOKEN or KV_REST_API_URL/TOKEN).")

                    blob = _kv_hget(rest_url, token, compiled_ptr.strip(), "blob")
                    if not blob:
                        raise Exception(f"compiledPointer provided but blob not found in KV (key={compiled_ptr}).")

                    compiled_inline = blob

            slip_raw = data.get("slipRaw") or data.get("slip") or None
            if isinstance(slip_raw, (dict, list)):
                slip_raw = json.dumps(slip_raw, ensure_ascii=False)

            if compiled_inline:
                system += "\n\nCOMPILED_STATS_JSON:\n" + str(compiled_inline)

            if slip_raw:
                system += "\n\nSLIP_EXTRACT_JSON:\n" + str(slip_raw)

            if mode == "extract":
                system += "\n\nReturn ONLY valid JSON. No markdown. No extra text."

            # For extract mode, do NOT append the generic "Guidelines" block.
            # That block encourages descriptive answers and can break JSON-only extraction.
            if is_extract:
                refined_system = system
                temperature = 0.0  # optional but recommended for deterministic extraction
            else:
                refined_system = (
                    system
                    + "\n\n"
                    + "Guidelines:\n"
                    + "- Answer like a helpful sports analyst.\n"
                    + "- If an image is provided, you CAN analyze it (including reading text in it).\n"
                    + "- Keep it concise. Use bullets when helpful.\n"
                    + "- Do not mention internal tools or infrastructure.\n"
                )

            # Build Responses API input messages
            input_msgs = []

            # system message first
            input_msgs.append(
                {
                    "role": "system",
                    "content": [{"type": "input_text", "text": refined_system}],
                }
            )

            # normalize provided messages
            normalized = []
            for m in messages:
                if not isinstance(m, dict):
                    continue
                role = (m.get("role") or "user").strip()
                content = m.get("content")
                parts = _coerce_to_input_parts(content)
                normalized.append({"role": role, "content": parts})

            # If we have attachments, append them to the last user message (or add a user message)
            if has_attachments:
                # prefer using a vision-capable model if configured
                model = DEFAULT_VISION_MODEL

                # find last user msg
                idx = None
                for i in range(len(normalized) - 1, -1, -1):
                    if normalized[i].get("role") == "user":
                        idx = i
                        break

                if idx is None:
                    normalized.append(
                        {
                            "role": "user",
                            "content": [{
                                "type": "input_text",
                                "text": (
                                    "Extract the betting slip into structured fields. Return ONLY the extracted fields; no commentary."
                                    if is_extract else
                                    "Analyze the attached image(s)."
                                )
                            }]
                            + attachment_parts,
                        }
                    )
                else:
                    normalized[idx]["content"] = (normalized[idx].get("content") or []) + attachment_parts

            input_msgs.extend(normalized)

            # Call OpenAI (Responses API so vision works)
            resp = client.responses.create(
                model=model,
                input=input_msgs,
                temperature=temperature,
                max_output_tokens=max_tokens,
            )

            reply_text = getattr(resp, "output_text", None) or ""
            
            # Normalize confidence to ensure it's always a percentage
            reply_text = normalize_confidence(reply_text)
            
            usage = getattr(resp, "usage", None)
            usage_dict = None
            if usage:
                # best-effort serialization
                usage_dict = {}
                for k in ("input_tokens", "output_tokens", "total_tokens"):
                    if hasattr(usage, k):
                        usage_dict[k] = getattr(usage, k)

            self._set_headers(200, "application/json")
            self.wfile.write(
                json.dumps(
                    {
                        "reply": reply_text,
                        "usage": usage_dict,
                        "model": model,
                        "has_attachments": has_attachments,
                    }
                ).encode("utf-8")
            )

        except Exception as e:
            self._set_headers(500, "application/json")
            self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))
