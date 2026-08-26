import asyncio
import hashlib
import hmac
import json
from contextlib import suppress
from importlib import import_module
from typing import Any

from fastapi import HTTPException, Request, WebSocket, WebSocketDisconnect

from backend import auth, config
from backend import state as state_reducer
from backend.event_bus import RedisStateEventBus
from backend.redis_contract import is_valid_room_id, normalize_room_id
from backend.room_store import (
    RedisUnavailable,
    RoomGenerationChanged,
    RoomLimitReached,
    StateConflict,
    create_redis_store,
)
from backend.state import BackendState


PIN_MIN_LENGTH = 4
PIN_MAX_LENGTH = 64
ROOM_INSTANCE_ID_KEY = "room_instance_id"


def _runtime() -> Any:
    return import_module("backend.main")


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


async def _issue_room_token(room_id: str, expected_instance_id: str) -> str:
    runtime = _runtime()
    normalized = normalize_room_id(room_id)
    token = auth.create_token()
    token_hash = _scoped_token_hash(token, expected_instance_id)
    if runtime.room_store is not None:
        try:
            await runtime.room_store.set_token_lookup(
                normalized,
                token_hash,
                expected_instance_id=expected_instance_id,
            )
        except RoomGenerationChanged:
            await _auth_failure()
    else:
        if runtime.local_room_instance_ids.get(normalized) != expected_instance_id:
            await _auth_failure()
        runtime.local_token_hashes.setdefault(normalized, set()).add(token_hash)
    return token


async def _token_authorizes_room(room_id: str, token: str) -> bool:
    return await _authorized_room_state(room_id, token) is not None


async def _authorized_room_snapshot(room_id: str, token: str) -> tuple[BackendState, str] | None:
    runtime = _runtime()
    normalized = normalize_room_id(room_id)
    if runtime.room_store is not None:
        metadata = await runtime.room_store.get_metadata(normalized)
        room_instance_id = _metadata_room_instance_id(metadata)
        if room_instance_id is None:
            return None
        token_hash = _scoped_token_hash(token, room_instance_id)
        state = await runtime.room_store.authorize_token(
            normalized,
            room_instance_id,
            token_hash,
        )
        return None if state is None else (state, room_instance_id)
    room_instance_id = runtime.local_room_instance_ids.get(normalized)
    if room_instance_id is None:
        return None
    token_hash = _scoped_token_hash(token, room_instance_id)
    if token_hash not in runtime.local_token_hashes.get(normalized, set()):
        return None
    state = await get_room_state(normalized)
    return None if state is None else (state, room_instance_id)


async def _authorized_room_state(room_id: str, token: str) -> BackendState | None:
    snapshot = await _authorized_room_snapshot(room_id, token)
    return None if snapshot is None else snapshot[0]


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
    normalized = normalize_room_id(room_id)
    if runtime.room_store is not None:
        # Presence is local to a worker, so it cannot safely authorize an eager
        # Redis delete: another worker may still own a live socket. Connected
        # and advancing rooms refresh their canonical TTL in the scheduler;
        # abandoned rooms expire naturally and the registry prunes them.
        return

    await asyncio.sleep(runtime.ROOM_TTL)
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


async def mutate_room_state(
    room_id: str,
    msg: dict[str, object],
    expected_instance_id: str,
) -> tuple[BackendState, bool] | None:
    runtime = _runtime()
    normalized = normalize_room_id(room_id)
    if runtime.room_store is None:
        if runtime.local_room_instance_ids.get(normalized) != expected_instance_id:
            raise RoomGenerationChanged("room generation changed during websocket mutation")
        state = await get_room_state(normalized)
        if state is None:
            return None
        before = json.dumps(state, sort_keys=True)
        await handle(state, msg)
        changed = json.dumps(state, sort_keys=True) != before
        if changed:
            state["revision"] += 1
            await save_room_state(normalized, state)
        return state, changed

    for _attempt in range(8):
        snapshot = await runtime.room_store.get_room_snapshot(normalized)
        if snapshot is None:
            raise RoomGenerationChanged("room generation is unavailable")
        state, room_instance_id = snapshot
        if room_instance_id != expected_instance_id:
            raise RoomGenerationChanged("room generation changed during websocket mutation")
        expected_revision = state["revision"]
        current_slot = await runtime.room_store.current_time_slot()
        advancing = state["break"] or (state["focus"] and not state["paused"])
        previous_slot = state["last_tick_slot"]
        reconciled = False
        if advancing and previous_slot is not None:
            elapsed_seconds = max(0, current_slot - previous_slot)
            if elapsed_seconds:
                reconciled = state_reducer.advance_timer_state(state, elapsed_seconds)
            still_advancing = state["break"] or (state["focus"] and not state["paused"])
            state["last_tick_slot"] = current_slot if still_advancing else None
        before_message = json.dumps(state, sort_keys=True)
        await handle(state, msg)
        advancing = state["break"] or (state["focus"] and not state["paused"])
        if advancing and state["last_tick_slot"] is None:
            state["last_tick_slot"] = current_slot
        changed = reconciled or json.dumps(state, sort_keys=True) != before_message
        if not changed:
            return state, False
        state["revision"] = expected_revision + 1
        if await runtime.room_store.compare_and_set_state(
            normalized,
            expected_revision,
            expected_instance_id,
            state,
        ):
            return state, True
    raise StateConflict("room state changed too frequently")


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
        load_canonical_snapshot=runtime.room_store.get_room_snapshot,
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
    ready = runtime.event_subscription_ready.get(normalized)
    created_subscription = False
    if task is None or task.done() or ready is None:
        ready = asyncio.get_running_loop().create_future()
        task = asyncio.create_task(_run_room_event_subscription(normalized, ready))
        runtime.event_subscription_tasks[normalized] = task
        runtime.event_subscription_ready[normalized] = ready
        created_subscription = True
    await asyncio.shield(ready)
    await asyncio.sleep(0)
    if task.done():
        exception = task.exception()
        if exception is not None:
            raise exception
        raise RedisUnavailable("Redis event subscription ended")
    if created_subscription:
        await runtime.event_bus.sync_room_from_store(normalized)


async def _run_room_event_subscription(room_id: str, ready: asyncio.Future[None]) -> None:
    runtime = _runtime()
    current_task = asyncio.current_task()
    try:
        await runtime.event_bus.consume_room_events(room_id, ready)
        raise RedisUnavailable("Redis event subscription ended")
    except asyncio.CancelledError:
        if not ready.done():
            ready.cancel()
        raise
    except Exception as exc:
        normalized_exc = (
            exc if isinstance(exc, RedisUnavailable) else RedisUnavailable("Redis event subscription failed")
        )
        if not ready.done():
            ready.set_exception(normalized_exc)
        else:
            runtime.logger.warning("room event subscription failed for %s", room_id, exc_info=exc)
            for websocket in runtime.connections.connections_for(room_id):
                try:
                    await websocket.close(
                        code=runtime.WS_OPERATIONAL_CLOSE_CODE,
                        reason=runtime.WS_OPERATIONAL_CLOSE_REASON,
                    )
                except (RuntimeError, WebSocketDisconnect):
                    pass
        return
    finally:
        if runtime.event_subscription_tasks.get(room_id) is current_task:
            runtime.event_subscription_tasks.pop(room_id, None)
        if runtime.event_subscription_ready.get(room_id) is ready:
            runtime.event_subscription_ready.pop(room_id, None)


async def stop_room_events(room_id: str) -> None:
    runtime = _runtime()
    normalized = normalize_room_id(room_id)
    task = runtime.event_subscription_tasks.pop(normalized, None)
    ready = runtime.event_subscription_ready.pop(normalized, None)
    if ready is not None and not ready.done():
        ready.cancel()
    if task is None:
        return
    _ = task.cancel()
    with suppress(asyncio.CancelledError, RedisUnavailable):
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
        with suppress(asyncio.CancelledError, RedisUnavailable):
            await subscription
    runtime.event_subscription_tasks.clear()
    for ready in tuple(runtime.event_subscription_ready.values()):
        if not ready.done():
            ready.cancel()
    runtime.event_subscription_ready.clear()
