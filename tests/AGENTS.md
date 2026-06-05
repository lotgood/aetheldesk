# TESTS KNOWLEDGE BASE

## OVERVIEW

Tests lock backend contracts, frontend source contracts, and browser room flows. Default pytest excludes Playwright e2e.

## STRUCTURE

```text
test_backend_routes.py      # REST/static/health behavior with fake Redis
test_backend_state.py       # BackendState defaults and reducer/timer transitions
test_room_store.py          # Redis store contract, TTLs, token lookup, rate limits
test_room_auth.py           # PIN/token hashing, generic auth failure, stale-token rejection
test_websocket_redis.py     # tokenized WebSocket, Redis outage, state publish/broadcast
test_event_bus.py           # Redis Pub/Sub full-state snapshot fanout
test_client_messages.py     # WebSocket client command parser boundary
test_state_codec.py         # BackendState Redis JSON codec validation
test_frontend_static.py     # source-level frontend contract and a11y assertions
test_frontend_*_structure.py # frontend module boundary regression checks
e2e/                        # Playwright room/lobby flows against live uvicorn
```

## WHERE TO LOOK

| Task | Location | Notes |
|---|---|---|
| Test selection | `../pytest.ini` | `addopts` excludes `tests/e2e` and marker `e2e`. |
| Fake Redis API tests | `test_backend_routes.py` | `api_client` monkeypatches `backend.main` globals and `RoomStore`. |
| Redis contract | `test_redis_contract.py`, `test_room_store.py` | Key builders, TTLs, room index, token and PIN attempt behavior. |
| WebSocket contract | `test_room_auth.py`, `test_websocket_redis.py` | Close codes, initial state, stale token rejection, outage handling. |
| Frontend contracts | `test_frontend_static.py`, `test_frontend_*_structure.py` | Storage keys, external asset allowlist, module boundaries, Korean/a11y/reduced-motion assertions. |
| Browser flows | `e2e/conftest.py`, `e2e/test_room_pin.py`, `e2e/test_room_sync.py` | Uvicorn starts from `backend/` with `AETHELDESK_ENV=test`; covers PIN, auth focus, font fallback, sync, touch, and reduced motion. |

## CONVENTIONS

- Prefer local fake Redis/test fixtures over requiring a real Redis service for default tests.
- Monkeypatch `backend.main` runtime globals when isolating app state; many tests intentionally import that compatibility surface.
- Backend tests should assert no secret fields or plaintext PIN/token leakage.
- Frontend source assertions are intentional contract tests; keep them high-signal when changing module boundaries or DOM ids.
- E2E tests require Chromium and should be marked/selected with `-m e2e`.
- Browser e2e uses a random local port and `python -m uvicorn main:app` from `backend/`.

## ANTI-PATTERNS (THIS PROJECT)

- Do not weaken tests to accept secret leakage, changed Redis keys, changed WebSocket close codes, or extra frontend storage keys.
- Do not add e2e assumptions to the default suite; keep slow/browser tests under `tests/e2e` and marker `e2e`.
- Do not make tests depend on committed `frontend/dist`; source fallback and Vite build are separate surfaces.
- Do not delete static contract tests just because they inspect source strings; they guard behavior without a JS test runner.

## COMMANDS

```bash
uv run pytest -q
uv run pytest tests/test_frontend_static.py -q
uv run playwright install chromium
uv run pytest tests/e2e -m e2e --browser chromium -q
```
