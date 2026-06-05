import asyncio
import json
from contextlib import suppress
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

try:
    from backend import config
    from backend import room_auth_service
    from backend import runtime as runtime_module
    from backend import state as state_reducer
    from backend.client_messages import parse_client_message
    from backend.event_bus import RedisStateEventBus
    from backend.redis_contract import normalize_room_id
    from backend.room_store import RedisUnavailable, RoomLimitReached, create_redis_store
    from backend.state import BackendState
except ModuleNotFoundError:
    import config
    import room_auth_service
    import runtime as runtime_module
    import state as state_reducer
    from client_messages import parse_client_message
    from event_bus import RedisStateEventBus
    from redis_contract import normalize_room_id
    from room_store import RedisUnavailable, RoomLimitReached, create_redis_store
    from state import BackendState


PIN_MIN_LENGTH = room_auth_service.PIN_MIN_LENGTH
PIN_MAX_LENGTH = room_auth_service.PIN_MAX_LENGTH
ROOM_INSTANCE_ID_KEY = room_auth_service.ROOM_INSTANCE_ID_KEY
_assert_not_rate_limited = room_auth_service.assert_not_rate_limited
_auth_failure = room_auth_service.auth_failure
_client_fingerprint = room_auth_service.client_fingerprint
_generated_room_id = room_auth_service.generated_room_id
_issue_room_token = room_auth_service.issue_room_token
_metadata_room_instance_id = room_auth_service.metadata_room_instance_id
_new_room_instance_id = room_auth_service.new_room_instance_id
_record_failed_attempt = room_auth_service.record_failed_attempt
_require_valid_room_id = room_auth_service.require_valid_room_id
_scoped_token_hash = room_auth_service.scoped_token_hash
_token_authorizes_room = room_auth_service.token_authorizes_room


def _runtime() -> Any:
    return runtime_module.get_runtime()


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


def schedule_empty_room_cleanup(room_id: str, room: runtime_module.Room | None) -> None:
    task = asyncio.create_task(schedule_cleanup(normalize_room_id(room_id)))
    if room is not None:
        room["cleanup"] = task


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


async def handle(state: BackendState, msg: object) -> bool:
    runtime = _runtime()
    command = parse_client_message(msg)
    if command is None:
        return False
    await state_reducer.handle(state, command, runtime.get_celestial_state)
    return True


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
