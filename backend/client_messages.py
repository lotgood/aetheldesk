import re
from datetime import datetime
from typing import Final, Literal, TypeAlias, TypedDict, cast


YT_ID_RE: Final = re.compile(r"^[A-Za-z0-9_-]{11}$")

TypeOnlyCommandType: TypeAlias = Literal[
    "focus_toggle",
    "focus_pause",
    "focus_cancel",
    "skip_break",
    "music_play",
    "music_pause",
]


class TypeOnlyCommand(TypedDict):
    type: TypeOnlyCommandType


class TimeOverrideCommand(TypedDict):
    type: Literal["time_override"]
    iso: str | None


class SetDurationCommand(TypedDict):
    type: Literal["set_duration"]
    minutes: int


class MusicSkipCommand(TypedDict):
    type: Literal["music_skip"]
    video_id: str


class LocationCommand(TypedDict):
    type: Literal["location"]
    lat: float
    lon: float


ClientCommand: TypeAlias = (
    TypeOnlyCommand | TimeOverrideCommand | SetDurationCommand | MusicSkipCommand | LocationCommand
)

TYPE_ONLY_COMMANDS: Final[frozenset[str]] = frozenset(
    {
        "focus_toggle",
        "focus_pause",
        "focus_cancel",
        "skip_break",
        "music_play",
        "music_pause",
    }
)


def parse_client_message(payload: object) -> ClientCommand | None:
    if not isinstance(payload, dict):
        return None

    message_type = payload.get("type")
    if not isinstance(message_type, str):
        return None

    if message_type in TYPE_ONLY_COMMANDS:
        return {"type": cast(TypeOnlyCommandType, message_type)}
    if message_type == "time_override":
        return _parse_time_override(payload)
    if message_type == "set_duration":
        return _parse_set_duration(payload)
    if message_type == "music_skip":
        return _parse_music_skip(payload)
    if message_type == "location":
        return _parse_location(payload)
    return None


def _parse_time_override(payload: dict[object, object]) -> TimeOverrideCommand | None:
    iso = payload.get("iso")
    if iso is None:
        return {"type": "time_override", "iso": None}
    if isinstance(iso, str) and _is_valid_iso(iso):
        return {"type": "time_override", "iso": iso}
    return None


def _parse_set_duration(payload: dict[object, object]) -> SetDurationCommand | None:
    minutes = payload.get("minutes")
    if isinstance(minutes, int) and 1 <= minutes <= 120:
        return {"type": "set_duration", "minutes": minutes}
    return None


def _parse_music_skip(payload: dict[object, object]) -> MusicSkipCommand | None:
    video_id = payload.get("video_id")
    if isinstance(video_id, str) and YT_ID_RE.match(video_id):
        return {"type": "music_skip", "video_id": video_id}
    return None


def _parse_location(payload: dict[object, object]) -> LocationCommand | None:
    lat = payload.get("lat")
    lon = payload.get("lon")
    if not (isinstance(lat, (int, float)) and isinstance(lon, (int, float))):
        return None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    return {"type": "location", "lat": cast(float, lat), "lon": cast(float, lon)}


def _is_valid_iso(iso: str) -> bool:
    try:
        datetime.fromisoformat(iso)
    except ValueError:
        return False
    return True
