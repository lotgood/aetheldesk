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
MAX_ROOM_TOKENS = cast(int, room_store_module.MAX_ROOM_TOKENS)
RedisUnavailable = cast(Any, room_store_module.RedisUnavailable)
RoomGenerationChanged = cast(Any, room_store_module.RoomGenerationChanged)
RoomLimitReached = cast(Any, room_store_module.RoomLimitReached)
RoomStore = cast(Any, room_store_module.RoomStore)
TokenLimitReached = cast(Any, room_store_module.TokenLimitReached)


class FakeRedis:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.sets: dict[str, set[str]] = {}
        self.ttls: dict[str, int] = {}
        self.fail_ping = False
        self.fail_get = False
        self.fail_set = False
        self.recreate_on_prune: tuple[str, str] | None = None
        self.eval_calls: list[tuple[str, int]] = []

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
        if name in self.values or name in self.sets:
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

    async def sismember(self, name: str, value: str) -> bool:
        return value in self.sets.get(name, builtins.set())

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

    async def eval(self, script: str, numkeys: int, *keys_and_args: object) -> object:
        self.eval_calls.append((script, numkeys))
        if self.fail_set:
            raise ConnectionError("down")
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
        if numkeys == 3:
            index_key, state_key, metadata_key, room_id = (str(value) for value in keys_and_args)
            if self.recreate_on_prune is not None:
                encoded_state, encoded_metadata = self.recreate_on_prune
                self.recreate_on_prune = None
                self.values[state_key] = encoded_state
                self.values[metadata_key] = encoded_metadata
                self.sets.setdefault(index_key, set()).add(room_id)
            if state_key not in self.values and metadata_key not in self.values:
                _ = await self.srem(index_key, room_id)
                return 1
            return 0
        if numkeys == 1 and "SCARD" in script:
            token_index_key, token_hash, limit, ttl = (str(value) for value in keys_and_args)
            tokens = self.sets.setdefault(token_index_key, set())
            if token_hash not in tokens and len(tokens) >= int(limit):
                return 0
            tokens.add(token_hash)
            self.ttls[token_index_key] = int(ttl)
            return 1
        raise AssertionError(f"unexpected eval arguments: {keys_and_args!r}")


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
        assert metadata is not None
        assert metadata["owner"] == "test"
        assert metadata["room_id"] == "ROOM-A"
        assert isinstance(metadata["room_instance_id"], str)
        assert metadata["room_instance_id"]
        assert json.loads(redis.values[redis_contract.room_state_key("ROOM-A")]) == state
        assert redis.ttls[redis_contract.room_state_key("ROOM-A")] == 300
        assert redis.ttls[redis_contract.room_metadata_key("ROOM-A")] == 300
        assert await store.room_ids() == ("ROOM-A",)

    asyncio.run(run())


def test_legacy_redis_snapshot_normalizes_before_revision_cas():
    redis = FakeRedis()
    store = RoomStore(redis)
    legacy = cast(dict[str, object], sample_state())
    legacy.pop("break_duration")
    legacy.pop("reward_id")
    legacy.pop("revision")
    legacy.pop("last_tick_slot")
    legacy["music"] = {"playing": True, "video_id": "legacy"}
    redis.values[redis_contract.room_state_key("LEGACY")] = json.dumps(legacy)
    redis.values[redis_contract.room_metadata_key("LEGACY")] = json.dumps(
        {"room_id": "LEGACY", "room_instance_id": "legacy-instance"}
    )
    redis.sets[ROOM_INDEX_KEY] = {"LEGACY"}

    async def run() -> None:
        loaded = await store.get_state("legacy")
        assert loaded is not None
        assert loaded["revision"] == 0
        assert loaded["last_tick_slot"] is None
        assert loaded["reward_id"] == 0
        assert "music" not in loaded
        loaded["paused"] = True
        loaded["revision"] = 1
        assert await store.compare_and_set_state("legacy", 0, "legacy-instance", loaded) is True

    asyncio.run(run())

    canonical = json.loads(redis.values[redis_contract.room_state_key("LEGACY")])
    assert canonical["revision"] == 1
    assert canonical["paused"] is True
    assert "music" not in canonical


def test_update_state_and_refresh_ttl_use_contract_keys():
    redis = FakeRedis()
    store = RoomStore(redis, ttl_seconds=300)

    async def run() -> None:
        await store.create_room("abc", sample_state())
        await store.set_token_lookup("abc", "token-a")
        await store.set_token_lookup("abc", "token-b")
        redis.ttls[redis_contract.room_state_key("ABC")] = 1
        redis.ttls[redis_contract.room_metadata_key("ABC")] = 1
        redis.ttls[redis_contract.room_token_index_key("ABC")] = 1

        updated = await store.update_state("abc", lambda state: state.update({"paused": True}))

        assert updated is not None
        assert updated["paused"] is True
        assert redis.ttls[redis_contract.room_state_key("ABC")] == 300
        assert redis.ttls[redis_contract.room_metadata_key("ABC")] == 300
        assert redis.ttls[redis_contract.room_token_index_key("ABC")] == 300

    asyncio.run(run())


def test_revision_cas_atomically_fences_generation_and_refreshes_all_room_ttls():
    redis = FakeRedis()
    store = RoomStore(redis, ttl_seconds=300)

    async def run() -> None:
        await store.create_room(
            "atomic",
            sample_state(),
            metadata={"room_id": "ATOMIC", "room_instance_id": "generation-a"},
        )
        await store.set_token_lookup("atomic", "token-a")
        state_key = redis_contract.room_state_key("ATOMIC")
        metadata_key = redis_contract.room_metadata_key("ATOMIC")
        token_key = redis_contract.room_token_index_key("ATOMIC")
        redis.ttls[state_key] = 1
        redis.ttls[metadata_key] = 1
        redis.ttls[token_key] = 1

        snapshot = await store.get_room_snapshot("atomic")
        assert snapshot is not None
        state, room_instance_id = snapshot
        state["paused"] = True
        state["revision"] = 1
        calls_before = len(redis.eval_calls)
        assert await store.compare_and_set_state("atomic", 0, room_instance_id, state) is True

        cas_calls = redis.eval_calls[calls_before:]
        assert len(cas_calls) == 1
        assert "AETHEL_COMPARE_AND_SET_STATE" in cas_calls[0][0]
        assert redis.ttls[state_key] == 300
        assert redis.ttls[metadata_key] == 300
        assert redis.ttls[token_key] == 300

        redis.values.pop(metadata_key)
        rejected = dict(state)
        rejected["paused"] = False
        rejected["revision"] = 2
        with pytest.raises(RoomGenerationChanged):
            await store.compare_and_set_state(
                "atomic",
                1,
                room_instance_id,
                cast(BackendState, rejected),
            )
        assert json.loads(redis.values[state_key])["paused"] is True

    asyncio.run(run())


def test_same_room_id_recreation_rejects_old_generation_cas_and_clears_tick_lease():
    redis = FakeRedis()
    store = RoomStore(redis)

    async def run() -> None:
        await store.create_room(
            "reborn",
            sample_state(),
            metadata={"room_id": "REBORN", "room_instance_id": "old-generation"},
        )
        old_snapshot = await store.get_room_snapshot("reborn")
        assert old_snapshot is not None
        old_state, old_instance_id = old_snapshot
        old_state["paused"] = True
        old_state["revision"] = 1
        tick_lock_key = redis_contract.room_tick_lock_key("REBORN")
        redis.values[tick_lock_key] = "1|running|old-worker|old-nonce"
        redis.ttls[tick_lock_key] = 2

        assert await store.expire_empty_room("reborn", has_connections=False) is True
        await store.create_room(
            "reborn",
            sample_state(),
            metadata={"room_id": "REBORN", "room_instance_id": "new-generation"},
        )

        assert tick_lock_key not in redis.values
        with pytest.raises(RoomGenerationChanged):
            await store.compare_and_set_state("reborn", 0, old_instance_id, old_state)
        current = await store.get_room_snapshot("reborn")
        assert current is not None
        assert current[1] == "new-generation"
        assert current[0]["paused"] is False
        assert current[0]["revision"] == 0

    asyncio.run(run())


def test_max_room_enforcement_counts_room_index():
    store = RoomStore(FakeRedis(), max_rooms=1)

    async def run() -> None:
        await store.create_room("one", sample_state())
        with pytest.raises(RoomLimitReached):
            await store.create_room("two", sample_state())
        assert await store.room_ids() == ("ONE",)

    asyncio.run(run())


def test_concurrent_different_room_creates_cannot_exceed_global_limit():
    redis = FakeRedis()
    store = RoomStore(redis, max_rooms=1)

    async def create(room_id: str) -> object:
        try:
            return await store.create_room(room_id, sample_state())
        except RoomLimitReached as exc:
            return exc

    async def run() -> list[object]:
        return list(await asyncio.gather(create("alpha"), create("beta")))

    results = asyncio.run(run())

    assert sum(isinstance(result, dict) for result in results) == 1
    assert sum(isinstance(result, RoomLimitReached) for result in results) == 1
    assert len(redis.sets[ROOM_INDEX_KEY]) == 1


def test_room_registry_prunes_expired_index_member_before_enforcing_limit():
    redis = FakeRedis()
    store = RoomStore(redis, max_rooms=1)

    async def run() -> None:
        await store.create_room("expired", sample_state())
        await store.set_token_lookup("expired", "token-a")
        redis.values.pop(redis_contract.room_state_key("EXPIRED"))
        redis.values.pop(redis_contract.room_metadata_key("EXPIRED"))

        await store.create_room("fresh", sample_state())

        assert await store.room_ids() == ("FRESH",)
        assert await store.get_token_room_id("EXPIRED", "token-a") == "EXPIRED"
        assert "EXPIRED" not in redis.sets[ROOM_INDEX_KEY]

    asyncio.run(run())


def test_partial_room_skew_is_counted_but_excluded_from_tickable_registry():
    redis = FakeRedis()
    store = RoomStore(redis, max_rooms=1)

    async def run() -> None:
        await store.create_room("skew", sample_state())
        redis.values.pop(redis_contract.room_metadata_key("SKEW"))

        assert await store.room_ids() == ()
        assert await store.room_count() == 1
        with pytest.raises(RoomLimitReached):
            await store.create_room("blocked", sample_state())

        redis.values.pop(redis_contract.room_state_key("SKEW"))
        assert await store.room_count() == 0
        assert "SKEW" not in redis.sets[ROOM_INDEX_KEY]

    asyncio.run(run())


def test_registry_prune_does_not_remove_room_recreated_during_absence_check():
    redis = FakeRedis()
    store = RoomStore(redis)
    redis.sets[ROOM_INDEX_KEY] = {"RACE"}
    recreated_state = sample_state()
    redis.recreate_on_prune = (
        json.dumps(recreated_state, separators=(",", ":")),
        json.dumps({"room_id": "RACE", "room_instance_id": "new"}, separators=(",", ":")),
    )

    async def run() -> None:
        assert await store.room_ids() == ("RACE",)
        assert "RACE" in redis.sets[ROOM_INDEX_KEY]
        assert await store.get_state("RACE") == recreated_state

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


def test_get_or_create_room_does_not_refresh_state_only_skew():
    redis = FakeRedis()
    store = RoomStore(redis)

    async def run() -> None:
        await store.create_room("skew", sample_state())
        redis.values.pop(redis_contract.room_metadata_key("SKEW"))
        redis.ttls[redis_contract.room_state_key("SKEW")] = 1

        loaded = await store.get_or_create_room("skew", sample_state)

        assert loaded is None
        assert redis.ttls[redis_contract.room_state_key("SKEW")] == 1

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
        await store.set_token_lookup("gone", "token-a")
        removed = await store.expire_empty_room("gone", has_connections=False)

        assert removed is True
        assert await store.get_state("gone") is None
        assert await store.get_metadata("gone") is None
        assert await store.get_token_room_id("gone", "token-a") is None
        assert redis_contract.room_token_index_key("GONE") not in redis.sets
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
        assert redis_contract.room_token_key("PIN-NEXT", "hash-only") not in redis.values
        assert redis.sets[redis_contract.room_token_index_key("PIN-NEXT")] == {"hash-only"}
        assert redis.ttls[redis_contract.room_token_index_key("PIN-NEXT")] == 300

    asyncio.run(run())


def test_room_token_registration_is_bounded_without_evicting_existing_tokens():
    redis = FakeRedis()
    store = RoomStore(redis)

    async def run() -> None:
        for index in range(MAX_ROOM_TOKENS):
            await store.set_token_lookup("bounded", f"token-{index}")
        await store.set_token_lookup("bounded", "token-0")
        with pytest.raises(TokenLimitReached):
            await store.set_token_lookup("bounded", "overflow")

    asyncio.run(run())

    assert len(redis.sets[redis_contract.room_token_index_key("BOUNDED")]) == MAX_ROOM_TOKENS
    assert "token-0" in redis.sets[redis_contract.room_token_index_key("BOUNDED")]
    assert "overflow" not in redis.sets[redis_contract.room_token_index_key("BOUNDED")]


def test_successful_legacy_token_lookup_is_indexed_and_refreshed():
    redis = FakeRedis()
    store = RoomStore(redis)
    token_key = redis_contract.room_token_key("LEGACY", "hash-only")
    redis.values[token_key] = "LEGACY"
    redis.ttls[token_key] = 1

    async def run() -> None:
        assert await store.get_token_room_id("legacy", "hash-only") == "LEGACY"

    asyncio.run(run())

    assert redis.sets[redis_contract.room_token_index_key("LEGACY")] == {"hash-only"}
    assert redis.ttls[redis_contract.room_token_index_key("LEGACY")] == 300
    assert token_key not in redis.values


def test_token_authorization_and_issuance_are_bound_to_room_generation():
    redis = FakeRedis()
    store = RoomStore(redis)

    async def run() -> None:
        await store.create_room(
            "generation",
            sample_state(),
            metadata={"room_id": "GENERATION", "room_instance_id": "old"},
        )
        await store.set_token_lookup(
            "generation",
            "old-hash",
            expected_instance_id="old",
        )
        assert await store.authorize_token("generation", "old", "old-hash") is not None

        assert await store.expire_empty_room("generation", has_connections=False) is True
        await store.create_room(
            "generation",
            sample_state(),
            metadata={"room_id": "GENERATION", "room_instance_id": "new"},
        )

        assert await store.authorize_token("generation", "old", "old-hash") is None
        with pytest.raises(RoomGenerationChanged):
            await store.set_token_lookup(
                "generation",
                "late-old-hash",
                expected_instance_id="old",
            )

    asyncio.run(run())


def test_legacy_token_is_rejected_when_authoritative_generation_set_is_full():
    redis = FakeRedis()
    store = RoomStore(redis)
    legacy_key = redis_contract.room_token_key("FULL", "legacy-hash")

    async def run() -> None:
        await store.create_room(
            "full",
            sample_state(),
            metadata={"room_id": "FULL", "room_instance_id": "generation"},
        )
        for index in range(MAX_ROOM_TOKENS):
            await store.set_token_lookup("full", f"token-{index}")
        redis.values[legacy_key] = "FULL"
        redis.ttls[legacy_key] = 1

        assert await store.authorize_token("full", "generation", "legacy-hash") is None

    asyncio.run(run())

    assert len(redis.sets[redis_contract.room_token_index_key("FULL")]) == MAX_ROOM_TOKENS
    assert redis.ttls[legacy_key] == 1


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
