# app/crud_base.py
from typing import Any, Dict, Optional
from fastapi import HTTPException
from app.db import fetch_all, fetch_one, execute

class CRUDBase:
    def __init__(self, table: str, id_column: str = "id"):
        self.table = table
        self.id_column = id_column

    async def list(self):
        return await fetch_all(f"SELECT * FROM {self.table}")

    async def get(self, item_id: Any):
        row = await fetch_one(f"SELECT * FROM {self.table} WHERE {self.id_column} = %(id)s", {"id": item_id})
        if not row:
            raise HTTPException(status_code=404, detail=f"{self.table} not found")
        return row

    async def create(self, data: Dict[str, Any]):
        keys = data.keys()
        query = f"""
        INSERT INTO {self.table} ({", ".join(keys)})
        VALUES ({", ".join(f"%({k})s" for k in keys)})
        RETURNING *
        """
        return await fetch_one(query, data)

    async def update(self, item_id: Any, data: Dict[str, Any]):
        if not data:
            raise HTTPException(status_code=400, detail="No fields to update")
        set_clause = ", ".join(f"{k} = %({k})s" for k in data.keys())
        data["id"] = item_id
        query = f"""
        UPDATE {self.table} SET {set_clause}
        WHERE {self.id_column} = %(id)s
        RETURNING *
        """
        row = await fetch_one(query, data)
        if not row:
            raise HTTPException(status_code=404, detail=f"{self.table} not found")
        return row

    async def delete(self, item_id: Any):
        await execute(f"DELETE FROM {self.table} WHERE {self.id_column} = %(id)s", {"id": item_id})
        return {"status": "deleted"}
