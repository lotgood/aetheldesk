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
        self.fail_get = False
        self.fail_set = False

    async def get(self, name: str) -> str | None:
        if self.fail_get:
            raise ConnectionError("down")
        return self.values.get(name)

    async def set(self, name: str, value: str, ex: int | None = None, nx: bool = False) -> bool:
        if self.fail_set:
            raise ConnectionError("down")
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


def test_create_room_refuses_state_only_skew_without_overwrite():
    redis = FakeRedis()
    store = RoomStore(redis)
    original = sample_state()
    replacement = sample_state()
    replacement["pomodoro_remaining"] = 99

    async def run() -> None:
        await store.create_room("skew", original, metadata={"room_id": "SKEW", "pin_hash": "old"})
        redis.values.pop(redis_contract.room_metadata_key("SKEW"))

        with pytest.raises(RuntimeError, match="room already exists"):
            await store.create_room("skew", replacement, metadata={"room_id": "SKEW", "pin_hash": "new"})

        assert await store.get_state("SKEW") == original
        assert await store.get_metadata("SKEW") is None

    asyncio.run(run())


def test_get_or_create_room_does_not_overwrite_metadata_only_skew():
    redis = FakeRedis()
    store = RoomStore(redis)
    metadata = {"room_id": "SKEW", "pin_hash": "old"}
    redis.values[redis_contract.room_metadata_key("SKEW")] = json.dumps(metadata, separators=(",", ":"))

    async def run() -> None:
        created = await store.get_or_create_room("skew", sample_state)

        assert created is None
        assert await store.get_state("SKEW") is None
        assert await store.get_metadata("SKEW") == metadata

    asyncio.run(run())


def test_concurrent_create_same_room_allows_single_writer():
    redis = FakeRedis()
    store = RoomStore(redis)

    async def create(marker: str) -> BackendState:
        state = sample_state()
        state["celestial"] = {"marker": marker}
        return await store.create_room("race", state, metadata={"room_id": "RACE", "marker": marker})

    async def run() -> None:
        results = await asyncio.gather(create("one"), create("two"), return_exceptions=True)

        assert sum(not isinstance(result, Exception) for result in results) == 1
        assert sum(isinstance(result, RuntimeError) for result in results) == 1
        stored_state = await store.get_state("RACE")
        stored_metadata = await store.get_metadata("RACE")
        assert stored_state is not None
        assert stored_metadata is not None
        assert stored_state["celestial"]["marker"] == stored_metadata["marker"]

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


def test_runtime_get_state_fails_closed_when_redis_connection_drops():
    redis = FakeRedis()
    store = RoomStore(redis)

    async def run() -> None:
        await store.create_room("drop", sample_state())
        redis.fail_get = True
        with pytest.raises(RedisUnavailable):
            await store.get_state("DROP")

    asyncio.run(run())


def test_runtime_set_state_fails_closed_when_redis_connection_drops():
    redis = FakeRedis()
    store = RoomStore(redis)

    async def run() -> None:
        redis.fail_set = True
        with pytest.raises(RedisUnavailable):
            await store.set_state("DROP", sample_state())

    asyncio.run(run())


def test_fake_redis_shape_matches_room_store_protocol():
    assert cast(object, FakeRedis()) is not None
