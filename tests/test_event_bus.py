import asyncio
import importlib
import json
import logging
from types import SimpleNamespace
from typing import Any, cast

import pytest
from fastapi import WebSocket

from backend.connection_manager import LocalConnectionManager
from backend.redis_contract import make_event_envelope, room_events_channel
from backend.room_store import RedisUnavailable
from backend import room_service
from backend.state import BackendState, make_state

event_bus_module = importlib.import_module("backend.event_bus")
STATE_SNAPSHOT_EVENT = cast(str, event_bus_module.STATE_SNAPSHOT_EVENT)
RedisStateEventBus = cast(Any, event_bus_module.RedisStateEventBus)


class DummyWebSocket:
    def __init__(self) -> None:
        self.messages: list[str] = []

    async def send_text(self, message: str) -> None:
        self.messages.append(message)


class FakePubSub:
    def __init__(self, messages: list[dict[str, object]]) -> None:
        self.messages = messages
        self.subscribed: list[str] = []
        self.closed = False

    async def subscribe(self, *channels: str) -> bool:
        self.subscribed.extend(channels)
        return True

    async def listen(self):
        for message in self.messages:
            yield message

    async def aclose(self) -> None:
        self.closed = True


class FakeRedis:
    def __init__(self, messages: list[dict[str, object]] | None = None) -> None:
        self.published: list[tuple[str, str]] = []
        self.pubsub_instance = FakePubSub(messages or [])

    async def publish(self, channel: str, message: str) -> int:
        self.published.append((channel, message))
        return 1

    def pubsub(self) -> FakePubSub:
        return self.pubsub_instance


class ControlledPubSub(FakePubSub):
    def __init__(self) -> None:
        super().__init__([])
        self.subscribe_started = asyncio.Event()
        self.allow_subscribe = asyncio.Event()
        self.keep_listening = asyncio.Event()

    async def subscribe(self, *channels: str) -> bool:
        self.subscribe_started.set()
        await self.allow_subscribe.wait()
        return await super().subscribe(*channels)

    async def listen(self):
        await self.keep_listening.wait()
        if False:
            yield {}


class FailingPublishRedis(FakeRedis):
    async def publish(self, channel: str, message: str) -> int:
        raise ConnectionError("redis down")


def sample_state(*, remaining: int = 42, marker: str = "celestial") -> BackendState:
    state = make_state(lambda *_args, **_kwargs: {"marker": marker})
    state["focus"] = True
    state["pomodoro_remaining"] = remaining
    return state


def decoded_messages(websocket: DummyWebSocket) -> list[dict[str, object]]:
    return [json.loads(message) for message in websocket.messages]


def event_payload(room_id: str, source_worker: str, event_id: str, state: BackendState) -> dict[str, object]:
    return make_event_envelope(
        room_id=room_id,
        source_worker=source_worker,
        event_type=STATE_SNAPSHOT_EVENT,
        event_id=event_id,
        data=state,
    )


def test_publish_state_uses_contract_channel_and_full_snapshot_envelope():
    redis = FakeRedis()
    manager = LocalConnectionManager()
    bus = RedisStateEventBus(redis, worker_id="worker-a", connections=manager)
    state = sample_state(remaining=37)

    async def run() -> dict[str, object]:
        return await bus.publish_state(" room-a ", state)

    envelope = asyncio.run(run())
    channel, payload = redis.published[0]
    decoded = json.loads(payload)

    assert channel == room_events_channel("ROOM-A")
    assert decoded == envelope
    assert set(decoded) == {"version", "room_id", "event_id", "source_worker", "type", "data"}
    assert decoded["room_id"] == "ROOM-A"
    assert decoded["source_worker"] == "worker-a"
    assert decoded["type"] == STATE_SNAPSHOT_EVENT
    assert decoded["data"] == state


def test_dispatch_ignores_self_origin_and_duplicate_event_ids():
    redis = FakeRedis()
    manager = LocalConnectionManager()
    websocket = DummyWebSocket()
    manager.connect("room-a", cast(WebSocket, websocket))
    bus = RedisStateEventBus(redis, worker_id="worker-a", connections=manager)
    state = sample_state(remaining=24)
    self_origin = event_payload("ROOM-A", "worker-a", "evt-self", state)
    remote = event_payload("ROOM-A", "worker-b", "evt-1", state)

    async def run() -> tuple[bool, bool, bool]:
        first = await bus.dispatch_envelope(self_origin)
        second = await bus.dispatch_envelope(remote)
        third = await bus.dispatch_envelope(remote)
        return first, second, third

    assert asyncio.run(run()) == (False, True, False)
    assert decoded_messages(websocket) == [{"type": "state", "data": state}]


def test_published_snapshot_fans_out_on_other_workers_but_not_source_worker():
    redis = FakeRedis()
    state = sample_state(remaining=18)
    source_manager = LocalConnectionManager()
    first_remote_manager = LocalConnectionManager()
    second_remote_manager = LocalConnectionManager()
    source_socket = DummyWebSocket()
    first_remote_socket = DummyWebSocket()
    second_remote_socket = DummyWebSocket()
    source_manager.connect("room-a", cast(WebSocket, source_socket))
    first_remote_manager.connect("room-a", cast(WebSocket, first_remote_socket))
    second_remote_manager.connect("room-a", cast(WebSocket, second_remote_socket))
    source_bus = RedisStateEventBus(redis, worker_id="worker-a", connections=source_manager)
    first_remote_bus = RedisStateEventBus(redis, worker_id="worker-b", connections=first_remote_manager)
    second_remote_bus = RedisStateEventBus(redis, worker_id="worker-c", connections=second_remote_manager)

    async def run() -> None:
        await source_bus.publish_state("room-a", state)
        _channel, payload = redis.published[0]
        await source_bus.dispatch_message(payload)
        await first_remote_bus.dispatch_message(payload)
        await second_remote_bus.dispatch_message(payload)

    asyncio.run(run())

    assert decoded_messages(source_socket) == []
    assert decoded_messages(first_remote_socket) == [{"type": "state", "data": state}]
    assert decoded_messages(second_remote_socket) == [{"type": "state", "data": state}]


def test_consume_room_events_subscribes_and_dispatches_messages():
    state = sample_state(remaining=12)
    envelope = event_payload("room-a", "worker-b", "evt-subscribe", state)
    redis = FakeRedis([{"type": "message", "data": json.dumps(envelope)}])
    manager = LocalConnectionManager()
    websocket = DummyWebSocket()
    manager.connect("room-a", cast(WebSocket, websocket))
    bus = RedisStateEventBus(redis, worker_id="worker-a", connections=manager)

    asyncio.run(bus.consume_room_events("room-a"))

    assert redis.pubsub_instance.subscribed == [room_events_channel("ROOM-A")]
    assert redis.pubsub_instance.closed is True
    assert decoded_messages(websocket) == [{"type": "state", "data": state}]


def test_consumer_ready_future_waits_for_subscribe_ack_and_closes_cleanly():
    redis = FakeRedis()
    controlled = ControlledPubSub()
    redis.pubsub_instance = controlled
    bus = RedisStateEventBus(redis, worker_id="worker-a", connections=LocalConnectionManager())

    async def run() -> None:
        ready = asyncio.get_running_loop().create_future()
        task = asyncio.create_task(bus.consume_room_events("room-a", ready))
        await controlled.subscribe_started.wait()
        assert ready.done() is False
        controlled.allow_subscribe.set()
        await ready
        assert controlled.subscribed == [room_events_channel("ROOM-A")]
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(run())
    assert controlled.closed is True


def test_ensure_room_events_does_not_sync_or_return_before_subscription_ready(
    monkeypatch: pytest.MonkeyPatch,
):
    class ControlledBus:
        def __init__(self) -> None:
            self.subscribe_started = asyncio.Event()
            self.allow_subscribe = asyncio.Event()
            self.keep_listening = asyncio.Event()
            self.order: list[str] = []

        async def consume_room_events(self, _room_id: str, ready: asyncio.Future[None]) -> None:
            self.subscribe_started.set()
            await self.allow_subscribe.wait()
            self.order.append("subscribed")
            ready.set_result(None)
            await self.keep_listening.wait()

        async def sync_room_from_store(self, _room_id: str) -> bool:
            self.order.append("sync")
            return True

    async def run() -> None:
        bus = ControlledBus()
        runtime = SimpleNamespace(
            event_bus=bus,
            event_subscription_tasks={},
            event_subscription_ready={},
            logger=logging.getLogger("test.event-bus"),
            connections=LocalConnectionManager(),
            WS_OPERATIONAL_CLOSE_CODE=1011,
            WS_OPERATIONAL_CLOSE_REASON="service unavailable",
        )
        monkeypatch.setattr(room_service, "_runtime", lambda: runtime)
        ensure_task = asyncio.create_task(room_service.ensure_room_events("room-a"))
        await bus.subscribe_started.wait()
        await asyncio.sleep(0)
        assert ensure_task.done() is False
        assert bus.order == []
        bus.allow_subscribe.set()
        await ensure_task
        assert bus.order == ["subscribed", "sync"]
        await room_service.ensure_room_events("room-a")
        assert bus.order == ["subscribed", "sync"]
        await room_service.stop_room_events("room-a")

    asyncio.run(run())


def test_publish_connection_error_is_normalized_to_redis_unavailable():
    bus = RedisStateEventBus(
        FailingPublishRedis(),
        worker_id="worker-a",
        connections=LocalConnectionManager(),
    )

    with pytest.raises(RedisUnavailable):
        asyncio.run(bus.publish_state("room-a", sample_state()))


def test_canonical_state_load_repairs_missed_pubsub_before_fanout():
    stale_state = sample_state(remaining=99)
    canonical_state = sample_state(remaining=7, marker="canonical")
    loads: list[str] = []

    async def load_canonical(room_id: str) -> BackendState | None:
        loads.append(room_id)
        return canonical_state

    redis = FakeRedis()
    manager = LocalConnectionManager()
    websocket = DummyWebSocket()
    manager.connect("room-a", cast(WebSocket, websocket))
    bus = RedisStateEventBus(
        redis,
        worker_id="worker-a",
        connections=manager,
        load_canonical_state=load_canonical,
    )
    envelope = event_payload("room-a", "worker-b", "evt-canonical", stale_state)

    async def run() -> tuple[bool, bool]:
        dispatched = await bus.dispatch_envelope(envelope)
        synced = await bus.sync_room_from_store("room-a")
        return dispatched, synced

    assert asyncio.run(run()) == (True, True)
    assert loads == ["ROOM-A", "ROOM-A"]
    assert decoded_messages(websocket) == [{"type": "state", "data": canonical_state}]


def test_canonical_snapshot_fans_out_only_to_matching_room_generation():
    state = sample_state(remaining=5, marker="new-generation")

    async def load_snapshot(_room_id: str) -> tuple[BackendState, str] | None:
        return state, "new-generation"

    redis = FakeRedis()
    manager = LocalConnectionManager()
    old_socket = DummyWebSocket()
    new_socket = DummyWebSocket()
    manager.connect("room-a", cast(WebSocket, old_socket), "old-generation")
    manager.connect("room-a", cast(WebSocket, new_socket), "new-generation")
    bus = RedisStateEventBus(
        redis,
        worker_id="worker-a",
        connections=manager,
        load_canonical_snapshot=load_snapshot,
    )
    envelope = event_payload("room-a", "worker-b", "evt-new-generation", state)

    assert asyncio.run(bus.dispatch_envelope(envelope)) is True
    assert decoded_messages(old_socket) == []
    assert decoded_messages(new_socket) == [{"type": "state", "data": state}]
    assert manager.connections_for("room-a") == frozenset({cast(WebSocket, new_socket)})


def test_delta_payload_is_not_accepted_as_state_source():
    redis = FakeRedis()
    manager = LocalConnectionManager()
    websocket = DummyWebSocket()
    manager.connect("room-a", cast(WebSocket, websocket))
    bus = RedisStateEventBus(redis, worker_id="worker-a", connections=manager)
    delta = make_event_envelope(
        room_id="room-a",
        source_worker="worker-b",
        event_type=STATE_SNAPSHOT_EVENT,
        event_id="evt-delta",
        data={"pomodoro_remaining": 1},
    )

    assert asyncio.run(bus.dispatch_envelope(delta)) is False
    assert decoded_messages(websocket) == []


def test_snapshot_missing_required_key_is_rejected():
    redis = FakeRedis()
    manager = LocalConnectionManager()
    websocket = DummyWebSocket()
    manager.connect("room-a", cast(WebSocket, websocket))
    bus = RedisStateEventBus(redis, worker_id="worker-a", connections=manager)
    state = sample_state()
    partial_state = dict(state)
    partial_state.pop("time_override")
    envelope = event_payload("room-a", "worker-b", "evt-missing", cast(BackendState, partial_state))

    assert asyncio.run(bus.dispatch_envelope(envelope)) is False
    assert decoded_messages(websocket) == []


def test_snapshot_with_extra_key_is_rejected():
    redis = FakeRedis()
    manager = LocalConnectionManager()
    websocket = DummyWebSocket()
    manager.connect("room-a", cast(WebSocket, websocket))
    bus = RedisStateEventBus(redis, worker_id="worker-a", connections=manager)
    state = sample_state()
    expanded_state = dict(state)
    expanded_state["unexpected"] = True
    envelope = event_payload("room-a", "worker-b", "evt-extra", cast(BackendState, expanded_state))

    assert asyncio.run(bus.dispatch_envelope(envelope)) is False
    assert decoded_messages(websocket) == []


def test_invalid_envelope_is_rejected_safely():
    redis = FakeRedis()
    manager = LocalConnectionManager()
    websocket = DummyWebSocket()
    manager.connect("room-a", cast(WebSocket, websocket))
    bus = RedisStateEventBus(redis, worker_id="worker-a", connections=manager)
    state = sample_state()
    invalid_version = event_payload("room-a", "worker-b", "evt-invalid", state)
    invalid_version["version"] = "0"

    async def run() -> tuple[bool, bool, bool]:
        invalid_first = await bus.dispatch_envelope(invalid_version)
        invalid_second = await bus.dispatch_message("not-json")
        invalid_third = await bus.dispatch_message(json.dumps(["wrong-shape"]))
        return invalid_first, invalid_second, invalid_third

    assert asyncio.run(run()) == (False, False, False)
    assert decoded_messages(websocket) == []
