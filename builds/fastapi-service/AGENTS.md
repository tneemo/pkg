# Conventions

- The FastAPI app is assembled in `app/main.py` (`create_app`). Add each feature as a router module in `app/routers/` and include it there: `app.include_router(items.router, prefix="/items")`.
- Use Pydantic models for request and response bodies. Raise `HTTPException` for expected errors.
- Settings come from environment variables via `app/config.py` (`get_settings()`); document new ones in `.env.example`.
- Tests live in `tests/` and use `fastapi.testclient.TestClient`. Run them with `.venv/bin/python -m pytest` (`.venv\Scripts\python -m pytest` on Windows).
- Run the server with `.venv/bin/python -m uvicorn app.main:app --reload`.
- Builds installed with pkg are listed in `pkg.lock.json`. Look for existing ones before writing a common feature: `npx -y @tneemo/pkg search "<need>" --stack python,fastapi`.
