import asyncio
import builtins
import importlib
import json
from typing import Any, cast

from fastapi import WebSocket

from backend.connection_manager import LocalConnectionManager
from backend.redis_contract import room_tick_lock_key
from backend.room_store import RoomStore
from backend.state import BackendState, make_state

scheduler_module = importlib.import_module("backend.scheduler")
RoomTickScheduler = cast(Any, scheduler_module.RoomTickScheduler)


class FakeRedis:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.sets: dict[str, builtins.set[str]] = {}
        self.ttls: dict[str, int] = {}

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
    assert redis.values[room_tick_lock_key("ROOM-A")] == "worker-a"
    assert redis.ttls[room_tick_lock_key("ROOM-A")] == 2
    assert decoded_messages(socket_a) == [{"type": "state", "data": state}]
    assert decoded_messages(socket_b) == []
    assert publisher_a.published == [("ROOM-A", state)]
    assert publisher_b.published == []


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
        redis.values[room_tick_lock_key("ROOM-A")] = "other-worker"
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
