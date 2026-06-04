import inspect
import json
from collections.abc import Callable
from datetime import datetime, timezone
from importlib import import_module
from typing import Any, Protocol, TypeVar, cast

try:
    from backend import config
    from backend import redis_contract
    from backend.redis_contract import (
        normalize_room_id,
        room_metadata_key,
        room_pin_attempts_key,
        room_pin_block_key,
        room_tick_lock_key,
        room_state_key,
        room_token_key,
    )
    from backend.state import BackendState
except ModuleNotFoundError:
    import config
    import redis_contract
    from redis_contract import (
        normalize_room_id,
        room_metadata_key,
        room_pin_attempts_key,
        room_pin_block_key,
        room_tick_lock_key,
        room_state_key,
        room_token_key,
    )
    from state import BackendState


ROOM_INDEX_KEY = f"{redis_contract.KEY_PREFIX}:rooms"
DEFAULT_MAX_ROOMS = 50
T = TypeVar("T")


class RedisUnavailable(RuntimeError):
    pass


class RoomLimitReached(RuntimeError):
    pass


class RoomAlreadyExists(RuntimeError):
    pass


class RedisLike(Protocol):
    def get(self, name: str) -> object: ...
    def set(self, name: str, value: str, ex: int | None = None, nx: bool = False) -> object: ...
    def expire(self, name: str, time: int) -> object: ...
    def delete(self, *names: str) -> object: ...
    def sadd(self, name: str, *values: str) -> object: ...
    def srem(self, name: str, *values: str) -> object: ...
    def smembers(self, name: str) -> object: ...
    def scard(self, name: str) -> object: ...
    def ping(self) -> object: ...
    def incr(self, name: str) -> object: ...


async def _resolve(value: T) -> T:
    if inspect.isawaitable(value):
        return await cast(Any, value)
    return value


def _is_redis_outage(exc: BaseException) -> bool:
    if isinstance(exc, (ConnectionError, OSError, TimeoutError)):
        return True
    return exc.__class__.__module__.startswith("redis") and exc.__class__.__name__ in {
        "BusyLoadingError",
        "ConnectionError",
        "TimeoutError",
    }


async def _redis_call(operation: Callable[[], T]) -> T:
    try:
        return await _resolve(operation())
    except Exception as exc:
        if _is_redis_outage(exc):
            raise RedisUnavailable("Redis is unavailable") from exc
        raise


def _decode_text(value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return str(value)


def _json_dumps(payload: object) -> str:
    return json.dumps(payload, separators=(",", ":"))


class RoomStore:
    def __init__(
        self,
        redis: RedisLike,
        *,
        ttl_seconds: int = config.ROOM_TTL_SECONDS,
        max_rooms: int = DEFAULT_MAX_ROOMS,
    ) -> None:
        self.redis = redis
        self.ttl_seconds = ttl_seconds
        self.max_rooms = max_rooms

    async def ping(self) -> None:
        await _redis_call(self.redis.ping)

    async def create_room(
        self,
        room_id: str,
        state: BackendState,
        *,
        metadata: dict[str, object] | None = None,
    ) -> BackendState:
        normalized = normalize_room_id(room_id)
        if await self.get_state(normalized) is not None or await self.get_metadata(normalized) is not None:
            raise RoomAlreadyExists("room already exists")
        if await self.room_count() >= self.max_rooms:
            raise RoomLimitReached(f"room limit reached ({self.max_rooms})")

        created = await self._set_state(normalized, state, nx=True)
        if not created:
            raise RoomAlreadyExists("room already exists")

        try:
            await self.set_metadata(normalized, metadata or self._default_metadata(normalized))
            await _redis_call(lambda: self.redis.sadd(ROOM_INDEX_KEY, normalized))
            await self.refresh_ttl(normalized)
        except Exception:
            await _redis_call(lambda: self.redis.delete(room_state_key(normalized), room_metadata_key(normalized)))
            raise
        return state

    async def get_or_create_room(self, room_id: str, state_factory: Callable[[], BackendState]) -> BackendState | None:
        normalized = normalize_room_id(room_id)
        state = await self.get_state(normalized)
        if state is not None:
            await self.refresh_ttl(normalized)
            return state
        if await self.get_metadata(normalized) is not None:
            return None
        try:
            return await self.create_room(normalized, state_factory())
        except RoomAlreadyExists:
            return await self.get_state(normalized)

    async def get_state(self, room_id: str) -> BackendState | None:
        encoded = _decode_text(await _redis_call(lambda: self.redis.get(room_state_key(room_id))))
        if encoded is None:
            return None
        return cast(BackendState, json.loads(encoded))

    async def set_state(self, room_id: str, state: BackendState) -> None:
        _ = await self._set_state(room_id, state)

    async def _set_state(self, room_id: str, state: BackendState, *, nx: bool = False) -> bool:
        encoded = _json_dumps(state)
        result = await _redis_call(lambda: self.redis.set(room_state_key(room_id), encoded, ex=self.ttl_seconds, nx=nx))
        return bool(result)

    async def update_state(self, room_id: str, updater: Callable[[BackendState], None]) -> BackendState | None:
        state = await self.get_state(room_id)
        if state is None:
            return None
        updater(state)
        await self.set_state(room_id, state)
        await self.refresh_ttl(room_id)
        return state

    async def get_metadata(self, room_id: str) -> dict[str, object] | None:
        encoded = _decode_text(await _redis_call(lambda: self.redis.get(room_metadata_key(room_id))))
        if encoded is None:
            return None
        return cast(dict[str, object], json.loads(encoded))

    async def set_metadata(self, room_id: str, metadata: dict[str, object]) -> None:
        encoded = _json_dumps(metadata)
        await _redis_call(lambda: self.redis.set(room_metadata_key(room_id), encoded, ex=self.ttl_seconds))

    async def refresh_ttl(self, room_id: str) -> None:
        await _redis_call(lambda: self.redis.expire(room_state_key(room_id), self.ttl_seconds))
        await _redis_call(lambda: self.redis.expire(room_metadata_key(room_id), self.ttl_seconds))

    async def has_room(self, room_id: str) -> bool:
        return await self.get_state(room_id) is not None

    async def room_ids(self) -> tuple[str, ...]:
        members = cast(Any, await _redis_call(lambda: self.redis.smembers(ROOM_INDEX_KEY)))
        return tuple(sorted(_decode_text(member) or "" for member in members))

    async def room_count(self) -> int:
        count = await _redis_call(lambda: self.redis.scard(ROOM_INDEX_KEY))
        return int(cast(int, count))

    async def expire_empty_room(self, room_id: str, *, has_connections: bool) -> bool:
        if has_connections:
            await self.refresh_ttl(room_id)
            return False
        normalized = normalize_room_id(room_id)
        await _redis_call(lambda: self.redis.delete(room_state_key(normalized), room_metadata_key(normalized)))
        await _redis_call(lambda: self.redis.srem(ROOM_INDEX_KEY, normalized))
        return True

    async def set_token_lookup(self, room_id: str, token_hash: str) -> None:
        normalized = normalize_room_id(room_id)
        await _redis_call(lambda: self.redis.set(room_token_key(normalized, token_hash), normalized, ex=self.ttl_seconds))

    async def get_token_room_id(self, room_id: str, token_hash: str) -> str | None:
        return _decode_text(await _redis_call(lambda: self.redis.get(room_token_key(room_id, token_hash))))

    async def is_pin_blocked(self, room_id: str, fingerprint: str) -> bool:
        normalized = normalize_room_id(room_id)
        value = await _redis_call(lambda: self.redis.get(room_pin_block_key(normalized, fingerprint)))
        return _decode_text(value) is not None

    async def record_failed_pin_attempt(
        self,
        room_id: str,
        fingerprint: str,
        *,
        attempt_window_seconds: int,
        max_attempts: int,
        block_seconds: int,
    ) -> bool:
        normalized = normalize_room_id(room_id)
        attempts_key = room_pin_attempts_key(normalized, fingerprint)
        block_key = room_pin_block_key(normalized, fingerprint)

        attempts = int(cast(int, await _redis_call(lambda: self.redis.incr(attempts_key))))
        if attempts == 1:
            await _redis_call(lambda: self.redis.expire(attempts_key, attempt_window_seconds))

        if attempts >= max_attempts:
            await _redis_call(lambda: self.redis.set(block_key, "1", ex=block_seconds))
            return True
        return False

    async def acquire_tick_lock(self, room_id: str, owner: str, ttl_seconds: int = config.ROOM_TICK_LOCK_SECONDS) -> bool:
        normalized = normalize_room_id(room_id)
        acquired = await _redis_call(lambda: self.redis.set(room_tick_lock_key(normalized), owner, ex=ttl_seconds, nx=True))
        return bool(acquired)

    def _default_metadata(self, room_id: str) -> dict[str, object]:
        return {
            "room_id": normalize_room_id(room_id),
            "created_at": datetime.now(timezone.utc).isoformat(),
        }


async def create_redis_store() -> RoomStore:
    try:
        redis_asyncio = import_module("redis.asyncio")
    except ModuleNotFoundError as exc:
        raise RedisUnavailable("redis package is required outside test mode") from exc

    client = redis_asyncio.from_url(config.REDIS_URL, decode_responses=True)
    store = RoomStore(client)
    await store.ping()
    return store
