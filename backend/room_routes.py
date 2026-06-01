from fastapi import APIRouter, HTTPException, Request
from importlib import import_module
from pydantic import BaseModel, Field
from typing import Any, cast

try:
    from backend import auth
    from backend.room_store import RedisUnavailable, RoomLimitReached
except ModuleNotFoundError:
    import auth
    from room_store import RedisUnavailable, RoomLimitReached


def _backend_module(name: str) -> Any:
    try:
        return import_module(f"backend.{name}")
    except ModuleNotFoundError:
        return import_module(name)


_room_service = _backend_module("room_service")
PIN_MAX_LENGTH = cast(int, _room_service.PIN_MAX_LENGTH)
PIN_MIN_LENGTH = cast(int, _room_service.PIN_MIN_LENGTH)
_assert_not_rate_limited = cast(Any, _room_service._assert_not_rate_limited)
_auth_failure = cast(Any, _room_service._auth_failure)
_client_fingerprint = cast(Any, _room_service._client_fingerprint)
_generated_room_id = cast(Any, _room_service._generated_room_id)
_issue_room_token = cast(Any, _room_service._issue_room_token)
_record_failed_attempt = cast(Any, _room_service._record_failed_attempt)
_require_valid_room_id = cast(Any, _room_service._require_valid_room_id)
_runtime = cast(Any, _room_service._runtime)
get_room = cast(Any, _room_service.get_room)
make_state = cast(Any, _room_service.make_state)


router = APIRouter()


class CreateRoomRequest(BaseModel):
    room_id: str | None = Field(default=None)
    pin: str = Field(min_length=PIN_MIN_LENGTH, max_length=PIN_MAX_LENGTH)


class JoinRoomRequest(BaseModel):
    pin: str = Field(min_length=PIN_MIN_LENGTH, max_length=PIN_MAX_LENGTH)


@router.get("/health")
async def health() -> dict[str, str]:
    runtime = _runtime()
    if runtime.room_store is None:
        if runtime.config.is_test_mode():
            return {"status": "ok"}
        raise HTTPException(status_code=503, detail="redis unavailable")
    try:
        await runtime.room_store.ping()
    except RedisUnavailable as exc:
        raise HTTPException(status_code=503, detail="redis unavailable") from exc
    return {"status": "ok"}


@router.post("/api/rooms")
async def create_room(request_body: CreateRoomRequest, request: Request):
    runtime = _runtime()
    requested_id = _require_valid_room_id(request_body.room_id) if request_body.room_id else _generated_room_id()
    fingerprint = _client_fingerprint(request)

    if runtime.room_store is not None:
        metadata = await runtime.room_store.get_metadata(requested_id)
        if metadata is None or "pin_hash" not in metadata:
            pin_hash = auth.hash_pin(request_body.pin)
            try:
                await runtime.room_store.create_room(
                    requested_id,
                    make_state(),
                    metadata={"room_id": requested_id, "pin_hash": pin_hash},
                )
            except RoomLimitReached:
                raise HTTPException(status_code=403, detail="room limit reached") from None
        else:
            await _assert_not_rate_limited(requested_id, fingerprint)
            stored_pin_hash = str(metadata.get("pin_hash", ""))
            if not stored_pin_hash or not auth.verify_pin(request_body.pin, stored_pin_hash):
                await _record_failed_attempt(requested_id, fingerprint)
                await _auth_failure()
    else:
        room = get_room(requested_id)
        if room is None:
            raise HTTPException(status_code=403, detail="room limit reached")
        stored_pin_hash = runtime.local_pin_hashes.get(requested_id)
        if stored_pin_hash is None:
            runtime.local_pin_hashes[requested_id] = auth.hash_pin(request_body.pin)
        elif not auth.verify_pin(request_body.pin, stored_pin_hash):
            await _auth_failure()

    token = await _issue_room_token(requested_id)
    return {"room_id": requested_id, "token": token}


@router.post("/api/rooms/{room_id}/join")
async def join_room(room_id: str, request_body: JoinRoomRequest, request: Request):
    runtime = _runtime()
    normalized = _require_valid_room_id(room_id)
    fingerprint = _client_fingerprint(request)
    await _assert_not_rate_limited(normalized, fingerprint)
    if runtime.room_store is not None:
        metadata = await runtime.room_store.get_metadata(normalized)
        stored_pin_hash = "" if metadata is None else str(metadata.get("pin_hash", ""))
    else:
        stored_pin_hash = runtime.local_pin_hashes.get(normalized, "")
    if not stored_pin_hash or not auth.verify_pin(request_body.pin, stored_pin_hash):
        await _record_failed_attempt(normalized, fingerprint)
        await _auth_failure()
    token = await _issue_room_token(normalized)
    return {"token": token}
