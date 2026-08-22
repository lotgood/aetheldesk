import inspect
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any, Protocol, TypeVar, cast

from backend import redis_contract
from backend.connection_manager import LocalConnectionManager
from backend.state import BACKEND_STATE_KEYS, BackendState


STATE_SNAPSHOT_EVENT = "state_snapshot"
T = TypeVar("T")


class RedisPublisher(Protocol):
    def publish(self, channel: str, message: str) -> object: ...
    def pubsub(self) -> "RedisPubSub": ...


class RedisPubSub(Protocol):
    def subscribe(self, *channels: str) -> object: ...
    def listen(self) -> AsyncIterator[dict[str, object]]: ...


StateLoader = Callable[[str], Awaitable[BackendState | None]]


async def _resolve(value: T) -> T:
    if inspect.isawaitable(value):
        return await cast(Any, value)
    return value


class RedisStateEventBus:
    def __init__(
        self,
        redis: RedisPublisher,
        *,
        worker_id: str,
        connections: LocalConnectionManager,
        load_canonical_state: StateLoader | None = None,
        recent_event_limit: int = 256,
    ) -> None:
        self.redis = redis
        self.worker_id = worker_id
        self.connections = connections
        self.load_canonical_state = load_canonical_state
        self.recent_event_limit = recent_event_limit
        self._recent_event_ids: dict[str, list[str]] = {}

    async def publish_state(self, room_id: str, state: BackendState) -> dict[str, object]:
        normalized = redis_contract.normalize_room_id(room_id)
        envelope = redis_contract.make_event_envelope(
            room_id=normalized,
            source_worker=self.worker_id,
            event_type=STATE_SNAPSHOT_EVENT,
            data=state,
        )
        self._remember_event(normalized, str(envelope["event_id"]))
        await _resolve(
            self.redis.publish(
                redis_contract.room_events_channel(normalized), json.dumps(envelope, separators=(",", ":"))
            )
        )
        return envelope

    async def dispatch_message(self, message: object) -> bool:
        envelope = self._coerce_envelope(message)
        if envelope is None:
            return False
        return await self.dispatch_envelope(envelope)

    async def dispatch_envelope(self, envelope: dict[str, object]) -> bool:
        if not self._accepts_envelope(envelope):
            return False

        room_id = redis_contract.normalize_room_id(cast(str, envelope["room_id"]))
        event_id = str(envelope["event_id"])
        self._remember_event(room_id, event_id)

        state = cast(BackendState | None, envelope.get("data"))
        if self.load_canonical_state is not None:
            canonical = await self.load_canonical_state(room_id)
            if canonical is not None:
                state = canonical

        if state is None:
            return False

        await self.connections.broadcast_json(room_id, {"type": "state", "data": state})
        return True

    async def sync_room_from_store(self, room_id: str) -> bool:
        if self.load_canonical_state is None:
            return False
        normalized = redis_contract.normalize_room_id(room_id)
        state = await self.load_canonical_state(normalized)
        if state is None:
            return False
        await self.connections.broadcast_json(normalized, {"type": "state", "data": state})
        return True

    async def consume_room_events(self, room_id: str) -> None:
        normalized = redis_contract.normalize_room_id(room_id)
        pubsub = self.redis.pubsub()
        await _resolve(pubsub.subscribe(redis_contract.room_events_channel(normalized)))
        try:
            async for message in pubsub.listen():
                if not isinstance(message, dict) or message.get("type") != "message":
                    continue
                await self.dispatch_message(message.get("data"))
        finally:
            close = getattr(pubsub, "aclose", None) or getattr(pubsub, "close", None)
            if close is not None:
                await _resolve(close())

    def _accepts_envelope(self, envelope: dict[str, object]) -> bool:
        if envelope.get("version") != redis_contract.EVENT_VERSION:
            return False
        if envelope.get("type") != STATE_SNAPSHOT_EVENT:
            return False
        if envelope.get("source_worker") == self.worker_id:
            return False
        room_id = envelope.get("room_id")
        event_id = envelope.get("event_id")
        if not isinstance(room_id, str) or not isinstance(event_id, str):
            return False
        if self._has_seen_event(redis_contract.normalize_room_id(room_id), event_id):
            return False
        return self._is_state_snapshot(envelope.get("data"))

    def _coerce_envelope(self, message: object) -> dict[str, object] | None:
        if isinstance(message, bytes):
            message = message.decode("utf-8")
        if isinstance(message, str):
            try:
                decoded = json.loads(message)
            except json.JSONDecodeError:
                return None
            return decoded if isinstance(decoded, dict) else None
        return message if isinstance(message, dict) else None

    def _has_seen_event(self, room_id: str, event_id: str) -> bool:
        return event_id in self._recent_event_ids.get(room_id, [])

    def _is_state_snapshot(self, value: object) -> bool:
        return (
            isinstance(value, dict) and set(value.keys()) == BACKEND_STATE_KEYS and isinstance(value.get("music"), dict)
        )

    def _remember_event(self, room_id: str, event_id: str) -> None:
        recent = self._recent_event_ids.setdefault(room_id, [])
        if event_id in recent:
            return
        recent.append(event_id)
        if len(recent) > self.recent_event_limit:
            del recent[: len(recent) - self.recent_event_limit]
