import json
import re
from typing import Final
from typing import cast

try:
    from backend.state import BACKEND_STATE_KEYS, AmbienceLayers, BackendState, MusicState
except ModuleNotFoundError:
    from state import BACKEND_STATE_KEYS, AmbienceLayers, BackendState, MusicState


MUSIC_STATE_KEYS = frozenset(MusicState.__annotations__.keys())
LEGACY_INTENT_KEYS = frozenset({"goal", "tasks", "active_task_id"})
INTENT_KEYS = frozenset({"enabled", "goal", "tasks", "active_task_id"})
TASK_KEYS = frozenset({"id", "text", "done"})
CHECKIN_KEYS = frozenset({"id", "kind", "text"})
AMBIENCE_KEYS = frozenset({"enabled", "layers"})
AMBIENCE_LAYER_KEYS = frozenset(AmbienceLayers.__annotations__.keys())
METRICS_KEYS = frozenset({"focus_seconds", "sessions_completed", "tasks_completed"})
SCENES = frozenset({"sky", "city", "beach", "forest"})
CHECKIN_KINDS = frozenset({"ready", "progress", "done"})
FEATURE_ID_RE: Final = re.compile(r"^[A-Za-z0-9_-]{8,24}$")
MAX_TASKS: Final = 8
MAX_CHECKINS: Final = 12
MAX_GOAL_CHARS: Final = 120
MAX_TASK_TEXT_CHARS: Final = 80
MAX_CHECKIN_TEXT_CHARS: Final = 80
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
    if not _valid_intent(value.get("intent")):
        return None
    if not _valid_checkins(value.get("checkins")):
        return None
    if value.get("scene") not in SCENES:
        return None
    if not _valid_ambience(value.get("ambience")):
        return None
    if not _valid_metrics(value.get("metrics")):
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


def _valid_intent(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    keys = set(value.keys())
    if keys == LEGACY_INTENT_KEYS:
        value["enabled"] = True
    elif keys != INTENT_KEYS:
        return False
    if type(value.get("enabled")) is not bool:
        return False
    goal = value.get("goal")
    tasks = value.get("tasks")
    active_task_id = value.get("active_task_id")
    if not isinstance(goal, str) or len(goal) > MAX_GOAL_CHARS:
        return False
    if not isinstance(tasks, list) or len(tasks) > MAX_TASKS:
        return False
    task_ids: set[str] = set()
    for task in tasks:
        if not isinstance(task, dict):
            return False
        task_id = task.get("id")
        if not _valid_task(task) or not isinstance(task_id, str):
            return False
        if task_id in task_ids:
            return False
        task_ids.add(task_id)
    return active_task_id is None or active_task_id in task_ids


def _valid_task(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    if set(value.keys()) != TASK_KEYS:
        return False
    task_id = value.get("id")
    text = value.get("text")
    return (
        isinstance(task_id, str)
        and FEATURE_ID_RE.match(task_id) is not None
        and isinstance(text, str)
        and 1 <= len(text) <= MAX_TASK_TEXT_CHARS
        and type(value.get("done")) is bool
    )


def _valid_checkins(value: object) -> bool:
    if not isinstance(value, list) or len(value) > MAX_CHECKINS:
        return False
    return all(_valid_checkin(checkin) for checkin in value)


def _valid_checkin(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    if set(value.keys()) != CHECKIN_KEYS:
        return False
    checkin_id = value.get("id")
    text = value.get("text")
    return (
        isinstance(checkin_id, str)
        and FEATURE_ID_RE.match(checkin_id) is not None
        and value.get("kind") in CHECKIN_KINDS
        and isinstance(text, str)
        and len(text) <= MAX_CHECKIN_TEXT_CHARS
    )


def _valid_ambience(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    if set(value.keys()) != AMBIENCE_KEYS:
        return False
    layers = value.get("layers")
    if type(value.get("enabled")) is not bool or not isinstance(layers, dict):
        return False
    if set(layers.keys()) != AMBIENCE_LAYER_KEYS:
        return False
    for layer in AMBIENCE_LAYER_KEYS:
        volume = layers.get(layer)
        if type(volume) is not int or not 0 <= volume <= 100:
            return False
    return True


def _valid_metrics(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    if set(value.keys()) != METRICS_KEYS:
        return False
    for field in METRICS_KEYS:
        metric = value.get(field)
        if type(metric) is not int or metric < 0:
            return False
    return True
