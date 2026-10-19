import hmac
import os

from fastapi import HTTPException, Security, status
from fastapi.security import APIKeyHeader

_header = APIKeyHeader(name="X-API-Key", auto_error=False)


def _accepted_keys() -> list[str]:
    return [k.strip() for k in os.environ.get("API_KEYS", "").split(",") if k.strip()]


def require_api_key(api_key: str | None = Security(_header)) -> str:
    """FastAPI dependency: 401 unless X-API-Key matches one of API_KEYS. Returns the key."""
    keys = _accepted_keys()
    if not keys:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "API_KEYS is not configured")
    if api_key and any(hmac.compare_digest(api_key.encode(), k.encode()) for k in keys):
        return api_key
    raise HTTPException(
        status.HTTP_401_UNAUTHORIZED,
        "Invalid or missing API key",
        headers={"WWW-Authenticate": "APIKey"},
    )
