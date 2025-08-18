# app/services/indexing.py

import os
import logging
from threading import Thread, Event
from typing import List, Any, Optional, Set, Dict

from haystack import Document
from haystack.utils import Secret
from haystack.document_stores.types import DuplicatePolicy
from haystack_integrations.document_stores.pgvector import PgvectorDocumentStore
from haystack_integrations.components.embedders.voyage_embedders import (
    VoyageDocumentEmbedder,
)

from app.services.file_utils import list_files
from app.services.ws import _broadcast
from app.chunking import chunk_code

logger = logging.getLogger(__name__)

EMBEDDINGS_INDEX = os.getenv("EMBEDDINGS_INDEX", "embeddings")
VOYAGE_MODEL = os.getenv("VOYAGE_MODEL", "voyage-code-2")


def _chunk_text(chunk: Any) -> str:
    """Normalize a chunk to text. Accepts strings or dicts with common content keys."""
    if isinstance(chunk, str):
        return chunk.strip()
    if isinstance(chunk, dict):
        for key in ("content", "text", "code", "chunk", "body", "value"):
            val = chunk.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
    return ""


def _is_hidden_path(rel_path: str) -> bool:
    """
    Return True if ANY path segment starts with '.'
    (e.g., '.git', '.env', '.vscode/foo', 'src/.cache/bar').
    """
    parts = rel_path.replace("\\", "/").split("/")
    return any(p.startswith(".") for p in parts if p)


def index_repo(
    repo_path: str,
    repo_id: str,
    batch_size: int = 16,
    max_chars: int = 5000,
    overlap: int = 200,
) -> None:
    """
    Index a repository by:
      1) collecting chunks from files,
      2) embedding them with VoyageAI,
      3) writing into a pgvector store.

    WebSocket events emitted (via _broadcast):
      - {"phase":"embedding","event":"start|progress|complete|error", "processed", "total", "progress?"}
      - {"phase":"indexing","event":"start|progress|complete|file_indexed|error", ...}
      - {"phase":"indexed","progress":100} on overall completion
      - {"phase":"error","message":"..."} on fatal failure
    """

    # -------- 1) gather chunks (skip hidden files/dirs) --------
    all_chunks: List[Dict[str, Any]] = []
    for rel_path in list_files(repo_id):
        if _is_hidden_path(rel_path):
            continue

        abs_path = os.path.join(repo_path, rel_path)
        try:
            with open(abs_path, "r", encoding="utf-8") as f:
                text = f.read()
        except Exception:
            # non-text/binary or unreadable file
            continue

        for raw in chunk_code(rel_path, text, max_chars=max_chars, overlap=overlap):
            content = _chunk_text(raw)
            if not content:
                continue
            s_line = raw.get("start_line") if isinstance(raw, dict) else None
            e_line = raw.get("end_line") if isinstance(raw, dict) else None
            all_chunks.append(
                {
                    "filename": rel_path,
                    "content": content,
                    "start_line": s_line,
                    "end_line": e_line,
                }
            )

    total_chunks = len(all_chunks)

    # nothing to index → emit completion signals & return
    if total_chunks == 0:
        _broadcast(repo_id, {
            "phase": "embedding",
            "event": "complete",
            "processed": 0,
            "total": 0,
            "progress": 100,
        })
        _broadcast(repo_id, {
            "phase": "indexing",
            "event": "complete",
            "processed": 0,
            "total": 0,
            "progress": 100,
        })
        _broadcast(repo_id, {"phase": "indexed", "progress": 100})
        return

    # initial phase announcements
    _broadcast(repo_id, {
        "phase": "embedding",
        "event": "start",
        "processed": 0,
        "total": total_chunks,
        "progress": 0,
    })
    _broadcast(repo_id, {
        "phase": "indexing",
        "event": "start",
        "processed": 0,
        "total": total_chunks,
        "progress": 0,
    })

    # -------- 2) Prepare embedder --------
    embedder = VoyageDocumentEmbedder(
        model=VOYAGE_MODEL,
        input_type="document",  # document mode for corpus chunks
        # VOYAGE_API_KEY is read from environment automatically
    )
    try:
        embedder.warm_up()
    except Exception:
        pass

    # allow future pause/resume if needed
    ready = Event()
    ready.set()

    # lazily create the vector store once embedding dimension is known
    store: Optional[PgvectorDocumentStore] = None

    # track filenames already announced to avoid duplicate file_indexed events
    sent_files: Set[str] = set()

    # embedding and indexing progress bars
    embed_done = 0   # chunks embedded
    index_done = 0   # chunks written
    last_emb_pct: Optional[int] = None
    last_idx_pct: Optional[int] = None

    def _worker():
        nonlocal store, embed_done, index_done, last_emb_pct, last_idx_pct

        try:
            for start in range(0, total_chunks, batch_size):
                batch = all_chunks[start : start + batch_size]

                # build documents (preserve filename + line metadata)
                docs: List[Document] = []
                for idx, item in enumerate(batch):
                    content = _chunk_text(item.get("content"))
                    if not content:
                        continue
                    rel_path = item["filename"]
                    s_line = item.get("start_line")
                    e_line = item.get("end_line")
                    # include a line range (or stable index) to keep chunks distinct
                    suffix = (
                        f"{s_line}-{e_line}"
                        if isinstance(s_line, int) and isinstance(e_line, int)
                        else f"{start + idx}"
                    )
                    docs.append(
                        Document(
                            id=f"{repo_id}:{rel_path}:{suffix}",
                            content=content,
                            meta={
                                "filename": rel_path,
                                "repo_id": repo_id,
                                "start_line": s_line,
                                "end_line": e_line,
                            },
                        )
                    )

                if not docs:
                    continue

                ready.wait()

                # —— embedding ——
                embedded_docs = embedder.run(docs)["documents"]

                # update embedding progress (only emit when percentage changes)
                embed_done += len(embedded_docs)
                emb_pct = int(embed_done * 100 / max(1, total_chunks))
                if emb_pct != last_emb_pct:
                    last_emb_pct = emb_pct
                    _broadcast(repo_id, {
                        "phase": "embedding",
                        "event": "progress",
                        "processed": embed_done,
                        "total": total_chunks,
                        "progress": emb_pct,
                    })

                # lazily initialize the vector store once dimension is known
                if store is None:
                    first_emb = next(
                        (d.embedding for d in embedded_docs if getattr(d, "embedding", None)),
                        None,
                    )
                    if first_emb is None:
                        raise RuntimeError("Failed to obtain embedding from first batch")
                    store = PgvectorDocumentStore(
                        connection_string=Secret.from_env_var("DATABASE_DSN"),
                        table_name=EMBEDDINGS_INDEX,
                        embedding_dimension=len(first_emb),
                        create_extension=True,
                        recreate_table=False,
                        search_strategy="hnsw",
                        hnsw_recreate_index_if_exists=False,
                        hnsw_index_creation_kwargs={"M": 16, "ef_construction": 200},
                        hnsw_index_name="haystack_hnsw_index",
                        hnsw_ef_search=50,
                    )

                # —— write to vector store ——
                store.write_documents(embedded_docs, policy=DuplicatePolicy.OVERWRITE)

                # per-file event (only once per filename)
                just_indexed: List[str] = []
                for d in embedded_docs:
                    meta = getattr(d, "meta", {}) or {}
                    rel = meta.get("filename")
                    if isinstance(rel, str) and rel and rel not in sent_files:
                        sent_files.add(rel)
                        just_indexed.append(rel)

                for rel in sorted(just_indexed):
                    _broadcast(repo_id, {
                        "phase": "indexing",
                        "event": "file_indexed",
                        "path": rel,
                    })

                # indexing progress (emit when percentage changes)
                index_done += len(embedded_docs)
                idx_pct = int(index_done * 100 / max(1, total_chunks))
                if idx_pct != last_idx_pct:
                    last_idx_pct = idx_pct
                    _broadcast(repo_id, {
                        "phase": "indexing",
                        "event": "progress",
                        "processed": index_done,
                        "total": total_chunks,
                        "progress": idx_pct,
                    })

            # completed
            _broadcast(repo_id, {
                "phase": "embedding",
                "event": "complete",
                "processed": total_chunks,
                "total": total_chunks,
                "progress": 100,
            })
            _broadcast(repo_id, {
                "phase": "indexing",
                "event": "complete",
                "processed": total_chunks,
                "total": total_chunks,
                "progress": 100,
            })
            _broadcast(repo_id, {"phase": "indexed", "progress": 100})

        except Exception as e:
            logger.exception("Indexing failed for repo_id=%s", repo_id)
            # mark both phases errored so UI can reflect failure
            _broadcast(repo_id, {"phase": "embedding", "event": "error", "error": str(e)})
            _broadcast(repo_id, {"phase": "indexing", "event": "error", "error": str(e)})
            _broadcast(repo_id, {"phase": "error", "message": str(e)})

    Thread(target=_worker, daemon=True, name=f"indexer-{repo_id[:6]}").start()