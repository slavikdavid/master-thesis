from fastapi import APIRouter, HTTPException, status
from typing import Any, Dict, List
from app.crud_base import CRUDBase

router = APIRouter(prefix="/user_roles", tags=["user_roles"])
crud = CRUDBase("user_roles")

@router.get("/", response_model=List[Dict[str, Any]])
async def list_user_roles():
    """List all user-role assignments"""
    return await crud.list()

@router.get("/{user_id}/{role_id}", response_model=Dict[str, Any])
async def get_user_role(user_id: Any, role_id: Any):
    """Get a specific user-role assignment"""
    query = (
        "SELECT user_id, role_id "
        "FROM user_roles "
        "WHERE user_id = :user_id AND role_id = :role_id"
    )
    record = await crud.db.fetch_one(query, {"user_id": user_id, "role_id": role_id})
    if not record:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="UserRole assignment not found"
        )
    return record

@router.post("/", status_code=status.HTTP_201_CREATED, response_model=Dict[str, Any])
async def assign_role_to_user(data: Dict[str, Any]):
    """Assign a role to a user (expects {'user_id': ..., 'role_id': ...})"""
    return await crud.create(data)

@router.delete("/{user_id}/{role_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_role_from_user(user_id: Any, role_id: Any):
    """Remove a role assignment from a user"""
    query = (
        "DELETE FROM user_roles "
        "WHERE user_id = :user_id AND role_id = :role_id"
    )
    await crud.db.execute(query, {"user_id": user_id, "role_id": role_id})
    return None
