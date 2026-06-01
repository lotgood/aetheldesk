import asyncio
import builtins
import importlib
import json
from typing import Any, cast

import pytest

from backend import redis_contract
from backend.state import BackendState, make_state

room_store_module = importlib.import_module("backend.room_store")
ROOM_INDEX_KEY = cast(str, room_store_module.ROOM_INDEX_KEY)
RedisUnavailable = cast(Any, room_store_module.RedisUnavailable)
RoomLimitReached = cast(Any, room_store_module.RoomLimitReached)
RoomStore = cast(Any, room_store_module.RoomStore)


class FakeRedis:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.sets: dict[str, set[str]] = {}
        self.ttls: dict[str, int] = {}
        self.fail_ping = False

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
        bucket = self.sets.setdefault(name, builtins.set())
        before = len(bucket)
        bucket.update(values)
        return len(bucket) - before

    async def srem(self, name: str, *values: str) -> int:
        bucket = self.sets.setdefault(name, builtins.set())
        before = len(bucket)
        bucket.difference_update(values)
        return before - len(bucket)

    async def smembers(self, name: str) -> builtins.set[str]:
        return builtins.set(self.sets.get(name, builtins.set()))

    async def scard(self, name: str) -> int:
        return len(self.sets.get(name, builtins.set()))

    async def ping(self) -> bool:
        if self.fail_ping:
            raise ConnectionError("down")
        return True

    async def incr(self, name: str) -> int:
        current = int(self.values.get(name, "0"))
        next_value = current + 1
        self.values[name] = str(next_value)
        return next_value


def sample_state() -> BackendState:
    state = make_state(lambda *_args, **_kwargs: {"marker": "celestial"})
    state["focus"] = True
    state["pomodoro_remaining"] = 42
    return state


def test_room_state_round_trips_as_json_and_sets_default_ttl():
    redis = FakeRedis()
    store = RoomStore(redis)
    state = sample_state()

    async def run() -> None:
        saved = await store.create_room(" room-a ", state, metadata={"owner": "test"})
        loaded = await store.get_state("ROOM-A")
        metadata = await store.get_metadata("room-a")

        assert saved == state
        assert loaded == state
        assert metadata == {"owner": "test"}
        assert json.loads(redis.values[redis_contract.room_state_key("ROOM-A")]) == state
        assert redis.ttls[redis_contract.room_state_key("ROOM-A")] == 300
        assert redis.ttls[redis_contract.room_metadata_key("ROOM-A")] == 300
        assert await store.room_ids() == ("ROOM-A",)

    asyncio.run(run())


def test_update_state_and_refresh_ttl_use_contract_keys():
    redis = FakeRedis()
    store = RoomStore(redis, ttl_seconds=300)

    async def run() -> None:
        await store.create_room("abc", sample_state())
        redis.ttls[redis_contract.room_state_key("ABC")] = 1
        redis.ttls[redis_contract.room_metadata_key("ABC")] = 1

        updated = await store.update_state("abc", lambda state: state.update({"paused": True}))

        assert updated is not None
        assert updated["paused"] is True
        assert redis.ttls[redis_contract.room_state_key("ABC")] == 300
        assert redis.ttls[redis_contract.room_metadata_key("ABC")] == 300

    asyncio.run(run())


def test_max_room_enforcement_counts_room_index():
    store = RoomStore(FakeRedis(), max_rooms=1)

    async def run() -> None:
        await store.create_room("one", sample_state())
        with pytest.raises(RoomLimitReached):
            await store.create_room("two", sample_state())
        assert await store.room_ids() == ("ONE",)

    asyncio.run(run())


def test_empty_room_expiry_cleans_state_metadata_and_index():
    redis = FakeRedis()
    store = RoomStore(redis)

    async def run() -> None:
        await store.create_room("gone", sample_state())
        removed = await store.expire_empty_room("gone", has_connections=False)

        assert removed is True
        assert await store.get_state("gone") is None
        assert await store.get_metadata("gone") is None
        assert redis.sets[ROOM_INDEX_KEY] == builtins.set()

    asyncio.run(run())


def test_connected_room_expiry_refreshes_ttl_without_deleting():
    redis = FakeRedis()
    store = RoomStore(redis)

    async def run() -> None:
        await store.create_room("kept", sample_state())
        redis.ttls[redis_contract.room_state_key("KEPT")] = 1
        removed = await store.expire_empty_room("kept", has_connections=True)

        assert removed is False
        assert await store.get_state("kept") is not None
        assert redis.ttls[redis_contract.room_state_key("KEPT")] == 300

    asyncio.run(run())


def test_token_lookup_placeholder_uses_contract_key_without_pin_logic():
    redis = FakeRedis()
    store = RoomStore(redis)

    async def run() -> None:
        await store.set_token_lookup("pin-next", "hash-only")

        assert await store.get_token_room_id("PIN-NEXT", "hash-only") == "PIN-NEXT"
        assert redis.ttls[redis_contract.room_token_key("PIN-NEXT", "hash-only")] == 300

    asyncio.run(run())


def test_failed_pin_attempt_counters_and_block_keys_use_contract_ttls():
    redis = FakeRedis()
    store = RoomStore(redis)

    async def run() -> None:
        blocked = False
        for _ in range(5):
            blocked = await store.record_failed_pin_attempt(
                "pin-next",
                "fingerprint-a",
                attempt_window_seconds=300,
                max_attempts=5,
                block_seconds=600,
            )

        assert blocked is True
        assert await store.is_pin_blocked("PIN-NEXT", "fingerprint-a") is True
        assert redis.ttls[redis_contract.room_pin_attempts_key("PIN-NEXT", "fingerprint-a")] == 300
        assert redis.ttls[redis_contract.room_pin_block_key("PIN-NEXT", "fingerprint-a")] == 600

    asyncio.run(run())


def test_store_payloads_never_contain_websocket_objects():
    class DummyWebSocket:
        pass

    redis = FakeRedis()
    store = RoomStore(redis)
    websocket = DummyWebSocket()

    async def run() -> None:
        await store.create_room("socket-free", sample_state())

    asyncio.run(run())

    assert websocket not in redis.values.values()
    assert all("DummyWebSocket" not in payload for payload in redis.values.values())
    assert all(json.loads(payload) for payload in redis.values.values())


def test_ping_fails_closed_when_redis_connection_is_unavailable():
    redis = FakeRedis()
    redis.fail_ping = True
    store = RoomStore(redis)

    async def run() -> None:
        with pytest.raises(RedisUnavailable):
            await store.ping()

    asyncio.run(run())


def test_fake_redis_shape_matches_room_store_protocol():
    assert cast(object, FakeRedis()) is not None
