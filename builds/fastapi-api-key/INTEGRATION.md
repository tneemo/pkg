1. Protect a whole router (for example in `app/main.py` of `tneemo/fastapi-service`):
   ```python
   from fastapi import Depends
   from app.security import require_api_key

   app.include_router(items.router, prefix="/items", dependencies=[Depends(require_api_key)])
   ```
   or a single route: `@router.get("/", dependencies=[Depends(require_api_key)])`.
2. Set `API_KEYS` (comma-separated) in the environment or `.env`. In tests use `monkeypatch.setenv("API_KEYS", "test-key")` and send `headers={"X-API-Key": "test-key"}`.
