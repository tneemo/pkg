from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Settings read from environment variables (and .env). Add new ones here."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "service"
    environment: str = "development"
    cors_origins: list[str] = []


@lru_cache
def get_settings() -> Settings:
    return Settings()
