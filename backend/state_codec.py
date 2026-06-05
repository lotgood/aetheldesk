import json
from typing import cast

try:
    from backend.state import BACKEND_STATE_KEYS, BackendState, MusicState
except ModuleNotFoundError:
    from state import BACKEND_STATE_KEYS, BackendState, MusicState


MUSIC_STATE_KEYS = frozenset(MusicState.__annotations__.keys())
INT_FIELDS = frozenset(
    {
        "pomodoro_remaining",
        "pomodoro_duration",
        "break_remaining",
        "sessions_done",
    }
)
BOOL_FIELDS = frozenset({"focus", "paused", "break"})


def encode_state_json(state: BackendState) -> str:
    return json.dumps(state, separators=(",", ":"))


def decode_state_json(encoded: str) -> BackendState | None:
    try:
        decoded = json.loads(encoded)
    except json.JSONDecodeError:
        return None
    return validate_state_snapshot(decoded)


def validate_state_snapshot(value: object) -> BackendState | None:
    if not isinstance(value, dict):
        return None
    if set(value.keys()) != BACKEND_STATE_KEYS:
        return None
    if not _valid_music(value.get("music")):
        return None
    if not isinstance(value.get("celestial"), dict):
        return None
    if not all(type(value.get(field)) is bool for field in BOOL_FIELDS):
        return None
    if not all(type(value.get(field)) is int for field in INT_FIELDS):
        return None
    time_override = value.get("time_override")
    if time_override is not None and not isinstance(time_override, str):
        return None
    return cast(BackendState, value)


def _valid_music(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    if set(value.keys()) != MUSIC_STATE_KEYS:
        return False
    return type(value.get("playing")) is bool and isinstance(value.get("video_id"), str)
