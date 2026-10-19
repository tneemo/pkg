This is a foundation: it creates the project. After installing (pkg creates `.venv` and installs the requirements):

1. Run the tests: `.venv/bin/python -m pytest` (Windows: `.venv\Scripts\python -m pytest`).
2. Start the server: `.venv/bin/python -m uvicorn app.main:app --reload`, then open http://localhost:8000/docs.
3. Add features as routers in `app/routers/<feature>.py` and include them in `create_app()` in `app/main.py`. Follow `AGENTS.md`.
