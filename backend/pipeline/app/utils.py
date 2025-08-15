# app/utils.py
import os
import json
import glob
from pathlib import Path

from haystack import Document
from haystack_integrations.document_stores.pgvector import PgvectorDocumentStore
from haystack.components.embedders import SentenceTransformersDocumentEmbedder

from app.chunking import chunk_code

# where repos get unpacked
UPLOADS = Path(__file__).resolve().parents[1] / "uploads"

# name of the shared embeddings table
EMBEDDINGS_TABLE = "embeddings"

# initialize or get the shared document store
def get_document_store():
    return PgvectorDocumentStore(
        table_name=EMBEDDINGS_TABLE,
        embedding_dimension=384,            # matches all-MiniLM-L6-v2
        vector_function="cosine_similarity",
        recreate_table=False,               # keep existing data/schema
        search_strategy="hnsw",
    )


def load_code_chunks(repo_id: str):
    """
    Load and chunk code files for a given repo using tree-sitter based chunking.
    """
    repo_path = UPLOADS / repo_id
    all_files = glob.glob(str(repo_path / "**/*.*"), recursive=True)

    docs = []
    for file in all_files:
        # only process supported code files
        try:
            content = Path(file).read_text(encoding="utf-8")
        except Exception:
            continue

        # chunk_code handles language support, fallback, and overlap
        for idx, chunk in enumerate(chunk_code(file, content)):
            docs.append(
                Document(
                    content=chunk,
                    meta={
                        "repo_id": repo_id,
                        "filename": os.path.relpath(file, repo_path),
                        "chunk_index": idx,
                    },
                )
            )
    return docs


def index_repo(repo_id: str):
    # 1) load chunks
    docs = load_code_chunks(repo_id)

    # 2) connect to the shared Postgres+pgvector store
    document_store = get_document_store()

    # 3) delete any existing docs for repo
    document_store.delete_documents(
        index=EMBEDDINGS_TABLE,
        filters={"repo_id": repo_id}
    )

    # 4) write new docs
    document_store.write_documents(docs, index=EMBEDDINGS_TABLE)

    # 5) embed all un-embedded docs (or re-embed)
    embedder = SentenceTransformersDocumentEmbedder(
        model="sentence-transformers/all-MiniLM-L6-v2"
    )
    embedder.warm_up()
    document_store.update_embeddings(
        embedder,
        batch_size=32,
        index=EMBEDDINGS_TABLE
    )

    # 6) persist status for WS endpoints
    data_path = Path(__file__).resolve().parents[1] / "data" / "repos" / repo_id
    data_path.mkdir(parents=True, exist_ok=True)
    with open(data_path / "status.json", "w") as f:
        json.dump({"status": "indexed", "chunks": len(docs)}, f)

    return {"status": "indexed", "chunks": len(docs)}