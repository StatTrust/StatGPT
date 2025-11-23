from http.server import BaseHTTPRequestHandler
import json, os, re
from openai import OpenAI
import httpx

# Allowed origins (CORS)
ALLOWED = [s.strip() for s in os.getenv("ALLOWED_ORIGINS", "*").split(",")]
ALLOW_ALL = "*" in ALLOWED

# Default model
MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

# Upstash (for pointer retrieval)
UPSTASH_URL = os.getenv("UPSTASH_REDIS_REST_URL", "").rstrip("/")
UPSTASH_TOKEN = os.getenv("UPSTASH_REDIS_REST_TOKEN", "")

# Inline summarization limits
MAX_SECTIONS_INLINE = int(os.getenv("MAX_SECTIONS_INLINE", "12"))  # limit section summaries
MAX_SECTION_CHARS = int(os.getenv("MAX_SECTION_CHARS", "1800"))    # cap each summarized section

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

def fetch_pointer_blob(pointer_key: str) -> str:
    """
    Fetch the 'blob' field from an Upstash Redis hash: HGET <pointer_key> blob.
    Expected Node side stored: kv.hset(pointerKey, { blob: <compiledJson>, bytes: <int>, ts: <timestamp> })
    """
    if not UPSTASH_URL or not UPSTASH_TOKEN:
        raise RuntimeError("Upstash REST not configured (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)")
    url = f"{UPSTASH_URL}/hget/{pointer_key}/blob"
    headers = {"Authorization": f"Bearer {UPSTASH_TOKEN}"}
    with httpx.Client(timeout=30.0) as http:
        r = http.get(url, headers=headers)
    if r.status_code != 200:
        raise RuntimeError(f"Upstash HGET failed ({r.status_code}): {r.text}")
    data = r.json()
    blob = data.get("result")
    if blob is None:
        raise RuntimeError(f"Pointer not found or blob missing for key: {pointer_key}")
    return blob

def extract_fallback_from_system(system_text: str) -> str | None:
    """
    Backward compatibility: Extract raw JSON inside <COMPILED_JSON>...</COMPILED_JSON>.
    Remove this once all callers send compiledInline/compiledPointer.
    """
    if not system_text:
        return None
    m = re.search(r"<COMPILED_JSON>([\s\S]*?)</COMPILED_JSON>", system_text)
    if not m:
        return None
    return m.group(1).strip()

def load_compiled(data: dict) -> tuple[dict, str]:
    """
    Returns (compiled_dict, source_mode) where source_mode is:
    'inline', 'pointer', 'system-fallback'.
    Raises ValueError if JSON invalid or nothing found.
    """
    # Priority 1: compiledInline
    inline = data.get("compiledInline")
    if inline:
        try:
            return json.loads(inline), "inline"
        except Exception as e:
            raise ValueError(f"compiledInline invalid JSON: {e}")

    # Priority 2: compiledPointer
    pointer = data.get("compiledPointer")
    if pointer:
        try:
            blob = fetch_pointer_blob(pointer)
        except Exception as e:
            raise ValueError(f"Failed to fetch pointer '{pointer}': {e}")
        try:
            return json.loads(blob), "pointer"
        except Exception as e:
            raise ValueError(f"Pointer blob invalid JSON: {e}")

    # Priority 3: system fallback
    system_text = data.get("system") or ""
    extracted = extract_fallback_from_system(system_text)
    if extracted:
        try:
            return json.loads(extracted), "system-fallback"
        except Exception as e:
            raise ValueError(f"Fallback system JSON invalid: {e}")

    raise ValueError("No compiledInline, compiledPointer, or <COMPILED_JSON> fallback provided.")

def summarize_compiled(compiled: dict) -> str:
    """
    Build a concise textual summary to give model enough structure
    without dumping entire massive JSON again.
    - Include meta
    - Include a teaser of sections (titles + truncated content length)
    """
    meta = compiled.get("meta", {})
    prompt = compiled.get("prompt", "")
    sections = compiled.get("sections", {})
    lines = []
    if meta:
        matchup_title = meta.get("matchupTitle") or meta.get("matchupId") or "Unknown Matchup"
        league = meta.get("league") or ""
        compiled_at = meta.get("compiledAt") or ""
        lines.append(f"Matchup: {matchup_title}")
        if league:
            lines.append(f"League: {league}")
        if compiled_at:
            lines.append(f"CompiledAt: {compiled_at}")
    if prompt:
        # Show only first 300 chars of prompt to avoid huge injection
        lines.append(f"TemplatePrompt(first300): {prompt[:300].replace('\\n',' ')}{'...' if len(prompt)>300 else ''}")

    # Sections summary
    if isinstance(sections, dict) and sections:
        lines.append(f"SectionsCount: {len(sections)}")
        count = 0
        for sec_title, per_cat in sections.items():
            if count >= MAX_SECTIONS_INLINE:
                lines.append(f"...({len(sections)-count} more sections truncated in summary)")
                break
            # Summarize categories present
            cat_names = list(per_cat.keys())
            sec_line = f"Section: {sec_title} (categories: {', '.join(cat_names)})"
            # Optionally include truncated JSON snippet
            try:
                snippet = json.dumps(per_cat)[:MAX_SECTION_CHARS]
                if len(json.dumps(per_cat)) > MAX_SECTION_CHARS:
                    snippet += "...(truncated snippet)"
                sec_line += f" snippet={snippet}"
            except Exception:
                pass
            lines.append(sec_line)
            count += 1
    else:
        lines.append("Sections: none or not a dict")

    return "\n".join(lines)

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

            # ✅ Backward-compatible message extraction
            msg = (
                data.get("message")
                or data.get("userMessage")
                or data.get("user_message")
                or data.get("text")
                or ""
            ).strip()

            # ✅ Backward-compatible system/prompt extraction
            system = (
                data.get("system")
                or data.get("prompt")
                or data.get("promptText")
                or data.get("prompt_text")
                or "You are StatGPT, a helpful assistant for sports data insights."
            )

            model = data.get("model") or MODEL

            if not msg:
                body = json.dumps({"error": "message is required"}).encode()
                self.send_response(400)
            else:
                # Load compiled JSON (no truncation)
                compiled = {}
                source_mode = "none"
                error_compiled = None
                try:
                    compiled, source_mode = load_compiled(data)
                except ValueError as e:
                    error_compiled = str(e)

                if error_compiled:
                    # You can choose to hard fail OR proceed without compiled context.
                    body = json.dumps({"error": "compiled load failed", "detail": error_compiled}).encode()
                    self.send_response(400)
                else:
                    # Build a refined system context (no huge inline JSON)
                    summary = summarize_compiled(compiled)
                    refined_system = (
                        f"{system}\n\n"
                        f"Compiled Source Mode: {source_mode}\n"
                        f"Structured Summary:\n{summary}\n\n"
                        f"IMPORTANT:\nUse only the summarized structure plus the internal parsed data you have (not shown entirely here) for factual reasoning. "
                        f"Do NOT hallucinate beyond available sections and meta.\n"
                    )

                    # Create chat completion
                    completion = client.chat.completions.create(
                        model=model,
                        messages=[
                            {"role": "system", "content": refined_system},
                            {"role": "user", "content": msg},
                        ],
                    )

                    reply = (completion.choices[0].message.content or "").strip()
                    body = json.dumps({
                        "reply": reply,
                        "model": model,
                        "sourceMode": source_mode,
                        "hasMeta": bool(compiled.get("meta")),
                        "sectionsCount": len(compiled.get("sections", {}) or {}),
                    }).encode()
                    self.send_response(200)

        except Exception as e:
            body = json.dumps({"error": "server error", "detail": str(e)}).encode()
            self.send_response(500)

        for k, v in _cors_headers(origin).items():
            self.send_header(k, v)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
