from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.security import require_api_key

app = FastAPI()


@app.get("/secret", dependencies=[Depends(require_api_key)])
def secret():
    return {"ok": True}


client = TestClient(app)


def test_accepts_configured_keys(monkeypatch):
    monkeypatch.setenv("API_KEYS", "one, two")
    assert client.get("/secret", headers={"X-API-Key": "two"}).json() == {"ok": True}


def test_rejects_missing_or_wrong_keys(monkeypatch):
    monkeypatch.setenv("API_KEYS", "one")
    assert client.get("/secret").status_code == 401
    assert client.get("/secret", headers={"X-API-Key": "nope"}).status_code == 401


def test_unconfigured_is_503(monkeypatch):
    monkeypatch.delenv("API_KEYS", raising=False)
    assert client.get("/secret", headers={"X-API-Key": "x"}).status_code == 503
