import re
from datetime import datetime, timezone
from importlib import import_module
from typing import Protocol, TypedDict, cast


class GetCelestialState(Protocol):
    def __call__(
        self, dt: datetime | None = None, lat: float | None = None, lon: float | None = None
    ) -> dict[str, object]: ...


try:
    _celestial_module = import_module("celestial")
except ModuleNotFoundError:
    _celestial_module = import_module("backend.celestial")

get_celestial_state = cast(GetCelestialState, _celestial_module.get_celestial_state)

YT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")

MusicState = TypedDict(
    "MusicState",
    {
        "playing": bool,
        "video_id": str,
    },
)


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
    }


def advance_timer_state(state: BackendState) -> bool:
    needs_broadcast = False

    if state["focus"] and not state["paused"] and state["pomodoro_remaining"] > 0:
        state["pomodoro_remaining"] -= 1
        needs_broadcast = True
        if state["pomodoro_remaining"] == 0:
            state["focus"] = False
            state["sessions_done"] += 1
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
    msg: dict[str, object],
    celestial_provider: GetCelestialState | None = None,
) -> None:
    provider = celestial_provider or get_celestial_state
    t = msg.get("type")
    if t == "time_override":
        iso = cast(str | None, msg.get("iso"))
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
        mins = msg.get("minutes")
        if isinstance(mins, int) and 1 <= mins <= 120:
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
        vid = msg.get("video_id")
        if isinstance(vid, str) and YT_ID_RE.match(vid):
            state["music"]["video_id"] = vid
    elif t == "location":
        lat, lon = msg.get("lat"), msg.get("lon")
        if not (isinstance(lat, (int, float)) and isinstance(lon, (int, float))):
            return
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            return
        dt = _parse_iso(state["time_override"]) if state["time_override"] else None
        state["celestial"] = provider(lat=lat, lon=lon, dt=dt)
