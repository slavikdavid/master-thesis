from pydantic import BaseModel

class QueryRequest(BaseModel):
    repoId: str
    question: str
