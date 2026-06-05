# BACKEND KNOWLEDGE BASE

## OVERVIEW

FastAPI owns room authority: REST room creation/join, PIN/token security, Redis canonical state, WebSocket fanout, and scheduler ticks.

## WHERE TO LOOK

| Task | Location | Notes |
|---|---|---|
| Composition/static mounts | `main.py`, `frontend_routes.py` | `main.py` is also a compatibility export surface for tests. |
| REST routes | `room_routes.py` | `/health`, `/api/rooms`, `/api/rooms/{room_id}/join`. |
| Runtime globals | `runtime.py`, `main.py` | Runtime constants, compatibility exports, Redis vs in-memory fallback globals. |
| Room orchestration | `room_service.py`, `room_lifecycle.py` | Room state access, empty cleanup, create/join lifecycle, event bus setup. |
| Auth primitives | `auth.py`, `room_auth_service.py` | PIN hashing, token generation/hash, uniform failure body, rate-limit policy, token scoping. |
| Redis persistence | `room_store.py`, `state_codec.py` | State, metadata, token lookup, PIN attempts/blocks, room index, tick lock, state JSON codec. |
| Redis contract | `redis_contract.py` | Normalization, key/channel builders, Pub/Sub envelope shape. |
| State reducer | `state.py` | `BackendState`, default state, timer transitions, accepted client messages. |
| Client messages | `client_messages.py` | Typed parser for WebSocket command payloads before state mutation. |
| WebSockets | `websocket_handler.py`, `room_session.py` | Transport close-code handling plus authorized state load, connect/disconnect, persist/broadcast/publish loop. |
| Cross-worker fanout | `event_bus.py` | Full-state snapshot publish/dispatch; ignores own and duplicate events. |
| Scheduler | `scheduler.py`, `scheduler_wiring.py` | Per-room tick lock, timer/celestial updates, startup task wiring. |

## CONVENTIONS

- Keep `BackendState` in `state.py` as the canonical schema for Redis values, WebSocket state messages, and Pub/Sub event data.
- Room ids must pass through `normalize_room_id()` and stay valid against `[A-Z0-9]{1,64}` before entering Redis keys.
- Redis keys/channels use `aetheldesk:room:{ROOM_ID}:...`; always use builders in `redis_contract.py`.
- Use `client_messages.parse_client_message()`, `room_service.handle()`, and `state.handle()` for accepted client message mutation; avoid ad hoc state field edits in route/transport code.
- Auth responses are deliberately generic. Use `auth.failure_body()` and WebSocket close `1008 authentication failed` for auth rejection.
- Redis operational failures surface as HTTP `503 {"detail":"redis unavailable"}` or WebSocket close `1011 service unavailable`.
- Opaque tokens are scoped by `room_instance_id`; recreated rooms must reject tokens from older instances.
- In-memory globals in `main.py` are fallback/test behavior only. Production/cross-worker behavior depends on `RoomStore` and Redis Pub/Sub.
- Preserve package import plus `except ModuleNotFoundError` fallback patterns where present; Docker and e2e run from `backend/`.

## ANTI-PATTERNS (THIS PROJECT)

- Do not persist plaintext PINs or plaintext tokens; do not expose token hashes in responses or room secrets in logs.
- Do not bypass Redis tick locks in scheduler paths; multiple workers may run the scheduler.
- Do not publish partial deltas over Redis Pub/Sub; current contract is full `BackendState` snapshots.
- Do not change close codes, Redis key names, route shapes, or response bodies without updating `../docs/architecture/contracts.md` and tests.
- Do not make health pass in normal runtime when required Redis is unavailable.

## VERIFY

```bash
uv run ruff format --check backend tests
uv run ruff check backend tests
uv run pyright
uv run pytest -q
```
