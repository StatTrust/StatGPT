import os
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()

app = FastAPI()

allowed = [s.strip() for s in os.getenv("ALLOWED_ORIGINS", "*").split(",")]
if "*" in allowed:
    allow_origins = ["*"]
else:
    allow_origins = allowed

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

class ChatIn(BaseModel):
    message: str = Field(min_length=1)
    system: str | None = None
    model: str | None = None

@app.get("/healthz")
async def healthz():
    return {"ok": True}

@app.post("/chat")
async def chat(payload: ChatIn):
    try:
        used_model = payload.model or os.getenv("OPENAI_MODEL", "gpt-4o-mini")
        completion = client.chat.completions.create(
            model=used_model,
            temperature=0.4,
            messages=[
                {"role": "system", "content": payload.system or "You are StatGPT, a helpful assistant for sports data insights."},
                {"role": "user", "content": payload.message},
            ],
        )
        reply = (completion.choices[0].message.content or "").strip()
        return {"reply": reply, "model": used_model}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", 8787)))
