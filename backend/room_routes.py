from importlib import import_module
from typing import Any, cast

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from backend import auth
from backend.room_store import RedisUnavailable, RoomAlreadyExists, RoomLimitReached, TokenLimitReached

_room_service = import_module("backend.room_service")
PIN_MAX_LENGTH = cast(int, _room_service.PIN_MAX_LENGTH)
PIN_MIN_LENGTH = cast(int, _room_service.PIN_MIN_LENGTH)
ROOM_INSTANCE_ID_KEY = cast(str, _room_service.ROOM_INSTANCE_ID_KEY)
_assert_not_rate_limited = cast(Any, _room_service._assert_not_rate_limited)
_auth_failure = cast(Any, _room_service._auth_failure)
_client_fingerprint = cast(Any, _room_service._client_fingerprint)
_generated_room_id = cast(Any, _room_service._generated_room_id)
_issue_room_token = cast(Any, _room_service._issue_room_token)
_metadata_room_instance_id = cast(Any, _room_service._metadata_room_instance_id)
_new_room_instance_id = cast(Any, _room_service._new_room_instance_id)
_record_failed_attempt = cast(Any, _room_service._record_failed_attempt)
_require_valid_room_id = cast(Any, _room_service._require_valid_room_id)
_runtime = cast(Any, _room_service._runtime)
get_room = cast(Any, _room_service.get_room)
make_state = cast(Any, _room_service.make_state)


router = APIRouter()


def _redis_unavailable(exc: RedisUnavailable) -> HTTPException:
    return HTTPException(status_code=503, detail="redis unavailable")


async def _verify_existing_pin(
    room_id: str,
    pin: str,
    fingerprint: str,
    metadata: dict[str, object] | None,
) -> str:
    await _assert_not_rate_limited(room_id, fingerprint)
    stored_pin_hash = "" if metadata is None else str(metadata.get("pin_hash", ""))
    room_instance_id = _metadata_room_instance_id(metadata)
    if not stored_pin_hash or room_instance_id is None or not auth.verify_pin(pin, stored_pin_hash):
        await _record_failed_attempt(room_id, fingerprint)
        await _auth_failure()
    return cast(str, room_instance_id)


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
        raise _redis_unavailable(exc) from exc
    return {"status": "ok"}


@router.post("/api/rooms")
async def create_room(request_body: CreateRoomRequest, request: Request):
    runtime = _runtime()
    requested_id = _require_valid_room_id(request_body.room_id) if request_body.room_id else _generated_room_id()
    fingerprint = _client_fingerprint(request)
    verified_instance_id: str | None = None

    if runtime.room_store is not None:
        try:
            metadata = await runtime.room_store.get_metadata(requested_id)
            if metadata is None or "pin_hash" not in metadata:
                if await runtime.room_store.has_room(requested_id):
                    await _auth_failure()
                pin_hash = auth.hash_pin(request_body.pin)
                new_instance_id = _new_room_instance_id()
                try:
                    await runtime.room_store.create_room(
                        requested_id,
                        make_state(),
                        metadata={
                            "room_id": requested_id,
                            "pin_hash": pin_hash,
                            ROOM_INSTANCE_ID_KEY: new_instance_id,
                        },
                    )
                    verified_instance_id = new_instance_id
                except RoomAlreadyExists:
                    metadata = await runtime.room_store.get_metadata(requested_id)
                    verified_instance_id = await _verify_existing_pin(
                        requested_id,
                        request_body.pin,
                        fingerprint,
                        metadata,
                    )
            else:
                verified_instance_id = await _verify_existing_pin(
                    requested_id,
                    request_body.pin,
                    fingerprint,
                    metadata,
                )
        except RoomLimitReached:
            raise HTTPException(status_code=403, detail="room limit reached") from None
        except RedisUnavailable as exc:
            raise _redis_unavailable(exc) from exc
    else:
        room_existed = requested_id in runtime.rooms
        room = get_room(requested_id)
        if room is None:
            raise HTTPException(status_code=403, detail="room limit reached")
        stored_pin_hash = runtime.local_pin_hashes.get(requested_id)
        if stored_pin_hash is None:
            if room_existed:
                await _auth_failure()
            else:
                runtime.local_pin_hashes[requested_id] = auth.hash_pin(request_body.pin)
                runtime.local_room_instance_ids[requested_id] = _new_room_instance_id()
        elif not auth.verify_pin(request_body.pin, stored_pin_hash):
            await _auth_failure()
        verified_instance_id = runtime.local_room_instance_ids.get(requested_id)

    if verified_instance_id is None:
        await _auth_failure()

    try:
        token = await _issue_room_token(requested_id, verified_instance_id)
    except TokenLimitReached:
        raise HTTPException(status_code=429, detail="room session limit reached") from None
    return {"room_id": requested_id, "token": token}


@router.post("/api/rooms/{room_id}/join")
async def join_room(room_id: str, request_body: JoinRoomRequest, request: Request):
    runtime = _runtime()
    normalized = _require_valid_room_id(room_id)
    fingerprint = _client_fingerprint(request)
    verified_instance_id: str | None = None
    try:
        if runtime.room_store is not None:
            metadata = await runtime.room_store.get_metadata(normalized)
            verified_instance_id = await _verify_existing_pin(
                normalized,
                request_body.pin,
                fingerprint,
                metadata,
            )
        else:
            await _assert_not_rate_limited(normalized, fingerprint)
            stored_pin_hash = runtime.local_pin_hashes.get(normalized, "")
            if not stored_pin_hash or not auth.verify_pin(request_body.pin, stored_pin_hash):
                await _record_failed_attempt(normalized, fingerprint)
                await _auth_failure()
            verified_instance_id = runtime.local_room_instance_ids.get(normalized)
        if verified_instance_id is None:
            await _auth_failure()
        token = await _issue_room_token(normalized, verified_instance_id)
    except RedisUnavailable as exc:
        raise _redis_unavailable(exc) from exc
    except TokenLimitReached:
        raise HTTPException(status_code=429, detail="room session limit reached") from None
    return {"token": token}
