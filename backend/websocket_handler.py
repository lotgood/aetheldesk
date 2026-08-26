import asyncio
import json
from importlib import import_module
from typing import Any, cast

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from backend.redis_contract import is_valid_room_id, normalize_room_id
from backend.room_store import RedisUnavailable, RoomGenerationChanged, StateConflict

_room_service = import_module("backend.room_service")
_runtime = cast(Any, _room_service._runtime)
_authorized_room_snapshot = cast(Any, _room_service._authorized_room_snapshot)
ensure_room_events = cast(Any, _room_service.ensure_room_events)
get_room_state = cast(Any, _room_service.get_room_state)
mutate_room_state = cast(Any, _room_service.mutate_room_state)
publish_room_state = cast(Any, _room_service.publish_room_state)
schedule_cleanup = cast(Any, _room_service.schedule_cleanup)
stop_room_events = cast(Any, _room_service.stop_room_events)


router = APIRouter()


@router.websocket("/ws/{room_id}")
async def ws_endpoint(websocket: WebSocket, room_id: str):
    runtime = _runtime()
    normalized = normalize_room_id(room_id)
    token = websocket.query_params.get("token")
    if not token or not is_valid_room_id(normalized):
        await websocket.accept()
        await websocket.close(code=runtime.WS_AUTH_CLOSE_CODE, reason=runtime.WS_AUTH_CLOSE_REASON)
        return

    try:
        authorized_snapshot = await _authorized_room_snapshot(normalized, token)
    except RedisUnavailable:
        await websocket.accept()
        await websocket.close(code=runtime.WS_OPERATIONAL_CLOSE_CODE, reason=runtime.WS_OPERATIONAL_CLOSE_REASON)
        return

    if authorized_snapshot is None:
        await websocket.accept()
        await websocket.close(code=runtime.WS_AUTH_CLOSE_CODE, reason=runtime.WS_AUTH_CLOSE_REASON)
        return
    _state, room_instance_id = authorized_snapshot

    try:
        await ensure_room_events(normalized)
    except RedisUnavailable:
        await websocket.accept()
        await websocket.close(code=runtime.WS_OPERATIONAL_CLOSE_CODE, reason=runtime.WS_OPERATIONAL_CLOSE_REASON)
        return
    await websocket.accept()
    runtime.connections.connect(normalized, websocket, room_instance_id)
    room = runtime.rooms.get(normalized)
    if room is not None:
        room["clients"].add(websocket)
    try:
        try:
            latest_snapshot = await _authorized_room_snapshot(normalized, token)
        except RedisUnavailable:
            await websocket.close(
                code=runtime.WS_OPERATIONAL_CLOSE_CODE,
                reason=runtime.WS_OPERATIONAL_CLOSE_REASON,
            )
            return
        if latest_snapshot is None or latest_snapshot[1] != room_instance_id:
            await websocket.close(code=runtime.WS_AUTH_CLOSE_CODE, reason=runtime.WS_AUTH_CLOSE_REASON)
            return
        latest_state, _latest_instance_id = latest_snapshot
        await runtime.connections.close_mismatched_generations(normalized, room_instance_id)
        connection_is_current = await runtime.connections.send_json(
            normalized,
            websocket,
            {"type": "state", "data": latest_state},
            expected_instance_id=room_instance_id,
        )
        if not connection_is_current:
            return

        async for raw in websocket.iter_text():
            try:
                decoded_message = json.loads(raw)
                if not isinstance(decoded_message, dict):
                    raise TypeError("websocket payload must be a JSON object")
                message = cast(dict[str, object], decoded_message)
                mutation = await mutate_room_state(normalized, message, room_instance_id)
                if mutation is None:
                    await websocket.close(code=runtime.WS_AUTH_CLOSE_CODE, reason=runtime.WS_AUTH_CLOSE_REASON)
                    return
                current_state, changed = mutation
                if not changed:
                    continue
                await runtime.connections.broadcast_json(
                    normalized,
                    {"type": "state", "data": current_state},
                    expected_instance_id=room_instance_id,
                )
                await publish_room_state(normalized, current_state)
            except RoomGenerationChanged:
                await websocket.close(code=runtime.WS_AUTH_CLOSE_CODE, reason=runtime.WS_AUTH_CLOSE_REASON)
                return
            except (RedisUnavailable, StateConflict):
                await websocket.close(
                    code=runtime.WS_OPERATIONAL_CLOSE_CODE, reason=runtime.WS_OPERATIONAL_CLOSE_REASON
                )
                return
            except (json.JSONDecodeError, TypeError, ValueError, KeyError):
                runtime.logger.exception("handle() failed for room %s", room_id)
    except WebSocketDisconnect:
        pass
    finally:
        became_empty = runtime.connections.disconnect(normalized, websocket)
        if room is not None:
            room["clients"].discard(websocket)
            became_empty = not room["clients"]
        if became_empty:
            await stop_room_events(normalized)
            if room is not None:
                room["cleanup"] = asyncio.create_task(schedule_cleanup(normalized))
            else:
                _ = asyncio.create_task(schedule_cleanup(normalized))
