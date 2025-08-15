# app/routes/users.py
from fastapi import APIRouter
from typing import Any
from app.crud_base import CRUDBase

router = APIRouter(prefix="/users", tags=["users"])
crud = CRUDBase("users")

@router.get("/")
async def list_users():
    return await crud.list()

@router.get("/{item_id}")
async def get_user(item_id: Any):
    return await crud.get(item_id)

@router.post("/")
async def create_user(data: dict):
    return await crud.create(data)

@router.put("/{item_id}")
async def update_user(item_id: Any, data: dict):
    return await crud.update(item_id, data)

@router.delete("/{item_id}")
async def delete_user(item_id: Any):
    return await crud.delete(item_id)