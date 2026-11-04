from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=REPO_ROOT / ".env", extra="ignore")

    app_env: Literal["development", "test", "production"] = "development"
    database_url: str = "postgresql+psycopg://testforge:testforge_local@127.0.0.1:55432/testforge"
    session_cookie_name: str = "testforge_session"
    session_ttl_seconds: int = 8 * 60 * 60
    cookie_secure: bool = False
    allowed_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]
    payment_sim_timeout_ms: int = 1000
    # Requests allowed to wait for a free slot before the API answers 503. See ARCHITECTURE.md.
    max_queued_requests: int = 200
    # Offline needs no credentials. The OpenAI key is read only by testforge_ai.llm, never here.
    support_chat_provider: Literal["offline", "openai"] = "offline"

    @model_validator(mode="after")
    def _production_requires_secure_cookies(self) -> "Settings":
        if self.app_env == "production" and not self.cookie_secure:
            raise ValueError("COOKIE_SECURE must be true when APP_ENV=production")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
