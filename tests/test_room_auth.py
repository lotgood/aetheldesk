import importlib
import json
import builtins
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend import auth

room_store_module = importlib.import_module("backend.room_store")
RoomStore = getattr(room_store_module, "RoomStore")


class FakeRedis:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.sets: dict[str, builtins.set[str]] = {}
        self.ttls: dict[str, int] = {}

    async def get(self, name: str) -> str | None:
        return self.values.get(name)

    async def set(self, name: str, value: str, ex: int | None = None) -> bool:
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


@pytest.fixture
def room_store_fixture(monkeypatch: pytest.MonkeyPatch) -> tuple[Any, FakeRedis]:
    from backend import main as backend_main

    redis = FakeRedis()
    store = RoomStore(redis)
    monkeypatch.setattr(backend_main, "room_store", store)
    monkeypatch.setattr(backend_main, "rooms", {})
    return backend_main, redis


def test_auth_hashes_and_verifies_pin_and_token_without_plaintext_echo():
    pin_hash = auth.hash_pin("1234")
    assert pin_hash != "1234"
    assert auth.verify_pin("1234", pin_hash) is True
    assert auth.verify_pin("9999", pin_hash) is False

    token = auth.create_token()
    token_hash = auth.hash_token(token)
    assert token_hash != token
    assert auth.hash_token(token) == token_hash


def test_create_room_and_join_never_return_or_store_plaintext_pin(room_store_fixture: tuple[Any, FakeRedis]):
    backend_main, redis = room_store_fixture

    with TestClient(backend_main.app) as client:
        created = client.post("/api/rooms", json={"room_id": "ABCD", "pin": "2468"})
        assert created.status_code == 200
        created_payload = created.json()
        assert created_payload["room_id"] == "ABCD"
        assert "pin" not in created_payload
        assert created_payload["token"]

        joined = client.post("/api/rooms/ABCD/join", json={"pin": "2468"})
        assert joined.status_code == 200
        join_payload = joined.json()
        assert "pin" not in join_payload
        assert join_payload["token"]

    for key, value in redis.values.items():
        assert "2468" not in key
        assert "2468" not in value
        if key.endswith(":meta") or key.endswith(":state"):
            assert json.loads(value)


def test_wrong_room_and_wrong_pin_return_same_failure_shape(room_store_fixture: tuple[Any, FakeRedis]):
    backend_main, _redis = room_store_fixture

    with TestClient(backend_main.app) as client:
        _ = client.post("/api/rooms", json={"room_id": "ABCD", "pin": "2468"})

        wrong_pin = client.post("/api/rooms/ABCD/join", json={"pin": "9999"})
        wrong_room = client.post("/api/rooms/ZZZZ/join", json={"pin": "2468"})

        assert wrong_pin.status_code == 401
        assert wrong_room.status_code == 401
        assert wrong_pin.json() == wrong_room.json() == {"detail": "authentication failed"}


def test_rate_limit_blocks_after_five_failed_attempts(room_store_fixture: tuple[Any, FakeRedis]):
    backend_main, redis = room_store_fixture

    with TestClient(backend_main.app) as client:
        _ = client.post("/api/rooms", json={"room_id": "RATE", "pin": "2468"})
        for _ in range(4):
            response = client.post("/api/rooms/RATE/join", json={"pin": "1111"})
            assert response.status_code == 401
            assert response.json() == {"detail": "authentication failed"}

        fifth = client.post("/api/rooms/RATE/join", json={"pin": "1111"})
        assert fifth.status_code == 403
        assert fifth.json() == {"detail": "authentication failed"}

        blocked = client.post("/api/rooms/RATE/join", json={"pin": "2468"})
        assert blocked.status_code == 403
        assert blocked.json() == {"detail": "authentication failed"}

    attempt_keys = [k for k in redis.ttls if ":pin-attempts:" in k]
    block_keys = [k for k in redis.ttls if ":pin-block:" in k]
    assert attempt_keys
    assert block_keys
    assert redis.ttls[attempt_keys[0]] == 300
    assert redis.ttls[block_keys[0]] == 600


def test_websocket_requires_valid_token(room_store_fixture: tuple[Any, FakeRedis]):
    backend_main, _redis = room_store_fixture

    with TestClient(backend_main.app) as client:
        create = client.post("/api/rooms", json={"room_id": "WSOK", "pin": "2468"})
        token = create.json()["token"]

        with client.websocket_connect(f"/ws/WSOK?token={token}") as websocket:
            payload = websocket.receive_json()
            assert payload["type"] == "state"

        with pytest.raises(WebSocketDisconnect) as missing:
            with client.websocket_connect("/ws/WSOK") as websocket:
                websocket.receive_text()
        assert missing.value.code == backend_main.WS_AUTH_CLOSE_CODE

        with pytest.raises(WebSocketDisconnect) as invalid:
            with client.websocket_connect("/ws/WSOK?token=bad-token") as websocket:
                websocket.receive_text()
        assert invalid.value.code == backend_main.WS_AUTH_CLOSE_CODE
