# app/routes/messages.py
from fastapi import APIRouter, Query
from typing import Any, Dict, List
from datetime import datetime
from app.crud_base import CRUDBase

router = APIRouter(prefix="/messages", tags=["messages"], redirect_slashes=False)
crud = CRUDBase("messages")

def _parse_ts(v) -> float:
    if not v:
        return 0.0
    if isinstance(v, (int, float)):
        return float(v)
    # ISO8601
    try:
        # allow trailing Z
        if isinstance(v, str) and v.endswith("Z"):
            v = v[:-1] + "+00:00"
        return datetime.fromisoformat(v).timestamp()
    except Exception:
        return 0.0

@router.get("")
@router.get("/")
async def list_messages(conversation_id: str = Query(...)) -> List[Dict[str, Any]]:
    """
    Return messages for a conversation in chronological order.
    Works even if CRUDBase.list() doesn't support 'filters'.
    """
    try:
        items = await crud.list({"conversation_id": conversation_id})
    except TypeError:
        # fallback: fetch all, filter client-side
        items = await crud.list()
        items = [
            m for m in (items or [])
            if str(m.get("conversation_id")) == str(conversation_id)
        ]

    # sort oldest→newest
    items.sort(key=lambda m: (_parse_ts(m.get("created_at") or m.get("createdAt")), str(m.get("id", ""))))
    return items

@router.get("/{item_id}")
async def get_message(item_id: Any):
    return await crud.get(item_id)

@router.post("")
@router.post("/")
async def create_message(data: Dict[str, Any]):
    return await crud.create(data)

@router.put("/{item_id}")
async def update_message(item_id: Any, data: Dict[str, Any]):
    return await crud.update(item_id, data)

@router.delete("/{item_id}")
async def delete_message(item_id: Any):
    return await crud.delete(item_id)