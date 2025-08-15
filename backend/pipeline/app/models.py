from pydantic import BaseModel
from typing import List

class RepoStatus(BaseModel):
    status: str

class RepoQuery(BaseModel):
    question: str
    answer: str
    timestamp: str
