# app/services/pipeline.py

import os
import json
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Tuple, Optional
from collections import defaultdict
import re as _re

from jinja2 import Template
from dotenv import load_dotenv

from app.schemas.request_models import QueryRequest
from haystack import Pipeline
from haystack.dataclasses import ChatMessage
from haystack.components.generators.chat import OpenAIChatGenerator
from haystack_integrations.components.retrievers.pgvector import PgvectorEmbeddingRetriever
from haystack.utils import Secret

from haystack_integrations.components.embedders.voyage_embedders import VoyageTextEmbedder

from app.utils import get_document_store

# load .env
DOTENV_PATH = Path(__file__).resolve().parent.parent.parent / ".env"
if DOTENV_PATH.exists():
    load_dotenv(DOTENV_PATH)

# default model
VOYAGE_MODEL = os.getenv("VOYAGE_MODEL", "voyage-code-2")


def _rewrite_doc_numbers_to_filenames(answer: str, file_order: List[str]) -> str:
    """
    Safety net: if the LLM still says 'Document 1/2/3', rewrite to the corresponding
    filename from the prompt order.
    """
    def repl(m):
        idx = int(m.group(1)) - 1
        return f"`{file_order[idx]}`" if 0 <= idx < len(file_order) else m.group(0)
    return _re.sub(r'\bDocument\s+(\d+)\b', repl, answer)


async def query_codebase(
    request: QueryRequest,
    filters: Optional[Dict] = None,
) -> Tuple[str, List[Dict]]:
    """
    Run retrieval + LLM and return (answer, contexts).
    contexts = [{ id, filename, content, start_line?, end_line? }]
    """

    # 1) embedder (query mode) - stays in Voyage space
    text_embedder = VoyageTextEmbedder(
        model=VOYAGE_MODEL,
        input_type="query",  # query embeddings for questions
        # VOYAGE_API_KEY is read from environment
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
    # explicit port-to-port connection to avoid ambiguity
    pipe.connect("embedder.embedding", "retriever.query_embedding")

    # 5) retrieve with filters
    run_inputs = {
        "embedder": {"text": request.question},
        "retriever": {"filters": filters or {}},
    }
    result = pipe.run(run_inputs)

    retrieved = result.get("retriever", {}).get("documents", []) or []
    print(f"[debug] Retrieved {len(retrieved)} docs from embeddings table")

    # Build UI contexts (dedupe to first chunk per file and include line ranges if present)
    contexts: List[Dict] = []
    seen_files = set()
    for d in retrieved:
        meta = getattr(d, "meta", {}) or {}
        fname = meta.get("filename") or meta.get("path") or "document"
        if fname in seen_files:
            continue
        contexts.append({
            "id": getattr(d, "id", None),
            "filename": fname,
            "content": getattr(d, "content", "") or "",
            "start_line": meta.get("start_line"),
            "end_line": meta.get("end_line"),
        })
        seen_files.add(fname)

    warning = ""
    if not retrieved:
        warning = "Warning: no docs matched repo_id; answering without context.\n\n"

    # Group retrieved chunks by filename and include (lines a–b) per excerpt
    grouped = defaultdict(list)
    file_order: List[str] = []
    for d in retrieved:
        meta = getattr(d, "meta", {}) or {}
        fname = meta.get("filename") or meta.get("path") or "document"
        if fname not in file_order:
            file_order.append(fname)
        s = int(meta.get("start_line") or 1)
        e = int(meta.get("end_line") or 1)
        grouped[fname].append((s, e, getattr(d, "content", "") or ""))

    # Create compact per-file bodies, preserving retrieval order; cap size per file
    grouped_files: List[Tuple[str, str]] = []
    for fname in file_order[:6]:  # limit files to keep the prompt concise
        spans = sorted(grouped[fname], key=lambda x: x[0])
        blocks = [f"(lines {s}–{e})\n{c}" for s, e, c in spans if c.strip()]
        body = "\n\n---\n\n".join(blocks)
        if len(body) > 2500:
            body = body[:2500]
        grouped_files.append((fname, body))

    # 6) build prompt (filenames + line ranges only, no numbering)
    tpl = Template(
        """{{ warning }}You are helping with repository `{{ repo_id }}`.

STRICT RULES:
- Refer to sources by **filename and line ranges** only (e.g., src/utils.py lines 120–180). Do NOT say “Document N”.
- Use the EXACT class/function/file names from the context. Wrap identifiers in backticks.
- If multiple excerpts come from the same file, treat them as **one document** and synthesize across them.
- If a name is unclear, say so; do NOT guess or shorten it.

Context (grouped by file):
{% for fname, body in grouped_files -%}
FILE: {{ fname }}
{{ body }}

{% endfor -%}
Question: {{ question }}
Answer (cite filenames + line ranges only):"""
    )
    prompt = tpl.render(
        grouped_files=grouped_files,
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

    llm_result = llm.run([ChatMessage.from_user(prompt)])

    # prefer streamed text; fallback to reply
    answer = "".join(streamed_chunks).strip()
    if not answer:
        replies = llm_result.get("replies", [])
        if replies:
            answer = getattr(replies[0], "text", str(replies[0])) or ""

    # last-ditch rewrite if model still said "Document N"
    answer = _rewrite_doc_numbers_to_filenames(answer, file_order)

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
