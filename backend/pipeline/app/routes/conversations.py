# app/routes/conversations.py

from fastapi import APIRouter, HTTPException, Query
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

@router.get("/{item_id}/contexts/history")
async def get_contexts_history(item_id: Any) -> List[Dict[str, Any]]:
    """
    Return contexts grouped per assistant message in this conversation.

    Response shape:
    [
      {
        "message_id": "<uuid of assistant message>",
        "rag_query_id": "<uuid of rag_queries row>",
        "contexts": [
          { "id": "<retrieved_chunks.id>", "filename": "<title or doc id>", "content": "<chunk text>", "rank": 1, "score": 0.42 },
          ...
        ]
      },
      ...
    ]
    """
    conv = await fetch_one(
        "SELECT id FROM conversations WHERE id = %(id)s",
        {"id": item_id},
    )
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")

    pairs = await fetch_all(
        """
        SELECT
          rq.id              AS rag_query_id,
          m.id               AS message_id
        FROM rag_queries rq
        LEFT JOIN LATERAL (
          SELECT id
          FROM messages
          WHERE conversation_id = rq.conversation_id
            AND role = 'assistant'
            AND created_at >= rq.created_at
          ORDER BY created_at ASC
          LIMIT 1
        ) m ON TRUE
        WHERE rq.conversation_id = %(cid)s
        ORDER BY rq.created_at ASC
        """,
        {"cid": item_id},
    )

    if not pairs:
        return []

    out: List[Dict[str, Any]] = []
    for row in pairs:
        rq_id = row["rag_query_id"]
        msg_id = row["message_id"]
        if not msg_id:
            continue

        chunks = await fetch_all(
            """
            SELECT
              rc.id                           AS id,
              COALESCE(d.title, dc.id::text)  AS filename,
              dc.chunk_text                   AS content,
              rc.rank                         AS rank,
              rc.score                        AS score
            FROM retrieved_chunks rc
            JOIN document_chunks dc ON dc.id = rc.document_chunk_id
            LEFT JOIN documents d    ON d.id  = dc.document_id
            WHERE rc.rag_query_id = %(rq_id)s
              AND COALESCE(rc.used_in_prompt, TRUE) = TRUE
            ORDER BY rc.rank ASC NULLS LAST, rc.score DESC NULLS LAST, rc.id
            """,
            {"rq_id": rq_id},
        )

        out.append({
            "message_id": str(msg_id),
            "rag_query_id": str(rq_id),
            "contexts": [
                {
                    "id": str(c["id"]),
                    "filename": c["filename"] or "snippet.txt",
                    "content": c["content"] or "",
                    "rank": c["rank"],
                    "score": c["score"],
                } for c in (chunks or [])
            ],
        })

    return out

@router.get("/{item_id}/contexts")
async def get_contexts(item_id: Any) -> List[Dict[str, Any]]:
  """
  Return retrieved chunks used for the *latest* RAG query of this conversation.
  """
  conv = await fetch_one("SELECT id FROM conversations WHERE id = %(id)s", {"id": item_id})
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
      rc.id                          AS id,
      COALESCE(d.title, dc.id::text) AS filename,
      dc.chunk_text                  AS content,
      rc.rank                        AS rank,
      rc.score                       AS score
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
      "score": r.get("score"),
    }
    for r in rows or []
  ]

# ---------- Contexts (full history) ----------

@router.get("/{item_id}/contexts/history")
async def get_context_history(item_id: Any) -> List[Dict[str, Any]]:
  """
  Return all RAG queries for the conversation, each with contexts and the
  *best-effort* assistant message id that this RAG turn produced.
  """
  conv = await fetch_one("SELECT id FROM conversations WHERE id = %(id)s", {"id": item_id})
  if not conv:
    raise HTTPException(status_code=404, detail="Conversation not found")

  rqs = await fetch_all(
    """
    SELECT id, created_at
    FROM rag_queries
    WHERE conversation_id = %(id)s
    ORDER BY created_at ASC
    """,
    {"id": item_id},
  )

  out: List[Dict[str, Any]] = []
  for rq in rqs or []:
    msg = await fetch_one(
      """
      SELECT id
      FROM messages
      WHERE conversation_id = %(cid)s
        AND role = 'assistant'
        AND created_at >= %(t)s
      ORDER BY created_at ASC
      LIMIT 1
      """,
      {"cid": item_id, "t": rq["created_at"]},
    )

    rows = await fetch_all(
      """
      SELECT
        rc.id                          AS id,
        COALESCE(d.title, dc.id::text) AS filename,
        dc.chunk_text                  AS content,
        rc.rank                        AS rank,
        rc.score                       AS score
      FROM retrieved_chunks rc
      JOIN document_chunks dc ON dc.id = rc.document_chunk_id
      LEFT JOIN documents d    ON d.id  = dc.document_id
      WHERE rc.rag_query_id = %(rq_id)s
        AND COALESCE(rc.used_in_prompt, TRUE) = TRUE
      ORDER BY rc.rank ASC NULLS LAST, rc.score DESC NULLS LAST, rc.id
      """,
      {"rq_id": rq["id"]},
    )

    out.append(
      {
        "rag_query_id": str(rq["id"]),
        "message_id": str(msg["id"]) if msg else None,
        "contexts": [
          {
            "id": str(r["id"]),
            "filename": r["filename"] or "snippet.txt",
            "content": r["content"] or "",
            "score": r.get("score"),
          }
          for r in rows or []
        ],
      }
    )
  return out

@router.get("/{item_id}/contexts/summary")
async def get_context_summary(item_id: Any):
  """
  Per-file usage summary for a conversation.
  Response:
  {
    "files": [{ "filename": str, "uses": int, "last_used_at": "timestamp", "sample": "..." }],
    "total_chunks": int
  }
  """
  conv = await fetch_one("SELECT id FROM conversations WHERE id = %(id)s", {"id": item_id})
  if not conv:
    raise HTTPException(status_code=404, detail="Conversation not found")

  rows = await fetch_all(
    """
    WITH used AS (
      SELECT
        rq.id                      AS rag_query_id,
        rq.created_at              AS rq_created_at,
        COALESCE(d.title, dc.id::text) AS filename,
        dc.chunk_text              AS content,
        rc.rank                    AS rank
      FROM rag_queries rq
      JOIN retrieved_chunks rc ON rc.rag_query_id = rq.id AND COALESCE(rc.used_in_prompt, TRUE) = TRUE
      JOIN document_chunks dc  ON dc.id = rc.document_chunk_id
      LEFT JOIN documents d    ON d.id  = dc.document_id
      WHERE rq.conversation_id = %(cid)s
    )
    SELECT
      filename,
      COUNT(*)                        AS uses,
      MAX(rq_created_at)              AS last_used_at,
      (ARRAY_AGG(content ORDER BY rank ASC))[1] AS sample
    FROM used
    GROUP BY filename
    ORDER BY uses DESC, last_used_at DESC, filename
    """,
    {"cid": item_id},
  )

  total = await fetch_one(
    """
    SELECT COUNT(*) AS n
    FROM retrieved_chunks rc
    WHERE rc.rag_query_id IN (
      SELECT id FROM rag_queries WHERE conversation_id = %(cid)s
    ) AND COALESCE(rc.used_in_prompt, TRUE) = TRUE
    """,
    {"cid": item_id},
  )

  return {
    "files": [
      {
        "filename": r["filename"] or "snippet.txt",
        "uses": int(r["uses"] or 0),
        "last_used_at": r["last_used_at"],
        "sample": (r["sample"] or "")[:500],
      }
      for r in rows or []
    ],
    "total_chunks": int(total["n"] or 0),
  }

# ---------- Highlights for a specific file ----------

@router.get("/{item_id}/file-highlights")
async def get_file_highlights(item_id: Any, path: str = Query(..., description="Repo-relative path / filename")):
  """
  Return line ranges for a given file used in this conversation.
  Response:
  {
    "filename": str,
    "ranges": [{ "start": int|null, "end": int|null, "rank": int|null }],
    "sample": "..."
  }
  """
  conv = await fetch_one("SELECT id FROM conversations WHERE id = %(id)s", {"id": item_id})
  if not conv:
    raise HTTPException(status_code=404, detail="Conversation not found")

  rows = await fetch_all(
    """
    SELECT
      COALESCE(d.title, dc.id::text) AS filename,
      NULLIF(dc.start_line, 0)       AS start_line,
      NULLIF(dc.end_line, 0)         AS end_line,
      rc.rank                        AS rank,
      dc.chunk_text                  AS content
    FROM rag_queries rq
    JOIN retrieved_chunks rc ON rc.rag_query_id = rq.id AND COALESCE(rc.used_in_prompt, TRUE) = TRUE
    JOIN document_chunks dc  ON dc.id = rc.document_chunk_id
    LEFT JOIN documents d    ON d.id  = dc.document_id
    WHERE rq.conversation_id = %(cid)s
      AND (COALESCE(d.title, dc.id::text) = %(p)s OR COALESCE(d.title, '') ILIKE %(sfx)s)
    ORDER BY rc.rank ASC NULLS LAST, rq.created_at DESC
    """,
    {"cid": item_id, "p": path, "sfx": f"%{path}"},
  )

  if not rows:
    return {"filename": path, "ranges": [], "sample": ""}

  ranges = [
    {
      "start": r["start_line"],
      "end": r["end_line"],
      "rank": r["rank"],
    }
    for r in rows
  ]
  sample = (rows[0]["content"] or "")[:1000]
  return {"filename": rows[0]["filename"] or path, "ranges": ranges, "sample": sample}