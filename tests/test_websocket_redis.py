import builtins
import json
from collections.abc import Generator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend import main as backend_main
from backend import websocket_handler
from backend.redis_contract import room_events_channel, room_state_key
from backend import room_service
from backend.room_store import RedisUnavailable, RoomStore


class FakePubSub:
    def __init__(self) -> None:
        self.subscribed: list[str] = []
        self.closed = False

    async def subscribe(self, *channels: str) -> bool:
        self.subscribed.extend(channels)
        return True

    async def listen(self):
        if False:
            yield {}

    async def aclose(self) -> None:
        self.closed = True


class FakeRedis:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.sets: dict[str, builtins.set[str]] = {}
        self.ttls: dict[str, int] = {}
        self.published: list[tuple[str, str]] = []
        self.fail_get = False
        self.fail_set = False

    async def get(self, name: str) -> str | None:
        if self.fail_get:
            raise ConnectionError("redis down")
        return self.values.get(name)

    async def set(self, name: str, value: str, ex: int | None = None, nx: bool = False) -> bool:
        if self.fail_set:
            raise ConnectionError("redis down")
        if nx and name in self.values:
            return False
        self.values[name] = value
        if ex is not None:
            self.ttls[name] = ex
        return True

    async def expire(self, name: str, time: int) -> bool:
        if name in self.values:
            self.ttls[name] = time
            return True
        return False

    async def delete(self, *names: str) -> int:
        deleted = 0
        for name in names:
            if name in self.values:
                deleted += 1
            self.values.pop(name, None)
            self.ttls.pop(name, None)
        return deleted

    async def sadd(self, name: str, *values: str) -> int:
        bucket = self.sets.setdefault(name, set())
        before = len(bucket)
        bucket.update(values)
        return len(bucket) - before

    async def srem(self, name: str, *values: str) -> int:
        bucket = self.sets.setdefault(name, set())
        before = len(bucket)
        bucket.difference_update(values)
        return before - len(bucket)

    async def smembers(self, name: str) -> builtins.set[str]:
        return set(self.sets.get(name, set()))

    async def scard(self, name: str) -> int:
        return len(self.sets.get(name, set()))

    async def ping(self) -> bool:
        return True

    async def incr(self, name: str) -> int:
        current = int(self.values.get(name, "0"))
        next_value = current + 1
        self.values[name] = str(next_value)
        return next_value

    async def publish(self, channel: str, message: str) -> int:
        self.published.append((channel, message))
        return 1

    def pubsub(self) -> FakePubSub:
        return FakePubSub()


@pytest.fixture
def websocket_client(monkeypatch: pytest.MonkeyPatch) -> Generator[tuple[TestClient, FakeRedis], None, None]:
    redis = FakeRedis()
    store = RoomStore(redis)
    monkeypatch.setattr(backend_main, "room_store", store)
    monkeypatch.setattr(backend_main, "event_bus", backend_main._build_event_bus())
    monkeypatch.setattr(backend_main, "rooms", {})
    monkeypatch.setattr(backend_main, "local_pin_hashes", {})
    monkeypatch.setattr(backend_main, "local_token_hashes", {})
    monkeypatch.setattr(backend_main, "local_room_instance_ids", {})
    monkeypatch.setattr(backend_main, "event_subscription_tasks", {})
    with TestClient(backend_main.app) as client:
        yield client, redis


def create_room(client: TestClient, room_id: str = "SYNC") -> str:
    response = client.post("/api/rooms", json={"room_id": room_id, "pin": "2468"})
    assert response.status_code == 200
    return str(response.json()["token"])


def test_valid_token_receives_initial_canonical_state(websocket_client: tuple[TestClient, FakeRedis]):
    client, _redis = websocket_client
    token = create_room(client, "SYNC")

    with client.websocket_connect(f"/ws/sync?token={token}") as websocket:
        initial = websocket.receive_json()

    assert initial["type"] == "state"
    assert initial["data"]["pomodoro_remaining"] == 3000


def test_missing_and_invalid_token_close_uniformly_without_room_leak(websocket_client: tuple[TestClient, FakeRedis]):
    client, _redis = websocket_client
    token = create_room(client, "KNOWN")

    failures = ["/ws/KNOWN", "/ws/KNOWN?token=bad", f"/ws/MISSING?token={token}"]
    for path in failures:
        with pytest.raises(WebSocketDisconnect) as closed:
            with client.websocket_connect(path) as websocket:
                websocket.receive_text()
        assert closed.value.code == backend_main.WS_AUTH_CLOSE_CODE
        assert closed.value.reason == backend_main.WS_AUTH_CLOSE_REASON


def test_inbound_message_updates_redis_and_publishes_full_state_snapshot(websocket_client: tuple[TestClient, FakeRedis]):
    client, redis = websocket_client
    token = create_room(client, "SYNC")

    with client.websocket_connect(f"/ws/SYNC?token={token}") as websocket:
        websocket.receive_json()
        websocket.send_json({"type": "focus_toggle"})
        update = websocket.receive_json()

    stored = json.loads(redis.values[room_state_key("SYNC")])
    channel, payload = redis.published[-1]
    envelope = json.loads(payload)
    assert update["type"] == "state"
    assert update["data"]["focus"] is True
    assert stored["focus"] is True
    assert channel == room_events_channel("SYNC")
    assert envelope["type"] == "state_snapshot"
    assert set(envelope["data"]) == set(stored)
    assert envelope["data"] == stored


def test_two_clients_receive_broadcast_state_snapshot(websocket_client: tuple[TestClient, FakeRedis]):
    client, _redis = websocket_client
    token_a = create_room(client, "FANOUT")
    joined = client.post("/api/rooms/FANOUT/join", json={"pin": "2468"})
    assert joined.status_code == 200
    token_b = str(joined.json()["token"])

    with client.websocket_connect(f"/ws/FANOUT?token={token_a}") as ws_a:
        with client.websocket_connect(f"/ws/FANOUT?token={token_b}") as ws_b:
            ws_a.receive_json()
            ws_b.receive_json()

            ws_a.send_json({"type": "focus_toggle"})

            update_a = ws_a.receive_json()
            update_b = ws_b.receive_json()
            if update_a["data"]["focus"] is False:
                update_a = ws_a.receive_json()
            if update_b["data"]["focus"] is False:
                update_b = ws_b.receive_json()

    assert update_a["type"] == "state"
    assert update_b["type"] == "state"
    assert update_a["data"]["focus"] is True
    assert update_b["data"]["focus"] is True
    assert update_a["data"] == update_b["data"]


def test_mid_session_redis_outage_closes_and_reconnect_recovers(websocket_client: tuple[TestClient, FakeRedis]):
    client, redis = websocket_client
    token = create_room(client, "DROP")

    with pytest.raises(WebSocketDisconnect) as closed:
        with client.websocket_connect(f"/ws/DROP?token={token}") as websocket:
            initial = websocket.receive_json()
            assert initial["data"]["focus"] is False
            redis.fail_get = True
            websocket.send_json({"type": "focus_toggle"})
            websocket.receive_text()

    assert closed.value.code == backend_main.WS_OPERATIONAL_CLOSE_CODE
    assert closed.value.reason == backend_main.WS_OPERATIONAL_CLOSE_REASON

    redis.fail_get = False
    state = json.loads(redis.values[room_state_key("DROP")])
    state["music"]["playing"] = True
    redis.values[room_state_key("DROP")] = json.dumps(state, separators=(",", ":"))

    with client.websocket_connect(f"/ws/DROP?token={token}") as websocket:
        recovered = websocket.receive_json()

    assert recovered["type"] == "state"
    assert recovered["data"]["music"]["playing"] is True


def test_ensure_room_events_redis_unavailable_closes_1011(
    websocket_client: tuple[TestClient, FakeRedis],
    monkeypatch: pytest.MonkeyPatch,
):
    client, _redis = websocket_client
    token = create_room(client, "EVENTDOWN")

    async def unavailable(_room_id: str) -> None:
        raise RedisUnavailable("Redis is unavailable")

    monkeypatch.setattr(websocket_handler, "ensure_room_events", unavailable)

    with pytest.raises(WebSocketDisconnect) as closed:
        with client.websocket_connect(f"/ws/EVENTDOWN?token={token}") as websocket:
            websocket.receive_text()

    assert closed.value.code == backend_main.WS_OPERATIONAL_CLOSE_CODE
    assert closed.value.reason == backend_main.WS_OPERATIONAL_CLOSE_REASON


def test_startup_redis_outage_fails_closed_in_required_runtime(monkeypatch: pytest.MonkeyPatch):
    async def unavailable_store():
        raise RedisUnavailable("Redis is unavailable")

    monkeypatch.setattr(backend_main, "room_store", None)
    monkeypatch.setattr(room_service.config, "is_test_mode", lambda: False)
    monkeypatch.setattr(room_service, "create_redis_store", unavailable_store)

    with pytest.raises(RedisUnavailable):
        import asyncio

        asyncio.run(room_service.initialize_store_and_events())
