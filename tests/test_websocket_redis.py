import builtins
import asyncio
import json
from collections.abc import Generator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend import main as backend_main
from backend import websocket_handler
from backend.redis_contract import (
    room_events_channel,
    room_metadata_key,
    room_state_key,
    room_token_index_key,
)
from backend import room_service
from backend.room_store import ROOM_INDEX_KEY, RedisUnavailable, RoomStore


class FakePubSub:
    def __init__(self, redis: "FakeRedis") -> None:
        self.redis = redis
        self.subscribed: list[str] = []
        self.closed = False

    async def subscribe(self, *channels: str) -> bool:
        if self.redis.fail_subscribe:
            raise ConnectionError("redis subscribe down")
        self.subscribed.extend(channels)
        return True

    async def listen(self):
        while not self.closed:
            if self.redis.fail_listen:
                raise ConnectionError("redis listen down")
            await asyncio.sleep(0.01)
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
        self.fail_subscribe = False
        self.fail_listen = False
        self.pubsub_instances: list[FakePubSub] = []
        self.now_seconds = 1

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
        if self.fail_get and "AETHEL_GET_ROOM_SNAPSHOT" in script:
            raise ConnectionError("redis down")
        if self.fail_set and "AETHEL_COMPARE_AND_SET_STATE" in script:
            raise ConnectionError("redis down")
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
        if numkeys == 0:
            return self.now_seconds
        if numkeys == 2 and "AETHEL_GET_ROOM_SNAPSHOT" in script:
            state_key, metadata_key = (str(value) for value in keys_and_args)
            encoded_state = self.values.get(state_key)
            encoded_metadata = self.values.get(metadata_key)
            if encoded_state is None or encoded_metadata is None:
                return None
            room_instance_id = json.loads(encoded_metadata).get("room_instance_id")
            if not isinstance(room_instance_id, str) or not room_instance_id:
                return None
            return [encoded_state, room_instance_id]
        if numkeys == 3 and "AETHEL_COMPARE_AND_SET_STATE" in script:
            state_key, metadata_key, token_index_key, expected_revision, expected_instance_id, encoded_state, ttl = (
                str(value) for value in keys_and_args
            )
            current_state = self.values.get(state_key)
            encoded_metadata = self.values.get(metadata_key)
            if current_state is None or encoded_metadata is None:
                return -1
            if json.loads(encoded_metadata).get("room_instance_id") != expected_instance_id:
                return -1
            if int(json.loads(current_state).get("revision", 0)) != int(expected_revision):
                return 0
            self.values[state_key] = encoded_state
            self.ttls[state_key] = int(ttl)
            self.ttls[metadata_key] = int(ttl)
            if token_index_key in self.sets:
                self.ttls[token_index_key] = int(ttl)
            return 1
        if numkeys == 3 and "AETHEL_REFRESH_ROOM_TTL" in script:
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

    async def publish(self, channel: str, message: str) -> int:
        self.published.append((channel, message))
        return 1

    def pubsub(self) -> FakePubSub:
        pubsub = FakePubSub(self)
        self.pubsub_instances.append(pubsub)
        return pubsub


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
    monkeypatch.setattr(backend_main, "event_subscription_ready", {})
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


def test_inbound_message_updates_redis_and_publishes_full_state_snapshot(
    websocket_client: tuple[TestClient, FakeRedis],
):
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


def test_retired_or_unknown_message_does_not_change_revision_before_real_mutation(
    websocket_client: tuple[TestClient, FakeRedis],
):
    client, redis = websocket_client
    token = create_room(client, "NOOP")

    with client.websocket_connect(f"/ws/NOOP?token={token}") as websocket:
        initial = websocket.receive_json()
        websocket.send_json({"type": "music_play"})
        websocket.send_json({"type": "focus_toggle"})
        update = websocket.receive_json()

    stored = json.loads(redis.values[room_state_key("NOOP")])
    assert initial["data"]["revision"] == 0
    assert update["data"]["revision"] == 1
    assert stored["revision"] == 1
    assert stored["focus"] is True


def test_non_object_json_payload_is_ignored_before_next_valid_mutation(
    websocket_client: tuple[TestClient, FakeRedis],
):
    client, _redis = websocket_client
    token = create_room(client, "SHAPE")

    with client.websocket_connect(f"/ws/SHAPE?token={token}") as websocket:
        initial = websocket.receive_json()
        websocket.send_text("[]")
        websocket.send_json({"type": "focus_toggle"})
        updated = websocket.receive_json()

    assert initial["data"]["revision"] == 0
    assert updated["data"]["revision"] == 1
    assert updated["data"]["focus"] is True


def test_pause_reconciles_elapsed_redis_time_before_freezing_focus(
    websocket_client: tuple[TestClient, FakeRedis],
):
    client, redis = websocket_client
    token = create_room(client, "PAUSEGAP")

    with client.websocket_connect(f"/ws/PAUSEGAP?token={token}") as websocket:
        websocket.receive_json()
        websocket.send_json({"type": "focus_toggle"})
        started = websocket.receive_json()
        redis.now_seconds = 11
        websocket.send_json({"type": "focus_pause"})
        paused = websocket.receive_json()

    assert started["data"]["last_tick_slot"] == 1
    assert paused["data"]["paused"] is True
    assert paused["data"]["pomodoro_remaining"] == 2990
    assert paused["data"]["last_tick_slot"] is None
    assert paused["data"]["revision"] == 2


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

    assert update_a["type"] == "state"
    assert update_b["type"] == "state"
    assert update_a["data"]["focus"] is True
    assert update_b["data"]["focus"] is True
    assert update_a["data"] == update_b["data"]


def test_recreated_room_generation_closes_old_socket_and_never_leaks_new_state(
    websocket_client: tuple[TestClient, FakeRedis],
):
    client, redis = websocket_client
    old_token = create_room(client, "REBORN")

    with client.websocket_connect(f"/ws/REBORN?token={old_token}") as old_websocket:
        old_initial = old_websocket.receive_json()
        assert old_initial["data"]["revision"] == 0

        redis.values.pop(room_state_key("REBORN"), None)
        redis.values.pop(room_metadata_key("REBORN"), None)
        redis.sets.pop(room_token_index_key("REBORN"), None)
        redis.sets.setdefault(ROOM_INDEX_KEY, set()).discard("REBORN")

        replacement = client.post("/api/rooms", json={"room_id": "REBORN", "pin": "8642"})
        assert replacement.status_code == 200
        new_token = str(replacement.json()["token"])

        with client.websocket_connect(f"/ws/REBORN?token={new_token}") as new_websocket:
            new_initial = new_websocket.receive_json()
            assert new_initial["data"]["revision"] == 0
            assert new_initial["data"]["focus"] is False

            with pytest.raises(WebSocketDisconnect) as old_closed:
                old_websocket.receive_text()
            assert old_closed.value.code == backend_main.WS_AUTH_CLOSE_CODE
            assert old_closed.value.reason == backend_main.WS_AUTH_CLOSE_REASON

            new_websocket.send_json({"type": "focus_toggle"})
            new_update = new_websocket.receive_json()

    assert new_update["data"]["focus"] is True
    assert new_update["data"]["revision"] == 1
    stored = json.loads(redis.values[room_state_key("REBORN")])
    assert stored["focus"] is True
    assert stored["revision"] == 1


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
    state["reward_id"] = 7
    redis.values[room_state_key("DROP")] = json.dumps(state, separators=(",", ":"))

    with client.websocket_connect(f"/ws/DROP?token={token}") as websocket:
        recovered = websocket.receive_json()

    assert recovered["type"] == "state"
    assert recovered["data"]["reward_id"] == 7


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


def test_real_subscribe_failure_is_normalized_and_closes_1011(
    websocket_client: tuple[TestClient, FakeRedis],
):
    client, redis = websocket_client
    token = create_room(client, "SUBDOWN")
    redis.fail_subscribe = True

    with pytest.raises(WebSocketDisconnect) as closed:
        with client.websocket_connect(f"/ws/SUBDOWN?token={token}") as websocket:
            websocket.receive_text()

    assert closed.value.code == backend_main.WS_OPERATIONAL_CLOSE_CODE
    assert closed.value.reason == backend_main.WS_OPERATIONAL_CLOSE_REASON
    assert redis.pubsub_instances[-1].closed is True


def test_consumer_failure_after_ready_closes_existing_socket_for_reconnect(
    websocket_client: tuple[TestClient, FakeRedis],
):
    client, redis = websocket_client
    token = create_room(client, "LISTENDOWN")

    with pytest.raises(WebSocketDisconnect) as closed:
        with client.websocket_connect(f"/ws/LISTENDOWN?token={token}") as websocket:
            websocket.receive_json()
            redis.fail_listen = True
            websocket.receive_text()

    assert closed.value.code == backend_main.WS_OPERATIONAL_CLOSE_CODE
    assert closed.value.reason == backend_main.WS_OPERATIONAL_CLOSE_REASON
    assert redis.pubsub_instances[-1].closed is True


def test_startup_redis_outage_fails_closed_in_required_runtime(monkeypatch: pytest.MonkeyPatch):
    async def unavailable_store():
        raise RedisUnavailable("Redis is unavailable")

    monkeypatch.setattr(backend_main, "room_store", None)
    monkeypatch.setattr(room_service.config, "is_test_mode", lambda: False)
    monkeypatch.setattr(room_service, "create_redis_store", unavailable_store)

    with pytest.raises(RedisUnavailable):
        import asyncio

        asyncio.run(room_service.initialize_store_and_events())
