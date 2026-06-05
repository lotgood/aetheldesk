import hashlib
import hmac
import os
from typing import Protocol, cast

from fastapi import HTTPException, Request

try:
    from backend import auth, config
    from backend import runtime as runtime_module
    from backend.redis_contract import is_valid_room_id, normalize_room_id
except ModuleNotFoundError:
    import auth
    import config
    import runtime as runtime_module
    from redis_contract import is_valid_room_id, normalize_room_id


PIN_MIN_LENGTH = 4
PIN_MAX_LENGTH = 64
ROOM_INSTANCE_ID_KEY = "room_instance_id"


class _RoomStore(Protocol):
    async def get_metadata(self, room_id: str) -> dict[str, object] | None: ...
    async def has_room(self, room_id: str) -> bool: ...
    async def set_token_lookup(self, room_id: str, token_hash: str) -> None: ...
    async def get_token_room_id(self, room_id: str, token_hash: str) -> str | None: ...
    async def is_pin_blocked(self, room_id: str, fingerprint: str) -> bool: ...
    async def record_failed_pin_attempt(
        self,
        room_id: str,
        fingerprint: str,
        *,
        attempt_window_seconds: int,
        max_attempts: int,
        block_seconds: int,
    ) -> bool: ...


class _Runtime(Protocol):
    room_store: _RoomStore | None
    local_room_instance_ids: dict[str, str]
    local_token_hashes: dict[str, set[str]]


def _runtime() -> _Runtime:
    return cast(_Runtime, runtime_module.get_runtime())


def generated_room_id() -> str:
    return "R" + os.urandom(4).hex().upper()[:7]


def new_room_instance_id() -> str:
    return auth.create_token()


def metadata_room_instance_id(metadata: dict[str, object] | None) -> str | None:
    if metadata is None:
        return None
    room_instance_id = metadata.get(ROOM_INSTANCE_ID_KEY)
    return room_instance_id if isinstance(room_instance_id, str) and room_instance_id else None


def scoped_token_hash(token: str, room_instance_id: str) -> str:
    return auth.hash_token(f"{room_instance_id}:{token}")


def require_valid_room_id(room_id: str) -> str:
    normalized = normalize_room_id(room_id)
    if not is_valid_room_id(normalized):
        raise HTTPException(status_code=400, detail="invalid room id")
    return normalized


def client_fingerprint(request: Request) -> str:
    ip: str | None = None
    if config.TRUST_PROXY:
        forwarded = request.headers.get("x-forwarded-for", "")
        ip = forwarded.split(",", 1)[0].strip() or None
    if not ip:
        ip = request.client.host if request.client is not None else "unknown"
    key = config.get_secret_key().encode("utf-8")
    return hmac.new(key, ip.encode("utf-8"), hashlib.sha256).hexdigest()


async def auth_failure() -> None:
    raise HTTPException(status_code=401, detail=auth.failure_body()["detail"])


async def assert_not_rate_limited(room_id: str, fingerprint: str) -> None:
    runtime = _runtime()
    if runtime.room_store is None:
        return
    if await runtime.room_store.is_pin_blocked(room_id, fingerprint):
        raise HTTPException(status_code=403, detail=auth.failure_body()["detail"])


async def record_failed_attempt(room_id: str, fingerprint: str) -> None:
    runtime = _runtime()
    if runtime.room_store is None:
        return
    policy = auth.PinRatePolicy()
    blocked = await runtime.room_store.record_failed_pin_attempt(
        room_id,
        fingerprint,
        attempt_window_seconds=policy.attempt_window_seconds,
        max_attempts=policy.max_attempts,
        block_seconds=policy.block_seconds,
    )
    if blocked:
        raise HTTPException(status_code=403, detail=auth.failure_body()["detail"])


async def issue_room_token(room_id: str) -> str:
    runtime = _runtime()
    normalized = normalize_room_id(room_id)
    token = auth.create_token()
    if runtime.room_store is not None:
        metadata = await runtime.room_store.get_metadata(normalized)
        room_instance_id = metadata_room_instance_id(metadata)
        if room_instance_id is None or not await runtime.room_store.has_room(normalized):
            await auth_failure()
        else:
            token_hash = scoped_token_hash(token, room_instance_id)
        await runtime.room_store.set_token_lookup(normalized, token_hash)
    else:
        room_instance_id = runtime.local_room_instance_ids.get(normalized)
        if room_instance_id is None:
            await auth_failure()
        else:
            token_hash = scoped_token_hash(token, room_instance_id)
        runtime.local_token_hashes.setdefault(normalized, set()).add(token_hash)
    return token


async def token_authorizes_room(room_id: str, token: str) -> bool:
    runtime = _runtime()
    normalized = normalize_room_id(room_id)
    if runtime.room_store is not None:
        metadata = await runtime.room_store.get_metadata(normalized)
        room_instance_id = metadata_room_instance_id(metadata)
        if room_instance_id is None:
            return False
        token_hash = scoped_token_hash(token, room_instance_id)
        resolved_room = await runtime.room_store.get_token_room_id(normalized, token_hash)
        return resolved_room == normalized
    room_instance_id = runtime.local_room_instance_ids.get(normalized)
    if room_instance_id is None:
        return False
    token_hash = scoped_token_hash(token, room_instance_id)
    return token_hash in runtime.local_token_hashes.get(normalized, set())
