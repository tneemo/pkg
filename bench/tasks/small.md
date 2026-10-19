Build a small Python HTTP API with FastAPI in the current directory (it is empty).

Requirements:
- `GET /health` returns 200 `{"status": "ok"}` and needs no authentication.
- `GET /v1/quote` returns 200 `{"quote": "<text>", "author": "<text>"}`, picked at random from at least 5 built-in quotes.
- `/v1/quote` requires an API key in the `X-API-Key` header. Accepted keys come from the `API_KEYS` environment variable (comma-separated, so keys can be rotated). A missing or wrong key gets 401.
- Create a virtualenv at `.venv` with everything installed. `./start.sh` starts the server, using `.venv`, on the port in the `PORT` environment variable (default 8000).
- Write pytest tests. `.venv/bin/python -m pytest` must pass.

Do not ask me questions; make reasonable decisions. When you are done, briefly summarize what you built.
