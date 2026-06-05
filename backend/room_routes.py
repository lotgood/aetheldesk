from pydantic import BaseModel, Field
from fastapi import APIRouter, HTTPException, Request

try:
    from backend import runtime as runtime_module
    from backend.room_auth_service import (
        PIN_MAX_LENGTH,
        PIN_MIN_LENGTH,
        client_fingerprint,
        generated_room_id,
        require_valid_room_id,
    )
    from backend.room_lifecycle import create_room_with_pin, join_room_with_pin
    from backend.room_store import RedisUnavailable
except ModuleNotFoundError:
    import runtime as runtime_module
    from room_auth_service import (
        PIN_MAX_LENGTH,
        PIN_MIN_LENGTH,
        client_fingerprint,
        generated_room_id,
        require_valid_room_id,
    )
    from room_lifecycle import create_room_with_pin, join_room_with_pin
    from room_store import RedisUnavailable


router = APIRouter()


def _redis_unavailable(exc: RedisUnavailable) -> HTTPException:
    return HTTPException(status_code=503, detail="redis unavailable")


class CreateRoomRequest(BaseModel):
    room_id: str | None = Field(default=None)
    pin: str = Field(min_length=PIN_MIN_LENGTH, max_length=PIN_MAX_LENGTH)


class JoinRoomRequest(BaseModel):
    pin: str = Field(min_length=PIN_MIN_LENGTH, max_length=PIN_MAX_LENGTH)


@router.get("/health")
async def health() -> dict[str, str]:
    runtime = runtime_module.get_runtime()
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
async def create_room(request_body: CreateRoomRequest, request: Request) -> dict[str, str]:
    requested_id = require_valid_room_id(request_body.room_id) if request_body.room_id else generated_room_id()
    fingerprint = client_fingerprint(request)
    try:
        token = await create_room_with_pin(requested_id, request_body.pin, fingerprint)
    except RedisUnavailable as exc:
        raise _redis_unavailable(exc) from exc
    return {"room_id": requested_id, "token": token}


@router.post("/api/rooms/{room_id}/join")
async def join_room(room_id: str, request_body: JoinRoomRequest, request: Request) -> dict[str, str]:
    normalized = require_valid_room_id(room_id)
    fingerprint = client_fingerprint(request)
    try:
        token = await join_room_with_pin(normalized, request_body.pin, fingerprint)
    except RedisUnavailable as exc:
        raise _redis_unavailable(exc) from exc
    return {"token": token}
