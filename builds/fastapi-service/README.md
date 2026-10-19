# fastapi-service

A clean starting point for a JSON REST API in Python with [FastAPI](https://fastapi.tiangolo.com).

- `app/main.py`: `create_app()` with optional CORS, a catch-all handler that logs unexpected errors and returns JSON 500s, and router registration.
- `app/config.py`: typed settings from environment variables and `.env` with pydantic-settings.
- `app/routers/health.py`: `GET /health`.
- `tests/`: pytest with FastAPI's `TestClient`, no running server needed.
- `AGENTS.md`: project conventions for coding agents.

pkg creates `.venv` and installs `requirements-dev.txt` for you. Pairs with `tneemo/fastapi-api-key` for API key auth.
