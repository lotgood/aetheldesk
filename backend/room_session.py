import json
from dataclasses import dataclass

from fastapi import WebSocket

try:
    from backend import room_auth_service, room_service
    from backend import runtime as runtime_module
    from backend.redis_contract import normalize_room_id
    from backend.state import BackendState
except ModuleNotFoundError:
    import room_auth_service
    import room_service
    import runtime as runtime_module
    from redis_contract import normalize_room_id
    from state import BackendState


@dataclass(frozen=True, slots=True)
class AppliedRoomMessage:
    state: BackendState


@dataclass(frozen=True, slots=True)
class MissingRoomState:
    pass


RoomMessageResult = AppliedRoomMessage | MissingRoomState


async def load_authorized_room_state(room_id: str, token: str) -> BackendState | None:
    normalized = normalize_room_id(room_id)
    if not await room_auth_service.token_authorizes_room(normalized, token):
        return None
    return await room_service.get_room_state(normalized)


def connect_room_websocket(room_id: str, websocket: WebSocket) -> None:
    runtime = runtime_module.get_runtime()
    normalized = normalize_room_id(room_id)
    runtime.connections.connect(normalized, websocket)
    room = runtime.rooms.get(normalized)
    if room is not None:
        room["clients"].add(websocket)


async def process_room_client_message(room_id: str, raw_message: str) -> RoomMessageResult:
    normalized = normalize_room_id(room_id)
    payload = json.loads(raw_message)
    current_state = await room_service.get_room_state(normalized)
    if current_state is None:
        return MissingRoomState()

    _ = await room_service.handle(current_state, payload)
    await room_service.save_room_state(normalized, current_state)
    await runtime_module.get_runtime().connections.broadcast_json(
        normalized,
        {"type": "state", "data": current_state},
    )
    await room_service.publish_room_state(normalized, current_state)
    return AppliedRoomMessage(current_state)


async def disconnect_room_websocket(room_id: str, websocket: WebSocket) -> None:
    runtime = runtime_module.get_runtime()
    normalized = normalize_room_id(room_id)
    became_empty = runtime.connections.disconnect(normalized, websocket)
    room = runtime.rooms.get(normalized)
    if room is not None:
        room["clients"].discard(websocket)
        became_empty = not room["clients"]
    if became_empty:
        await room_service.stop_room_events(normalized)
        room_service.schedule_empty_room_cleanup(normalized, room)
