import asyncio
import importlib
import json
import builtins
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend import auth
from backend.redis_contract import room_metadata_key, room_state_key

room_store_module = importlib.import_module("backend.room_store")
RoomStore = getattr(room_store_module, "RoomStore")


class FakeRedis:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.sets: dict[str, builtins.set[str]] = {}
        self.ttls: dict[str, int] = {}
        self.recreate_before_issue: tuple[str, str] | None = None

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
        deleted = 0
        for name in names:
            if name in self.values or name in self.sets:
                deleted += 1
            self.values.pop(name, None)
            self.sets.pop(name, None)
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

    async def sismember(self, name: str, value: str) -> bool:
        return value in self.sets.get(name, set())

    async def scard(self, name: str) -> int:
        return len(self.sets.get(name, set()))

    async def ping(self) -> bool:
        return True

    async def incr(self, name: str) -> int:
        current = int(self.values.get(name, "0"))
        next_value = current + 1
        self.values[name] = str(next_value)
        return next_value

    async def eval(self, script: str, numkeys: int, *keys_and_args: object) -> object:
        if numkeys == 5 and "AETHEL_CREATE_ROOM" in script:
            (
                index_key,
                state_key,
                metadata_key,
                token_index_key,
                tick_lock_key,
                room_id,
                encoded_state,
                encoded_metadata,
                ttl,
                max_rooms,
            ) = (str(value) for value in keys_and_args)
            if state_key in self.values or metadata_key in self.values:
                return -1
            rooms = self.sets.setdefault(index_key, set())
            rooms.discard(room_id)
            if len(rooms) >= int(max_rooms):
                return -2
            self.sets.pop(token_index_key, None)
            self.values.pop(tick_lock_key, None)
            self.ttls.pop(tick_lock_key, None)
            self.values[state_key] = encoded_state
            self.values[metadata_key] = encoded_metadata
            self.ttls[state_key] = int(ttl)
            self.ttls[metadata_key] = int(ttl)
            rooms.add(room_id)
            return 1
        if numkeys == 4 and "AETHEL_AUTHORIZE_ROOM_TOKEN" in script:
            metadata_key, state_key, token_index_key, legacy_key, expected, token_hash, room_id, ttl, limit = (
                str(value) for value in keys_and_args
            )
            encoded_metadata = self.values.get(metadata_key)
            encoded_state = self.values.get(state_key)
            if encoded_metadata is None or encoded_state is None:
                return None
            if json.loads(encoded_metadata).get("room_instance_id") != expected:
                return None
            tokens = self.sets.setdefault(token_index_key, set())
            if token_hash not in tokens:
                if self.values.get(legacy_key) != room_id:
                    return None
                if len(tokens) >= int(limit):
                    return None
                tokens.add(token_hash)
                await self.delete(legacy_key)
            self.ttls[state_key] = int(ttl)
            self.ttls[metadata_key] = int(ttl)
            self.ttls[token_index_key] = int(ttl)
            return encoded_state
        if numkeys == 3 and "AETHEL_ISSUE_ROOM_TOKEN" in script:
            metadata_key, state_key, token_index_key, expected, token_hash, limit, ttl = (
                str(value) for value in keys_and_args
            )
            if self.recreate_before_issue is not None:
                encoded_state, encoded_metadata = self.recreate_before_issue
                self.recreate_before_issue = None
                self.values[state_key] = encoded_state
                self.values[metadata_key] = encoded_metadata
                self.sets[token_index_key] = set()
            encoded_metadata = self.values.get(metadata_key)
            if encoded_metadata is None or state_key not in self.values:
                return -1
            if json.loads(encoded_metadata).get("room_instance_id") != expected:
                return -1
            tokens = self.sets.setdefault(token_index_key, set())
            if token_hash not in tokens and len(tokens) >= int(limit):
                return -2
            tokens.add(token_hash)
            self.ttls[state_key] = int(ttl)
            self.ttls[metadata_key] = int(ttl)
            self.ttls[token_index_key] = int(ttl)
            return 1
        if numkeys == 3 and "EXPIRE" in script:
            state_key, metadata_key, token_index_key, ttl = (str(value) for value in keys_and_args)
            if state_key not in self.values or metadata_key not in self.values:
                return 0
            self.ttls[state_key] = int(ttl)
            self.ttls[metadata_key] = int(ttl)
            if token_index_key in self.sets:
                self.ttls[token_index_key] = int(ttl)
            return 1
        if numkeys == 1 and "SCARD" in script:
            token_index_key, token_hash, limit, ttl = (str(value) for value in keys_and_args)
            tokens = self.sets.setdefault(token_index_key, set())
            if token_hash not in tokens and len(tokens) >= int(limit):
                return 0
            tokens.add(token_hash)
            self.ttls[token_index_key] = int(ttl)
            return 1
        raise AssertionError(f"unexpected eval arguments: {keys_and_args!r}")


@pytest.fixture
def room_store_fixture(monkeypatch: pytest.MonkeyPatch) -> tuple[Any, FakeRedis]:
    from backend import main as backend_main

    redis = FakeRedis()
    store = RoomStore(redis)
    monkeypatch.setattr(backend_main, "room_store", store)
    monkeypatch.setattr(backend_main, "rooms", {})
    monkeypatch.setattr(backend_main, "local_pin_hashes", {})
    monkeypatch.setattr(backend_main, "local_token_hashes", {})
    monkeypatch.setattr(backend_main, "local_room_instance_ids", {})
    monkeypatch.setattr(backend_main, "event_subscription_tasks", {})
    monkeypatch.setattr(backend_main, "event_subscription_ready", {})
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


def test_create_room_does_not_overwrite_state_when_metadata_is_missing(
    room_store_fixture: tuple[Any, FakeRedis],
):
    backend_main, redis = room_store_fixture

    with TestClient(backend_main.app) as client:
        created = client.post("/api/rooms", json={"room_id": "SKEW", "pin": "2468"})
        assert created.status_code == 200
        state_key = room_state_key("SKEW")
        original_state = redis.values[state_key]
        redis.values.pop(room_metadata_key("SKEW"))

        recreated = client.post("/api/rooms", json={"room_id": "SKEW", "pin": "9999"})

    assert recreated.status_code == 401
    assert recreated.json() == {"detail": "authentication failed"}
    assert redis.values[state_key] == original_state


def test_create_and_join_fail_closed_when_state_is_missing_but_metadata_exists(
    room_store_fixture: tuple[Any, FakeRedis],
):
    backend_main, redis = room_store_fixture

    with TestClient(backend_main.app) as client:
        created = client.post("/api/rooms", json={"room_id": "METASK", "pin": "2468"})
        assert created.status_code == 200
        redis.values.pop(room_state_key("METASK"))

        recreated = client.post("/api/rooms", json={"room_id": "METASK", "pin": "2468"})
        joined = client.post("/api/rooms/METASK/join", json={"pin": "2468"})

    assert recreated.status_code == 401
    assert recreated.json() == {"detail": "authentication failed"}
    assert "token" not in recreated.json()
    assert joined.status_code == 401
    assert joined.json() == {"detail": "authentication failed"}
    assert "token" not in joined.json()


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
        assert missing.value.code == 1008

        with pytest.raises(WebSocketDisconnect) as invalid:
            with client.websocket_connect("/ws/WSOK?token=bad-token") as websocket:
                websocket.receive_text()
        assert invalid.value.code == backend_main.WS_AUTH_CLOSE_CODE
        assert invalid.value.code == 1008


def test_recreated_redis_room_rejects_token_from_previous_instance(room_store_fixture: tuple[Any, FakeRedis]):
    backend_main, _redis = room_store_fixture

    with TestClient(backend_main.app) as client:
        created = client.post("/api/rooms", json={"room_id": "REUSE", "pin": "2468"})
        assert created.status_code == 200
        stale_token = created.json()["token"]

        expired = asyncio.run(backend_main.room_store.expire_empty_room("REUSE", has_connections=False))
        assert expired is True

        recreated = client.post("/api/rooms", json={"room_id": "REUSE", "pin": "9999"})
        assert recreated.status_code == 200
        current_token = recreated.json()["token"]

        with pytest.raises(WebSocketDisconnect) as stale_close:
            with client.websocket_connect(f"/ws/REUSE?token={stale_token}") as websocket:
                websocket.receive_text()
        assert stale_close.value.code == backend_main.WS_AUTH_CLOSE_CODE
        assert stale_close.value.reason == backend_main.WS_AUTH_CLOSE_REASON

        with client.websocket_connect(f"/ws/REUSE?token={current_token}") as websocket:
            payload = websocket.receive_json()
        assert payload["type"] == "state"


@pytest.mark.parametrize("route_kind", ["join", "existing-create"])
def test_pin_verified_for_old_generation_cannot_issue_new_generation_token(
    room_store_fixture: tuple[Any, FakeRedis],
    route_kind: str,
):
    backend_main, redis = room_store_fixture

    with TestClient(backend_main.app) as client:
        created = client.post("/api/rooms", json={"room_id": "PINRACE", "pin": "2468"})
        assert created.status_code == 200

        new_state = backend_main.make_state()
        new_metadata = {
            "room_id": "PINRACE",
            "pin_hash": auth.hash_pin("9999"),
            "room_instance_id": "new-generation",
        }
        redis.recreate_before_issue = (
            json.dumps(new_state, separators=(",", ":")),
            json.dumps(new_metadata, separators=(",", ":")),
        )

        if route_kind == "join":
            raced = client.post("/api/rooms/PINRACE/join", json={"pin": "2468"})
        else:
            raced = client.post("/api/rooms", json={"room_id": "PINRACE", "pin": "2468"})

        assert raced.status_code == 401
        assert raced.json() == {"detail": "authentication failed"}
        assert "token" not in raced.json()

        current = client.post("/api/rooms/PINRACE/join", json={"pin": "9999"})
        assert current.status_code == 200
        assert current.json()["token"]
