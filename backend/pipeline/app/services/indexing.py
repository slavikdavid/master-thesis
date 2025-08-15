# app/services/indexing.py

import os
import json
from threading import Thread, Event
from typing import List

from app.services.file_utils import list_files
from app.chunking import chunk_code
from haystack import Document
from haystack.utils import Secret
from haystack.components.embedders import SentenceTransformersDocumentEmbedder
from haystack.document_stores.types import DuplicatePolicy
from haystack_integrations.document_stores.pgvector import PgvectorDocumentStore

DATA_DIR = os.getenv("DATA_DIR", "data/repos")
EMBEDDINGS_INDEX = "embeddings"


def index_repo(
    repo_path: str,
    repo_id: str,
    batch_size: int = 16,
    max_chars: int = 1000,
    overlap: int = 200
):
    repo_data_dir = os.path.join(DATA_DIR, repo_id)
    os.makedirs(repo_data_dir, exist_ok=True)
    status_file = os.path.join(repo_data_dir, "status.json")

    # skip if already indexed
    if os.path.exists(status_file):
        try:
            with open(status_file, "r", encoding="utf-8") as f:
                status = json.load(f)
            if status.get("status") == "indexed":
                return
        except json.JSONDecodeError:
            pass

    def write_status(data: dict):
        with open(status_file, "w", encoding="utf-8") as f:
            json.dump(data, f)

    # 1) gather code/text chunks
    all_chunks: List[tuple[str, str]] = []
    for rel_path in list_files(repo_id):
        if rel_path.startswith(".git") or "/.git/" in rel_path:
            continue
        abs_path = os.path.join(repo_path, rel_path)
        try:
            text = open(abs_path, "r", encoding="utf-8").read()
        except Exception:
            continue

        for chunk in chunk_code(rel_path, text, max_chars=max_chars, overlap=overlap):
            all_chunks.append((rel_path, chunk))

    total_chunks = len(all_chunks)
    write_status({"status": "indexing", "processed": 0, "total": total_chunks})

    # 2) warm up embedder and infer dimension
    embedder = SentenceTransformersDocumentEmbedder(
        model="sentence-transformers/all-MiniLM-L6-v2"
    )
    try:
        embedder.warm_up()
    except Exception:
        pass

    sample_emb = embedder.run([Document(content="")])["documents"][0].embedding
    embedding_dim = len(sample_emb)

    ready = Event()
    ready.set()

    def _worker():
        processed = 0

        # create the vector store using HNSW for ANN search
        store = PgvectorDocumentStore(
            connection_string=Secret.from_env_var("DATABASE_URL"),
            table_name=EMBEDDINGS_INDEX,
            embedding_dimension=embedding_dim,
            create_extension=True,
            recreate_table=False,
            search_strategy="hnsw",
            hnsw_recreate_index_if_exists=False,
            hnsw_index_creation_kwargs={"M": 16, "ef_construction": 200},
            hnsw_index_name="haystack_hnsw_index",
            hnsw_ef_search=50,
        )

        for start in range(0, total_chunks, batch_size):
            batch = all_chunks[start : start + batch_size]
            docs: List[Document] = []
            for idx, (rel_path, chunk) in enumerate(batch):
                doc_id = f"{repo_id}:{rel_path}:{start + idx}"
                docs.append(
                    Document(
                        id=doc_id,
                        content=chunk,
                        meta={"filename": rel_path, "repo_id": repo_id},
                    )
                )

            ready.wait()
            embedded_docs = embedder.run(docs)["documents"]

            store.write_documents(
                embedded_docs,
                policy=DuplicatePolicy.OVERWRITE,
            )

            processed += len(batch)
            write_status({
                "status": "indexing",
                "processed": processed,
                "total": total_chunks,
            })

        write_status({
            "status": "indexed",
            "processed": total_chunks,
            "total": total_chunks,
        })

    Thread(target=_worker, daemon=True).start()