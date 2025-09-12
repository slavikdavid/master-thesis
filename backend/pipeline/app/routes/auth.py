# app/routes/auth.py

from fastapi import APIRouter, HTTPException, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, EmailStr
from passlib.context import CryptContext
import jwt
from datetime import datetime, timedelta
from uuid import UUID

from app.db import fetch_one, execute
from app.config import JWT_SECRET, JWT_ALGORITHM, ACCESS_TOKEN_EXPIRE_MINUTES

router = APIRouter(prefix="/auth", tags=["auth"])
pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
bearer_scheme = HTTPBearer()

class SignupRequest(BaseModel):
    email: EmailStr
    password: str
    display_name: str

class LoginRequest(BaseModel):
    email: EmailStr
    password: str

class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"

class UserProfile(BaseModel):
    id: str
    email: EmailStr
    display_name: str
    created_at: datetime
    updated_at: datetime
    is_active: bool
    is_email_verified: bool

def create_access_token(user_id: str) -> str:
    now = datetime.utcnow()
    exp = now + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    payload = {"sub": user_id, "iat": now, "exp": exp}
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)

def get_current_user_token(
    creds: HTTPAuthorizationCredentials = Depends(bearer_scheme),
) -> str:
    token = creds.credentials
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        user_id: str = payload.get("sub")
        if not user_id:
            raise HTTPException(status_code=401, detail="Invalid auth token")
        return user_id
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid auth token")

@router.post("/signup", response_model=TokenResponse)
async def signup(req: SignupRequest):
    existing = await fetch_one(
        "SELECT id FROM users WHERE email = %(email)s",
        {"email": req.email},
    )
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")

    pw_hash = pwd_ctx.hash(req.password)
    row = await fetch_one(
        """
        INSERT INTO users (email, password_hash, display_name, is_email_verified)
        VALUES (%(email)s, %(pw_hash)s, %(display_name)s, TRUE)
        RETURNING id
        """,
        {"email": req.email, "pw_hash": pw_hash, "display_name": req.display_name},
    )
    user_id = row["id"]

    await execute(
        """
        INSERT INTO teams (name, owner_user_id)
        VALUES (%(team_name)s, %(user_id)s)
        ON CONFLICT (owner_user_id) DO NOTHING
        """,
        {"team_name": f"Personal: {req.email}", "user_id": user_id},
    )

    token = create_access_token(str(user_id))
    return TokenResponse(access_token=token)


@router.post("/login", response_model=TokenResponse)
async def login(req: LoginRequest):
    row = await fetch_one(
        "SELECT id, password_hash, is_active FROM users WHERE email = %(email)s",
        {"email": req.email},
    )
    if not row or not row["is_active"]:
        raise HTTPException(status_code=401, detail="Invalid credentials")

    if not pwd_ctx.verify(req.password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    token = create_access_token(str(row["id"]))
    return TokenResponse(access_token=token)


@router.get("/me", response_model=UserProfile)
async def me(user_id: str = Depends(get_current_user_token)):
    row = await fetch_one(
        """
        SELECT id, email, display_name, created_at, updated_at,
               is_active, is_email_verified
        FROM users
        WHERE id = %(id)s
        """,
        {"id": user_id},
    )
    if not row:
        raise HTTPException(status_code=404, detail="User not found")

    data = dict(row)
    data["id"] = str(data["id"])

    return UserProfile(**data)
