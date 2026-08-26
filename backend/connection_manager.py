import asyncio
import json
from collections.abc import Iterable

from fastapi import WebSocket, WebSocketDisconnect

from backend.redis_contract import normalize_room_id


class LocalConnectionManager:
    def __init__(self) -> None:
        self._connections: dict[str, dict[WebSocket, str | None]] = {}
        self._last_state_revision: dict[tuple[str, str | None], int] = {}
        self._socket_state_revision: dict[WebSocket, int] = {}
        self._socket_send_locks: dict[WebSocket, asyncio.Lock] = {}

    def room_ids(self) -> tuple[str, ...]:
        return tuple(self._connections.keys())

    def connect(self, room_id: str, websocket: WebSocket, room_instance_id: str | None = None) -> None:
        normalized = normalize_room_id(room_id)
        self._connections.setdefault(normalized, {})[websocket] = room_instance_id
        self._socket_state_revision.pop(websocket, None)
        self._socket_send_locks.setdefault(websocket, asyncio.Lock())

    def disconnect(self, room_id: str, websocket: WebSocket) -> bool:
        normalized = normalize_room_id(room_id)
        sockets = self._connections.get(normalized)
        if sockets is None:
            return True
        room_instance_id = sockets.pop(websocket, None)
        self._socket_state_revision.pop(websocket, None)
        self._socket_send_locks.pop(websocket, None)
        if room_instance_id is not None and room_instance_id not in sockets.values():
            self._last_state_revision.pop((normalized, room_instance_id), None)
        if not sockets:
            del self._connections[normalized]
            for key in tuple(self._last_state_revision):
                if key[0] == normalized:
                    self._last_state_revision.pop(key, None)
            return True
        return False

    def has_connections(self, room_id: str, room_instance_id: str | None = None) -> bool:
        normalized = normalize_room_id(room_id)
        sockets = self._connections.get(normalized)
        if not sockets:
            return False
        if room_instance_id is None:
            return True
        return room_instance_id in sockets.values()

    def connections_for(self, room_id: str) -> frozenset[WebSocket]:
        normalized = normalize_room_id(room_id)
        return frozenset(self._connections.get(normalized, {}))

    def room_instance_id_for(self, room_id: str, websocket: WebSocket) -> str | None:
        normalized = normalize_room_id(room_id)
        return self._connections.get(normalized, {}).get(websocket)

    def note_state_revision(
        self,
        room_id: str,
        revision: object,
        room_instance_id: str | None = None,
    ) -> None:
        if isinstance(revision, int) and not isinstance(revision, bool):
            normalized = normalize_room_id(room_id)
            key = (normalized, room_instance_id)
            self._last_state_revision[key] = max(
                revision,
                self._last_state_revision.get(key, revision),
            )

    async def send_json(
        self,
        room_id: str,
        websocket: WebSocket,
        payload: dict[str, object],
        *,
        expected_instance_id: str | None = None,
    ) -> bool:
        """Send one ordered state payload to one generation-bound socket.

        A Pub/Sub or scheduler broadcast may race the initial snapshot read. A
        per-socket lock and high-water mark guarantee that the new connection
        observes either initial -> newer, or just newer, never newer -> stale.
        Equal-revision snapshots are suppressed as duplicates.
        """
        normalized = normalize_room_id(room_id)
        sockets = self._connections.get(normalized)
        if not sockets or websocket not in sockets:
            return False

        room_instance_id = sockets[websocket]
        if expected_instance_id is not None and room_instance_id != expected_instance_id:
            close = getattr(websocket, "close", None)
            if close is not None:
                try:
                    await close(code=1008, reason="authentication failed")
                except (RuntimeError, TypeError, WebSocketDisconnect):
                    pass
            self.disconnect(normalized, websocket)
            return False

        lock = self._socket_send_locks.setdefault(websocket, asyncio.Lock())
        async with lock:
            sockets = self._connections.get(normalized)
            if not sockets or sockets.get(websocket) != room_instance_id:
                return False

            data = payload.get("data")
            revision = data.get("revision") if payload.get("type") == "state" and isinstance(data, dict) else None
            if isinstance(revision, int) and not isinstance(revision, bool):
                previous_revision = self._socket_state_revision.get(websocket)
                if previous_revision is not None and revision <= previous_revision:
                    return True

            try:
                await websocket.send_text(json.dumps(payload))
            except (RuntimeError, WebSocketDisconnect):
                self.disconnect(normalized, websocket)
                return False

            if isinstance(revision, int) and not isinstance(revision, bool):
                self._socket_state_revision[websocket] = revision
                self.note_state_revision(
                    normalized,
                    revision,
                    expected_instance_id if expected_instance_id is not None else room_instance_id,
                )
            return True

    async def close_mismatched_generations(
        self,
        room_id: str,
        expected_instance_id: str,
    ) -> None:
        """Close sockets authenticated for an obsolete room generation.

        A newly-created room can reuse the same public room id while an old
        socket is still connected. Prune those sockets without broadcasting
        the new generation's initial snapshot to any existing connection.
        """
        normalized = normalize_room_id(room_id)
        sockets = self._connections.get(normalized)
        if not sockets:
            return

        for websocket, room_instance_id in tuple(sockets.items()):
            if room_instance_id == expected_instance_id:
                continue

            lock = self._socket_send_locks.setdefault(websocket, asyncio.Lock())
            async with lock:
                current_sockets = self._connections.get(normalized)
                if (
                    not current_sockets
                    or websocket not in current_sockets
                    or current_sockets[websocket] == expected_instance_id
                ):
                    continue
                close = getattr(websocket, "close", None)
                if close is not None:
                    try:
                        await close(code=1008, reason="authentication failed")
                    except (RuntimeError, TypeError, WebSocketDisconnect):
                        pass
                self.disconnect(normalized, websocket)

    async def broadcast_json(
        self,
        room_id: str,
        payload: dict[str, object],
        *,
        expected_instance_id: str | None = None,
    ) -> None:
        normalized = normalize_room_id(room_id)
        sockets = self._connections.get(normalized)
        if not sockets:
            return

        if expected_instance_id is not None:
            await self.close_mismatched_generations(normalized, expected_instance_id)
            sockets = self._connections.get(normalized)
            if not sockets:
                return

        data = payload.get("data")
        revision = data.get("revision") if payload.get("type") == "state" and isinstance(data, dict) else None
        if isinstance(revision, int) and not isinstance(revision, bool):
            revision_key = (normalized, expected_instance_id)
            previous_revision = self._last_state_revision.get(revision_key)
            if previous_revision is not None and revision < previous_revision:
                return
            self._last_state_revision[revision_key] = revision

        dead: set[WebSocket] = set()
        for websocket in tuple(sockets):
            if not await self.send_json(
                normalized,
                websocket,
                payload,
                expected_instance_id=expected_instance_id,
            ):
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
