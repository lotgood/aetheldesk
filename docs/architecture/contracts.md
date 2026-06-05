# AethelDesk Architecture Contracts

This document records the Wave 1 contract baseline for modernization. Later refactors must preserve these public REST, WebSocket, Redis, `BackendState`, and frontend storage contracts unless a later decision record explicitly changes them.

## Decision Record

| Decision | Baseline |
|---|---|
| Public boundary owner | `backend/main.py` assembles the FastAPI app and compatibility exports; `backend/frontend_routes.py`, `backend/room_routes.py`, and `backend/websocket_handler.py` own route handlers/static serving/transport while `backend/room_auth_service.py`, `backend/room_lifecycle.py`, `backend/client_messages.py`, `backend/state_codec.py`, and `backend/room_session.py` own focused auth, lifecycle, parsing, codec, and WebSocket session boundaries. |
| State authority | FastAPI owns authoritative room state. Redis stores the cross-worker canonical JSON state when configured; the in-memory path is only for tests/local no-Redis behavior. |
| Room identity | Room ids are normalized with `normalize_room_id(room_id)`, which strips surrounding whitespace and uppercases the id. Valid ids match `[A-Z0-9]{1,64}` after normalization. |
| Auth and secrecy | Create/join requests accept plaintext PINs only at the request boundary. Stored PINs and tokens are hashes; API responses do not expose PINs, PIN hashes, or token hashes. Auth failures remain generic. |
| Frontend stack | The current frontend is Vite + vanilla ES modules. React, Vue, Svelte, and TypeScript remain out of scope unless separately approved. |

## Modernization Governance

These decisions guide later waves without changing the Wave 1 runtime contracts above. Current-state wording describes what exists now. Out-of-scope wording names work that still requires separate approval.

| Area | Governance |
|---|---|
| Frontend tooling | Vite + vanilla ES modules is the current frontend implementation. `vite.config.js` proxies `/api` to `http://127.0.0.1:8000` and `/ws` to `ws://127.0.0.1:8000` for local dev. |
| Framework scope | React, Vue, Svelte, and TypeScript remain out of scope unless separately approved. Webpack is not part of this modernization plan. |
| Workflows | Docker Compose, local `uv run`, and direct Vite builds are first-class workflows. The command matrix anchors are `uv sync --frozen`, `uv run ruff format --check .`, `uv run ruff check .`, `uv run pyright`, `uv run pytest -q`, `uv run pytest tests/e2e -m e2e --browser chromium -q`, `npm ci`, `npm run build`, and `docker compose up --build --detach`. |
| Quality staging | Python typing and formatting strictness is tightened module by module. `backend/auth.py` is the current Pyright strict pilot; later modules should graduate by adding a focused strict entry and keeping module contract tests green before broader policy changes. |
| Redis policy | Redis is mandatory for Docker/prod and cross-worker behavior. The in-memory fallback is only for tests and local no-Redis development. Redis outages are normalized to the existing HTTP `503 {"detail":"redis unavailable"}` and WebSocket `1011 service unavailable` operational contracts. |
| UI language | The UI is Korean-primary for interactive controls, validation errors, live regions, and status text. Brand, `PIN`, YouTube terms, API fields, and storage keys stay stable. A full i18n toggle is out of scope for this plan. |
| External frontend dependencies | The YouTube iframe API remains allowed for focus music. Tailwind CDN and Google Fonts are not runtime dependencies; local Vite-managed CSS owns styling and font fallback stacks. Vite should serve local build assets, and `frontend/dist/` remains generated output only. |
| Excluded systems | SQL/accounts/analytics, Redis Streams, Celery, Kubernetes, TLS automation, React, Vue, Svelte, TypeScript, and reverse-proxy config changes remain out of scope. |

## Route Matrix

| Path | Method / Protocol | Request contract | Success contract | Failure / close contract | Source | Tests |
|---|---|---|---|---|---|---|
| `/` | `GET` | No payload. | Serves `frontend/lobby.html`; Vite production assets are referenced from `frontend/dist/assets` when built. | Static file errors are framework-level. | `backend/frontend_routes.py` `lobby()`; `frontend/lobby.html` | `tests/test_frontend_static.py`; e2e tests navigate from lobby to room. |
| `/room/{room_id}` | `GET` | `room_id` path segment is accepted by the route and the Vite room client uppercases the final path segment for client-side use. | Serves `frontend/room.html`; Vite production assets are referenced from `frontend/dist/assets` when built. | Static file errors are framework-level. | `backend/frontend_routes.py` `room_page()`; `frontend/app.js`; `frontend/src/room-controller.js` `roomId` | `tests/test_frontend_static.py::test_room_token_uses_session_storage_keyed_by_uppercase_room_id`; e2e room tests. |
| `/health` | `GET` | No payload. | Returns `{"status":"ok"}` in test mode without Redis or when Redis ping succeeds. | Returns HTTP `503` with `{"detail":"redis unavailable"}` when Redis is required but unavailable. | `backend/room_routes.py` `health()` | `tests/test_backend_routes.py::test_health_returns_ok_when_redis_is_reachable`; `tests/test_backend_routes.py::test_health_returns_503_when_redis_unreachable`. |
| `/api/rooms` | `POST` | JSON body `{"room_id": string or null, "pin": string}`. `pin` must be 4-64 chars. Missing `room_id` generates an uppercase id; supplied ids are normalized and must be valid. | Returns `{"room_id": NORMALIZED_ROOM_ID, "token": OPAQUE_TOKEN}`. Existing rooms require the same PIN and return a fresh token. | Invalid room ids return HTTP `400` `{"detail":"invalid room id"}`. Room limit returns HTTP `403` `{"detail":"room limit reached"}`. Existing-room wrong PIN uses generic auth failure. | `backend/room_routes.py` `CreateRoomRequest`, `_require_valid_room_id()`, `create_room()` | `tests/test_backend_routes.py`; `tests/test_room_auth.py`; `tests/test_input_validation.py`. |
| `/api/rooms/{room_id}/join` | `POST` | JSON body `{"pin": string}`. `pin` must be 4-64 chars. `room_id` is normalized and must be valid. | Returns `{"token": OPAQUE_TOKEN}` only. | Wrong room, wrong PIN, or missing stored PIN returns the same generic auth failure shape. Redis-backed rate-limit blocks return generic auth failure with HTTP `403`. | `backend/room_routes.py` `JoinRoomRequest`, `_assert_not_rate_limited()`, `_record_failed_attempt()`, `join_room()` | `tests/test_backend_routes.py`; `tests/test_room_auth.py`; `tests/test_input_validation.py`. |
| `/ws/{room_id}` | WebSocket | `room_id` path segment plus required `token` query parameter. The token must authorize the normalized room id. Client URL shape is `/ws/${ROOM_ID}?token=${encodeURIComponent(token)}`. | Accepts the socket, registers it, then sends the first message as `{"type":"state","data": BackendState}`. Inbound JSON messages mutate the canonical state and broadcast `{"type":"state","data": BackendState}` snapshots. | Missing token, invalid room id, bad token, missing room, or disappeared state close with code `1008` and reason `authentication failed`. Redis operational failures close with code `1011` and reason `service unavailable`. Malformed inbound JSON is logged and ignored without changing this contract. | `backend/main.py` `WS_AUTH_CLOSE_CODE`, `WS_OPERATIONAL_CLOSE_CODE`; `backend/websocket_handler.py` `ws_endpoint()`; `backend/room_session.py`; `backend/client_messages.py`; `frontend/src/room-websocket.js` `wsUrl()` and close handler | `tests/test_room_auth.py::test_websocket_requires_valid_token`; `tests/test_websocket_redis.py`; `tests/test_websocket_structure.py`; `tests/test_client_messages.py`; `tests/test_frontend_static.py::test_room_auth_uses_tokenized_websocket_and_generic_korean_rejection`. |

## Static Serving And Dependency Boundaries

- `backend/main.py` includes frontend routes, room routes, and WebSocket routes before the root static mount, so `/api` and `/ws` are not shadowed by static files.
- `backend/frontend_routes.py` serves `lobby.html` and `room.html` with `Cache-Control: no-cache`.
- `backend/main.py` mounts built Vite `/assets/*` from `frontend/dist/assets` with `Cache-Control: public, max-age=31536000, immutable` when the directory exists.
- The root static fallback serves `frontend/` with `Cache-Control: no-cache` for local source files.
- Python dependencies are authoritative in `pyproject.toml` and `uv.lock`; `requirements.txt` and `requirements-dev.txt` are exported compatibility files, mainly for Docker or older local commands.
- Frontend dependencies are authoritative in `package.json` and `package-lock.json`; `frontend/dist/` is generated by `npm run build` and should not be edited by hand.
- Docker hardening uses `npm ci` in the frontend build stage and runs the final Python image as non-root `appuser`.
- Docker Compose Redis health checks `PING`, `appendonly yes`, and `appendfsync everysec`; local Compose verification is blocked in this environment when `docker` is unavailable, as recorded in `.omo/evidence/task-11-docker-health.txt`.

## WebSocket Contract

- Endpoint: `/ws/{room_id}`.
- Query parameter: `token` is required. The backend scopes issued opaque-token hashes to the current room instance and checks that the token lookup resolves to the same normalized room id.
- Auth close: code `1008`, reason `authentication failed`, used for missing token, invalid room id, invalid token, missing room, or missing state.
- Operational close: code `1011`, reason `service unavailable`, used when Redis becomes unavailable during authorization or message handling.
- First successful server message: `{"type":"state","data": BackendState}`. This initial `{"type":"state"}` snapshot is the canonical current room state.
- Ongoing successful server messages: full-state snapshots shaped as `{"type":"state","data": BackendState}` after accepted client mutations, scheduler ticks, or Redis Pub/Sub fanout.
- Client behavior: `frontend/src/room-websocket.js` clears `room_token:{ROOM_ID}` from `sessionStorage` and shows the generic Korean rejection message on close code `1008`; other closes reconnect with exponential backoff through `frontend/src/room-connection.js`.
- Source mapping: `backend/websocket_handler.py` `ws_endpoint()`, `backend/room_session.py` room state authorization/message processing/connect/disconnect, `backend/event_bus.py` `publish_state()` / `dispatch_envelope()` / `consume_room_events()`, `frontend/src/room-websocket.js` `wsUrl()` / `connect()` / `send()`.
- Test mapping: `tests/test_room_auth.py`, `tests/test_websocket_redis.py`, `tests/test_event_bus.py`, `tests/test_frontend_static.py`.

## Redis Contract

Redis keys and channels are defined in `backend/redis_contract.py` and all room ids are normalized before interpolation. `{ROOM_ID}` below means the normalized uppercase room id.

| Purpose | Pattern | Builder / source | Notes | Tests |
|---|---|---|---|---|
| State | `aetheldesk:room:{ROOM_ID}:state` | `room_state_key(room_id)` | Stores JSON-encoded `BackendState`; this is the canonical Redis room-state value. | `tests/test_redis_contract.py`; `tests/test_room_store.py`; `tests/test_websocket_redis.py`. |
| Metadata | `aetheldesk:room:{ROOM_ID}:meta` | `room_metadata_key(room_id)` | Stores JSON metadata, including `room_id` and, for PIN-protected rooms, `pin_hash`. | `tests/test_redis_contract.py`; `tests/test_room_auth.py`; `tests/test_room_store.py`. |
| Token lookup | `aetheldesk:room:{ROOM_ID}:token:{TOKEN_HASH}` | `room_token_key(room_id, token_hash)` | Maps a room-instance-scoped opaque token hash to the normalized room id; plaintext tokens are not stored, and same-id recreated rooms reject tokens from previous instances. | `tests/test_redis_contract.py`; `tests/test_room_store.py`; `tests/test_room_auth.py`. |
| PIN attempts | `aetheldesk:room:{ROOM_ID}:pin-attempts:{FINGERPRINT}` | `room_pin_attempts_key(room_id, fingerprint)` | Counts failed PIN attempts within the configured attempt window. | `tests/test_redis_contract.py`; `tests/test_room_auth.py`. |
| PIN block | `aetheldesk:room:{ROOM_ID}:pin-block:{FINGERPRINT}` | `room_pin_block_key(room_id, fingerprint)` | Marks a fingerprint as temporarily blocked after too many failures. | `tests/test_redis_contract.py`; `tests/test_room_auth.py`. |
| Tick lock | `aetheldesk:room:{ROOM_ID}:tick-lock` | `room_tick_lock_key(room_id)` | Acquired with `NX` and a TTL before scheduler workers mutate timer/celestial state. | `tests/test_redis_contract.py`; `tests/test_room_store.py`; scheduler tests. |
| Event channel | `aetheldesk:room:{ROOM_ID}:events` | `room_events_channel(room_id)` | Redis Pub/Sub channel for full-state event snapshots. | `tests/test_redis_contract.py`; `tests/test_event_bus.py`; `tests/test_websocket_redis.py`. |

Event envelopes are created by `make_event_envelope()` and include `version`, normalized `room_id`, `event_id`, `source_worker`, `type`, and `data`. Current state publication uses `type: "state_snapshot"` with `data` equal to the full `BackendState` snapshot. The state schema remains canonical for event snapshots.

## BackendState Contract

`BackendState` in `backend/state.py` is the canonical room state schema for in-memory rooms, Redis `aetheldesk:room:{ROOM_ID}:state` values, WebSocket `state` messages, and Redis event snapshot `data`.

| Field | Type / shape | Baseline semantics |
|---|---|---|
| `celestial` | `dict[str, object]` | Current celestial presentation data from `get_celestial_state()`. |
| `focus` | `bool` | Whether a focus session is active. |
| `paused` | `bool` | Whether an active focus session is paused. |
| `pomodoro_remaining` | `int` | Remaining focus seconds; default `3000`. |
| `pomodoro_duration` | `int` | Configured focus duration seconds; default `3000`. |
| `break` | `bool` | Whether a break is active. |
| `break_remaining` | `int` | Remaining break seconds; default `0`. |
| `sessions_done` | `int` | Completed focus sessions; default `0`. |
| `music` | `MusicState` | `{"playing": bool, "video_id": string}`; default video id `jfKfPfyJRdk`. |
| `time_override` | `str or None` | Client-provided ISO override for celestial state, or `None` for real time. |

Accepted client mutation message types are handled in `backend/state.py`: `time_override`, `focus_toggle`, `focus_pause`, `focus_cancel`, `set_duration`, `skip_break`, `music_play`, `music_pause`, `music_skip`, and `location`. Tests in `tests/test_backend_state.py`, `tests/test_websocket_redis.py`, and `tests/test_event_bus.py` assert JSON-serializable defaults, compatibility exports, state transitions, Redis persistence, and full-state snapshot fanout.

## Frontend Storage Contract

| Storage | Key | Source | Contract | Tests |
|---|---|---|---|---|
| `sessionStorage` | `room_token:{ROOM_ID}` | `frontend/src/storage.js` `tokenStorageKey()`; `frontend/lobby.js` create/join handlers | Room tokens are stored per normalized uppercase room id under `room_token:{ROOM_ID}` only. Room tokens are read, set, and removed from `sessionStorage`; they must not be stored in `localStorage` or URL PIN parameters. | `tests/test_frontend_static.py`; e2e PIN tests. |
| `localStorage` | `playlist` | `frontend/src/storage.js` `readPlaylist()`; `frontend/src/music-youtube.js` `submitTrack()` | Playlist customization is one of the two owned `localStorage` keys. It stores JSON YouTube ids and is not used for room tokens. | `tests/test_frontend_static.py::test_frontend_persists_only_playlist_and_scene_local_storage_keys`. |
| `localStorage` | `scene` | `frontend/scenes.js` `activeScene` and `switchScene()` | Scene selection is persisted in `localStorage` under `scene` only. | `tests/test_frontend_static.py::test_frontend_persists_only_playlist_and_scene_local_storage_keys`. |

## Contract-To-Source/Test Map

| Contract section | Source files | Relevant tests |
|---|---|---|
| Decision record and route matrix | `.omo/plans/project-wide-improvement-2026.md`; `backend/main.py`; `backend/frontend_routes.py`; `backend/room_routes.py`; `backend/websocket_handler.py`; `backend/room_session.py`; `frontend/lobby.html`; `frontend/app.js`; `frontend/src/room-controller.js` | `tests/test_backend_routes.py`; `tests/test_room_auth.py`; `tests/test_frontend_static.py`; e2e room tests. |
| WebSocket contract | `backend/main.py`; `backend/websocket_handler.py`; `backend/room_session.py`; `backend/client_messages.py`; `backend/event_bus.py`; `backend/connection_manager.py`; `frontend/src/room-websocket.js`; `frontend/src/room-connection.js` | `tests/test_room_auth.py`; `tests/test_websocket_redis.py`; `tests/test_websocket_structure.py`; `tests/test_client_messages.py`; `tests/test_event_bus.py`; `tests/test_connection_manager.py`; `tests/test_frontend_static.py`. |
| Redis contract | `backend/redis_contract.py`; `backend/room_store.py`; `backend/state_codec.py`; `backend/event_bus.py`; `backend/scheduler.py` | `tests/test_redis_contract.py`; `tests/test_room_store.py`; `tests/test_state_codec.py`; `tests/test_event_bus.py`; `tests/test_websocket_redis.py`; room auth tests for PIN/rate-limit keys. |
| `BackendState` contract | `backend/state.py`; `backend/main.py`; `backend/room_store.py`; `backend/state_codec.py`; `backend/event_bus.py` | `tests/test_backend_state.py`; `tests/test_state_codec.py`; `tests/test_room_store.py`; `tests/test_websocket_redis.py`; `tests/test_event_bus.py`. |
| Frontend storage contract | `frontend/src/storage.js`; `frontend/lobby.js`; `frontend/src/music-youtube.js`; `frontend/scenes.js`; `frontend/src/room-controller.js` | `tests/test_frontend_static.py`; `tests/e2e/test_room_pin.py`; `tests/e2e/test_room_sync.py`. |

## Preservation Checklist For Later Waves

- Preserve `/api/rooms`, `/api/rooms/{room_id}/join`, and `/ws/{room_id}` route shapes.
- Preserve WebSocket close codes `1008` and `1011` and the first `{"type":"state"}` message.
- Preserve Redis normalization and key/channel names, especially `aetheldesk:room:{ROOM_ID}:state`.
- Preserve `BackendState` as the canonical event snapshot schema until a future task explicitly migrates it with tests.
- Preserve frontend room token storage in `sessionStorage` under `room_token:{ROOM_ID}` and keep playlist/scene as the only `localStorage` contracts.
