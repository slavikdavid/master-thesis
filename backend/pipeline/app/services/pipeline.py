# app/services/pipeline.py
import os
import json
import hashlib
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Tuple, Optional
from collections import defaultdict
import re as _re
import traceback
import textwrap

from jinja2 import Template
from dotenv import load_dotenv

from app.schemas.request_models import QueryRequest
from haystack import Pipeline
from haystack.dataclasses import ChatMessage
from haystack.components.generators.chat import OpenAIChatGenerator
from haystack_integrations.components.retrievers.pgvector import PgvectorEmbeddingRetriever
from haystack.utils import Secret

from haystack_integrations.components.embedders.voyage_embedders import VoyageTextEmbedder

try:
    from haystack_integrations.components.rankers.voyage import VoyageRanker
except ImportError:
    from haystack_integrations.components.rankers.voyage.ranker import VoyageRanker  # type: ignore

from app.utils import get_document_store
from app.db import fetch_one, execute  # NOTE: we use fetch_one for RETURNING

DOTENV_PATH = Path(__file__).resolve().parent.parent.parent / ".env"
if DOTENV_PATH.exists():
    load_dotenv(DOTENV_PATH)

VOYAGE_MODEL = os.getenv("VOYAGE_MODEL", "voyage-code-2")
VOYAGE_RERANKER_MODEL = os.getenv("VOYAGE_RERANKER_MODEL", "rerank-2.5-lite")


# ------------------------
# Utilities
# ------------------------
def _rewrite_doc_numbers_to_filenames(answer: str, file_order: List[str]) -> str:
    """Turn 'Document N' into `filename` if the model slips."""
    def repl(m):
        idx = int(m.group(1)) - 1
        return f"`{file_order[idx]}`" if 0 <= idx < len(file_order) else m.group(0)
    return _re.sub(r'\bDocument\s+(\d+)\b', repl, answer)


async def _resolve_chunk_id(meta: Dict, content: str) -> Optional[str]:
    """Best-effort mapping of retriever meta/content back to document_chunks.id for persistence."""
    chunk_id = meta.get("document_chunk_id") or meta.get("chunk_id")
    if chunk_id:
        row = await fetch_one(
            "SELECT id FROM document_chunks WHERE id = %(id)s LIMIT 1",
            {"id": chunk_id},
        )
        if row:
            return str(row["id"])

    doc_id = meta.get("document_id") or meta.get("doc_id")
    chunk_index = meta.get("chunk_index")
    if doc_id is not None and chunk_index is not None:
        row = await fetch_one(
            """
            SELECT id
            FROM document_chunks
            WHERE document_id = %(doc_id)s AND chunk_index = %(idx)s
            LIMIT 1
            """,
            {"doc_id": doc_id, "idx": chunk_index},
        )
        if row:
            return str(row["id"])

    text = (content or "").strip()
    if text:
        h = hashlib.sha256(text.encode("utf-8")).hexdigest()
        row = await fetch_one(
            "SELECT id FROM document_chunks WHERE chunk_hash = %(h)s LIMIT 1",
            {"h": h},
        )
        if row:
            return str(row["id"])

    return None


async def _load_recent_history(conversation_id: Optional[str], limit: int = 6) -> List[Dict]:
    """
    Load the latest N turns for this conversation, newest-first.
    We use json_agg to minimize roundtrips and preserve order in Python.
    """
    if not conversation_id:
        return []
    rows = await fetch_one(
        """
        SELECT json_agg(t.* ORDER BY t.created_at DESC) AS items
        FROM (
          SELECT query_text, response_text, created_at
          FROM rag_queries
          WHERE conversation_id = %(cid)s
          ORDER BY created_at DESC
          LIMIT %(lim)s
        ) t
        """,
        {"cid": conversation_id, "lim": limit},
    )
    return (rows.get("items") if rows else []) or []


def _compact(s: str, max_chars: int = 800) -> str:
    """
    Token-friendly compaction:
    - Drop large code fences (replace with marker)
    - Collapse whitespace
    - Truncate with ellipsis
    """
    if not s:
        return ""
    s = s.strip()
    s = _re.sub(r"```.*?```", "[code omitted]", s, flags=_re.DOTALL)
    s = _re.sub(r"\s+", " ", s)
    return (s[: max_chars - 1] + "…") if len(s) > max_chars else s


def _render_history_md(turns: List[Dict], max_total_chars: int = 2400) -> str:
    """Markdown history (oldest → newest), clipped to a total size budget."""
    if not turns:
        return ""
    buf, used = [], 0
    for t in reversed(turns):  # oldest to newest
        q = _compact(t.get("query_text", ""), 700)
        a = _compact(t.get("response_text", ""), 1000)
        chunk = f"- **User earlier**: {q}\n  **Assistant earlier**: {a}"
        if used + len(chunk) > max_total_chars:
            buf.insert(0, "> (Earlier turns omitted for brevity)")
            break
        buf.append(chunk)
        used += len(chunk)
    return "\n".join(buf)


def _history_hint(turns: List[Dict], max_len: int = 240) -> str:
    """A short hint derived from the latest user query to steer retrieval."""
    if not turns:
        return ""
    latest = turns[0]  # newest-first from _load_recent_history
    hint = latest.get("query_text", "") or ""
    hint = _re.sub(r"\s+", " ", hint).strip()
    return hint[:max_len]


# ------------------------
# Main entry
# ------------------------
async def query_codebase(
    request: QueryRequest,
    filters: Optional[Dict] = None,
) -> Tuple[str, List[Dict]]:
    """
    Run retrieval + LLM with history-aware chat and return (answer, contexts).
    Also persists the turn into rag_queries + retrieved_chunks.

    contexts = [{ id, filename, content, start_line?, end_line? }]
    """
    # 1) embedder
    text_embedder = VoyageTextEmbedder(
        model=VOYAGE_MODEL,
        input_type="query",
    )
    try:
        text_embedder.warm_up()
    except Exception:
        pass

    # 2) document store
    store = get_document_store()

    # 3) retriever + ranker
    retriever = PgvectorEmbeddingRetriever(document_store=store, top_k=10)
    ranker = VoyageRanker(model=VOYAGE_RERANKER_MODEL)

    pipe = Pipeline()
    pipe.add_component("embedder", text_embedder)
    pipe.add_component("retriever", retriever)
    pipe.add_component("ranker", ranker)
    pipe.connect("embedder.embedding", "retriever.query_embedding")
    pipe.connect("retriever.documents", "ranker.documents")

    # ---- Conversation history (for both chat and retrieval) ----
    recent_turns = await _load_recent_history(getattr(request, "conversationId", None), limit=6)
    history_md = _render_history_md(recent_turns)
    hint = _history_hint(recent_turns)

    # 4) Retrieval (make it history-aware)
    retriever_query = request.question
    if hint:
        retriever_query = f"{request.question}\n\n(History hint: {hint})"

    run_inputs = {
        "embedder": {"text": retriever_query},
        "retriever": {"filters": filters or {}},
        "ranker": {"query": retriever_query, "top_k": 4},
    }
    result = pipe.run(run_inputs)

    ranked_docs = result.get("ranker", {}).get("documents") or []
    retrieved = ranked_docs or result.get("retriever", {}).get("documents", []) or []

    if ranked_docs:
        print(f"[debug] Retrieved {len(retrieved)} docs after rerank")
        try:
            scores = [getattr(d, "score", None) for d in ranked_docs]
            print(f"[debug] Reranker scores (desc): {scores}")
        except Exception:
            pass
    else:
        print(f"[debug] Retrieved {len(retrieved)} docs from embeddings table")

    # Build UI contexts (dedupe by first chunk per file)
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

    # Group excerpts by file for the prompt
    warning = ""
    if not retrieved:
        warning = "Warning: no docs matched repo_id; answering without context.\n\n"

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

    grouped_files: List[Tuple[str, str]] = []
    for fname in file_order[:6]:
        spans = sorted(grouped[fname], key=lambda x: x[0])
        blocks = [f"(lines {s}–{e})\n{c}" for s, e, c in spans if (c or "").strip()]
        body = "\n\n---\n\n".join(blocks)
        if len(body) > 2500:
            body = body[:2500]
        grouped_files.append((fname, body))

    # 5) Build messages for the chat model (true chat: system + history + current)
    system_rules = (
        "You are a coding RAG assistant.\n"
        "- Cite sources by filename + line ranges only (e.g., `src/utils.py` lines 120–180).\n"
        "- NEVER refer to sources as “Document N”.\n"
        "- Use EXACT identifiers (class/function/file names) from the context, wrapped in backticks.\n"
        "- If multiple excerpts are from the same file, synthesize across them as one.\n"
        "- If a name/reference is ambiguous, say it is unclear — do NOT guess or invent.\n"
        "- Answer concisely first, then offer one short, relevant follow-up help question."
    )

    # Current context + question in a single user message
    current_user_tpl = Template(
        """{{ warning }}You are assisting with the repository: `{{ repo_id }}`.

{% if history_md -%}
🗂️ Earlier conversation (most recent last). Use only if relevant:
{{ history_md }}

{%- endif %}
📂 Context (grouped by file):
{% for fname, body in grouped_files -%}
FILE: {{ fname }}
{{ body }}

{% endfor -%}

❓ Question: {{ question }}

💡 Respond with citations (filename + line ranges only)."""
    )
    current_user_payload = current_user_tpl.render(
        warning=warning,
        repo_id=request.repoId,
        history_md=history_md,
        grouped_files=grouped_files,
        question=request.question,
    )

    messages: List[ChatMessage] = []
    messages.append(ChatMessage.from_system(system_rules))

    # Add prior turns as literal chat messages (oldest → newest), compacted
    if recent_turns:
        for t in reversed(recent_turns):
            messages.append(ChatMessage.from_user(_compact(t.get("query_text", ""), 1000)))
            messages.append(ChatMessage.from_assistant(_compact(t.get("response_text", ""), 1400)))

    # Current turn
    messages.append(ChatMessage.from_user(current_user_payload))

    # 6) LLM call with streaming
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

    llm_result = llm.run(messages)

    answer = "".join(streamed_chunks).strip()
    if not answer:
        replies = llm_result.get("replies", [])
        if replies:
            answer = getattr(replies[0], "text", str(replies[0])) or ""

    answer = _rewrite_doc_numbers_to_filenames(answer, file_order)

    # 7) Persist JSON history on disk (unchanged)
    repo_dir = Path("data") / "repos" / request.repoId
    repo_dir.mkdir(parents=True, exist_ok=True)
    hist_file = repo_dir / "queries.json"
    history = json.loads(hist_file.read_text(encoding="utf-8")) if hist_file.exists() else []
    history.append({
        "question": request.question,
        "answer": answer,
        "timestamp": datetime.utcnow().isoformat(),
    })
    hist_file.write_text(json.dumps(history, indent=2), encoding="utf-8")

    # 8) DB persistence: rag_queries + retrieved_chunks
    try:
        print(f"[dbg] conversationId={getattr(request, 'conversationId', None)} userId={getattr(request, 'userId', None)} repoId={request.repoId}")

        # Conversation handling
        conv_ok = False
        conv_id_param: Optional[str] = None
        conv_user_id: Optional[str] = None

        if getattr(request, "conversationId", None):
            conv_row = await fetch_one(
                "SELECT id, user_id FROM conversations WHERE id = %(id)s",
                {"id": request.conversationId},
            )
            if conv_row:
                conv_ok = True
                conv_id_param = conv_row["id"]
                conv_user_id = conv_row.get("user_id")

        if not conv_ok and getattr(request, "conversationId", None):
            print(f"[warn] conversationId {request.conversationId} not found; inserting rag_query with NULL conversation_id")

        # Choose user_id: explicit from request, else from conversation row (if any)
        user_id_param: Optional[str] = getattr(request, "userId", None) or conv_user_id

        # response metadata (cast to jsonb explicitly)
        meta_obj = {
            "repo_id": request.repoId,
            "ranker_model": VOYAGE_RERANKER_MODEL,
            "retrieved_count": len(retrieved),
        }
        meta_json = json.dumps(meta_obj)

        # IMPORTANT: use fetch_one for INSERT ... RETURNING
        rq = await fetch_one(
            """
            INSERT INTO rag_queries (conversation_id, user_id, query_text, response_text, response_metadata)
            VALUES (%(conversation_id)s, %(user_id)s, %(query_text)s, %(response_text)s, %(response_metadata)s::jsonb)
            RETURNING id
            """,
            {
                "conversation_id": conv_id_param,
                "user_id": user_id_param,
                "query_text": request.question,
                "response_text": answer,
                "response_metadata": meta_json,
            },
        )

        if not rq or "id" not in rq:
            raise RuntimeError("INSERT rag_queries did not return an id")

        rag_query_id = rq["id"]

        # retrieved_chunks (best-effort)
        try:
            rank_counter = 1
            for d in retrieved:
                meta = getattr(d, "meta", {}) or {}
                content = getattr(d, "content", "") or ""
                score = getattr(d, "score", None)

                dc_id = await _resolve_chunk_id(meta, content)
                if not dc_id:
                    rank_counter += 1
                    continue

                await execute(
                    """
                    INSERT INTO retrieved_chunks (id, rag_query_id, document_chunk_id, score, rank, used_in_prompt, created_at)
                    VALUES (gen_random_uuid(), %(rq_id)s, %(dc_id)s, %(score)s, %(rank)s, TRUE, now())
                    """,
                    {
                        "rq_id": rag_query_id,
                        "dc_id": dc_id,
                        "score": float(score) if isinstance(score, (int, float)) else None,
                        "rank": rank_counter,
                    },
                )
                rank_counter += 1
        except Exception as e_chunks:
            print("[warn] Failed to persist retrieved_chunks:", repr(e_chunks))
            traceback.print_exc()

    except Exception as e:
        print("[warn] Failed to persist RAG query/chunks:", repr(e))
        traceback.print_exc()

    return answer, contexts


def get_document_store():
    from app.utils import get_document_store as _g
    return _g()
