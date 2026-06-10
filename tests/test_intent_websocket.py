import builtins
import json
from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient

from backend import main as backend_main
from backend.redis_contract import room_state_key
from backend.room_store import RoomStore


class FakePubSub:
    async def subscribe(self, *channels: str) -> bool:
        return bool(channels)

    async def listen(self):
        if False:
            yield {}

    async def aclose(self) -> None:
        return None


class FakeRedis:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.sets: dict[str, builtins.set[str]] = {}
        self.ttls: dict[str, int] = {}
        self.published: list[tuple[str, str]] = []

    async def get(self, name: str) -> str | None:
        return self.values.get(name)

    async def set(self, name: str, value: str, ex: int | None = None, nx: bool = False) -> bool:
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
        for name in names:
            self.values.pop(name, None)
            self.ttls.pop(name, None)
        return len(names)

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
        self.values[name] = str(current + 1)
        return current + 1

    async def publish(self, channel: str, message: str) -> int:
        self.published.append((channel, message))
        return 1

    def pubsub(self) -> FakePubSub:
        return FakePubSub()


@pytest.fixture
def intent_websocket_client(monkeypatch: pytest.MonkeyPatch) -> Generator[tuple[TestClient, FakeRedis], None, None]:
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


def create_room(client: TestClient, room_id: str) -> str:
    response = client.post("/api/rooms", json={"room_id": room_id, "pin": "2468"})
    assert response.status_code == 200
    return str(response.json()["token"])


def receive_selected_intent_snapshot(websocket) -> dict[str, object]:
    for _ in range(6):
        update = websocket.receive_json()
        data = update["data"]
        assert isinstance(data, dict)
        intent = data.get("intent")
        assert isinstance(intent, dict)
        if intent.get("active_task_id") == "task_001":
            return update
    pytest.fail("selected intent task snapshot was not received")


def test_intent_commands_fan_out_as_full_state_snapshots(
    intent_websocket_client: tuple[TestClient, FakeRedis],
):
    client, redis = intent_websocket_client
    token_a = create_room(client, "INTENT")
    joined = client.post("/api/rooms/INTENT/join", json={"pin": "2468"})
    assert joined.status_code == 200
    token_b = str(joined.json()["token"])

    with client.websocket_connect(f"/ws/INTENT?token={token_a}") as ws_a:
        with client.websocket_connect(f"/ws/INTENT?token={token_b}") as ws_b:
            ws_a.receive_json()
            ws_b.receive_json()
            ws_a.send_json({"type": "intent_set_goal", "goal": "문서 정리"})
            ws_a.send_json({"type": "intent_add_task", "id": "task_001", "text": "초안 작성"})
            ws_a.send_json({"type": "intent_select_task", "id": "task_001"})
            update_a = receive_selected_intent_snapshot(ws_a)
            update_b = receive_selected_intent_snapshot(ws_b)

    stored = json.loads(redis.values[room_state_key("INTENT")])
    data_a = update_a["data"]
    data_b = update_b["data"]
    assert isinstance(data_a, dict)
    assert isinstance(data_b, dict)
    assert update_a["type"] == "state"
    assert update_b["type"] == "state"
    assert data_a == data_b
    assert stored["intent"] == data_a["intent"]
    assert stored["intent"]["goal"] == "문서 정리"
    assert stored["intent"]["tasks"] == [{"id": "task_001", "text": "초안 작성", "done": False}]
    assert stored["intent"]["active_task_id"] == "task_001"
