import uuid
from typing import Final


KEY_PREFIX: Final[str] = "aetheldesk"
EVENT_VERSION: Final[int] = 1


def normalize_room_id(room_id: str) -> str:
    return room_id.strip().upper()


def room_state_key(room_id: str) -> str:
    normalized = normalize_room_id(room_id)
    return f"{KEY_PREFIX}:room:{normalized}:state"


def room_metadata_key(room_id: str) -> str:
    normalized = normalize_room_id(room_id)
    return f"{KEY_PREFIX}:room:{normalized}:meta"


def room_token_key(room_id: str, token_hash: str) -> str:
    normalized = normalize_room_id(room_id)
    return f"{KEY_PREFIX}:room:{normalized}:token:{token_hash}"


def room_pin_attempts_key(room_id: str, fingerprint: str) -> str:
    normalized = normalize_room_id(room_id)
    return f"{KEY_PREFIX}:room:{normalized}:pin-attempts:{fingerprint}"


def room_pin_block_key(room_id: str, fingerprint: str) -> str:
    normalized = normalize_room_id(room_id)
    return f"{KEY_PREFIX}:room:{normalized}:pin-block:{fingerprint}"


def room_tick_lock_key(room_id: str) -> str:
    normalized = normalize_room_id(room_id)
    return f"{KEY_PREFIX}:room:{normalized}:tick-lock"


def room_events_channel(room_id: str) -> str:
    normalized = normalize_room_id(room_id)
    return f"{KEY_PREFIX}:room:{normalized}:events"


def make_event_envelope(
    *,
    room_id: str,
    source_worker: str,
    event_type: str,
    data: object,
    event_id: str | None = None,
) -> dict[str, object]:
    return {
        "version": EVENT_VERSION,
        "room_id": normalize_room_id(room_id),
        "event_id": event_id or str(uuid.uuid4()),
        "source_worker": source_worker,
        "type": event_type,
        "data": data,
    }
