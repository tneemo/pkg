# fastapi-api-key

API key authentication for [FastAPI](https://fastapi.tiangolo.com) services, for machine-to-machine APIs where user accounts would be overkill.

- `require_api_key` is a FastAPI dependency that reads the `X-API-Key` header and accepts any key listed in the `API_KEYS` environment variable (comma-separated, so keys can be rotated without downtime).
- Comparison is constant time (`hmac.compare_digest`).
- Missing or wrong keys get `401`; if no keys are configured the API answers `503` instead of silently allowing access.
- The header shows up in the OpenAPI docs, so `/docs` gets an "Authorize" button.
