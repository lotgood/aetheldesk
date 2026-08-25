import inspect
import json
import uuid
from collections.abc import Callable
from datetime import datetime, timezone
from importlib import import_module
from typing import Any, Protocol, TypeVar, cast

from backend import config
from backend import redis_contract
from backend.redis_contract import (
    normalize_room_id,
    room_metadata_key,
    room_pin_attempts_key,
    room_pin_block_key,
    room_state_key,
    room_tick_lock_key,
    room_token_index_key,
    room_token_key,
)
from backend.state import BackendState, normalize_state


ROOM_INDEX_KEY = f"{redis_contract.KEY_PREFIX}:rooms"
DEFAULT_MAX_ROOMS = 50
MAX_ROOM_TOKENS = 256
T = TypeVar("T")


# Keep the documented per-room lock key, but fence it by Redis server second.
# A completed slot stays as `slot|done`, blocking another worker in that same
# second while allowing the next second to replace it without waiting for EX=2.
_ACQUIRE_TICK_LEASE_SCRIPT = """
local now = redis.call('TIME')
local slot = tostring(now[1])
local current = redis.call('GET', KEYS[1])

if current then
  local current_slot, current_status = string.match(current, '^([^|]+)|([^|]+)')
  if not current_slot or current_slot == slot or current_status == 'running' then
    return nil
  end
  redis.call('DEL', KEYS[1])
end

local lease = slot .. '|running|' .. ARGV[1] .. '|' .. ARGV[2]
local acquired = redis.call('SET', KEYS[1], lease, 'EX', tonumber(ARGV[3]), 'NX')
if not acquired then
  return nil
end
return {slot, lease}
"""


_COMPLETE_TICK_LEASE_SCRIPT = """
local current = redis.call('GET', KEYS[1])
if current ~= ARGV[1] then
  return 0
end

local slot = string.match(ARGV[1], '^([^|]+)|running|')
if not slot then
  return 0
end

redis.call('SET', KEYS[1], slot .. '|done', 'EX', tonumber(ARGV[2]))
return 1
"""


_COMMIT_TICK_STATE_SCRIPT = """
local current = redis.call('GET', KEYS[1])
if current ~= ARGV[1] then
  return 0
end

local encoded_state = redis.call('GET', KEYS[2])
if not encoded_state then
  return 0
end
local decoded_state = cjson.decode(encoded_state)
local current_revision = tonumber(decoded_state['revision'] or 0)
if current_revision ~= tonumber(ARGV[2]) then
  return 0
end

local slot = string.match(ARGV[1], '^([^|]+)|running|')
if not slot then
  return 0
end

redis.call('SET', KEYS[2], ARGV[3], 'EX', tonumber(ARGV[4]))
redis.call('SET', KEYS[1], slot .. '|done', 'EX', tonumber(ARGV[5]))
return 1
"""


_COMPARE_AND_SET_STATE_SCRIPT = """
local encoded_state = redis.call('GET', KEYS[1])
if not encoded_state then
  return 0
end
local decoded_state = cjson.decode(encoded_state)
local current_revision = tonumber(decoded_state['revision'] or 0)
if current_revision ~= tonumber(ARGV[1]) then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
return 1
"""


_PRUNE_EXPIRED_ROOM_INDEX_SCRIPT = """
if redis.call('EXISTS', KEYS[2]) == 0 and redis.call('EXISTS', KEYS[3]) == 0 then
  redis.call('SREM', KEYS[1], ARGV[1])
  return 1
end
return 0
"""


_SERVER_TIME_SLOT_SCRIPT = """
local now = redis.call('TIME')
return now[1]
"""


_REGISTER_ROOM_TOKEN_SCRIPT = """
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
  return 1
end
if redis.call('SCARD', KEYS[1]) >= tonumber(ARGV[2]) then
  return 0
end
redis.call('SADD', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return 1
"""


_REFRESH_ROOM_TTL_SCRIPT = """
if redis.call('EXISTS', KEYS[1]) == 0 or redis.call('EXISTS', KEYS[2]) == 0 then
  return 0
end
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[1]))
if redis.call('EXISTS', KEYS[3]) == 1 then
  redis.call('EXPIRE', KEYS[3], tonumber(ARGV[1]))
end
return 1
"""


_CREATE_ROOM_SCRIPT = """
-- AETHEL_CREATE_ROOM
if redis.call('EXISTS', KEYS[2]) == 1 or redis.call('EXISTS', KEYS[3]) == 1 then
  return -1
end
redis.call('SREM', KEYS[1], ARGV[1])
if redis.call('SCARD', KEYS[1]) >= tonumber(ARGV[5]) then
  return -2
end
redis.call('DEL', KEYS[4])
redis.call('SET', KEYS[2], ARGV[2], 'EX', tonumber(ARGV[4]))
redis.call('SET', KEYS[3], ARGV[3], 'EX', tonumber(ARGV[4]))
redis.call('SADD', KEYS[1], ARGV[1])
return 1
"""


_ISSUE_ROOM_TOKEN_SCRIPT = """
-- AETHEL_ISSUE_ROOM_TOKEN
local encoded_metadata = redis.call('GET', KEYS[1])
if not encoded_metadata or redis.call('EXISTS', KEYS[2]) == 0 then
  return -1
end
local metadata = cjson.decode(encoded_metadata)
if metadata['room_instance_id'] ~= ARGV[1] then
  return -1
end
if redis.call('SISMEMBER', KEYS[3], ARGV[2]) == 0 then
  if redis.call('SCARD', KEYS[3]) >= tonumber(ARGV[3]) then
    return -2
  end
  redis.call('SADD', KEYS[3], ARGV[2])
end
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[4]))
redis.call('EXPIRE', KEYS[3], tonumber(ARGV[4]))
return 1
"""


_AUTHORIZE_ROOM_TOKEN_SCRIPT = """
-- AETHEL_AUTHORIZE_ROOM_TOKEN
local encoded_metadata = redis.call('GET', KEYS[1])
local encoded_state = redis.call('GET', KEYS[2])
if not encoded_metadata or not encoded_state then
  return nil
end
local metadata = cjson.decode(encoded_metadata)
if metadata['room_instance_id'] ~= ARGV[1] then
  return nil
end
if redis.call('SISMEMBER', KEYS[3], ARGV[2]) == 0 then
  if redis.call('GET', KEYS[4]) ~= ARGV[3] then
    return nil
  end
  if redis.call('SCARD', KEYS[3]) >= tonumber(ARGV[5]) then
    return nil
  end
  redis.call('SADD', KEYS[3], ARGV[2])
  redis.call('DEL', KEYS[4])
end
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[4]))
redis.call('EXPIRE', KEYS[3], tonumber(ARGV[4]))
return encoded_state
"""


class RedisUnavailable(RuntimeError):
    pass


class RoomLimitReached(RuntimeError):
    pass


class RoomAlreadyExists(RuntimeError):
    pass


class StateConflict(RuntimeError):
    pass


class TokenLimitReached(RuntimeError):
    pass


class RoomGenerationChanged(RuntimeError):
    pass


class RedisLike(Protocol):
    def get(self, name: str) -> object: ...
    def set(self, name: str, value: str, ex: int | None = None, nx: bool = False) -> object: ...
    def expire(self, name: str, time: int) -> object: ...
    def delete(self, *names: str) -> object: ...
    def sadd(self, name: str, *values: str) -> object: ...
    def srem(self, name: str, *values: str) -> object: ...
    def smembers(self, name: str) -> object: ...
    def sismember(self, name: str, value: str) -> object: ...
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
        # Prune unrelated naturally expired members before the atomic capacity
        # decision. The Lua transaction then serializes all concurrent creates.
        _ = await self.room_count()
        encoded_state = _json_dumps(state)
        encoded_metadata = _json_dumps(metadata or self._default_metadata(normalized))
        result = int(
            cast(
                int,
                await _redis_call(
                    lambda: cast(Any, self.redis).eval(
                        _CREATE_ROOM_SCRIPT,
                        4,
                        ROOM_INDEX_KEY,
                        room_state_key(normalized),
                        room_metadata_key(normalized),
                        room_token_index_key(normalized),
                        normalized,
                        encoded_state,
                        encoded_metadata,
                        self.ttl_seconds,
                        self.max_rooms,
                    )
                ),
            )
        )
        if result == -1:
            raise RoomAlreadyExists("room already exists")
        if result == -2:
            raise RoomLimitReached(f"room limit reached ({self.max_rooms})")
        if result != 1:
            raise RedisUnavailable("Redis room creation returned an invalid result")
        return state

    async def get_or_create_room(self, room_id: str, state_factory: Callable[[], BackendState]) -> BackendState | None:
        normalized = normalize_room_id(room_id)
        state = await self.get_state(normalized)
        metadata = await self.get_metadata(normalized)
        if state is not None and metadata is not None:
            return state if await self.refresh_ttl(normalized) else None
        if state is not None or metadata is not None:
            return None
        try:
            return await self.create_room(normalized, state_factory())
        except RoomAlreadyExists:
            return await self.get_state(normalized)

    async def get_state(self, room_id: str) -> BackendState | None:
        encoded = _decode_text(await _redis_call(lambda: self.redis.get(room_state_key(room_id))))
        if encoded is None:
            return None
        return normalize_state(cast(dict[str, object], json.loads(encoded)))

    async def set_state(self, room_id: str, state: BackendState) -> None:
        _ = await self._set_state(room_id, state)
        await self.refresh_ttl(room_id)

    async def _set_state(self, room_id: str, state: BackendState, *, nx: bool = False) -> bool:
        encoded = _json_dumps(state)
        result = await _redis_call(lambda: self.redis.set(room_state_key(room_id), encoded, ex=self.ttl_seconds, nx=nx))
        return bool(result)

    async def update_state(self, room_id: str, updater: Callable[[BackendState], None]) -> BackendState | None:
        for _attempt in range(8):
            state = await self.get_state(room_id)
            if state is None:
                return None
            expected_revision = state["revision"]
            updater(state)
            state["revision"] = expected_revision + 1
            if await self.compare_and_set_state(room_id, expected_revision, state):
                return state
        raise StateConflict("room state changed too frequently")

    async def compare_and_set_state(
        self,
        room_id: str,
        expected_revision: int,
        state: BackendState,
    ) -> bool:
        normalized = normalize_room_id(room_id)
        committed = await _redis_call(
            lambda: cast(Any, self.redis).eval(
                _COMPARE_AND_SET_STATE_SCRIPT,
                1,
                room_state_key(normalized),
                expected_revision,
                _json_dumps(state),
                self.ttl_seconds,
            )
        )
        if not committed:
            return False
        await self.refresh_ttl(normalized)
        return True

    async def get_metadata(self, room_id: str) -> dict[str, object] | None:
        encoded = _decode_text(await _redis_call(lambda: self.redis.get(room_metadata_key(room_id))))
        if encoded is None:
            return None
        return cast(dict[str, object], json.loads(encoded))

    async def set_metadata(self, room_id: str, metadata: dict[str, object]) -> None:
        encoded = _json_dumps(metadata)
        await _redis_call(lambda: self.redis.set(room_metadata_key(room_id), encoded, ex=self.ttl_seconds))

    async def refresh_ttl(self, room_id: str) -> bool:
        normalized = normalize_room_id(room_id)
        refreshed = await _redis_call(
            lambda: cast(Any, self.redis).eval(
                _REFRESH_ROOM_TTL_SCRIPT,
                3,
                room_state_key(normalized),
                room_metadata_key(normalized),
                room_token_index_key(normalized),
                self.ttl_seconds,
            )
        )
        return bool(refreshed)

    async def has_room(self, room_id: str) -> bool:
        return await self.get_state(room_id) is not None

    async def room_ids(self) -> tuple[str, ...]:
        members = cast(Any, await _redis_call(lambda: self.redis.smembers(ROOM_INDEX_KEY)))
        live_room_ids: list[str] = []
        for member in members:
            room_id = _decode_text(member)
            if not room_id:
                continue
            state_exists = await _redis_call(lambda room_id=room_id: self.redis.get(room_state_key(room_id)))
            metadata_exists = await _redis_call(lambda room_id=room_id: self.redis.get(room_metadata_key(room_id)))
            if state_exists is not None and metadata_exists is not None:
                live_room_ids.append(room_id)
                continue

            if state_exists is None and metadata_exists is None:
                # The index itself has no TTL. Once both canonical keys have
                # naturally expired, remove only the stale registry member.
                pruned = await self._prune_expired_room_index(room_id)
                if not pruned:
                    state_exists = await _redis_call(lambda room_id=room_id: self.redis.get(room_state_key(room_id)))
                    metadata_exists = await _redis_call(
                        lambda room_id=room_id: self.redis.get(room_metadata_key(room_id))
                    )
                    if state_exists is not None and metadata_exists is not None:
                        live_room_ids.append(room_id)
        return tuple(sorted(live_room_ids))

    async def room_count(self) -> int:
        members = cast(Any, await _redis_call(lambda: self.redis.smembers(ROOM_INDEX_KEY)))
        count = 0
        for member in members:
            room_id = _decode_text(member)
            if not room_id:
                continue
            state_exists = await _redis_call(lambda room_id=room_id: self.redis.get(room_state_key(room_id)))
            metadata_exists = await _redis_call(lambda room_id=room_id: self.redis.get(room_metadata_key(room_id)))
            if state_exists is None and metadata_exists is None:
                if await self._prune_expired_room_index(room_id):
                    continue
            # A one-sided room is intentionally counted but is not tickable.
            # This preserves fail-closed auth until the surviving key expires.
            count += 1
        return count

    async def _prune_expired_room_index(self, room_id: str) -> bool:
        normalized = normalize_room_id(room_id)
        pruned = await _redis_call(
            lambda: cast(Any, self.redis).eval(
                _PRUNE_EXPIRED_ROOM_INDEX_SCRIPT,
                3,
                ROOM_INDEX_KEY,
                room_state_key(normalized),
                room_metadata_key(normalized),
                normalized,
            )
        )
        return bool(pruned)

    async def expire_empty_room(self, room_id: str, *, has_connections: bool) -> bool:
        if has_connections:
            await self.refresh_ttl(room_id)
            return False
        normalized = normalize_room_id(room_id)
        token_hashes = await self._token_hashes(normalized)
        keys = [
            room_state_key(normalized),
            room_metadata_key(normalized),
            room_token_index_key(normalized),
            *(room_token_key(normalized, token_hash) for token_hash in token_hashes),
        ]
        await _redis_call(lambda: self.redis.delete(*keys))
        await _redis_call(lambda: self.redis.srem(ROOM_INDEX_KEY, normalized))
        return True

    async def set_token_lookup(
        self,
        room_id: str,
        token_hash: str,
        *,
        expected_instance_id: str | None = None,
    ) -> None:
        normalized = normalize_room_id(room_id)
        if expected_instance_id is not None:
            result = int(
                cast(
                    int,
                    await _redis_call(
                        lambda: cast(Any, self.redis).eval(
                            _ISSUE_ROOM_TOKEN_SCRIPT,
                            3,
                            room_metadata_key(normalized),
                            room_state_key(normalized),
                            room_token_index_key(normalized),
                            expected_instance_id,
                            token_hash,
                            MAX_ROOM_TOKENS,
                            self.ttl_seconds,
                        )
                    ),
                )
            )
            if result == -2:
                raise TokenLimitReached(f"room token limit reached ({MAX_ROOM_TOKENS})")
            if result != 1:
                raise RoomGenerationChanged("room generation changed during token issuance")
            return
        if not await self._track_token_hash(normalized, token_hash):
            raise TokenLimitReached(f"room token limit reached ({MAX_ROOM_TOKENS})")

    async def authorize_token(
        self,
        room_id: str,
        expected_instance_id: str,
        token_hash: str,
    ) -> BackendState | None:
        normalized = normalize_room_id(room_id)
        encoded = _decode_text(
            await _redis_call(
                lambda: cast(Any, self.redis).eval(
                    _AUTHORIZE_ROOM_TOKEN_SCRIPT,
                    4,
                    room_metadata_key(normalized),
                    room_state_key(normalized),
                    room_token_index_key(normalized),
                    room_token_key(normalized, token_hash),
                    expected_instance_id,
                    token_hash,
                    normalized,
                    self.ttl_seconds,
                    MAX_ROOM_TOKENS,
                )
            )
        )
        if encoded is None:
            return None
        return normalize_state(cast(dict[str, object], json.loads(encoded)))

    async def get_token_room_id(self, room_id: str, token_hash: str) -> str | None:
        normalized = normalize_room_id(room_id)
        token_index_key = room_token_index_key(normalized)
        indexed = await _redis_call(lambda: self.redis.sismember(token_index_key, token_hash))
        if indexed:
            await _redis_call(lambda: self.redis.expire(token_index_key, self.ttl_seconds))
            return normalized

        # One-release migration path for credentials issued before the token
        # set became authoritative. Successful use moves the hash into the set.
        token_key = room_token_key(normalized, token_hash)
        resolved = _decode_text(await _redis_call(lambda: self.redis.get(token_key)))
        if resolved == normalized:
            if await self._track_token_hash(normalized, token_hash):
                await _redis_call(lambda: self.redis.delete(token_key))
            else:
                await _redis_call(lambda: self.redis.expire(token_key, self.ttl_seconds))
        return resolved

    async def _track_token_hash(self, room_id: str, token_hash: str) -> bool:
        normalized = normalize_room_id(room_id)
        token_index_key = room_token_index_key(normalized)
        registered = await _redis_call(
            lambda: cast(Any, self.redis).eval(
                _REGISTER_ROOM_TOKEN_SCRIPT,
                1,
                token_index_key,
                token_hash,
                MAX_ROOM_TOKENS,
                self.ttl_seconds,
            )
        )
        return bool(registered)

    async def _token_hashes(self, room_id: str) -> tuple[str, ...]:
        members = cast(Any, await _redis_call(lambda: self.redis.smembers(room_token_index_key(room_id))))
        return tuple(sorted(value for member in members if (value := _decode_text(member))))

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

    async def acquire_tick_lock(
        self, room_id: str, owner: str, ttl_seconds: int = config.ROOM_TICK_LOCK_SECONDS
    ) -> tuple[int, str] | None:
        normalized = normalize_room_id(room_id)
        nonce = uuid.uuid4().hex
        lease_ttl = max(1, ttl_seconds)
        result = cast(
            Any,
            await _redis_call(
                lambda: cast(Any, self.redis).eval(
                    _ACQUIRE_TICK_LEASE_SCRIPT,
                    1,
                    room_tick_lock_key(normalized),
                    owner,
                    nonce,
                    lease_ttl,
                )
            ),
        )
        if not isinstance(result, (list, tuple)) or len(result) != 2:
            return None
        slot = _decode_text(result[0])
        lease = _decode_text(result[1])
        if slot is None or lease is None:
            return None
        return int(slot), lease

    async def current_time_slot(self) -> int:
        slot = await _redis_call(lambda: cast(Any, self.redis).eval(_SERVER_TIME_SLOT_SCRIPT, 0))
        decoded = _decode_text(slot)
        if decoded is None:
            raise RedisUnavailable("Redis TIME returned no value")
        return int(decoded)

    async def complete_tick_lock(
        self,
        room_id: str,
        lease: str,
        ttl_seconds: int = config.ROOM_TICK_LOCK_SECONDS,
    ) -> bool:
        normalized = normalize_room_id(room_id)
        completed = await _redis_call(
            lambda: cast(Any, self.redis).eval(
                _COMPLETE_TICK_LEASE_SCRIPT,
                1,
                room_tick_lock_key(normalized),
                lease,
                max(1, ttl_seconds),
            )
        )
        return bool(completed)

    async def commit_tick_state(
        self,
        room_id: str,
        lease: str,
        expected_revision: int,
        state: BackendState,
        lock_seconds: int = config.ROOM_TICK_LOCK_SECONDS,
    ) -> bool:
        normalized = normalize_room_id(room_id)
        committed = await _redis_call(
            lambda: cast(Any, self.redis).eval(
                _COMMIT_TICK_STATE_SCRIPT,
                2,
                room_tick_lock_key(normalized),
                room_state_key(normalized),
                lease,
                expected_revision,
                _json_dumps(state),
                self.ttl_seconds,
                max(1, lock_seconds),
            )
        )
        if not committed:
            return False
        await self.refresh_ttl(normalized)
        return True

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
