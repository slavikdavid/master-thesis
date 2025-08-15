from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field, AnyHttpUrl

class Settings(BaseSettings):
    # Database
    DATABASE_DSN: str = Field(..., env="DATABASE_URL")

    # JWT / Auth
    JWT_SECRET: str = Field(..., env="JWT_SECRET")
    JWT_ALGORITHM: str = Field("HS256", env="JWT_ALGORITHM")
    ACCESS_TOKEN_EXPIRE_MINUTES: int = Field(
        60 * 24, env="ACCESS_TOKEN_EXPIRE_MINUTES"
    )  # 1 day

    # LLM
    GROQ_API_KEY: str | None = Field(None, env="GROQ_API_KEY")
    GROQ_API_BASE: AnyHttpUrl = Field(
        "https://api.groq.com/openai/v1", env="GROQ_API_BASE"
    )
    GROQ_MODEL: str = Field("qwen/qwen3-32b", env="GROQ_MODEL")

    # misc
    UPLOAD_DIR: str = Field("uploads", env="UPLOAD_DIR")
    DATA_DIR: str = Field("data/repos", env="DATA_DIR")
    TOKEN_EXPIRE_MINUTES: int = Field(60 * 24, env="TOKEN_EXPIRE_MINUTES")

    # SettingsConfigDict for Pydantic v2
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

# instantiate settings
settings = Settings()

# expose module-level constants for easier imports
DATABASE_DSN = settings.DATABASE_DSN
JWT_SECRET = settings.JWT_SECRET
JWT_ALGORITHM = settings.JWT_ALGORITHM
ACCESS_TOKEN_EXPIRE_MINUTES = settings.ACCESS_TOKEN_EXPIRE_MINUTES
GROQ_API_KEY = settings.GROQ_API_KEY
GROQ_API_BASE = settings.GROQ_API_BASE
GROQ_MODEL = settings.GROQ_MODEL
UPLOAD_DIR = settings.UPLOAD_DIR
DATA_DIR = settings.DATA_DIR
TOKEN_EXPIRE_MINUTES = settings.TOKEN_EXPIRE_MINUTES
