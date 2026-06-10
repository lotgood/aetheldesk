import re
from datetime import datetime
from typing import Final, Literal, TypeAlias, TypedDict, cast


YT_ID_RE: Final = re.compile(r"^[A-Za-z0-9_-]{11}$")
FEATURE_ID_RE: Final = re.compile(r"^[A-Za-z0-9_-]{8,24}$")
MAX_GOAL_CHARS: Final = 120
MAX_TASK_TEXT_CHARS: Final = 80
MAX_CHECKIN_TEXT_CHARS: Final = 80
CHECKIN_KINDS: Final[frozenset[str]] = frozenset({"ready", "progress", "done"})

TypeOnlyCommandType: TypeAlias = Literal[
    "focus_toggle",
    "focus_pause",
    "focus_cancel",
    "skip_break",
    "music_play",
    "music_pause",
    "intent_clear_completed",
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


class IntentSetGoalCommand(TypedDict):
    type: Literal["intent_set_goal"]
    goal: str


class IntentSetEnabledCommand(TypedDict):
    type: Literal["intent_set_enabled"]
    enabled: bool


class IntentTaskTextCommand(TypedDict):
    type: Literal["intent_add_task", "intent_update_task"]
    id: str
    text: str


class IntentToggleTaskCommand(TypedDict):
    type: Literal["intent_toggle_task"]
    id: str
    done: bool


class IntentTaskIdCommand(TypedDict):
    type: Literal["intent_select_task", "intent_delete_task"]
    id: str | None


class CheckinAddCommand(TypedDict):
    type: Literal["checkin_add"]
    id: str
    kind: Literal["ready", "progress", "done"]
    text: str


class CheckinClearCommand(TypedDict):
    type: Literal["checkin_clear"]


class SceneSelectCommand(TypedDict):
    type: Literal["scene_select"]
    scene: Literal["sky", "city", "beach", "forest"]


class AmbienceSetEnabledCommand(TypedDict):
    type: Literal["ambience_set_enabled"]
    enabled: bool


class AmbienceSetLayerCommand(TypedDict):
    type: Literal["ambience_set_layer"]
    layer: Literal["rain", "wind", "brown_noise"]
    volume: int


ClientCommand: TypeAlias = (
    TypeOnlyCommand
    | TimeOverrideCommand
    | SetDurationCommand
    | MusicSkipCommand
    | LocationCommand
    | IntentSetGoalCommand
    | IntentSetEnabledCommand
    | IntentTaskTextCommand
    | IntentToggleTaskCommand
    | IntentTaskIdCommand
    | CheckinAddCommand
    | CheckinClearCommand
    | SceneSelectCommand
    | AmbienceSetEnabledCommand
    | AmbienceSetLayerCommand
)

TYPE_ONLY_COMMANDS: Final[frozenset[str]] = frozenset(
    {
        "focus_toggle",
        "focus_pause",
        "focus_cancel",
        "skip_break",
        "music_play",
        "music_pause",
        "intent_clear_completed",
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
    if message_type == "intent_set_goal":
        return _parse_intent_set_goal(payload)
    if message_type == "intent_set_enabled":
        return _parse_intent_set_enabled(payload)
    if message_type == "intent_add_task":
        return _parse_intent_task_text(payload, "intent_add_task")
    if message_type == "intent_update_task":
        return _parse_intent_task_text(payload, "intent_update_task")
    if message_type == "intent_toggle_task":
        return _parse_intent_toggle_task(payload)
    if message_type == "intent_select_task":
        return _parse_intent_task_id(payload, "intent_select_task")
    if message_type == "intent_delete_task":
        return _parse_intent_task_id(payload, "intent_delete_task")
    if message_type == "checkin_add":
        return _parse_checkin_add(payload)
    if message_type == "checkin_clear":
        return _parse_checkin_clear(payload)
    if message_type == "scene_select":
        return _parse_scene_select(payload)
    if message_type == "ambience_set_enabled":
        return _parse_ambience_set_enabled(payload)
    if message_type == "ambience_set_layer":
        return _parse_ambience_set_layer(payload)
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


def _valid_feature_id(value: object) -> str | None:
    if isinstance(value, str) and FEATURE_ID_RE.match(value):
        return value
    return None


def _parse_intent_set_goal(payload: dict[object, object]) -> IntentSetGoalCommand | None:
    goal = payload.get("goal")
    if isinstance(goal, str) and len(goal) <= MAX_GOAL_CHARS:
        return {"type": "intent_set_goal", "goal": goal}
    return None


def _parse_intent_set_enabled(payload: dict[object, object]) -> IntentSetEnabledCommand | None:
    enabled = payload.get("enabled")
    if type(enabled) is bool:
        return {"type": "intent_set_enabled", "enabled": enabled}
    return None


def _parse_intent_task_text(
    payload: dict[object, object],
    message_type: Literal["intent_add_task", "intent_update_task"],
) -> IntentTaskTextCommand | None:
    task_id = _valid_feature_id(payload.get("id"))
    text = payload.get("text")
    if task_id is not None and isinstance(text, str) and 1 <= len(text) <= MAX_TASK_TEXT_CHARS:
        return {"type": message_type, "id": task_id, "text": text}
    return None


def _parse_intent_toggle_task(payload: dict[object, object]) -> IntentToggleTaskCommand | None:
    task_id = _valid_feature_id(payload.get("id"))
    done = payload.get("done")
    if task_id is not None and type(done) is bool:
        return {"type": "intent_toggle_task", "id": task_id, "done": done}
    return None


def _parse_intent_task_id(
    payload: dict[object, object],
    message_type: Literal["intent_select_task", "intent_delete_task"],
) -> IntentTaskIdCommand | None:
    raw_task_id = payload.get("id")
    if raw_task_id is None and message_type == "intent_select_task":
        return {"type": message_type, "id": None}
    task_id = _valid_feature_id(raw_task_id)
    if task_id is not None:
        return {"type": message_type, "id": task_id}
    return None


def _parse_checkin_add(payload: dict[object, object]) -> CheckinAddCommand | None:
    checkin_id = _valid_feature_id(payload.get("id"))
    kind = payload.get("kind")
    text = payload.get("text")
    if (
        checkin_id is not None
        and kind in CHECKIN_KINDS
        and isinstance(text, str)
        and len(text) <= MAX_CHECKIN_TEXT_CHARS
    ):
        return {
            "type": "checkin_add",
            "id": checkin_id,
            "kind": cast(Literal["ready", "progress", "done"], kind),
            "text": text,
        }
    return None


def _parse_checkin_clear(payload: dict[object, object]) -> CheckinClearCommand | None:
    if set(payload.keys()) == {"type"}:
        return {"type": "checkin_clear"}
    return None


def _parse_scene_select(payload: dict[object, object]) -> SceneSelectCommand | None:
    scene = payload.get("scene")
    if scene in {"sky", "city", "beach", "forest"}:
        return {"type": "scene_select", "scene": cast(Literal["sky", "city", "beach", "forest"], scene)}
    return None


def _parse_ambience_set_enabled(payload: dict[object, object]) -> AmbienceSetEnabledCommand | None:
    enabled = payload.get("enabled")
    if type(enabled) is bool:
        return {"type": "ambience_set_enabled", "enabled": enabled}
    return None


def _parse_ambience_set_layer(payload: dict[object, object]) -> AmbienceSetLayerCommand | None:
    layer = payload.get("layer")
    volume = payload.get("volume")
    if layer in {"rain", "wind", "brown_noise"} and type(volume) is int and 0 <= volume <= 100:
        return {
            "type": "ambience_set_layer",
            "layer": cast(Literal["rain", "wind", "brown_noise"], layer),
            "volume": volume,
        }
    return None
