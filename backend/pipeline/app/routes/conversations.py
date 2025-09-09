# app/routes/conversations.py

from fastapi import APIRouter, HTTPException
from typing import Any, Dict, List
from app.crud_base import CRUDBase
from app.db import fetch_all, fetch_one

router = APIRouter(prefix="/conversations", tags=["conversations"], redirect_slashes=False)
crud = CRUDBase("conversations")

@router.get("")
@router.get("/")
async def list_items():
    return await crud.list()

@router.get("/{item_id}")
async def get_item(item_id: Any):
    return await crud.get(item_id)

@router.post("")
@router.post("/")
async def create_item(data: Dict[str, Any]):
    return await crud.create(data)

@router.put("/{item_id}")
async def update_item(item_id: Any, data: Dict[str, Any]):
    return await crud.update(item_id, data)

@router.delete("/{item_id}")
async def delete_item(item_id: Any):
    return await crud.delete(item_id)

@router.get("/{item_id}/contexts")
async def get_contexts(item_id: Any) -> List[Dict[str, Any]]:
    """
    Return the retrieved chunks used for the latest RAG query of this conversation.
    Shape:
      [
        { "id": <uuid>, "filename": <str>, "content": <str> },
        ...
      ]
    """
    conv = await fetch_one(
        "SELECT id FROM conversations WHERE id = %(id)s",
        {"id": item_id},
    )
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")

    rq = await fetch_one(
        """
        SELECT id
        FROM rag_queries
        WHERE conversation_id = %(id)s
        ORDER BY created_at DESC
        LIMIT 1
        """,
        {"id": item_id},
    )
    if not rq:
        return []

    rows = await fetch_all(
        """
        SELECT
          rc.id                         AS id,
          COALESCE(d.title, dc.id::text) AS filename,
          dc.chunk_text                 AS content,
          rc.rank                       AS rank,
          rc.score                      AS score
        FROM retrieved_chunks rc
        JOIN document_chunks dc ON dc.id = rc.document_chunk_id
        LEFT JOIN documents d    ON d.id  = dc.document_id
        WHERE rc.rag_query_id = %(rq_id)s
          AND COALESCE(rc.used_in_prompt, TRUE) = TRUE
        ORDER BY rc.rank ASC NULLS LAST, rc.score DESC NULLS LAST, rc.id
        """,
        {"rq_id": rq["id"]},
    )

    return [
        {
            "id": str(r["id"]),
            "filename": r["filename"] or "snippet.txt",
            "content": r["content"] or "",
        }
        for r in rows or []
    ]