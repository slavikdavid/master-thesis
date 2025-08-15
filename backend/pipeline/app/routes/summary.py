# app/routes/summary.py
import os
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from haystack.dataclasses import ChatMessage
from haystack.components.generators.chat import OpenAIChatGenerator
from haystack.utils import Secret

router = APIRouter(tags=["summary"], prefix="/v2")

class SummarizeRequest(BaseModel):
    texts: list[str]
    concise: bool = True

@router.post("/summarize")
def summarize(req: SummarizeRequest):
    key = os.getenv("GROQ_API_KEY")
    if not key: raise HTTPException(500, "GROQ_API_KEY not set")
    template = "Summarize the following text{plural} {style}:\n\n{content}\n\nSummary:"
    plural = "s" if len(req.texts)>1 else ""
    style  = "briefly" if req.concise else "in detail"
    content = "\n\n---\n\n".join(req.texts[:5])
    prompt = template.format(plural=plural, style=style, content=content)

    llm = OpenAIChatGenerator(api_key=Secret.from_token(key),
                              api_base_url=os.getenv("GROQ_API_BASE","https://api.groq.com/openai/v1"),
                              model=os.getenv("GROQ_MODEL","qwen/qwen3-32b"))
    result = llm.run(messages=[ChatMessage.from_user(prompt)])
    reply = result.get("replies",[None])[0]
    return {"summary": getattr(reply,"text", str(reply))}