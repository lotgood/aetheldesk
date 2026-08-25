# AethelDesk Architecture Contracts

This document records the current public REST, WebSocket, Redis, `BackendState`, and frontend storage contracts. Later refactors must preserve them unless a later decision record explicitly changes them with matching tests.

## Decision Record

| Decision | Baseline |
|---|---|
| Public boundary owner | `backend/main.py` assembles the FastAPI app and compatibility exports; `backend/frontend_routes.py`, `backend/room_routes.py`, and `backend/websocket_handler.py` own route handlers, WebSocket authorization, state mutation dispatch, and static frontend serving. |
| State authority | FastAPI owns authoritative room state. Redis stores the cross-worker canonical JSON state when configured; the in-memory path is only for tests/local no-Redis behavior. |
| Room identity | Room ids are normalized with `normalize_room_id(room_id)`, which strips surrounding whitespace and uppercases the id. Valid ids match `[A-Z0-9]{1,64}` after normalization. |
| Auth and secrecy | Create/join requests accept plaintext PINs only at the request boundary. Stored PINs and tokens are hashes; API responses do not expose PINs, PIN hashes, or token hashes. Auth failures remain generic. |
| Frontend stack | The current frontend is Vite + vanilla ES modules. React, Vue, Svelte, and TypeScript remain out of scope unless separately approved. |

## Modernization Governance

These decisions govern the current implementation. Current-state wording describes what exists now; out-of-scope wording names work that still requires separate approval.

| Area | Governance |
|---|---|
| Frontend tooling | Vite + vanilla ES modules is the current frontend implementation. `vite.config.js` proxies `/api` to `http://127.0.0.1:8000` and `/ws` to `ws://127.0.0.1:8000` for local dev. |
| Framework scope | React, Vue, Svelte, and TypeScript remain out of scope unless separately approved. Webpack is not part of this modernization plan. |
| Workflows | Docker Compose and local `uv run` are first-class workflows. The command matrix anchors are `uv sync --frozen`, `uv run ruff format --check .`, `uv run ruff check .`, `uv run pyright`, `uv run pytest -q`, `uv run pytest tests/e2e -m e2e --browser chromium -q`, `npm run build`, and `docker compose up --build --detach`. |
| Redis policy | Redis is mandatory for Docker/prod and cross-worker behavior. The supported topology is standalone Redis (the bundled Docker path), not Redis Cluster: the fenced Lua mutations intentionally touch the room index and per-room keys atomically. The in-memory fallback is only for tests and local no-Redis development. Redis outages are normalized to the existing HTTP `503 {"detail":"redis unavailable"}` and WebSocket `1011 service unavailable` operational contracts. |
| UI language | The UI is Korean-primary for interactive controls, validation errors, live regions, and status text. Brand, `PIN`, API fields, and storage keys stay stable. A full i18n toggle is out of scope for this plan. |
| External frontend dependencies | Tailwind CSS is compiled locally into `frontend/tailwind.css` (via `npm run build:css`), Google Fonts (Inter variable, Instrument Serif) are self-hosted in `frontend/fonts/` with `frontend/fonts.css`, and the Quiet Orbit page layers live in `frontend/lobby.css` and `frontend/room.css`. The focus room makes no external media request and works offline after its own assets load. |
| Excluded systems | SQL/accounts/analytics, Redis Streams, Celery, Kubernetes, TLS automation, React, Vue, Svelte, TypeScript, and reverse-proxy config changes remain out of scope. |

## Quiet Orbit Frontend Contract

Quiet Orbit is the current presentation and interaction contract. It changes the visual shell without changing the REST, WebSocket, Redis, or `BackendState` boundaries below.

- The lobby presents room creation and room-code entry as distinct actions while retaining `#btn-start`, `#code-toggle`, `#code-section`, `#room-input`, `#btn-join`, and the existing create/join APIs.
- The room keeps one primary `#focus-btn`. Duration options only choose the shared duration; they never start a session themselves. `#idle-duration` mirrors the selected duration inside the primary control.
- The persistent HUD exposes a selectable room code, `#btn-copy-room`, visible `#conn-copy` connection text, and the visible/live `#room-status` status surface.
- A normal focus completion increments the server-authoritative `reward_id` exactly once and starts a 600-second break. Reconnect, cancel, and break skip never mint another reward.
- `#btn-scene` opens the labelled `#scene-panel`; its three `[data-scene]` options are `sky` (the unified coastal sky), `city`, and `forest`, expose `aria-pressed`, and persist the selected `scene` locally. A legacy `beach` preference is migrated to `sky` and is not a selectable fourth scene.
- Scene, display, and exit surfaces coordinate as mutually exclusive panels and retain focus management, hidden-interaction handling, and Korean status announcements.
- Focus and break progress must be derived only from canonical `BackendState` fields, including `break_duration`; clients must not infer a fourth-session long break.
- The break ritual is optional and non-punitive. Recovery choices are ephemeral; only the bounded `next-intent` preference remains in this browser and neither choice mutates shared room state.
- `frontend/velorah.css` owns shared tokens and primitives. `frontend/lobby.css` and `frontend/room.css` own page-specific Quiet Orbit layout and responsive styling.

## Route Matrix

| Path | Method / Protocol | Request contract | Success contract | Failure / close contract | Source | Tests |
|---|---|---|---|---|---|---|
| `/` | `GET` | No payload. | Serves `frontend/lobby.html`; Vite production assets are referenced from `frontend/dist/assets` when built. | Static file errors are framework-level. | `backend/frontend_routes.py` `lobby()`; `frontend/lobby.html` | `tests/test_frontend_static.py`; e2e tests navigate from lobby to room. |
| `/room/{room_id}` | `GET` | `room_id` path segment is accepted by the route and the Vite room client uppercases the final path segment for client-side use. | Serves `frontend/room.html`; Vite production assets are referenced from `frontend/dist/assets` when built. | Static file errors are framework-level. | `backend/frontend_routes.py` `room_page()`; `frontend/app.js` `ROOM_ID` | `tests/test_frontend_static.py::test_room_token_uses_session_storage_keyed_by_uppercase_room_id`; e2e room tests. |
| `/health` | `GET` | No payload. | Returns `{"status":"ok"}` in test mode without Redis or when Redis ping succeeds. | Returns HTTP `503` with `{"detail":"redis unavailable"}` when Redis is required but unavailable. | `backend/room_routes.py` `health()` | `tests/test_backend_routes.py::test_health_returns_ok_when_redis_is_reachable`; `tests/test_backend_routes.py::test_health_returns_503_when_redis_unreachable`. |
| `/api/rooms` | `POST` | JSON body `{"room_id": string or null, "pin": string}`. `pin` must be 4-64 chars. Missing `room_id` generates an uppercase id; supplied ids are normalized and must be valid. | Returns `{"room_id": NORMALIZED_ROOM_ID, "token": OPAQUE_TOKEN}`. Existing rooms require the same PIN and return a fresh generation-bound token. | Invalid room ids return HTTP `400` `{"detail":"invalid room id"}`. The atomic room-cap decision returns HTTP `403` `{"detail":"room limit reached"}`. Existing-room wrong PIN uses generic auth failure. A room with 256 live session tokens returns HTTP `429` rather than evicting an existing browser token. | `backend/room_routes.py` `CreateRoomRequest`, `_require_valid_room_id()`, `create_room()` | `tests/test_backend_routes.py`; `tests/test_room_auth.py`; `tests/test_input_validation.py`. |
| `/api/rooms/{room_id}/join` | `POST` | JSON body `{"pin": string}`. `pin` must be 4-64 chars. `room_id` is normalized and must be valid. | Returns `{"token": OPAQUE_TOKEN}` only. | Wrong room, wrong PIN, or missing stored PIN returns the same generic auth failure shape. Redis-backed rate-limit blocks return generic auth failure with HTTP `403`. A room with 256 live session tokens rejects another issuance with HTTP `429` rather than evicting an existing browser token. | `backend/room_routes.py` `JoinRoomRequest`, `_assert_not_rate_limited()`, `_record_failed_attempt()`, `join_room()` | `tests/test_backend_routes.py`; `tests/test_room_auth.py`; `tests/test_input_validation.py`. |
| `/ws/{room_id}` | WebSocket | `room_id` path segment plus required `token` query parameter. The token must authorize the normalized room id. Client URL shape is `/ws/${ROOM_ID}?token=${encodeURIComponent(token)}`. | Accepts the socket, registers it, then sends the first message as `{"type":"state","data": BackendState}`. Inbound JSON messages mutate the canonical state and broadcast `{"type":"state","data": BackendState}` snapshots. | Missing token, invalid room id, bad token, missing room, or disappeared state close with code `1008` and reason `authentication failed`. Redis operational failures close with code `1011` and reason `service unavailable`. Malformed inbound JSON is logged and ignored without changing this contract. | `backend/main.py` `WS_AUTH_CLOSE_CODE`, `WS_OPERATIONAL_CLOSE_CODE`; `backend/websocket_handler.py` `ws_endpoint()`; `frontend/src/room-websocket.js` `wsUrl()` and close handler | `tests/test_room_auth.py::test_websocket_requires_valid_token`; `tests/test_websocket_redis.py`; `tests/test_frontend_static.py::test_room_auth_uses_tokenized_websocket_and_generic_korean_rejection`. |

## Static Serving And Dependency Boundaries

- `backend/main.py` includes frontend routes, room routes, and WebSocket routes before the root static mount, so `/api` and `/ws` are not shadowed by static files.
- `backend/frontend_routes.py` serves `lobby.html` and `room.html` with `Cache-Control: no-cache`.
- `backend/main.py` mounts built Vite `/assets/*` from `frontend/dist/assets` with `Cache-Control: public, max-age=31536000, immutable` when the directory exists.
- The root static fallback serves `frontend/` with `Cache-Control: no-cache` for local source files.
- Python dependencies are authoritative in `pyproject.toml` and `uv.lock`; `requirements.txt` and `requirements-dev.txt` are exported compatibility files, mainly for Docker or older local commands.
- Frontend dependencies are authoritative in `package.json` and `package-lock.json`; `frontend/dist/` is generated by `npm run build` and should not be edited by hand.
- Docker hardening uses `npm ci` in the frontend build stage and runs the final Python image as non-root `appuser`.
- Docker Compose Redis health checks `PING`, `appendonly yes`, and `appendfsync everysec`. If the local host has no `docker`, do not treat Compose health as passed; CI still runs compose and `/health` in the Playwright e2e job.

## WebSocket Contract

- Endpoint: `/ws/{room_id}`.
- Query parameter: `token` is required. The backend scopes issued opaque-token hashes to the current room instance and checks that the token lookup resolves to the same normalized room id.
- Auth close: code `1008`, reason `authentication failed`, used for missing token, invalid room id, invalid token, missing room, or missing state.
- Operational close: code `1011`, reason `service unavailable`, used when Redis becomes unavailable during authorization or message handling.
- First successful server message: `{"type":"state","data": BackendState}`. This initial `{"type":"state"}` snapshot is the canonical current room state.
- Ongoing successful server messages: full-state snapshots shaped as `{"type":"state","data": BackendState}` after accepted client mutations, scheduler ticks, or Redis Pub/Sub fanout.
- Revision ordering: the local connection manager and browser client ignore state snapshots below their accepted `revision`. A new WebSocket generation resets the browser high-water and treats its first snapshot as a non-replaying reward baseline.
- Client behavior: `frontend/app.js` clears `room_token:{ROOM_ID}` from `sessionStorage` and shows the generic Korean rejection message on close code `1008`; other closes reconnect with exponential backoff.
- Source mapping: `backend/websocket_handler.py` `ws_endpoint()`, `backend/event_bus.py` `publish_state()` / `dispatch_envelope()` / `consume_room_events()`, `frontend/src/room-websocket.js` `wsUrl()` / `connect()` / `send()`.
- Test mapping: `tests/test_room_auth.py`, `tests/test_websocket_redis.py`, `tests/test_event_bus.py`, `tests/test_frontend_static.py`.

## Redis Contract

Per-room keys and channels are defined in `backend/redis_contract.py`; the one global registry key is `backend.room_store.ROOM_INDEX_KEY`. All room ids are normalized before interpolation. `{ROOM_ID}` below means the normalized uppercase room id.

| Purpose | Pattern | Builder / source | Notes | Tests |
|---|---|---|---|---|
| Room registry | `aetheldesk:rooms` | `backend.room_store.ROOM_INDEX_KEY` | Shared room-id set used for scheduler discovery and capacity. Expired entries are pruned only after both canonical state and metadata are absent; one-sided state/metadata skew stays counted but is not tickable, preserving fail-closed auth. The standalone-Redis creation Lua script atomically checks the cap, creates state and metadata, clears the prior token set, and registers the id. | `tests/test_room_store.py`; `tests/test_scheduler.py`. |
| State | `aetheldesk:room:{ROOM_ID}:state` | `room_state_key(room_id)` | Stores JSON-encoded `BackendState`; this is the canonical Redis room-state value. | `tests/test_redis_contract.py`; `tests/test_room_store.py`; `tests/test_websocket_redis.py`. |
| Metadata | `aetheldesk:room:{ROOM_ID}:meta` | `room_metadata_key(room_id)` | Stores JSON metadata. Public PIN rooms include `room_id`, `pin_hash`, and the authoritative `room_instance_id`. PIN verification returns that exact generation id; atomic token issuance rejects a generation swap between verification and issuance. | `tests/test_redis_contract.py`; `tests/test_room_auth.py`; `tests/test_room_store.py`. |
| Legacy token lookup | `aetheldesk:room:{ROOM_ID}:token:{TOKEN_HASH}` | `room_token_key(room_id, token_hash)` | Read-only one-release migration fallback for credentials issued before the authoritative token set. A successful lookup migrates the hash into the set and deletes this key. | `tests/test_redis_contract.py`; `tests/test_room_store.py`. |
| Token set | `aetheldesk:room:{ROOM_ID}:tokens` | `room_token_index_key(room_id)` | Authoritative set of room-instance-scoped opaque token hashes. Admission is an atomic Lua operation capped at 256 members; one set TTL refresh keeps credential work O(1), and same-id recreation clears the previous generation before issuing tokens. | `tests/test_redis_contract.py`; `tests/test_room_store.py`; `tests/test_scheduler.py`; `tests/test_room_auth.py`. |
| PIN attempts | `aetheldesk:room:{ROOM_ID}:pin-attempts:{FINGERPRINT}` | `room_pin_attempts_key(room_id, fingerprint)` | Counts failed PIN attempts within the configured attempt window. | `tests/test_redis_contract.py`; `tests/test_room_auth.py`. |
| PIN block | `aetheldesk:room:{ROOM_ID}:pin-block:{FINGERPRINT}` | `room_pin_block_key(room_id, fingerprint)` | Marks a fingerprint as temporarily blocked after too many failures. | `tests/test_redis_contract.py`; `tests/test_room_auth.py`. |
| Tick lock | `aetheldesk:room:{ROOM_ID}:tick-lock` | `room_tick_lock_key(room_id)` | Redis `TIME` fences an `NX` lease by logical second. `running` blocks overlap; `done` blocks duplicate work in the same second. Tick state is committed only when both the lease and expected state `revision` still match. `last_tick_slot` applies elapsed Redis seconds after scheduler gaps without double-decrementing a same-slot message reconciliation. | `tests/test_redis_contract.py`; `tests/test_scheduler.py`; `tests/test_websocket_redis.py`. |
| Event channel | `aetheldesk:room:{ROOM_ID}:events` | `room_events_channel(room_id)` | Redis Pub/Sub channel for full-state event snapshots. | `tests/test_redis_contract.py`; `tests/test_event_bus.py`; `tests/test_websocket_redis.py`. |

Event envelopes are created by `make_event_envelope()` and include `version`, normalized `room_id`, `event_id`, `source_worker`, `type`, and `data`. Current state publication uses event version `2`, `type: "state_snapshot"`, and `data` equal to the full `BackendState` snapshot. Version 2 is a coordinated deployment boundary for the revised state schema; mixed v1/v2 workers are intentionally not a supported rolling configuration.

## BackendState Contract

`BackendState` in `backend/state.py` is the canonical room state schema for in-memory rooms, Redis `aetheldesk:room:{ROOM_ID}:state` values, WebSocket `state` messages, and Redis event snapshot `data`.

| Field | Type / shape | Baseline semantics |
|---|---|---|
| `celestial` | `dict[str, object]` | Current celestial presentation data from `get_celestial_state()`: solar `elevation` / `arc_pct`, server-authoritative illustrative `night_arc_pct`, `phase`, `gradient`, and timezone-aware `iso`. |
| `focus` | `bool` | Whether a focus session is active. |
| `paused` | `bool` | Whether an active focus session is paused. |
| `pomodoro_remaining` | `int` | Remaining focus seconds; default `3000`. |
| `pomodoro_duration` | `int` | Configured focus duration seconds; default `3000`. |
| `break` | `bool` | Whether a break is active. |
| `break_remaining` | `int` | Remaining break seconds; default `0`. |
| `break_duration` | `int` | Canonical break length; always `600` seconds. Every normal focus completion copies this value into `break_remaining`, including every fourth completion. |
| `sessions_done` | `int` | Completed focus sessions; default `0`. |
| `reward_id` | `int` | Monotonic completion reward id; default `0`. It increments exactly once when a running focus countdown reaches zero and is unchanged by pause, cancel, break tick/skip, reconnect, or retired message types. |
| `revision` | `int` | Monotonic canonical-state revision; default `0`. Redis client mutations use compare-and-set and timer commits require the expected revision. Broadcast consumers ignore lower revisions so delayed fanout cannot regress visible state. |
| `last_tick_slot` | `int or None` | Last applied Redis `TIME` second for an advancing focus/break cycle. It anchors elapsed-time catch-up, resets while idle/paused, and prevents a scheduler tick from repeating time already reconciled by a same-second client mutation. |
| `time_override` | `str or None` | Client-provided ISO override for celestial state, or `None` for real time. |

Accepted client mutation message types are handled in `backend/state.py`: `time_override`, `focus_toggle`, `focus_pause`, `focus_cancel`, `set_duration`, `skip_break`, and `location`. Retired music message types are unknown messages and are ignored without mutating state. Tests in `tests/test_backend_state.py`, `tests/test_websocket_redis.py`, and `tests/test_event_bus.py` assert JSON-serializable defaults, completion/reward transitions, Redis persistence, and full-state snapshot fanout.

## Frontend Storage Contract

| Storage | Key | Source | Contract | Tests |
|---|---|---|---|---|
| `sessionStorage` | `room_token:{ROOM_ID}` | `frontend/src/storage.js` `tokenStorageKey()`; `frontend/lobby.js` create/join handlers | Room tokens are stored per normalized uppercase room id under `room_token:{ROOM_ID}` only. Room tokens are read, set, and removed from `sessionStorage`; they must not be stored in `localStorage` or URL PIN parameters. | `tests/test_frontend_static.py`; e2e PIN tests. |
| `localStorage` | `scene` | `frontend/src/storage.js` `readScene()` / `storeScene()`; `frontend/scenes.js` | Stores the client-local selected scene name. Allowed current values are `sky`, `city`, and `forest`; legacy `beach` is normalized and rewritten to `sky`. | `tests/test_frontend_static.py::test_frontend_persists_only_allowlisted_local_storage_keys`; `tests/e2e/test_scene_picker.py`. |
| `localStorage` | `next-intent` | `frontend/src/storage.js` `readNextIntent()` / `storeNextIntent()`; `frontend/src/rest-ritual.js` | Stores one optional return intention: `continue`, `next`, or `finish`. Invalid or cleared values remove the key. It is browser-local and never mutates shared room state. | `tests/test_frontend_static.py::test_frontend_persists_only_allowlisted_local_storage_keys`; `tests/js/storage.test.js`; `tests/js/rest-ritual.test.js`. |
| `localStorage` | `display-quality` | `frontend/src/storage.js` `readDisplayQuality()` / `storeDisplayQuality()` | Stores the client-local renderer quality choice (`auto`, `low`, `medium`, `high`, or `ultra`). | `tests/test_frontend_static.py::test_frontend_persists_only_allowlisted_local_storage_keys`. |
| `localStorage` | `display-fx` | `frontend/src/storage.js` `readDisplayFX()` / `storeDisplayFX()` | Stores the client-local JSON overrides for supported visual effects. It is not synchronized through room state. | `tests/test_frontend_static.py::test_frontend_persists_only_allowlisted_local_storage_keys`. |

`playlist` is a retired key, not part of the allowlist. Room startup removes any legacy value without reading or migrating it into shared state.

## Contract-To-Source/Test Map

| Contract section | Source files | Relevant tests |
|---|---|---|
| Decision record and route matrix | `backend/main.py`; `backend/frontend_routes.py`; `backend/room_routes.py`; `backend/websocket_handler.py`; `frontend/lobby.html`; `frontend/app.js` | `tests/test_backend_routes.py`; `tests/test_room_auth.py`; `tests/test_frontend_static.py`; e2e room tests. |
| WebSocket contract | `backend/main.py`; `backend/websocket_handler.py`; `backend/event_bus.py`; `backend/connection_manager.py`; `frontend/src/room-websocket.js` | `tests/test_room_auth.py`; `tests/test_websocket_redis.py`; `tests/test_event_bus.py`; `tests/test_connection_manager.py`; `tests/test_frontend_static.py`. |
| Redis contract | `backend/redis_contract.py`; `backend/room_store.py`; `backend/event_bus.py`; `backend/scheduler.py` | `tests/test_redis_contract.py`; `tests/test_room_store.py`; `tests/test_event_bus.py`; `tests/test_websocket_redis.py`; room auth tests for PIN/rate-limit keys. |
| `BackendState` contract | `backend/state.py`; `backend/main.py`; `backend/room_store.py`; `backend/event_bus.py` | `tests/test_backend_state.py`; `tests/test_room_store.py`; `tests/test_websocket_redis.py`; `tests/test_event_bus.py`. |
| Frontend storage contract | `frontend/src/storage.js`; `frontend/lobby.js`; `frontend/scenes.js`; `frontend/src/rest-ritual.js` | `tests/test_frontend_static.py`; `tests/js/storage.test.js`; `tests/js/rest-ritual.test.js`; `tests/e2e/test_room_pin.py`; `tests/e2e/test_room_sync.py`; `tests/e2e/test_scene_picker.py`. |

## Preservation Checklist For Later Changes

- Preserve `/api/rooms`, `/api/rooms/{room_id}/join`, and `/ws/{room_id}` route shapes.
- Preserve WebSocket close codes `1008` and `1011` and the first `{"type":"state"}` message.
- Preserve Redis normalization and key/channel names, especially `aetheldesk:room:{ROOM_ID}:state`.
- Preserve `BackendState` as the canonical event snapshot schema until a future task explicitly migrates it with tests.
- Preserve frontend room token storage in `sessionStorage` under `room_token:{ROOM_ID}`. The complete `localStorage` allowlist is `scene`, `next-intent`, `display-quality`, and `display-fx`; room tokens and PINs must never be added there.
