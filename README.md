# AethelDesk

> A quiet celestial productivity dashboard for a 5K Mac and iPad companion setup.

<p align="center">
  <img alt="FastAPI" src="https://img.shields.io/badge/FastAPI-backend-009688?style=flat-square">
  <img alt="Vanilla JavaScript" src="https://img.shields.io/badge/Vanilla%20JS-frontend-f7df1e?style=flat-square">
  <img alt="Static frontend today" src="https://img.shields.io/badge/frontend-static%20today-4b5563?style=flat-square">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square">
  <img alt="Python 3.12" src="https://img.shields.io/badge/python-3.12-3776ab?style=flat-square">
</p>

AethelDesk is a small shared-room dashboard for focus sessions, celestial ambience, and synchronized lofi controls. Run it on your Mac, open the same PIN-protected room on your iPad, and keep both screens in sync.

## Architecture

AethelDesk keeps room coordination server owned while the browser client stays lightweight:

* Frontend today: static vanilla HTML, CSS, and classic-script JavaScript served by FastAPI.
* Frontend target: Vite + vanilla ES modules is approved for future modernization. Vite is approved only for vanilla ES modules in this plan.
* Backend: FastAPI serves `/`, `/room/{room_id}`, `/app.js`, `/scenes.js`, REST room APIs, WebSockets, and `/health` today. Later Vite static serving must not shadow `/api` or `/ws`.
* Room state: Redis stores the canonical JSON room state and metadata with keys such as `aetheldesk:room:{ROOM_ID}:state` and `aetheldesk:room:{ROOM_ID}:meta`.
* Sync: Redis Pub/Sub publishes full-state room snapshots on `aetheldesk:room:{ROOM_ID}:events`; each worker fans updates out only to its own local WebSockets.
* Scheduler: every worker may run the scheduler, but room timer and celestial ticks mutate state only after the worker acquires the per-room Redis tick lock.
* Access: rooms use a PIN at create or join time. The backend stores hashes and opaque token hashes, not plaintext PINs.

Redis state is restart-tolerant ephemeral room state when Docker AOF is enabled with `appendfsync everysec`. It helps recover current active room state after a restart, but it is not permanent history, audit storage, analytics storage, or replay storage.

## What It Does

| Feature | Details |
|---|---|
| Celestial ambience | Backend calculates the sun state and broadcasts updates to connected clients. |
| Shared rooms | `/room/{room_id}` serves room sessions from the same static frontend today. |
| Room PIN access | Create and join flows require a PIN and return an opaque session token. |
| Focus mode | Starts a Pomodoro timer with hidden YouTube playback. |
| Music sync | Play, pause, and skip controls broadcast to all connected clients. |
| Touch-friendly controls | Desktop controls auto-hide after idle; touch devices keep controls available. |

## Workflows

Docker Compose and local `uv run` are the first-class target workflows for this modernization. The repository still supports the current `python -m` flow until Task 3 adds `pyproject.toml` and `uv.lock`.

| Workflow | Status | Use |
|---|---|---|
| Current local Python | Available now | Run the app and tests before Task 3 tooling lands. |
| Target local `uv run` | Approved target | Use after Task 3 adds `uv` project files. |
| Docker Compose | Available now | Run the app with Redis, matching Docker/prod Redis policy. |
| Frontend build | Approved target | Use after Vite migration adds `package.json` and build scripts. |

### Current Local Python Run Flow

Use this flow for development and tests without Docker while the repository still uses `requirements-dev.txt`:

```bash
python -m pip install -r requirements-dev.txt
cd backend
AETHELDESK_ENV=test python -m uvicorn main:app --host 0.0.0.0 --port 8000
```

Open the app from each device:

```text
http://<your-mac-ip>:8000
http://<your-mac-ip>:8000/room/<room-id>
```

`AETHELDESK_ENV=test` uses the test/local path and avoids requiring a production secret while you work locally. Outside pytest or test mode, set a real `AETHELDESK_SECRET_KEY` before starting the app.

### Target Local uv Run Flow

After Task 3 lands the `uv` project files, install locked dependencies with:

```bash
uv sync --frozen
```

Run the default quick test gate with:

```bash
uv run pytest -q
```

Use `uv run` for local app and test commands once that tooling exists. Do not treat `requirements*.txt` as authoritative after the `uv` migration unless a later task documents them as exported compatibility files.

### Docker Self-Host Run Flow

Docker Compose runs the FastAPI app and Redis:

```bash
cp .env.example .env
```

Edit `.env` and replace `AETHELDESK_SECRET_KEY=replace-with-long-random-secret` with a real secret, then start the stack:

```bash
docker compose up --build --detach
```

Check app health and Redis AOF configuration:

```bash
docker compose ps
curl -fsS http://127.0.0.1:${APP_PORT:-8000}/health
docker compose exec redis redis-cli CONFIG GET appendonly appendfsync
```

The Redis config should report `appendonly yes` and `appendfsync everysec`. The compose file persists Redis data in the `redis-data` volume, which supports restart tolerance for current room state only.

### Target Frontend Build Flow

After Task 7 lands the Vite migration, build the vanilla ES module frontend with:

```bash
npm run build
```

This command is documented as a target workflow. It is not expected to work before the Vite package files exist.

Required and useful environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `APP_PORT` | `8000` | Host port used by Docker Compose. |
| `REDIS_URL` | `redis://redis:6379/0` | Redis connection URL for the app container. |
| `ROOM_TTL_SECONDS` | `300` | Empty room expiry window. |
| `ROOM_TICK_LOCK_SECONDS` | `2` | Redis lock TTL for per-room scheduler ticks. |
| `AETHELDESK_ENV` | `docker` in `.env.example` | Runtime mode. Use `test` only for local/test runs. |
| `AETHELDESK_SECRET_KEY` | none | Required outside pytest/test mode for Room PIN tokens. |
| `AETHELDESK_TRUST_PROXY` | off | Set to `1` only behind a trusted reverse proxy so `X-Forwarded-For` is used for PIN rate-limit identity. Leave off when the app is exposed directly. |

## Governance For Modernization

The approved frontend modernization direction is Vite + vanilla ES modules. React, Vue, Svelte, and TypeScript remain out of scope unless separately approved. Webpack is not part of this plan.

Redis remains mandatory for Docker/prod and cross-worker behavior. The in-memory fallback is only for tests and local no-Redis development until it is isolated by later runtime work.

The UI should become Korean-primary as modernization continues. This plan does not add a full i18n toggle.

External frontend dependency policy:

* The YouTube iframe API remains allowed for focus music.
* Tailwind CDN usage should be replaced with local build assets after Vite parity is reached.
* Google Fonts should be self-hosted or given a local fallback in a later task.

Still out of scope for this modernization:

* OAuth, user accounts, profiles, invite systems, admin dashboards, or analytics.
* SQL history, PostgreSQL or Postgres storage, permanent audit logs, or permanent room history.
* Redis Streams replay, Celery, CRDTs, distributed queues, or event replay storage.
* Kubernetes, managed cloud automation, TLS automation, Nginx, Traefik, or reverse-proxy config changes.

## Room PIN Behavior

Create and join both require a PIN of 4-64 characters. Room ids are restricted to `[A-Z0-9]` (1-64 chars) after normalization, so they cannot inject extra Redis key segments. On success, the frontend stores the opaque token in `sessionStorage` under `room_token:{ROOM_ID}` and uses it on the room WebSocket URL.

Plaintext PIN values are sent only with the create or join request. They are not stored in Redis, room state, WebSocket payloads, `sessionStorage`, or `localStorage` after the request completes. Authentication failures use generic responses, including the Korean room error `입장할 수 없습니다`, so the UI does not reveal whether a room exists.

## Tests And E2E

Default Python tests exclude browser E2E through `pytest.ini`:

```bash
python -m pytest -q
```

After Task 3, the same quick gate should run through `uv`:

```bash
uv run pytest -q
```

Install the Chromium browser for Python Playwright, then run the browser suite:

```bash
python -m playwright install chromium
python -m pytest tests/e2e -m e2e --browser chromium -q
```

For a quick static JavaScript syntax check before the Vite migration:

```bash
node --check frontend/app.js
node --check frontend/scenes.js
```

After Vite migration, use the frontend build gate:

```bash
npm run build
```

## Reverse Proxy WebSocket Notes

When placing AethelDesk behind a reverse proxy, preserve WebSocket upgrades for `/ws/*`:

* Forward `Upgrade` and `Connection` headers.
* Preserve `Host` and `X-Forwarded-For`.
* Disable response buffering on WebSocket paths.
* Keep WebSocket timeouts long enough for focus sessions.
* Set `AETHELDESK_TRUST_PROXY=1` so the app reads the real client IP from `X-Forwarded-For` for PIN rate limiting. Only do this when the proxy is trusted and overwrites the header.

Without these settings, room sync can fail or disconnect unexpectedly.

## Controls

| Control | Behavior |
|---|---|
| Time slider | Drag to override sun position; double-click to return to real time. |
| Focus button | Toggles the Pomodoro timer and hidden music playback. |
| Music buttons | Play, pause, and skip are shared across connected clients. |
| Idle desktop UI | Controls fade after 3 seconds of mouse inactivity. |

## Troubleshooting

| Symptom | Check |
|---|---|
| `/health` returns 503 or rooms cannot sync | Redis is unavailable. Check the Redis container, `REDIS_URL`, and `docker compose ps`. |
| Startup fails with missing `AETHELDESK_SECRET_KEY` | Set a real secret in `.env` for Docker or production. Only pytest/test mode can use the built-in test secret. |
| Playwright says Chromium is missing | Run `python -m playwright install chromium`. If the host warns about missing system libraries, install the OS packages named by Playwright. |
| Tests fail with missing `astral` | Run `python -m pip install -r requirements-dev.txt`; `requirements-dev.txt` includes `astral`. |
| `uv sync --frozen` fails | Task 3 tooling is not present yet, or the lockfile is out of date. Use the current local Python flow until Task 3 is merged. |
| `npm run build` fails because `package.json` is missing | Task 7 Vite migration is not present yet. This command is a target gate, not a current static-frontend command. |

## Development Notes

The app is intentionally small. Today it is classic-script based; the approved target is Vite + vanilla ES modules:

```text
aetheldesk/
|-- backend/
|   |-- auth.py
|   |-- config.py
|   |-- connection_manager.py
|   |-- event_bus.py
|   |-- main.py
|   |-- room_store.py
|   |-- scheduler.py
|   `-- state.py
|-- frontend/
|   |-- app.js
|   |-- lobby.html
|   |-- room.html
|   `-- scenes.js
|-- tests/
|   |-- e2e/
|   |-- test_backend_state.py
|   `-- test_frontend_static.py
|-- docker-compose.yml
|-- requirements.txt
`-- requirements-dev.txt
```

## Contributing

Contributions are welcome. To keep the project small and predictable:

1. Open an issue first for anything beyond a small fix, so scope can be agreed before code.
2. Fork, branch from `main`, and keep changes focused.
3. Match the approved modernization scope: plain Python, vanilla JavaScript, Vite + vanilla ES modules only when frontend tooling lands, and no new heavyweight runtime dependencies without agreement.
4. Add or update tests for behavior changes and make sure the relevant suite passes:

   ```bash
   python -m pip install -r requirements-dev.txt
   python -m pytest -q
   node --check frontend/app.js
   node --check frontend/scenes.js
   ```

5. After Task 3 and Task 7 land, use the target gates too:

   ```bash
   uv sync --frozen
   uv run pytest -q
   npm run build
   ```

6. Open a pull request describing the change and how you verified it.

Please keep proposals within the project's intent. See [Governance For Modernization](#governance-for-modernization) before suggesting larger systems.

## License

Released under the [MIT License](LICENSE). You are free to use, modify, and distribute it, including for commercial purposes, provided the copyright and license notice are retained.
