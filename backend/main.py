import asyncio
import hashlib
import hmac
import json
import logging
import sys
import os
from contextlib import asynccontextmanager, suppress
from datetime import datetime
from importlib import import_module
from typing import Any, Protocol, TypedDict, cast

sys.path.insert(0, os.path.dirname(__file__))

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
try:
    from backend import config
    from backend import auth
    from backend import state as state_reducer
    from backend.connection_manager import LocalConnectionManager
    from backend.redis_contract import normalize_room_id
    from backend.state import BackendState, MusicState, _parse_iso, advance_timer_state
except ModuleNotFoundError:
    import config
    import auth
    import state as state_reducer
    from connection_manager import LocalConnectionManager
    from redis_contract import normalize_room_id
    from state import BackendState, MusicState, _parse_iso, advance_timer_state

try:
    _room_store_module = import_module("backend.room_store")
except ModuleNotFoundError:
    _room_store_module = import_module("room_store")

RedisUnavailable = cast(Any, _room_store_module.RedisUnavailable)
RoomLimitReached = cast(Any, _room_store_module.RoomLimitReached)
create_redis_store = cast(Any, _room_store_module.create_redis_store)

try:
    _event_bus_module = import_module("backend.event_bus")
except ModuleNotFoundError:
    _event_bus_module = import_module("event_bus")

RedisStateEventBus = cast(Any, _event_bus_module.RedisStateEventBus)

try:
    _scheduler_module = import_module("backend.scheduler")
except ModuleNotFoundError:
    _scheduler_module = import_module("scheduler")

RoomTickScheduler = cast(Any, _scheduler_module.RoomTickScheduler)


class GetCelestialState(Protocol):
    def __call__(
        self, dt: datetime | None = None, lat: float | None = None, lon: float | None = None
    ) -> dict[str, object]: ...


get_celestial_state = cast(GetCelestialState, import_module("celestial").get_celestial_state)

logger = logging.getLogger("aetheldesk")

FRONTEND = os.path.join(os.path.dirname(__file__), "../frontend")
MAX_ROOMS = 50
ROOM_TTL = config.ROOM_TTL_SECONDS
WS_AUTH_CLOSE_CODE = 1008
WS_AUTH_CLOSE_REASON = "authentication failed"
WS_OPERATIONAL_CLOSE_CODE = 1011
WS_OPERATIONAL_CLOSE_REASON = "service unavailable"

# ── Room registry ─────────────────────────────────────────────────────────────


Room = TypedDict(
    "Room",
    {
        "state": BackendState,
        "clients": set[WebSocket],
        "cleanup": asyncio.Task[None] | None,
    },
)


rooms: dict[str, Room] = {}
connections = LocalConnectionManager()
room_store: Any | None = None
event_bus: Any | None = None
event_subscription_tasks: dict[str, asyncio.Task[None]] = {}
local_pin_hashes: dict[str, str] = {}
local_token_hashes: dict[str, set[str]] = {}
worker_id = config.get_worker_identity()


class CreateRoomRequest(BaseModel):
    room_id: str | None = Field(default=None)
    pin: str


class JoinRoomRequest(BaseModel):
    pin: str


def _generated_room_id() -> str:
    return "R" + os.urandom(4).hex().upper()[:7]


def _client_fingerprint(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    first = forwarded.split(",", 1)[0].strip()
    ip = first or (request.client.host if request.client is not None else "unknown")
    key = config.get_secret_key().encode("utf-8")
    return hmac.new(key, ip.encode("utf-8"), hashlib.sha256).hexdigest()


async def _auth_failure() -> None:
    raise HTTPException(status_code=401, detail=auth.failure_body()["detail"])


async def _assert_not_rate_limited(room_id: str, fingerprint: str) -> None:
    if room_store is None:
        return
    if await room_store.is_pin_blocked(room_id, fingerprint):
        raise HTTPException(status_code=403, detail=auth.failure_body()["detail"])


async def _record_failed_attempt(room_id: str, fingerprint: str) -> None:
    if room_store is None:
        return
    policy = auth.PinRatePolicy()
    blocked = await room_store.record_failed_pin_attempt(
        room_id,
        fingerprint,
        attempt_window_seconds=policy.attempt_window_seconds,
        max_attempts=policy.max_attempts,
        block_seconds=policy.block_seconds,
    )
    if blocked:
        raise HTTPException(status_code=403, detail=auth.failure_body()["detail"])


async def _issue_room_token(room_id: str) -> str:
    normalized = normalize_room_id(room_id)
    token = auth.create_token()
    token_hash = auth.hash_token(token)
    if room_store is not None:
        await room_store.set_token_lookup(normalized, token_hash)
    else:
        local_token_hashes.setdefault(normalized, set()).add(token_hash)
    return token


async def _token_authorizes_room(room_id: str, token: str) -> bool:
    normalized = normalize_room_id(room_id)
    token_hash = auth.hash_token(token)
    if room_store is not None:
        resolved_room = await room_store.get_token_room_id(normalized, token_hash)
        return resolved_room == normalized
    return token_hash in local_token_hashes.get(normalized, set())

def make_state() -> BackendState:
    return state_reducer.make_state(get_celestial_state)

def get_room(room_id: str) -> Room | None:
    normalized = normalize_room_id(room_id)
    if normalized not in rooms:
        if len(rooms) >= MAX_ROOMS:
            return None
        rooms[normalized] = {"state": make_state(), "clients": set(), "cleanup": None}
    else:
        # Cancel pending cleanup when someone rejoins
        task = rooms[normalized]["cleanup"]
        if task and not task.done():
            _ = task.cancel()
            rooms[normalized]["cleanup"] = None
    return rooms[normalized]


async def schedule_cleanup(room_id: str):
    await asyncio.sleep(ROOM_TTL)
    normalized = normalize_room_id(room_id)
    if room_store is not None:
        _ = await room_store.expire_empty_room(
            normalized,
            has_connections=connections.has_connections(normalized),
        )
        return

    room = rooms.get(normalized)
    if room and not room["clients"] and room["cleanup"] is asyncio.current_task():
        _ = rooms.pop(normalized, None)


async def broadcast(room: Room, payload: dict[str, object]):
    dead: set[WebSocket] = set()
    for ws in room["clients"]:
        try:
            await ws.send_text(json.dumps(payload))
        except (RuntimeError, WebSocketDisconnect):
            dead.add(ws)
    room["clients"].difference_update(dead)


async def get_room_state(room_id: str) -> BackendState | None:
    normalized = normalize_room_id(room_id)
    if room_store is not None:
        try:
            return await room_store.get_or_create_room(normalized, make_state)
        except RoomLimitReached:
            return None

    room = get_room(normalized)
    if room is None:
        return None
    return room["state"]


async def save_room_state(room_id: str, state: BackendState) -> None:
    normalized = normalize_room_id(room_id)
    if room_store is not None:
        await room_store.set_state(normalized, state)
        return
    room = rooms.get(normalized)
    if room is not None:
        room["state"] = state


def _build_event_bus() -> Any | None:
    if room_store is None:
        return None
    redis = getattr(room_store, "redis", None)
    if redis is None or not hasattr(redis, "publish") or not hasattr(redis, "pubsub"):
        return None
    return RedisStateEventBus(
        redis,
        worker_id=worker_id,
        connections=connections,
        load_canonical_state=room_store.get_state,
    )


async def publish_room_state(room_id: str, state: BackendState) -> None:
    if event_bus is not None:
        await event_bus.publish_state(room_id, state)


async def ensure_room_events(room_id: str) -> None:
    if event_bus is None:
        return
    normalized = normalize_room_id(room_id)
    task = event_subscription_tasks.get(normalized)
    if task is not None and not task.done():
        return
    await event_bus.sync_room_from_store(normalized)
    event_subscription_tasks[normalized] = asyncio.create_task(event_bus.consume_room_events(normalized))


async def stop_room_events(room_id: str) -> None:
    normalized = normalize_room_id(room_id)
    task = event_subscription_tasks.pop(normalized, None)
    if task is None:
        return
    _ = task.cancel()
    with suppress(asyncio.CancelledError):
        await task


async def tick():
    counter = 0
    while True:
        await asyncio.sleep(1)
        counter += 1
        if room_store is not None:
            scheduler = RoomTickScheduler(
                room_store,
                connections=connections,
                worker_id=worker_id,
                celestial_provider=get_celestial_state,
                publisher=event_bus,
            )
            await scheduler.tick_once(counter=counter)
            continue

        for room in list(rooms.values()):
            if not room["clients"]:
                continue
            state = room["state"]
            needs_broadcast = advance_timer_state(state)

            # Celestial refresh every 30 s when not overridden
            if counter % 30 == 0 and state["time_override"] is None:
                state["celestial"] = get_celestial_state()
                needs_broadcast = True

            if needs_broadcast:
                await broadcast(room, {"type": "state", "data": state})


@asynccontextmanager
async def lifespan(app: FastAPI):
    del app
    global event_bus, room_store
    if room_store is None and not config.is_test_mode():
        try:
            room_store = await create_redis_store()
        except RedisUnavailable:
            logger.exception("Redis is unavailable during startup")
            raise

    if event_bus is None:
        event_bus = _build_event_bus()

    task = asyncio.create_task(tick())
    try:
        yield
    finally:
        for subscription in tuple(event_subscription_tasks.values()):
            _ = subscription.cancel()
        for subscription in tuple(event_subscription_tasks.values()):
            with suppress(asyncio.CancelledError):
                await subscription
        event_subscription_tasks.clear()
        _ = task.cancel()
        with suppress(asyncio.CancelledError):
            await task


app = FastAPI(lifespan=lifespan)

# ── Routes ────────────────────────────────────────────────────────────────────
@app.get("/")
async def lobby():
    return FileResponse(os.path.join(FRONTEND, "lobby.html"))

@app.get("/room/{room_id}")
async def room_page(room_id: str):
    _ = room_id
    return FileResponse(os.path.join(FRONTEND, "room.html"))


@app.get("/health")
async def health() -> dict[str, str]:
    if room_store is None:
        if config.is_test_mode():
            return {"status": "ok"}
        raise HTTPException(status_code=503, detail="redis unavailable")
    try:
        await room_store.ping()
    except RedisUnavailable as exc:
        raise HTTPException(status_code=503, detail="redis unavailable") from exc
    return {"status": "ok"}


@app.post("/api/rooms")
async def create_room(request_body: CreateRoomRequest, request: Request):
    requested_id = normalize_room_id(request_body.room_id) if request_body.room_id else _generated_room_id()
    fingerprint = _client_fingerprint(request)

    if room_store is not None:
        metadata = await room_store.get_metadata(requested_id)
        if metadata is None or "pin_hash" not in metadata:
            pin_hash = auth.hash_pin(request_body.pin)
            try:
                await room_store.create_room(
                    requested_id,
                    make_state(),
                    metadata={"room_id": requested_id, "pin_hash": pin_hash},
                )
            except RoomLimitReached:
                raise HTTPException(status_code=403, detail="room limit reached") from None
        else:
            await _assert_not_rate_limited(requested_id, fingerprint)
            stored_pin_hash = str(metadata.get("pin_hash", ""))
            if not stored_pin_hash or not auth.verify_pin(request_body.pin, stored_pin_hash):
                await _record_failed_attempt(requested_id, fingerprint)
                await _auth_failure()
    else:
        room = get_room(requested_id)
        if room is None:
            raise HTTPException(status_code=403, detail="room limit reached")
        stored_pin_hash = local_pin_hashes.get(requested_id)
        if stored_pin_hash is None:
            local_pin_hashes[requested_id] = auth.hash_pin(request_body.pin)
        elif not auth.verify_pin(request_body.pin, stored_pin_hash):
            await _auth_failure()

    token = await _issue_room_token(requested_id)
    return {"room_id": requested_id, "token": token}


@app.post("/api/rooms/{room_id}/join")
async def join_room(room_id: str, request_body: JoinRoomRequest, request: Request):
    normalized = normalize_room_id(room_id)
    fingerprint = _client_fingerprint(request)
    await _assert_not_rate_limited(normalized, fingerprint)
    if room_store is not None:
        metadata = await room_store.get_metadata(normalized)
        stored_pin_hash = "" if metadata is None else str(metadata.get("pin_hash", ""))
    else:
        stored_pin_hash = local_pin_hashes.get(normalized, "")
    if not stored_pin_hash or not auth.verify_pin(request_body.pin, stored_pin_hash):
        await _record_failed_attempt(normalized, fingerprint)
        await _auth_failure()
    token = await _issue_room_token(normalized)
    return {"token": token}


# ── WebSocket ─────────────────────────────────────────────────────────────────
@app.websocket("/ws/{room_id}")
async def ws_endpoint(websocket: WebSocket, room_id: str):
    normalized = normalize_room_id(room_id)
    token = websocket.query_params.get("token")
    if not token:
        await websocket.accept()
        await websocket.close(code=WS_AUTH_CLOSE_CODE, reason=WS_AUTH_CLOSE_REASON)
        return

    try:
        authorized = await _token_authorizes_room(normalized, token)
        state = await get_room_state(normalized) if authorized else None
    except RedisUnavailable:
        await websocket.accept()
        await websocket.close(code=WS_OPERATIONAL_CLOSE_CODE, reason=WS_OPERATIONAL_CLOSE_REASON)
        return

    if not authorized or state is None:
        await websocket.accept()
        await websocket.close(code=WS_AUTH_CLOSE_CODE, reason=WS_AUTH_CLOSE_REASON)
        return

    await ensure_room_events(normalized)
    await websocket.accept()
    connections.connect(normalized, websocket)
    room = rooms.get(normalized)
    if room is not None:
        room["clients"].add(websocket)
    await websocket.send_text(json.dumps({"type": "state", "data": state}))

    try:
        async for raw in websocket.iter_text():
            try:
                current_state = await get_room_state(normalized)
                if current_state is None:
                    await websocket.close(code=WS_AUTH_CLOSE_CODE, reason=WS_AUTH_CLOSE_REASON)
                    return
                await handle(current_state, cast(dict[str, object], json.loads(raw)))
                await save_room_state(normalized, current_state)
                await connections.broadcast_json(normalized, {"type": "state", "data": current_state})
                await publish_room_state(normalized, current_state)
            except RedisUnavailable:
                await websocket.close(code=WS_OPERATIONAL_CLOSE_CODE, reason=WS_OPERATIONAL_CLOSE_REASON)
                return
            except (json.JSONDecodeError, TypeError, ValueError, KeyError):
                logger.exception("handle() failed for room %s", room_id)
    except WebSocketDisconnect:
        pass
    finally:
        became_empty = connections.disconnect(normalized, websocket)
        if room is not None:
            room["clients"].discard(websocket)
            became_empty = not room["clients"]
        if became_empty:
            await stop_room_events(normalized)
            if room is not None:
                room["cleanup"] = asyncio.create_task(schedule_cleanup(normalized))
            else:
                _ = asyncio.create_task(schedule_cleanup(normalized))


async def handle(state: BackendState, msg: dict[str, object]) -> None:
    await state_reducer.handle(state, msg, get_celestial_state)


app.mount("/", StaticFiles(directory=FRONTEND), name="static")
