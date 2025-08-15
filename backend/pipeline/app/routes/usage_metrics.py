# app/routes/usage_metrics.py
from fastapi import APIRouter
from typing import Any, Dict
from app.crud_base import CRUDBase

router = APIRouter(prefix="/usage_metrics", tags=["usage_metrics"])
crud = CRUDBase("usage_metrics")

@router.get("/")
async def list_items():
    return await crud.list()

@router.get("/{item_id}")
async def get_item(item_id: Any):
    return await crud.get(item_id)

@router.post("/")
async def create_item(data: Dict[str, Any]):
    return await crud.create(data)

@router.put("/{item_id}")
async def update_item(item_id: Any, data: Dict[str, Any]):
    return await crud.update(item_id, data)

@router.delete("/{item_id}")
async def delete_item(item_id: Any):
    return await crud.delete(item_id)