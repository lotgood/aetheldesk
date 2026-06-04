import asyncio
import hashlib
import hmac
import json
from contextlib import suppress
from importlib import import_module
from typing import Any

from fastapi import HTTPException, Request, WebSocket, WebSocketDisconnect

try:
    from backend import auth, config
    from backend import state as state_reducer
    from backend.event_bus import RedisStateEventBus
    from backend.redis_contract import is_valid_room_id, normalize_room_id
    from backend.room_store import RedisUnavailable, RoomLimitReached, create_redis_store
    from backend.state import BackendState
except ModuleNotFoundError:
    import auth
    import config
    import state as state_reducer
    from event_bus import RedisStateEventBus
    from redis_contract import is_valid_room_id, normalize_room_id
    from room_store import RedisUnavailable, RoomLimitReached, create_redis_store
    from state import BackendState


PIN_MIN_LENGTH = 4
PIN_MAX_LENGTH = 64
ROOM_INSTANCE_ID_KEY = "room_instance_id"


def _runtime() -> Any:
    try:
        return import_module("backend.main")
    except ModuleNotFoundError:
        return import_module("main")


def _generated_room_id() -> str:
    return "R" + os_urandom_hex(4)[:7]


def os_urandom_hex(size: int) -> str:
    import os

    return os.urandom(size).hex().upper()


def _new_room_instance_id() -> str:
    return auth.create_token()


def _metadata_room_instance_id(metadata: dict[str, object] | None) -> str | None:
    if metadata is None:
        return None
    room_instance_id = metadata.get(ROOM_INSTANCE_ID_KEY)
    return room_instance_id if isinstance(room_instance_id, str) and room_instance_id else None


def _scoped_token_hash(token: str, room_instance_id: str) -> str:
    return auth.hash_token(f"{room_instance_id}:{token}")


def _require_valid_room_id(room_id: str) -> str:
    normalized = normalize_room_id(room_id)
    if not is_valid_room_id(normalized):
        raise HTTPException(status_code=400, detail="invalid room id")
    return normalized


def _client_fingerprint(request: Request) -> str:
    ip: str | None = None
    if config.TRUST_PROXY:
        forwarded = request.headers.get("x-forwarded-for", "")
        ip = forwarded.split(",", 1)[0].strip() or None
    if not ip:
        ip = request.client.host if request.client is not None else "unknown"
    key = config.get_secret_key().encode("utf-8")
    return hmac.new(key, ip.encode("utf-8"), hashlib.sha256).hexdigest()


async def _auth_failure() -> None:
    raise HTTPException(status_code=401, detail=auth.failure_body()["detail"])


async def _assert_not_rate_limited(room_id: str, fingerprint: str) -> None:
    runtime = _runtime()
    if runtime.room_store is None:
        return
    if await runtime.room_store.is_pin_blocked(room_id, fingerprint):
        raise HTTPException(status_code=403, detail=auth.failure_body()["detail"])


async def _record_failed_attempt(room_id: str, fingerprint: str) -> None:
    runtime = _runtime()
    if runtime.room_store is None:
        return
    policy = auth.PinRatePolicy()
    blocked = await runtime.room_store.record_failed_pin_attempt(
        room_id,
        fingerprint,
        attempt_window_seconds=policy.attempt_window_seconds,
        max_attempts=policy.max_attempts,
        block_seconds=policy.block_seconds,
    )
    if blocked:
        raise HTTPException(status_code=403, detail=auth.failure_body()["detail"])


async def _issue_room_token(room_id: str) -> str:
    runtime = _runtime()
    normalized = normalize_room_id(room_id)
    token = auth.create_token()
    if runtime.room_store is not None:
        metadata = await runtime.room_store.get_metadata(normalized)
        room_instance_id = _metadata_room_instance_id(metadata)
        if room_instance_id is None or not await runtime.room_store.has_room(normalized):
            await _auth_failure()
        else:
            token_hash = _scoped_token_hash(token, room_instance_id)
        await runtime.room_store.set_token_lookup(normalized, token_hash)
    else:
        room_instance_id = runtime.local_room_instance_ids.get(normalized)
        if room_instance_id is None:
            await _auth_failure()
        else:
            token_hash = _scoped_token_hash(token, room_instance_id)
        runtime.local_token_hashes.setdefault(normalized, set()).add(token_hash)
    return token


async def _token_authorizes_room(room_id: str, token: str) -> bool:
    runtime = _runtime()
    normalized = normalize_room_id(room_id)
    if runtime.room_store is not None:
        metadata = await runtime.room_store.get_metadata(normalized)
        room_instance_id = _metadata_room_instance_id(metadata)
        if room_instance_id is None:
            return False
        token_hash = _scoped_token_hash(token, room_instance_id)
        resolved_room = await runtime.room_store.get_token_room_id(normalized, token_hash)
        return resolved_room == normalized
    room_instance_id = runtime.local_room_instance_ids.get(normalized)
    if room_instance_id is None:
        return False
    token_hash = _scoped_token_hash(token, room_instance_id)
    return token_hash in runtime.local_token_hashes.get(normalized, set())


def make_state() -> BackendState:
    runtime = _runtime()
    return state_reducer.make_state(runtime.get_celestial_state)


def get_room(room_id: str) -> Any | None:
    runtime = _runtime()
    normalized = normalize_room_id(room_id)
    if normalized not in runtime.rooms:
        if len(runtime.rooms) >= runtime.MAX_ROOMS:
            return None
        runtime.rooms[normalized] = {"state": make_state(), "clients": set(), "cleanup": None}
    else:
        task = runtime.rooms[normalized]["cleanup"]
        if task and not task.done():
            _ = task.cancel()
            runtime.rooms[normalized]["cleanup"] = None
    return runtime.rooms[normalized]


async def schedule_cleanup(room_id: str):
    runtime = _runtime()
    await asyncio.sleep(runtime.ROOM_TTL)
    normalized = normalize_room_id(room_id)
    if runtime.room_store is not None:
        _ = await runtime.room_store.expire_empty_room(
            normalized,
            has_connections=runtime.connections.has_connections(normalized),
        )
        return

    room = runtime.rooms.get(normalized)
    if room and not room["clients"] and room["cleanup"] is asyncio.current_task():
        _ = runtime.rooms.pop(normalized, None)
        _ = runtime.local_pin_hashes.pop(normalized, None)
        _ = runtime.local_token_hashes.pop(normalized, None)
        _ = runtime.local_room_instance_ids.pop(normalized, None)


async def broadcast(room: Any, payload: dict[str, object]):
    dead: set[WebSocket] = set()
    for ws in room["clients"]:
        try:
            await ws.send_text(json.dumps(payload))
        except (RuntimeError, WebSocketDisconnect):
            dead.add(ws)
    room["clients"].difference_update(dead)


async def get_room_state(room_id: str) -> BackendState | None:
    runtime = _runtime()
    normalized = normalize_room_id(room_id)
    if runtime.room_store is not None:
        try:
            return await runtime.room_store.get_or_create_room(normalized, make_state)
        except RoomLimitReached:
            return None

    room = get_room(normalized)
    if room is None:
        return None
    return room["state"]


async def save_room_state(room_id: str, state: BackendState) -> None:
    runtime = _runtime()
    normalized = normalize_room_id(room_id)
    if runtime.room_store is not None:
        await runtime.room_store.set_state(normalized, state)
        return
    room = runtime.rooms.get(normalized)
    if room is not None:
        room["state"] = state


def _build_event_bus() -> Any | None:
    runtime = _runtime()
    if runtime.room_store is None:
        return None
    redis = getattr(runtime.room_store, "redis", None)
    if redis is None or not hasattr(redis, "publish") or not hasattr(redis, "pubsub"):
        return None
    return RedisStateEventBus(
        redis,
        worker_id=runtime.worker_id,
        connections=runtime.connections,
        load_canonical_state=runtime.room_store.get_state,
    )


async def publish_room_state(room_id: str, state: BackendState) -> None:
    runtime = _runtime()
    if runtime.event_bus is not None:
        await runtime.event_bus.publish_state(room_id, state)


async def ensure_room_events(room_id: str) -> None:
    runtime = _runtime()
    if runtime.event_bus is None:
        return
    normalized = normalize_room_id(room_id)
    task = runtime.event_subscription_tasks.get(normalized)
    if task is not None and not task.done():
        return
    await runtime.event_bus.sync_room_from_store(normalized)
    runtime.event_subscription_tasks[normalized] = asyncio.create_task(
        runtime.event_bus.consume_room_events(normalized)
    )


async def stop_room_events(room_id: str) -> None:
    runtime = _runtime()
    normalized = normalize_room_id(room_id)
    task = runtime.event_subscription_tasks.pop(normalized, None)
    if task is None:
        return
    _ = task.cancel()
    with suppress(asyncio.CancelledError):
        await task


async def handle(state: BackendState, msg: dict[str, object]) -> None:
    runtime = _runtime()
    await state_reducer.handle(state, msg, runtime.get_celestial_state)


async def initialize_store_and_events() -> None:
    runtime = _runtime()
    if runtime.room_store is None and not config.is_test_mode():
        try:
            runtime.room_store = await create_redis_store()
        except RedisUnavailable:
            runtime.logger.exception("Redis is unavailable during startup")
            raise

    if runtime.event_bus is None:
        runtime.event_bus = _build_event_bus()


async def stop_event_subscriptions() -> None:
    runtime = _runtime()
    for subscription in tuple(runtime.event_subscription_tasks.values()):
        _ = subscription.cancel()
    for subscription in tuple(runtime.event_subscription_tasks.values()):
        with suppress(asyncio.CancelledError):
            await subscription
    runtime.event_subscription_tasks.clear()
