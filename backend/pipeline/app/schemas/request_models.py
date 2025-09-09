# app/schemas/request_models.py
from pydantic import BaseModel
from typing import Optional

class QueryRequest(BaseModel):
    question: str
    repoId: str
    conversationId: Optional[str] = None
    userId: Optional[str] = None 