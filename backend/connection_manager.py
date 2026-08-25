import json
from collections.abc import Iterable

from fastapi import WebSocket, WebSocketDisconnect

from backend.redis_contract import normalize_room_id


class LocalConnectionManager:
    def __init__(self) -> None:
        self._connections: dict[str, set[WebSocket]] = {}
        self._last_state_revision: dict[str, int] = {}

    def room_ids(self) -> tuple[str, ...]:
        return tuple(self._connections.keys())

    def connect(self, room_id: str, websocket: WebSocket) -> None:
        normalized = normalize_room_id(room_id)
        self._connections.setdefault(normalized, set()).add(websocket)

    def disconnect(self, room_id: str, websocket: WebSocket) -> bool:
        normalized = normalize_room_id(room_id)
        sockets = self._connections.get(normalized)
        if sockets is None:
            return True
        sockets.discard(websocket)
        if not sockets:
            del self._connections[normalized]
            self._last_state_revision.pop(normalized, None)
            return True
        return False

    def has_connections(self, room_id: str) -> bool:
        normalized = normalize_room_id(room_id)
        return bool(self._connections.get(normalized))

    def connections_for(self, room_id: str) -> frozenset[WebSocket]:
        normalized = normalize_room_id(room_id)
        return frozenset(self._connections.get(normalized, set()))

    def note_state_revision(self, room_id: str, revision: object) -> None:
        if isinstance(revision, int) and not isinstance(revision, bool):
            normalized = normalize_room_id(room_id)
            self._last_state_revision[normalized] = max(
                revision,
                self._last_state_revision.get(normalized, revision),
            )

    async def broadcast_json(self, room_id: str, payload: dict[str, object]) -> None:
        normalized = normalize_room_id(room_id)
        sockets = self._connections.get(normalized)
        if not sockets:
            return

        data = payload.get("data")
        revision = data.get("revision") if payload.get("type") == "state" and isinstance(data, dict) else None
        if isinstance(revision, int) and not isinstance(revision, bool):
            previous_revision = self._last_state_revision.get(normalized)
            if previous_revision is not None and revision < previous_revision:
                return
            self._last_state_revision[normalized] = revision

        encoded = json.dumps(payload)
        dead: set[WebSocket] = set()
        for websocket in tuple(sockets):
            try:
                await websocket.send_text(encoded)
            except (RuntimeError, WebSocketDisconnect):
                dead.add(websocket)

        for websocket in dead:
            self.disconnect(normalized, websocket)

    def local_payloads(self) -> dict[str, list[str]]:
        return {
            room_id: [type(socket).__name__ for socket in sockets] for room_id, sockets in self._connections.items()
        }


def contains_live_websocket(value: object) -> bool:
    if isinstance(value, WebSocket):
        return True
    if hasattr(value, "send_text") and callable(getattr(value, "send_text")):
        return True
    if isinstance(value, dict):
        return any(contains_live_websocket(item) for item in value.values())
    if isinstance(value, (str, bytes, bytearray)):
        return False
    if isinstance(value, Iterable):
        return any(contains_live_websocket(item) for item in value)
    return False
