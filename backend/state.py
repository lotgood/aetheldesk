from datetime import datetime, timezone
from importlib import import_module
from typing import Protocol, TypedDict, cast


class GetCelestialState(Protocol):
    def __call__(
        self, dt: datetime | None = None, lat: float | None = None, lon: float | None = None
    ) -> dict[str, object]: ...


_celestial_module = import_module("backend.celestial")

get_celestial_state = cast(GetCelestialState, _celestial_module.get_celestial_state)

BREAK_DURATION_SECONDS = 600


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
        "break_duration": int,
        "sessions_done": int,
        "reward_id": int,
        "revision": int,
        "last_tick_slot": int | None,
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
        "break_duration": BREAK_DURATION_SECONDS,
        "sessions_done": 0,
        "reward_id": 0,
        "revision": 0,
        "last_tick_slot": None,
        "time_override": None,
    }


def normalize_state(state: dict[str, object]) -> BackendState:
    """Upgrade an ephemeral pre-reward snapshot to the canonical state shape."""
    state.pop("music", None)
    state["break_duration"] = BREAK_DURATION_SECONDS
    if state.get("break") is True and isinstance(state.get("break_remaining"), int):
        state["break_remaining"] = max(
            0,
            min(cast(int, state["break_remaining"]), BREAK_DURATION_SECONDS),
        )
    reward_id = state.get("reward_id")
    if not isinstance(reward_id, int) or isinstance(reward_id, bool) or reward_id < 0:
        state["reward_id"] = 0
    revision = state.get("revision")
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 0:
        state["revision"] = 0
    last_tick_slot = state.get("last_tick_slot")
    if not isinstance(last_tick_slot, int) or isinstance(last_tick_slot, bool):
        state["last_tick_slot"] = None
    return cast(BackendState, state)


def advance_timer_state(state: BackendState, seconds: int = 1) -> bool:
    remaining_elapsed = max(0, seconds)
    changed = False

    while remaining_elapsed > 0:
        if state["focus"] and not state["paused"]:
            focus_step = min(remaining_elapsed, max(0, state["pomodoro_remaining"]))
            if focus_step:
                state["pomodoro_remaining"] -= focus_step
                remaining_elapsed -= focus_step
                changed = True
            if state["pomodoro_remaining"] > 0:
                break

            state["focus"] = False
            state["paused"] = False
            state["sessions_done"] += 1
            state["reward_id"] += 1
            state["break_duration"] = BREAK_DURATION_SECONDS
            state["break"] = True
            state["break_remaining"] = BREAK_DURATION_SECONDS
            state["pomodoro_remaining"] = state["pomodoro_duration"]
            changed = True
            continue

        if state["break"]:
            break_step = min(remaining_elapsed, max(0, state["break_remaining"]))
            if break_step:
                state["break_remaining"] -= break_step
                remaining_elapsed -= break_step
                changed = True
            if state["break_remaining"] > 0:
                break
            state["break"] = False
            changed = True
            continue

        break

    return changed


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
        state["last_tick_slot"] = None
    elif t == "focus_pause":
        if state["focus"]:
            state["paused"] = not state["paused"]
            state["last_tick_slot"] = None
    elif t == "focus_cancel":
        state["focus"] = False
        state["paused"] = False
        state["break"] = False
        state["break_remaining"] = 0
        state["pomodoro_remaining"] = state["pomodoro_duration"]
        state["last_tick_slot"] = None
    elif t == "set_duration":
        mins = msg.get("minutes")
        if isinstance(mins, int) and 1 <= mins <= 120:
            state["pomodoro_duration"] = mins * 60
            if not state["focus"]:
                state["pomodoro_remaining"] = state["pomodoro_duration"]
                state["last_tick_slot"] = None
    elif t == "skip_break":
        if state["break"]:
            state["focus"] = False
            state["paused"] = False
            state["break"] = False
            state["break_remaining"] = 0
            state["pomodoro_remaining"] = state["pomodoro_duration"]
            state["last_tick_slot"] = None
    elif t == "location":
        lat, lon = msg.get("lat"), msg.get("lon")
        if not (isinstance(lat, (int, float)) and isinstance(lon, (int, float))):
            return
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            return
        dt = _parse_iso(state["time_override"]) if state["time_override"] else None
        state["celestial"] = provider(lat=lat, lon=lon, dt=dt)
