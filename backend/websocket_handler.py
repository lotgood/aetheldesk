from json import JSONDecodeError
from typing import assert_never

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

try:
    from backend import room_service, room_session
    from backend import runtime as runtime_module
    from backend.redis_contract import is_valid_room_id, normalize_room_id
    from backend.room_store import RedisUnavailable
except ModuleNotFoundError:
    import room_service
    import room_session
    import runtime as runtime_module
    from redis_contract import is_valid_room_id, normalize_room_id
    from room_store import RedisUnavailable


ensure_room_events = room_service.ensure_room_events
router = APIRouter()


async def _accept_and_close(websocket: WebSocket, *, code: int, reason: str) -> None:
    await websocket.accept()
    await websocket.close(code=code, reason=reason)


@router.websocket("/ws/{room_id}")
async def ws_endpoint(websocket: WebSocket, room_id: str) -> None:
    normalized = normalize_room_id(room_id)
    token = websocket.query_params.get("token")
    if not token or not is_valid_room_id(normalized):
        await _accept_and_close(
            websocket,
            code=runtime_module.WS_AUTH_CLOSE_CODE,
            reason=runtime_module.WS_AUTH_CLOSE_REASON,
        )
        return

    try:
        state = await room_session.load_authorized_room_state(normalized, token)
    except RedisUnavailable:
        await _accept_and_close(
            websocket,
            code=runtime_module.WS_OPERATIONAL_CLOSE_CODE,
            reason=runtime_module.WS_OPERATIONAL_CLOSE_REASON,
        )
        return
    if state is None:
        await _accept_and_close(
            websocket,
            code=runtime_module.WS_AUTH_CLOSE_CODE,
            reason=runtime_module.WS_AUTH_CLOSE_REASON,
        )
        return

    try:
        await ensure_room_events(normalized)
    except RedisUnavailable:
        await _accept_and_close(
            websocket,
            code=runtime_module.WS_OPERATIONAL_CLOSE_CODE,
            reason=runtime_module.WS_OPERATIONAL_CLOSE_REASON,
        )
        return

    await websocket.accept()
    room_session.connect_room_websocket(normalized, websocket)
    await websocket.send_json({"type": "state", "data": state})

    try:
        async for raw in websocket.iter_text():
            try:
                result = await room_session.process_room_client_message(normalized, raw)
                match result:
                    case room_session.AppliedRoomMessage():
                        pass
                    case room_session.MissingRoomState():
                        await websocket.close(
                            code=runtime_module.WS_AUTH_CLOSE_CODE,
                            reason=runtime_module.WS_AUTH_CLOSE_REASON,
                        )
                        return
                    case unreachable:
                        assert_never(unreachable)
            except RedisUnavailable:
                await websocket.close(
                    code=runtime_module.WS_OPERATIONAL_CLOSE_CODE,
                    reason=runtime_module.WS_OPERATIONAL_CLOSE_REASON,
                )
                return
            except (JSONDecodeError, TypeError, ValueError, KeyError):
                runtime_module.logger.exception("handle() failed for room %s", room_id)
    except WebSocketDisconnect:
        pass
    finally:
        await room_session.disconnect_room_websocket(normalized, websocket)
