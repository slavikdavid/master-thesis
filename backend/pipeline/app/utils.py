# app/utils.py
import os
from pathlib import Path
from typing import List, Dict, Any, Optional

from haystack import Document
from haystack.utils import Secret
from haystack_integrations.document_stores.pgvector import PgvectorDocumentStore
from haystack_integrations.components.embedders.voyage_embedders import (
    VoyageDocumentEmbedder,
    VoyageTextEmbedder,
)

from app.chunking import chunk_code
from app.services.file_utils import list_files

# dir where repos get unpacked
UPLOADS = Path(os.getenv("UPLOAD_DIR", "uploads")).resolve()

# name of the shared embeddings table
EMBEDDINGS_TABLE = os.getenv("EMBEDDINGS_INDEX", "embeddings")

# ---- model & dim (voyage-code-2 dim is 1536) ----
VOYAGE_MODEL = os.getenv("VOYAGE_MODEL", "voyage-code-2")
DEFAULT_EMBED_DIM = int(os.getenv("EMBEDDING_DIMENSION", "1536"))


def get_document_store(
    recreate: bool = False,
    embedding_dimension: Optional[int] = None,
) -> PgvectorDocumentStore:
    """
    Return a PgvectorDocumentStore consistent with the one used in indexing.py.
    NOTE: indexing.py lazily creates the table when it knows the model's true dim.
    Here, we fall back to DEFAULT_EMBED_DIM if not provided.
    """
    dim = embedding_dimension or DEFAULT_EMBED_DIM
    return PgvectorDocumentStore(
        connection_string=Secret.from_env_var("DATABASE_DSN"),
        table_name=EMBEDDINGS_TABLE,
        embedding_dimension=dim,
        create_extension=True,
        recreate_table=recreate,
        search_strategy="hnsw",
        hnsw_recreate_index_if_exists=False,
        hnsw_index_creation_kwargs={"M": 16, "ef_construction": 200},
        hnsw_index_name="haystack_hnsw_index",
        hnsw_ef_search=50,
    )


def _skip_hidden(rel_path: str) -> bool:
    """
    Return True if any path segment starts with '.' (e.g. '.git', '.env', '.dir/file').
    """
    parts = rel_path.replace("\\", "/").split("/")
    return any(p.startswith(".") for p in parts if p)  # skip hidden files/dirs anywhere in the path


def load_code_chunks(repo_id: str) -> List[Document]:
    """
    Load and chunk code/text files for a given repo_id.
    Skips any file whose path contains a hidden segment (starts with '.').
    """
    repo_path = (UPLOADS / repo_id).resolve()
    if not repo_path.is_dir():
        return []

    docs: List[Document] = []
    for rel_path in list_files(repo_id):
        if _skip_hidden(rel_path):
            continue

        abs_path = (repo_path / rel_path).resolve()
        # ensure containment
        try:
            if not str(abs_path).startswith(str(repo_path)) or not abs_path.is_file():
                continue
        except Exception:
            continue

        # read text (skip binaries)
        try:
            text = abs_path.read_text(encoding="utf-8")
        except Exception:
            continue

        # chunk_code returns dicts: {content, start_line, end_line}
        for idx, ch in enumerate(chunk_code(rel_path, text)):
            content = (ch.get("content") or "").strip()
            if not content:
                continue
            docs.append(
                Document(
                    content=content,
                    meta={
                        "repo_id": repo_id,
                        "filename": rel_path,
                        "chunk_index": idx,
                        "start_line": ch.get("start_line"),
                        "end_line": ch.get("end_line"),
                    },
                )
            )
    return docs


def index_repo(repo_id: str, *, batch_size: int = 16, max_chars: int = 5000, overlap: int = 200) -> Dict[str, Any]:
    """
    Thin wrapper to kick off the real async/threaded indexing pipeline.
    Returns immediately; progress is reported via the WebSocket broker.
    """
    repo_dir = (UPLOADS / repo_id).resolve()
    if not repo_dir.is_dir():
        return {"status": "error", "detail": "Repository not found"}

    from app.services.indexing import index_repo as _index_repo  # local import to avoid cycles
    _index_repo(str(repo_dir), repo_id, batch_size=batch_size, max_chars=max_chars, overlap=overlap)
    return {"status": "started", "repo_id": repo_id}


def get_query_embedder() -> VoyageTextEmbedder:
    """
    Returns a VoyageTextEmbedder configured for query embeddings.
    Usage:
        q_embedder = get_query_embedder()
        q_embedder.run({"text": "find init functions in auth module"})
    """
    return VoyageTextEmbedder(
        model=VOYAGE_MODEL,
        input_type="query",
    )


# one-off utility if needed to backfill embeddings for existing docs
def backfill_embeddings(batch_size: int = 32) -> int:
    """
    Embed any documents in the store missing embeddings.
    Returns number of docs processed. Use sparingly; live flow already embeds on write.
    """
    store = get_document_store()
    embedder = VoyageDocumentEmbedder(model=VOYAGE_MODEL, input_type="document")
    try:
        embedder.warm_up()
    except Exception:
        pass
    store.update_embeddings(embedder, batch_size=batch_size, index=EMBEDDINGS_TABLE)
    return 0