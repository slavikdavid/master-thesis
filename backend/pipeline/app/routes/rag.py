# app/routes/rag.py
from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from haystack.components.embedders import SentenceTransformersTextEmbedder
from haystack_integrations.components.retrievers.pgvector import PgvectorEmbeddingRetriever

from app.services.pipeline import get_document_store

router = APIRouter(tags=["rag"], prefix="/v1")

class RetrieveRequest(BaseModel):
    repoId: str
    query: str
    top_k: Optional[int] = 5

class RetrieveDocument(BaseModel):
    content: str
    meta: dict
    score: Optional[float]

class RetrieveResponse(BaseModel):
    documents: list[RetrieveDocument]

@router.post("/retrieve", response_model=RetrieveResponse)
async def retrieve(req: RetrieveRequest):
    # 1) embed the incoming query
    embedder = SentenceTransformersTextEmbedder(
        model="sentence-transformers/all-MiniLM-L6-v2"
    )
    embedder.warm_up()
    out = embedder.run({"text": req.query})
    emb = out.get("embedding") or out.get("query_embedding")
    if not emb:
        raise HTTPException(status_code=500, detail="Failed to embed query")

    # 2) point at the pgvector-backed store for this repo
    store = get_document_store()

    # 3) retrieve top_k via pgvector
    retriever = PgvectorEmbeddingRetriever(
        document_store=store,
        top_k=req.top_k
    )
    res = retriever.run(query_embedding=emb)
    docs = res.get("documents", [])

    # 4) return the content, meta and score
    return RetrieveResponse(
        documents=[
            RetrieveDocument(
                content=d.content,
                meta=d.meta or {},
                score=getattr(d, "score", None)
            )
            for d in docs
        ]
    )