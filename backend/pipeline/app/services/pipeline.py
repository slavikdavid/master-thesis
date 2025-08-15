# app/services/pipeline.py

import os
import json
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Tuple, Optional, Callable

from jinja2 import Template
from dotenv import load_dotenv

from app.schemas.request_models import QueryRequest
from haystack import Pipeline
from haystack.dataclasses import ChatMessage
from haystack.components.generators.chat import OpenAIChatGenerator
from haystack.components.embedders import SentenceTransformersTextEmbedder
from haystack_integrations.components.retrievers.pgvector import PgvectorEmbeddingRetriever
from haystack.utils import Secret

from app.utils import get_document_store

# load .env
DOTENV_PATH = Path(__file__).resolve().parent.parent.parent / ".env"
if DOTENV_PATH.exists():
    load_dotenv(DOTENV_PATH)


async def query_codebase(
    request: QueryRequest,
    filters: Optional[Dict] = None,
) -> Tuple[str, List[Dict]]:
    """
    Run retrieval + LLM and return (answer, contexts).
    contexts = [{ filename, content, id }]
    """

    # 1) embedder
    text_embedder = SentenceTransformersTextEmbedder(
        model="sentence-transformers/all-MiniLM-L6-v2"
    )
    try:
        text_embedder.warm_up()
    except Exception:
        pass

    # 2) shared doc store
    store = get_document_store()

    # 3) retriever
    retriever = PgvectorEmbeddingRetriever(
        document_store=store,
        top_k=10,
    )

    # 4) pipeline
    pipe = Pipeline()
    pipe.add_component("embedder", text_embedder)
    pipe.add_component("retriever", retriever)
    pipe.connect("embedder", "retriever")

    # 5) retrieve with filters
    run_inputs = {
        "embedder": {"text": request.question},
        "retriever": {"filters": filters or {}},
    }
    result = pipe.run(run_inputs)

    retrieved = result.get("retriever", {}).get("documents", []) or []
    print(f"[debug] Retrieved {len(retrieved)} docs from embeddings table")

    # prepare contexts for UI
    contexts: List[Dict] = []
    for d in retrieved:
        meta = getattr(d, "meta", {}) or {}
        contexts.append({
            "id": getattr(d, "id", None),
            "filename": meta.get("filename") or meta.get("path") or "document",
            "content": getattr(d, "content", "") or "",
        })

    warning = ""
    if not retrieved:
        warning = "Warning: no docs matched repo_id; answering without context.\n\n"

    # 6) build prompt (make filenames explicit so the LLM keeps real identifiers)
    prompt_docs: List[str] = []
    for d in retrieved:
        meta = getattr(d, "meta", {}) or {}
        fname = meta.get("filename") or meta.get("path") or "document"
        prompt_docs.append(f"FILE: {fname}\n{getattr(d, 'content', '')}")

    tpl = Template(
        """{{ warning }}You are helping with repository `{{ repo_id }}`.

STRICT RULES:
- Use the EXACT class/function/file names found in the context. DO NOT abbreviate to single letters.
- Always wrap identifiers in backticks, except for filenames.
- If a name is unclear, say so; do NOT guess or shorten it.

Context:
{% for doc in documents %}
--- Document {{ loop.index }} ---
{{ doc }}
{% endfor %}

Question: {{ question }}
Answer:"""
    )
    prompt = tpl.render(
        documents=prompt_docs,
        question=request.question,
        repo_id=request.repoId,
        warning=warning,
    )

    # 7) GROQ API key for LLM Generator
    groq_key = os.getenv("GROQ_API_KEY")
    if not groq_key:
        raise RuntimeError("GROQ_API_KEY not set")

    streamed_chunks: List[str] = []

    def on_chunk(chunk) -> None:
        """
        Haystack will call this with incremental content.
        Most integrations expose `chunk.content` during streaming.
        """
        text = getattr(chunk, "content", None)
        if not text:
            try:
                choices = getattr(chunk, "choices", None) or []
                if choices:
                    text = getattr(getattr(choices[0], "delta", {}), "content", "") or getattr(choices[0], "text", "")
            except Exception:
                text = ""
        if text:
            print(text, end="", flush=True)
            streamed_chunks.append(text)

    llm = OpenAIChatGenerator(
        api_key=Secret.from_token(groq_key),
        api_base_url="https://api.groq.com/openai/v1",
        model="qwen/qwen3-32b",
        streaming_callback=on_chunk,
    )

    # run without extra flags; streaming goes through the callback
    llm_result = llm.run([ChatMessage.from_user(prompt)])

    # prefer streamed text; if none arrived, fall back to final reply
    answer = "".join(streamed_chunks).strip()
    if not answer:
        replies = llm_result.get("replies", [])
        if replies:
            answer = getattr(replies[0], "text", str(replies[0])) or ""

    # 8) persist history
    repo_dir = Path("data") / "repos" / request.repoId
    repo_dir.mkdir(parents=True, exist_ok=True)
    hist_file = repo_dir / "queries.json"
    history = json.loads(hist_file.read_text(encoding="utf-8")) if hist_file.exists() else []
    history.append({
        "question": request.question,
        "answer": answer,
        "timestamp": datetime.utcnow().isoformat()
    })
    hist_file.write_text(json.dumps(history, indent=2), encoding="utf-8")

    return answer, contexts


def get_document_store():
    from app.utils import get_document_store as _g
    return _g()
