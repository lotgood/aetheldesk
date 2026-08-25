import asyncio
import json
from importlib import import_module
from typing import Any, cast

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from backend.redis_contract import is_valid_room_id, normalize_room_id
from backend.room_store import RedisUnavailable, StateConflict

_room_service = import_module("backend.room_service")
_runtime = cast(Any, _room_service._runtime)
_authorized_room_state = cast(Any, _room_service._authorized_room_state)
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
        state = await _authorized_room_state(normalized, token)
    except RedisUnavailable:
        await websocket.accept()
        await websocket.close(code=runtime.WS_OPERATIONAL_CLOSE_CODE, reason=runtime.WS_OPERATIONAL_CLOSE_REASON)
        return

    if state is None:
        await websocket.accept()
        await websocket.close(code=runtime.WS_AUTH_CLOSE_CODE, reason=runtime.WS_AUTH_CLOSE_REASON)
        return

    try:
        await ensure_room_events(normalized)
    except RedisUnavailable:
        await websocket.accept()
        await websocket.close(code=runtime.WS_OPERATIONAL_CLOSE_CODE, reason=runtime.WS_OPERATIONAL_CLOSE_REASON)
        return
    await websocket.accept()
    runtime.connections.connect(normalized, websocket)
    room = runtime.rooms.get(normalized)
    if room is not None:
        room["clients"].add(websocket)
    try:
        try:
            latest_state = await _authorized_room_state(normalized, token)
        except RedisUnavailable:
            await websocket.close(
                code=runtime.WS_OPERATIONAL_CLOSE_CODE,
                reason=runtime.WS_OPERATIONAL_CLOSE_REASON,
            )
            return
        if latest_state is None:
            await websocket.close(code=runtime.WS_AUTH_CLOSE_CODE, reason=runtime.WS_AUTH_CLOSE_REASON)
            return
        runtime.connections.note_state_revision(normalized, latest_state["revision"])
        await websocket.send_text(json.dumps({"type": "state", "data": latest_state}))

        async for raw in websocket.iter_text():
            try:
                message = cast(dict[str, object], json.loads(raw))
                mutation = await mutate_room_state(normalized, message)
                if mutation is None:
                    await websocket.close(code=runtime.WS_AUTH_CLOSE_CODE, reason=runtime.WS_AUTH_CLOSE_REASON)
                    return
                current_state, changed = mutation
                if not changed:
                    continue
                await runtime.connections.broadcast_json(normalized, {"type": "state", "data": current_state})
                await publish_room_state(normalized, current_state)
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
