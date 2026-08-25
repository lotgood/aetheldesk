import asyncio
import builtins
import importlib
import json
from types import SimpleNamespace
from typing import Any, cast

import pytest
from fastapi import WebSocket

from backend.connection_manager import LocalConnectionManager
from backend.redis_contract import (
    room_metadata_key,
    room_state_key,
    room_tick_lock_key,
    room_token_index_key,
)
from backend.room_store import RedisUnavailable, RoomStore
from backend.state import BackendState, make_state

scheduler_module = importlib.import_module("backend.scheduler")
scheduler_wiring_module = importlib.import_module("backend.scheduler_wiring")
RoomTickScheduler = cast(Any, scheduler_module.RoomTickScheduler)


class FakeRedis:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.sets: dict[str, builtins.set[str]] = {}
        self.ttls: dict[str, int] = {}
        self.now_seconds = 1

    def advance(self, seconds: int = 1) -> None:
        self.now_seconds += seconds
        for name in list(self.ttls):
            self.ttls[name] -= seconds
            if self.ttls[name] > 0:
                continue
            self.ttls.pop(name, None)
            self.values.pop(name, None)
            self.sets.pop(name, None)

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

    async def eval(self, _script: str, _numkeys: int, *keys_and_args: object) -> object:
        if _numkeys == 4 and "AETHEL_CREATE_ROOM" in _script:
            (
                index_key,
                state_key,
                metadata_key,
                token_index_key,
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
            self.values[state_key] = encoded_state
            self.values[metadata_key] = encoded_metadata
            self.ttls[state_key] = int(ttl)
            self.ttls[metadata_key] = int(ttl)
            rooms.add(room_id)
            return 1
        if _numkeys == 3 and "EXPIRE" in _script:
            state_key, metadata_key, token_index_key, ttl = (str(value) for value in keys_and_args)
            if state_key not in self.values or metadata_key not in self.values:
                return 0
            self.ttls[state_key] = int(ttl)
            self.ttls[metadata_key] = int(ttl)
            if token_index_key in self.sets:
                self.ttls[token_index_key] = int(ttl)
            return 1
        if _numkeys == 2:
            key, state_key, lease, expected_revision, encoded_state, state_ttl, lock_ttl = (
                str(value) for value in keys_and_args
            )
            if self.values.get(key) != lease:
                return 0
            current_state = json.loads(self.values[state_key])
            if int(current_state.get("revision", 0)) != int(expected_revision):
                return 0
            slot, status, *_rest = lease.split("|")
            if status != "running":
                return 0
            self.values[state_key] = encoded_state
            self.ttls[state_key] = int(state_ttl)
            self.values[key] = f"{slot}|done"
            self.ttls[key] = int(lock_ttl)
            return 1

        if _numkeys == 1 and "cjson.decode" in _script:
            state_key, expected_revision, encoded_state, state_ttl = (str(value) for value in keys_and_args)
            current_state = self.values.get(state_key)
            if current_state is None:
                return 0
            if int(json.loads(current_state).get("revision", 0)) != int(expected_revision):
                return 0
            self.values[state_key] = encoded_state
            self.ttls[state_key] = int(state_ttl)
            return 1

        if _numkeys == 1 and "SCARD" in _script:
            token_index_key, token_hash, limit, ttl = (str(value) for value in keys_and_args)
            tokens = self.sets.setdefault(token_index_key, set())
            if token_hash not in tokens and len(tokens) >= int(limit):
                return 0
            tokens.add(token_hash)
            self.ttls[token_index_key] = int(ttl)
            return 1

        if len(keys_and_args) == 4:
            key, owner, nonce, ttl_seconds = (str(value) for value in keys_and_args)
            slot = str(self.now_seconds)
            current = self.values.get(key)
            if current is not None:
                parts = current.split("|")
                if len(parts) < 2 or parts[0] == slot or parts[1] == "running":
                    return None
            lease = f"{slot}|running|{owner}|{nonce}"
            self.values[key] = lease
            self.ttls[key] = int(ttl_seconds)
            return [slot, lease]

        if len(keys_and_args) == 3:
            key, lease, ttl_seconds = (str(value) for value in keys_and_args)
            if self.values.get(key) != lease:
                return 0
            slot, status, *_rest = lease.split("|")
            if status != "running":
                return 0
            self.values[key] = f"{slot}|done"
            self.ttls[key] = int(ttl_seconds)
            return 1

        raise AssertionError(f"unexpected eval arguments: {keys_and_args!r}")


class DummyWebSocket:
    def __init__(self) -> None:
        self.messages: list[str] = []

    async def send_text(self, message: str) -> None:
        self.messages.append(message)


class RecordingPublisher:
    def __init__(self) -> None:
        self.published: list[tuple[str, BackendState]] = []

    async def publish_state(self, room_id: str, state: BackendState) -> dict[str, object]:
        self.published.append((room_id, json.loads(json.dumps(state))))
        return {"room_id": room_id, "data": state}


def sample_state(*, focus: bool = True, remaining: int = 10, marker: str = "celestial") -> BackendState:
    state = make_state(lambda *_args, **_kwargs: {"marker": marker})
    state["focus"] = focus
    state["pomodoro_remaining"] = remaining
    return state


def decoded_messages(websocket: DummyWebSocket) -> list[dict[str, object]]:
    return [json.loads(message) for message in websocket.messages]


def test_two_workers_run_scheduler_but_tick_lock_allows_one_decrement():
    redis = FakeRedis()
    store = RoomStore(redis)
    manager_a = LocalConnectionManager()
    manager_b = LocalConnectionManager()
    socket_a = DummyWebSocket()
    socket_b = DummyWebSocket()
    manager_a.connect("room-a", cast(WebSocket, socket_a))
    manager_b.connect("room-a", cast(WebSocket, socket_b))
    publisher_a = RecordingPublisher()
    publisher_b = RecordingPublisher()
    scheduler_a = RoomTickScheduler(
        store,
        connections=manager_a,
        worker_id="worker-a",
        celestial_provider=lambda: {"marker": "unused"},
        publisher=publisher_a,
        lock_seconds=2,
    )
    scheduler_b = RoomTickScheduler(
        store,
        connections=manager_b,
        worker_id="worker-b",
        celestial_provider=lambda: {"marker": "unused"},
        publisher=publisher_b,
        lock_seconds=2,
    )

    async def run() -> BackendState:
        await store.set_state("room-a", sample_state(remaining=10))
        await scheduler_a.tick_once(counter=1)
        await scheduler_b.tick_once(counter=1)
        loaded = await store.get_state("room-a")
        assert loaded is not None
        return loaded

    state = asyncio.run(run())

    assert state["pomodoro_remaining"] == 9
    assert redis.values[room_tick_lock_key("ROOM-A")] == "1|done"
    assert redis.ttls[room_tick_lock_key("ROOM-A")] == 2
    assert decoded_messages(socket_a) == [{"type": "state", "data": state}]
    assert decoded_messages(socket_b) == []
    assert publisher_a.published == [("ROOM-A", state)]
    assert publisher_b.published == []


def test_completed_tick_lease_allows_the_next_second_without_double_decrement():
    redis = FakeRedis()
    store = RoomStore(redis)
    manager_a = LocalConnectionManager()
    manager_b = LocalConnectionManager()
    manager_a.connect("room-a", cast(WebSocket, DummyWebSocket()))
    manager_b.connect("room-a", cast(WebSocket, DummyWebSocket()))
    scheduler_a = RoomTickScheduler(
        store,
        connections=manager_a,
        worker_id="worker-a",
        celestial_provider=lambda: {"marker": "unused"},
        lock_seconds=2,
    )
    scheduler_b = RoomTickScheduler(
        store,
        connections=manager_b,
        worker_id="worker-b",
        celestial_provider=lambda: {"marker": "unused"},
        lock_seconds=2,
    )

    async def run() -> BackendState:
        await store.set_state("room-a", sample_state(remaining=10))
        await scheduler_a.tick_once(counter=1)
        await scheduler_b.tick_once(counter=1)
        redis.advance()
        await scheduler_b.tick_once(counter=2)
        await scheduler_a.tick_once(counter=2)
        loaded = await store.get_state("room-a")
        assert loaded is not None
        return loaded

    state = asyncio.run(run())

    assert state["pomodoro_remaining"] == 8
    assert redis.values[room_tick_lock_key("ROOM-A")] == "2|done"
    assert redis.ttls[room_tick_lock_key("ROOM-A")] == 2


def test_running_previous_tick_blocks_overlap_until_lease_expires():
    redis = FakeRedis()
    store = RoomStore(redis)
    manager = LocalConnectionManager()
    manager.connect("room-a", cast(WebSocket, DummyWebSocket()))
    scheduler = RoomTickScheduler(
        store,
        connections=manager,
        worker_id="worker-b",
        celestial_provider=lambda: {"marker": "unused"},
        lock_seconds=2,
    )

    async def run() -> tuple[bool, bool, BackendState]:
        await store.set_state("room-a", sample_state(remaining=10))
        lock_key = room_tick_lock_key("ROOM-A")
        redis.values[lock_key] = "1|running|worker-a|stalled"
        redis.ttls[lock_key] = 2
        redis.advance()
        blocked = await scheduler.tick_room("room-a", counter=2)
        redis.advance()
        acquired = await scheduler.tick_room("room-a", counter=3)
        loaded = await store.get_state("room-a")
        assert loaded is not None
        return blocked, acquired, loaded

    blocked, acquired, state = asyncio.run(run())

    assert blocked is False
    assert acquired is True
    assert state["pomodoro_remaining"] == 9


def test_expired_tick_lease_cannot_overwrite_newer_timer_state():
    redis = FakeRedis()
    store = RoomStore(redis, ttl_seconds=300)

    async def run() -> tuple[bool, BackendState]:
        await store.create_room(
            "room-a",
            sample_state(remaining=3),
            metadata={"room_id": "ROOM-A", "room_instance_id": "instance-a"},
        )
        stale_lease = await store.acquire_tick_lock("room-a", "slow", ttl_seconds=2)
        assert stale_lease is not None
        stale_state = await store.get_state("room-a")
        assert stale_state is not None
        stale_state["pomodoro_remaining"] = 2

        redis.advance(2)
        fast_lease = await store.acquire_tick_lock("room-a", "fast", ttl_seconds=2)
        assert fast_lease is not None
        fast_state = await store.get_state("room-a")
        assert fast_state is not None
        fast_state["pomodoro_remaining"] = 1
        fast_state["revision"] = 1
        assert await store.commit_tick_state("room-a", fast_lease[1], 0, fast_state, 2) is True

        stale_state["revision"] = 1
        stale_committed = await store.commit_tick_state("room-a", stale_lease[1], 0, stale_state, 2)
        loaded = await store.get_state("room-a")
        assert loaded is not None
        return stale_committed, loaded

    stale_committed, state = asyncio.run(run())

    assert stale_committed is False
    assert state["pomodoro_remaining"] == 1


def test_websocket_cancel_revision_cannot_be_resurrected_by_inflight_tick():
    redis = FakeRedis()
    store = RoomStore(redis, ttl_seconds=300)

    async def run() -> tuple[bool, BackendState]:
        await store.create_room(
            "room-a",
            sample_state(remaining=10),
            metadata={"room_id": "ROOM-A", "room_instance_id": "instance-a"},
        )
        tick_lease = await store.acquire_tick_lock("room-a", "tick", ttl_seconds=2)
        assert tick_lease is not None
        stale_tick_state = await store.get_state("room-a")
        assert stale_tick_state is not None
        stale_tick_state["pomodoro_remaining"] = 9
        stale_tick_state["revision"] = 1

        cancelled = await store.get_state("room-a")
        assert cancelled is not None
        cancelled["focus"] = False
        cancelled["pomodoro_remaining"] = cancelled["pomodoro_duration"]
        cancelled["revision"] = 1
        assert await store.compare_and_set_state("room-a", 0, cancelled) is True

        tick_committed = await store.commit_tick_state(
            "room-a",
            tick_lease[1],
            0,
            stale_tick_state,
            2,
        )
        loaded = await store.get_state("room-a")
        assert loaded is not None
        return tick_committed, loaded

    tick_committed, state = asyncio.run(run())

    assert tick_committed is False
    assert state["focus"] is False
    assert state["pomodoro_remaining"] == 3000
    assert state["revision"] == 1


def test_celestial_refresh_is_skipped_until_worker_gets_tick_lock():
    redis = FakeRedis()
    store = RoomStore(redis)
    manager = LocalConnectionManager()
    websocket = DummyWebSocket()
    manager.connect("room-a", cast(WebSocket, websocket))
    called = {"count": 0}

    def celestial_provider() -> dict[str, object]:
        called["count"] += 1
        return {"marker": "updated"}

    scheduler = RoomTickScheduler(
        store,
        connections=manager,
        worker_id="worker-a",
        celestial_provider=celestial_provider,
        lock_seconds=2,
    )

    async def run() -> tuple[bool, bool, BackendState]:
        state = sample_state(focus=False, remaining=10)
        await store.set_state("room-a", state)
        redis.now_seconds = 30
        redis.values[room_tick_lock_key("ROOM-A")] = "30|running|other-worker|stalled"
        blocked = await scheduler.tick_room("room-a", counter=30)
        blocked_state = await store.get_state("room-a")
        assert blocked_state is not None
        assert blocked_state["celestial"] == {"marker": "celestial"}
        await redis.delete(room_tick_lock_key("ROOM-A"))
        acquired = await scheduler.tick_room("room-a", counter=30)
        loaded = await store.get_state("room-a")
        assert loaded is not None
        return blocked, acquired, loaded

    blocked, acquired, state = asyncio.run(run())

    assert blocked is False
    assert acquired is True
    assert called["count"] == 1
    assert state["celestial"] == {"marker": "updated"}
    assert decoded_messages(websocket) == [{"type": "state", "data": state}]


def test_two_workers_complete_accelerated_50_plus_10_cycle_and_keep_credentials_alive():
    redis = FakeRedis()
    store = RoomStore(redis, ttl_seconds=3)
    manager_a = LocalConnectionManager()
    manager_b = LocalConnectionManager()
    socket_a = DummyWebSocket()
    socket_b = DummyWebSocket()
    manager_a.connect("room-a", cast(WebSocket, socket_a))
    manager_b.connect("room-a", cast(WebSocket, socket_b))
    scheduler_a = RoomTickScheduler(
        store,
        connections=manager_a,
        worker_id="worker-a",
        celestial_provider=lambda: {"marker": "unused"},
        lock_seconds=2,
    )
    scheduler_b = RoomTickScheduler(
        store,
        connections=manager_b,
        worker_id="worker-b",
        celestial_provider=lambda: {"marker": "unused"},
        lock_seconds=2,
    )

    async def run() -> BackendState:
        await store.create_room(
            "room-a",
            sample_state(remaining=3000),
            metadata={"room_id": "ROOM-A", "room_instance_id": "instance-a"},
        )
        await store.set_token_lookup("room-a", "token-a")
        await store.set_token_lookup("room-a", "token-b")

        for counter in range(1, 3601):
            schedulers = (scheduler_a, scheduler_b) if counter % 2 else (scheduler_b, scheduler_a)
            for scheduler in schedulers:
                await scheduler.tick_once(counter=counter)
            redis.advance()
            assert await store.get_metadata("room-a") is not None
            assert redis.sets[room_token_index_key("ROOM-A")] == {"token-a", "token-b"}

        loaded = await store.get_state("room-a")
        assert loaded is not None
        return loaded

    state = asyncio.run(run())

    assert state["sessions_done"] == 1
    assert state["focus"] is False
    assert state["break"] is False
    assert state["pomodoro_remaining"] == 3000
    assert len(socket_a.messages) + len(socket_b.messages) == 3600
    assert redis.ttls[room_state_key("ROOM-A")] == 2
    assert redis.ttls[room_metadata_key("ROOM-A")] == 2
    assert redis.ttls[room_token_index_key("ROOM-A")] == 2


def test_disconnected_active_room_keeps_ticking_from_shared_room_registry():
    redis = FakeRedis()
    store = RoomStore(redis, ttl_seconds=3)
    manager = LocalConnectionManager()
    scheduler = RoomTickScheduler(
        store,
        connections=manager,
        worker_id="worker-a",
        celestial_provider=lambda: {"marker": "unused"},
        lock_seconds=2,
    )

    async def run() -> BackendState:
        await store.create_room(
            "room-a",
            sample_state(remaining=2),
            metadata={"room_id": "ROOM-A", "room_instance_id": "instance-a"},
        )
        await scheduler.tick_once(counter=1)
        loaded = await store.get_state("room-a")
        assert loaded is not None
        return loaded

    state = asyncio.run(run())

    assert manager.room_ids() == ()
    assert state["focus"] is True
    assert state["pomodoro_remaining"] == 1
    assert redis.ttls[room_state_key("ROOM-A")] == 3
    assert redis.ttls[room_metadata_key("ROOM-A")] == 3


def test_timer_catches_up_elapsed_redis_seconds_after_scheduler_gap():
    redis = FakeRedis()
    store = RoomStore(redis, ttl_seconds=300)
    manager = LocalConnectionManager()
    manager.connect("room-a", cast(WebSocket, DummyWebSocket()))
    scheduler = RoomTickScheduler(
        store,
        connections=manager,
        worker_id="worker-a",
        celestial_provider=lambda: {"marker": "unused"},
        lock_seconds=2,
    )

    async def run() -> BackendState:
        await store.create_room(
            "room-a",
            sample_state(remaining=10),
            metadata={"room_id": "ROOM-A", "room_instance_id": "instance-a"},
        )
        await scheduler.tick_once(counter=1)
        redis.advance(4)
        await scheduler.tick_once(counter=2)
        loaded = await store.get_state("room-a")
        assert loaded is not None
        return loaded

    state = asyncio.run(run())

    assert state["pomodoro_remaining"] == 5
    assert state["last_tick_slot"] == 5
    assert state["revision"] == 2


def test_same_redis_slot_after_message_reconciliation_does_not_double_decrement():
    redis = FakeRedis()
    store = RoomStore(redis, ttl_seconds=300)
    manager = LocalConnectionManager()
    manager.connect("room-a", cast(WebSocket, DummyWebSocket()))
    scheduler = RoomTickScheduler(
        store,
        connections=manager,
        worker_id="worker-a",
        celestial_provider=lambda: {"marker": "unused"},
        lock_seconds=2,
    )

    async def run() -> BackendState:
        state = sample_state(remaining=9)
        state["last_tick_slot"] = 1
        state["revision"] = 1
        await store.create_room(
            "room-a",
            state,
            metadata={"room_id": "ROOM-A", "room_instance_id": "instance-a"},
        )
        await scheduler.tick_once(counter=1)
        loaded = await store.get_state("room-a")
        assert loaded is not None
        return loaded

    state = asyncio.run(run())

    assert state["pomodoro_remaining"] == 9
    assert state["last_tick_slot"] == 1
    assert state["revision"] == 1


def test_elapsed_gap_crosses_focus_completion_and_consumes_break_time_once():
    redis = FakeRedis()
    store = RoomStore(redis, ttl_seconds=300)
    manager = LocalConnectionManager()
    manager.connect("room-a", cast(WebSocket, DummyWebSocket()))
    scheduler = RoomTickScheduler(
        store,
        connections=manager,
        worker_id="worker-a",
        celestial_provider=lambda: {"marker": "unused"},
        lock_seconds=2,
    )

    async def run() -> BackendState:
        await store.create_room(
            "room-a",
            sample_state(remaining=2),
            metadata={"room_id": "ROOM-A", "room_instance_id": "instance-a"},
        )
        await scheduler.tick_once(counter=1)
        redis.advance(3)
        await scheduler.tick_once(counter=2)
        loaded = await store.get_state("room-a")
        assert loaded is not None
        return loaded

    state = asyncio.run(run())

    assert state["focus"] is False
    assert state["break"] is True
    assert state["break_remaining"] == 598
    assert state["sessions_done"] == 1
    assert state["reward_id"] == 1
    assert state["last_tick_slot"] == 4


def test_disconnected_idle_room_does_not_refresh_ttl_or_celestial_state():
    redis = FakeRedis()
    store = RoomStore(redis, ttl_seconds=3)
    manager = LocalConnectionManager()
    called = {"count": 0}

    def celestial_provider() -> dict[str, object]:
        called["count"] += 1
        return {"marker": "updated"}

    scheduler = RoomTickScheduler(
        store,
        connections=manager,
        worker_id="worker-a",
        celestial_provider=celestial_provider,
        lock_seconds=2,
    )

    async def run() -> BackendState:
        await store.create_room(
            "room-a",
            sample_state(focus=False),
            metadata={"room_id": "ROOM-A", "room_instance_id": "instance-a"},
        )
        redis.ttls[room_state_key("ROOM-A")] = 1
        redis.ttls[room_metadata_key("ROOM-A")] = 1
        redis.now_seconds = 30
        await scheduler.tick_once(counter=30)
        loaded = await store.get_state("room-a")
        assert loaded is not None
        return loaded

    state = asyncio.run(run())

    assert called["count"] == 0
    assert state["celestial"] == {"marker": "celestial"}
    assert redis.ttls[room_state_key("ROOM-A")] == 1
    assert redis.ttls[room_metadata_key("ROOM-A")] == 1


def test_connected_idle_room_refreshes_ttl_and_celestial_state():
    redis = FakeRedis()
    store = RoomStore(redis, ttl_seconds=3)
    manager = LocalConnectionManager()
    manager.connect("room-a", cast(WebSocket, DummyWebSocket()))
    called = {"count": 0}

    def celestial_provider() -> dict[str, object]:
        called["count"] += 1
        return {"marker": "updated"}

    scheduler = RoomTickScheduler(
        store,
        connections=manager,
        worker_id="worker-a",
        celestial_provider=celestial_provider,
        lock_seconds=2,
    )

    async def run() -> BackendState:
        await store.create_room(
            "room-a",
            sample_state(focus=False),
            metadata={"room_id": "ROOM-A", "room_instance_id": "instance-a"},
        )
        redis.ttls[room_state_key("ROOM-A")] = 1
        redis.ttls[room_metadata_key("ROOM-A")] = 1
        redis.now_seconds = 30
        await scheduler.tick_once(counter=30)
        loaded = await store.get_state("room-a")
        assert loaded is not None
        return loaded

    state = asyncio.run(run())

    assert called["count"] == 1
    assert state["celestial"] == {"marker": "updated"}
    assert redis.ttls[room_state_key("ROOM-A")] == 3
    assert redis.ttls[room_metadata_key("ROOM-A")] == 3


def test_scheduler_loop_survives_one_redis_failure_then_runs_again(
    monkeypatch: pytest.MonkeyPatch,
):
    calls = {"count": 0}

    class FlakyScheduler:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

        async def tick_once(self, *, counter: int) -> None:
            del counter
            calls["count"] += 1
            if calls["count"] == 1:
                raise RedisUnavailable("temporary")
            raise asyncio.CancelledError

    async def no_delay(_seconds: float) -> None:
        return None

    runtime = SimpleNamespace(
        room_store=object(),
        connections=LocalConnectionManager(),
        worker_id="worker-a",
        get_celestial_state=lambda: {"marker": "unused"},
        event_bus=None,
    )
    monkeypatch.setattr(scheduler_wiring_module, "_runtime", lambda: runtime)
    monkeypatch.setattr(scheduler_wiring_module, "RoomTickScheduler", FlakyScheduler)
    monkeypatch.setattr(scheduler_wiring_module.asyncio, "sleep", no_delay)

    async def run() -> None:
        try:
            await scheduler_wiring_module.tick()
        except asyncio.CancelledError:
            return
        raise AssertionError("scheduler cancellation did not propagate")

    asyncio.run(run())

    assert calls["count"] == 2
