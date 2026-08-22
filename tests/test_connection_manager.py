import asyncio
import json
from typing import cast

from fastapi import WebSocket

from backend.connection_manager import LocalConnectionManager, contains_live_websocket


class DummyWebSocket:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.messages: list[str] = []

    async def send_text(self, message: str) -> None:
        if self.fail:
            raise RuntimeError("closed")
        self.messages.append(message)


def test_connections_are_normalized_and_local_to_manager():
    manager = LocalConnectionManager()
    websocket = cast(WebSocket, DummyWebSocket())

    manager.connect(" room-a ", websocket)

    assert manager.room_ids() == ("ROOM-A",)
    assert manager.has_connections("room-a") is True
    assert manager.connections_for("ROOM-A") == frozenset({websocket})
    assert contains_live_websocket(manager.connections_for("ROOM-A")) is True


def test_broadcast_json_sends_to_local_sockets_only_and_removes_dead_sockets():
    manager = LocalConnectionManager()
    live = DummyWebSocket()
    dead = DummyWebSocket(fail=True)
    manager.connect("room-a", cast(WebSocket, live))
    manager.connect("room-a", cast(WebSocket, dead))

    async def run() -> None:
        await manager.broadcast_json("ROOM-A", {"type": "state", "data": {"focus": True}})

    asyncio.run(run())

    assert [json.loads(message) for message in live.messages] == [{"type": "state", "data": {"focus": True}}]
    assert manager.connections_for("room-a") == frozenset({cast(WebSocket, live)})


def test_disconnect_reports_when_room_becomes_empty():
    manager = LocalConnectionManager()
    first = cast(WebSocket, DummyWebSocket())
    second = cast(WebSocket, DummyWebSocket())
    manager.connect("room-a", first)
    manager.connect("room-a", second)

    assert manager.disconnect("room-a", first) is False
    assert manager.has_connections("room-a") is True
    assert manager.disconnect("room-a", second) is True
    assert manager.has_connections("room-a") is False
    assert manager.room_ids() == ()


def test_json_payloads_do_not_contain_websocket_objects():
    manager = LocalConnectionManager()
    websocket = cast(WebSocket, DummyWebSocket())
    manager.connect("room-a", websocket)
    payload = {"type": "state", "data": {"room_id": "ROOM-A"}}

    assert contains_live_websocket(payload) is False
    assert contains_live_websocket(websocket) is True
    assert "DummyWebSocket" not in json.dumps(payload)
