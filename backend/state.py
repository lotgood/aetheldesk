from datetime import datetime, timezone
from importlib import import_module
from typing import TYPE_CHECKING, Literal, Protocol, TypedDict, cast

try:
    from backend import client_messages
    from backend.state_features import apply_room_feature_command
except ModuleNotFoundError:
    import client_messages
    from state_features import apply_room_feature_command

if TYPE_CHECKING:
    from backend.client_messages import (
        ClientCommand,
        LocationCommand,
        MusicSkipCommand,
        SetDurationCommand,
        TimeOverrideCommand,
    )


class GetCelestialState(Protocol):
    def __call__(
        self, dt: datetime | None = None, lat: float | None = None, lon: float | None = None
    ) -> dict[str, object]: ...


try:
    _celestial_module = import_module("celestial")
except ModuleNotFoundError:
    _celestial_module = import_module("backend.celestial")

get_celestial_state = cast(GetCelestialState, _celestial_module.get_celestial_state)
YT_ID_RE = client_messages.YT_ID_RE

MusicState = TypedDict(
    "MusicState",
    {
        "playing": bool,
        "video_id": str,
    },
)

RoomTask = TypedDict(
    "RoomTask",
    {
        "id": str,
        "text": str,
        "done": bool,
    },
)


RoomIntent = TypedDict(
    "RoomIntent",
    {
        "goal": str,
        "tasks": list[RoomTask],
        "active_task_id": str | None,
    },
)


RoomCheckIn = TypedDict(
    "RoomCheckIn",
    {
        "id": str,
        "kind": Literal["ready", "progress", "done"],
        "text": str,
    },
)


AmbienceLayers = TypedDict(
    "AmbienceLayers",
    {
        "rain": int,
        "wind": int,
        "brown_noise": int,
    },
)


AmbienceState = TypedDict(
    "AmbienceState",
    {
        "enabled": bool,
        "layers": AmbienceLayers,
    },
)


RoomMetrics = TypedDict(
    "RoomMetrics",
    {
        "focus_seconds": int,
        "sessions_completed": int,
        "tasks_completed": int,
    },
)

SceneName = Literal["sky", "city", "beach", "forest"]


BackendState = TypedDict(
    "BackendState",
    {
        "celestial": dict[str, object],
        "focus": bool,
        "paused": bool,
        "pomodoro_remaining": int,
        "pomodoro_duration": int,
        "break": bool,
        "break_remaining": int,
        "sessions_done": int,
        "music": MusicState,
        "time_override": str | None,
        "intent": RoomIntent,
        "checkins": list[RoomCheckIn],
        "scene": SceneName,
        "ambience": AmbienceState,
        "metrics": RoomMetrics,
    },
)

BACKEND_STATE_KEYS = frozenset(BackendState.__annotations__.keys())


def _parse_iso(iso: str) -> datetime:
    """Parse client ISO string; assume UTC when tz is missing."""
    dt = datetime.fromisoformat(iso)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def make_state(celestial_provider: GetCelestialState | None = None) -> BackendState:
    provider = celestial_provider or get_celestial_state
    return {
        "celestial": provider(),
        "focus": False,
        "paused": False,
        "pomodoro_remaining": 3000,
        "pomodoro_duration": 3000,
        "break": False,
        "break_remaining": 0,
        "sessions_done": 0,
        "music": {"playing": False, "video_id": "jfKfPfyJRdk"},
        "time_override": None,
        "intent": {"goal": "", "tasks": [], "active_task_id": None},
        "checkins": [],
        "scene": "sky",
        "ambience": {"enabled": False, "layers": {"rain": 0, "wind": 0, "brown_noise": 0}},
        "metrics": {"focus_seconds": 0, "sessions_completed": 0, "tasks_completed": 0},
    }


def advance_timer_state(state: BackendState) -> bool:
    needs_broadcast = False

    if state["focus"] and not state["paused"] and state["pomodoro_remaining"] > 0:
        state["pomodoro_remaining"] -= 1
        state["metrics"]["focus_seconds"] += 1
        needs_broadcast = True
        if state["pomodoro_remaining"] == 0:
            state["focus"] = False
            state["sessions_done"] += 1
            state["metrics"]["sessions_completed"] += 1
            break_secs = 1500 if state["sessions_done"] % 4 == 0 else 600
            state["break"] = True
            state["break_remaining"] = break_secs
            state["pomodoro_remaining"] = state["pomodoro_duration"]
    elif state["break"] and state["break_remaining"] > 0:
        state["break_remaining"] -= 1
        needs_broadcast = True
        if state["break_remaining"] == 0:
            state["break"] = False

    return needs_broadcast


async def handle(
    state: BackendState,
    command: "ClientCommand",
    celestial_provider: GetCelestialState | None = None,
) -> None:
    provider = celestial_provider or get_celestial_state
    t = command["type"]
    if t == "time_override":
        time_override = cast("TimeOverrideCommand", command)
        iso = time_override["iso"]
        dt = _parse_iso(iso) if iso else None
        state["time_override"] = iso
        state["celestial"] = provider(dt)
    elif t == "focus_toggle":
        if state["break"]:
            state["break"] = False
            state["break_remaining"] = 0
        state["focus"] = not state["focus"]
        state["paused"] = False
        state["pomodoro_remaining"] = state["pomodoro_duration"]
    elif t == "focus_pause":
        if state["focus"]:
            state["paused"] = not state["paused"]
    elif t == "focus_cancel":
        state["focus"] = False
        state["paused"] = False
        state["break"] = False
        state["break_remaining"] = 0
        state["pomodoro_remaining"] = state["pomodoro_duration"]
    elif t == "set_duration":
        set_duration = cast("SetDurationCommand", command)
        mins = set_duration["minutes"]
        state["pomodoro_duration"] = mins * 60
        if not state["focus"]:
            state["pomodoro_remaining"] = state["pomodoro_duration"]
    elif t == "skip_break":
        state["break"] = False
        state["break_remaining"] = 0
    elif t == "music_play":
        state["music"]["playing"] = True
    elif t == "music_pause":
        state["music"]["playing"] = False
    elif t == "music_skip":
        music_skip = cast("MusicSkipCommand", command)
        state["music"]["video_id"] = music_skip["video_id"]
    elif t == "location":
        location = cast("LocationCommand", command)
        lat, lon = location["lat"], location["lon"]
        dt = _parse_iso(state["time_override"]) if state["time_override"] else None
        state["celestial"] = provider(lat=lat, lon=lon, dt=dt)
    else:
        apply_room_feature_command(state, command)
