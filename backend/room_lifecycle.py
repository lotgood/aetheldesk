from typing import Protocol, cast

from fastapi import HTTPException

try:
    from backend import auth
    from backend import runtime as runtime_module
    from backend.room_auth_service import (
        ROOM_INSTANCE_ID_KEY,
        assert_not_rate_limited,
        auth_failure,
        issue_room_token,
        new_room_instance_id,
        record_failed_attempt,
    )
    from backend.room_service import get_room, make_state
    from backend.room_store import RoomAlreadyExists, RoomLimitReached
    from backend.state import BackendState
except ModuleNotFoundError:
    import auth
    import runtime as runtime_module
    from room_auth_service import (
        ROOM_INSTANCE_ID_KEY,
        assert_not_rate_limited,
        auth_failure,
        issue_room_token,
        new_room_instance_id,
        record_failed_attempt,
    )
    from room_service import get_room, make_state
    from room_store import RoomAlreadyExists, RoomLimitReached
    from state import BackendState


class _RoomStore(Protocol):
    async def get_metadata(self, room_id: str) -> dict[str, object] | None: ...
    async def has_room(self, room_id: str) -> bool: ...
    async def create_room(
        self,
        room_id: str,
        state: BackendState,
        *,
        metadata: dict[str, object] | None = None,
    ) -> BackendState: ...


class _Runtime(Protocol):
    room_store: _RoomStore | None
    rooms: dict[str, object]
    local_pin_hashes: dict[str, str]
    local_room_instance_ids: dict[str, str]


def _runtime() -> _Runtime:
    return cast(_Runtime, runtime_module.get_runtime())


async def verify_existing_pin(
    room_id: str,
    pin: str,
    fingerprint: str,
    metadata: dict[str, object] | None,
) -> None:
    await assert_not_rate_limited(room_id, fingerprint)
    stored_pin_hash = "" if metadata is None else str(metadata.get("pin_hash", ""))
    if not stored_pin_hash or not auth.verify_pin(pin, stored_pin_hash):
        await record_failed_attempt(room_id, fingerprint)
        await auth_failure()


async def create_room_with_pin(room_id: str, pin: str, fingerprint: str) -> str:
    runtime = _runtime()
    if runtime.room_store is not None:
        try:
            await _create_redis_room_with_pin(runtime.room_store, room_id, pin, fingerprint)
        except RoomLimitReached:
            raise HTTPException(status_code=403, detail="room limit reached") from None
    else:
        await _create_local_room_with_pin(runtime, room_id, pin)
    return await issue_room_token(room_id)


async def join_room_with_pin(room_id: str, pin: str, fingerprint: str) -> str:
    runtime = _runtime()
    await assert_not_rate_limited(room_id, fingerprint)
    if runtime.room_store is not None:
        metadata = await runtime.room_store.get_metadata(room_id)
        stored_pin_hash = "" if metadata is None else str(metadata.get("pin_hash", ""))
    else:
        stored_pin_hash = runtime.local_pin_hashes.get(room_id, "")
    if not stored_pin_hash or not auth.verify_pin(pin, stored_pin_hash):
        await record_failed_attempt(room_id, fingerprint)
        await auth_failure()
    return await issue_room_token(room_id)


async def _create_redis_room_with_pin(
    room_store: _RoomStore,
    room_id: str,
    pin: str,
    fingerprint: str,
) -> None:
    metadata = await room_store.get_metadata(room_id)
    if metadata is None or "pin_hash" not in metadata:
        if await room_store.has_room(room_id):
            await auth_failure()
        pin_hash = auth.hash_pin(pin)
        try:
            await room_store.create_room(
                room_id,
                make_state(),
                metadata={
                    "room_id": room_id,
                    "pin_hash": pin_hash,
                    ROOM_INSTANCE_ID_KEY: new_room_instance_id(),
                },
            )
        except RoomAlreadyExists:
            metadata = await room_store.get_metadata(room_id)
            await verify_existing_pin(room_id, pin, fingerprint, metadata)
    else:
        await verify_existing_pin(room_id, pin, fingerprint, metadata)


async def _create_local_room_with_pin(runtime: _Runtime, room_id: str, pin: str) -> None:
    room_existed = room_id in runtime.rooms
    room = get_room(room_id)
    if room is None:
        raise HTTPException(status_code=403, detail="room limit reached")
    stored_pin_hash = runtime.local_pin_hashes.get(room_id)
    if stored_pin_hash is None:
        if room_existed:
            await auth_failure()
        else:
            runtime.local_pin_hashes[room_id] = auth.hash_pin(pin)
            runtime.local_room_instance_ids[room_id] = new_room_instance_id()
    elif not auth.verify_pin(pin, stored_pin_hash):
        await auth_failure()
