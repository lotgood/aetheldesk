import asyncio
import json
from typing import cast

from fastapi import WebSocket

from backend.connection_manager import LocalConnectionManager, contains_live_websocket


class DummyWebSocket:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.messages: list[str] = []
        self.closed: list[tuple[int, str]] = []

    async def send_text(self, message: str) -> None:
        if self.fail:
            raise RuntimeError("closed")
        self.messages.append(message)

    async def close(self, *, code: int, reason: str) -> None:
        self.closed.append((code, reason))


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


def test_state_broadcast_never_regresses_below_noted_revision():
    manager = LocalConnectionManager()
    websocket = DummyWebSocket()
    manager.connect("room-a", cast(WebSocket, websocket))
    manager.note_state_revision("room-a", 4)

    async def run() -> None:
        await manager.broadcast_json("room-a", {"type": "state", "data": {"revision": 3}})
        await manager.broadcast_json("room-a", {"type": "state", "data": {"revision": 5}})
        await manager.broadcast_json("room-a", {"type": "state", "data": {"revision": 4}})

    asyncio.run(run())

    assert [json.loads(message)["data"]["revision"] for message in websocket.messages] == [5]

    assert manager.disconnect("room-a", cast(WebSocket, websocket)) is True
    replacement = DummyWebSocket()
    manager.connect("room-a", cast(WebSocket, replacement))
    asyncio.run(manager.broadcast_json("room-a", {"type": "state", "data": {"revision": 0}}))
    assert json.loads(replacement.messages[0])["data"]["revision"] == 0


def test_json_payloads_do_not_contain_websocket_objects():
    manager = LocalConnectionManager()
    websocket = cast(WebSocket, DummyWebSocket())
    manager.connect("room-a", websocket)
    payload = {"type": "state", "data": {"room_id": "ROOM-A"}}

    assert contains_live_websocket(payload) is False
    assert contains_live_websocket(websocket) is True
    assert "DummyWebSocket" not in json.dumps(payload)


def test_generation_bound_broadcast_closes_old_socket_without_leaking_new_state():
    manager = LocalConnectionManager()
    old_socket = DummyWebSocket()
    new_socket = DummyWebSocket()
    manager.connect("room-a", cast(WebSocket, old_socket), "old-generation")
    manager.connect("room-a", cast(WebSocket, new_socket), "new-generation")
    manager.note_state_revision("room-a", 9, "old-generation")

    asyncio.run(
        manager.broadcast_json(
            "room-a",
            {"type": "state", "data": {"revision": 0, "focus": False}},
            expected_instance_id="new-generation",
        )
    )

    assert old_socket.messages == []
    assert old_socket.closed == [(1008, "authentication failed")]
    assert [json.loads(message)["data"]["revision"] for message in new_socket.messages] == [0]
    assert manager.connections_for("room-a") == frozenset({cast(WebSocket, new_socket)})
    assert manager.room_instance_id_for("room-a", cast(WebSocket, new_socket)) == "new-generation"


def test_targeted_initial_send_prunes_old_generation_without_notifying_existing_current_socket():
    manager = LocalConnectionManager()
    old_socket = DummyWebSocket()
    existing_current_socket = DummyWebSocket()
    joining_socket = DummyWebSocket()
    manager.connect("room-a", cast(WebSocket, old_socket), "old-generation")
    manager.connect("room-a", cast(WebSocket, existing_current_socket), "new-generation")
    manager.connect("room-a", cast(WebSocket, joining_socket), "new-generation")

    async def run() -> None:
        await manager.close_mismatched_generations("room-a", "new-generation")
        assert await manager.send_json(
            "room-a",
            cast(WebSocket, joining_socket),
            {"type": "state", "data": {"revision": 0, "focus": False}},
            expected_instance_id="new-generation",
        )

    asyncio.run(run())

    assert old_socket.messages == []
    assert old_socket.closed == [(1008, "authentication failed")]
    assert existing_current_socket.messages == []
    assert [json.loads(message)["data"]["revision"] for message in joining_socket.messages] == [0]


def test_targeted_initial_send_is_single_socket_and_cannot_regress_a_racing_broadcast():
    manager = LocalConnectionManager()
    existing_socket = DummyWebSocket()
    joining_socket = DummyWebSocket()
    manager.connect("room-a", cast(WebSocket, existing_socket), "generation-a")
    manager.connect("room-a", cast(WebSocket, joining_socket), "generation-a")

    async def run() -> None:
        assert await manager.send_json(
            "room-a",
            cast(WebSocket, existing_socket),
            {"type": "state", "data": {"revision": 0, "focus": False}},
            expected_instance_id="generation-a",
        )
        await manager.broadcast_json(
            "room-a",
            {"type": "state", "data": {"revision": 1, "focus": True}},
            expected_instance_id="generation-a",
        )
        assert await manager.send_json(
            "room-a",
            cast(WebSocket, joining_socket),
            {"type": "state", "data": {"revision": 0, "focus": False}},
            expected_instance_id="generation-a",
        )
        assert await manager.send_json(
            "room-a",
            cast(WebSocket, joining_socket),
            {"type": "state", "data": {"revision": 1, "focus": True}},
            expected_instance_id="generation-a",
        )

    asyncio.run(run())

    assert [json.loads(message)["data"]["revision"] for message in existing_socket.messages] == [0, 1]
    assert [json.loads(message)["data"]["revision"] for message in joining_socket.messages] == [1]
