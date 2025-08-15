# app/routes/teams.py
from fastapi import APIRouter
from typing import Any
from app.crud_base import CRUDBase

router = APIRouter(prefix="/teams", tags=["teams"])
crud = CRUDBase("teams")

@router.get("/")
async def list_teams():
    return await crud.list()

@router.get("/{item_id}")
async def get_team(item_id: Any):
    return await crud.get(item_id)

@router.post("/")
async def create_team(data: dict):
    return await crud.create(data)

@router.put("/{item_id}")
async def update_team(item_id: Any, data: dict):
    return await crud.update(item_id, data)

@router.delete("/{item_id}")
async def delete_team(item_id: Any):
    return await crud.delete(item_id)