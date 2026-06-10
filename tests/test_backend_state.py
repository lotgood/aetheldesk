import asyncio
import json
from collections.abc import Awaitable
from datetime import datetime
from types import ModuleType
from typing import Callable, TypedDict, cast

import pytest
from fastapi import WebSocket
from fastapi.testclient import TestClient

from backend import main as backend_main_module
from backend import state as backend_state_module
from backend.state import AmbienceState, RoomCheckIn, RoomIntent, RoomMetrics, SceneName


class MusicState(TypedDict):
    playing: bool
    video_id: str


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


class BackendMain:
    def __init__(self, module: ModuleType):
        self._module: ModuleType = module

    def make_state(self) -> BackendState:
        return cast(Callable[[], BackendState], getattr(self._module, "make_state"))()

    async def handle(self, state: BackendState, msg: dict[str, object]) -> None:
        handler = cast(Callable[[BackendState, dict[str, object]], Awaitable[None]], getattr(self._module, "handle"))
        await handler(state, msg)


backend_main = BackendMain(backend_main_module)


def make_timer_state(
    *,
    focus: bool = False,
    paused: bool = False,
    pomodoro_remaining: int = 3000,
    pomodoro_duration: int = 3000,
    break_: bool = False,
    break_remaining: int = 0,
    sessions_done: int = 0,
    time_override: str | None = None,
    celestial: dict[str, object] | None = None,
    music_playing: bool = False,
    video_id: str = "jfKfPfyJRdk",
) -> BackendState:
    return {
        "celestial": celestial if celestial is not None else {"marker": "celestial"},
        "focus": focus,
        "paused": paused,
        "pomodoro_remaining": pomodoro_remaining,
        "pomodoro_duration": pomodoro_duration,
        "break": break_,
        "break_remaining": break_remaining,
        "sessions_done": sessions_done,
        "music": {"playing": music_playing, "video_id": video_id},
        "time_override": time_override,
        "intent": {"enabled": True, "goal": "", "tasks": [], "active_task_id": None},
        "checkins": [],
        "scene": "sky",
        "ambience": {"enabled": False, "layers": {"rain": 0, "wind": 0, "brown_noise": 0}},
        "metrics": {"focus_seconds": 0, "sessions_completed": 0, "tasks_completed": 0},
    }


def celestial_stub(*_args: object, **_kwargs: object) -> dict[str, object]:
    return {"marker": "celestial"}


def updated_celestial_stub(*_args: object, **_kwargs: object) -> dict[str, object]:
    return {"marker": "updated"}


def test_backend_state_make_state_defaults_are_json_serializable(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(backend_state_module, "get_celestial_state", celestial_stub)

    state = backend_state_module.make_state()

    assert json.dumps(state)
    assert state["focus"] is False
    assert state["paused"] is False
    assert state["pomodoro_duration"] == 3000
    assert state["pomodoro_remaining"] == 3000
    assert state["break"] is False
    assert state["music"]["video_id"] == "jfKfPfyJRdk"
    assert state["celestial"] == {"marker": "celestial"}
    assert state["time_override"] is None
    assert state["sessions_done"] == 0


def test_backend_main_exports_state_compatibility_names():
    assert backend_main_module.BackendState is backend_state_module.BackendState
    assert backend_main_module.MusicState is backend_state_module.MusicState
    assert backend_main_module.advance_timer_state is backend_state_module.advance_timer_state
    assert backend_main_module._parse_iso is backend_state_module._parse_iso


def test_make_state_defaults(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(backend_main_module, "get_celestial_state", celestial_stub)

    state = backend_main.make_state()

    assert state["focus"] is False
    assert state["paused"] is False
    assert state["pomodoro_duration"] == 3000
    assert state["pomodoro_remaining"] == 3000
    assert state["break"] is False
    assert state["music"]["video_id"] == "jfKfPfyJRdk"
    assert state["celestial"] == {"marker": "celestial"}
    assert state["time_override"] is None
    assert state["sessions_done"] == 0


def test_handle_focus_music_and_duration_transitions(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(backend_main_module, "get_celestial_state", celestial_stub)
    state = backend_main.make_state()

    async def run() -> None:
        await backend_main.handle(state, {"type": "focus_toggle"})
        assert state["focus"] is True
        assert state["paused"] is False
        assert state["pomodoro_remaining"] == state["pomodoro_duration"]

        await backend_main.handle(state, {"type": "focus_pause"})
        assert state["paused"] is True

        await backend_main.handle(state, {"type": "focus_pause"})
        assert state["paused"] is False

        await backend_main.handle(state, {"type": "focus_cancel"})
        assert state["focus"] is False
        assert state["paused"] is False
        assert state["break"] is False
        assert state["pomodoro_remaining"] == state["pomodoro_duration"]

        await backend_main.handle(state, {"type": "set_duration", "minutes": 42})
        assert state["pomodoro_duration"] == 2520
        assert state["pomodoro_remaining"] == 2520

        before_duration = state["pomodoro_duration"]
        before_remaining = state["pomodoro_remaining"]
        await backend_main.handle(state, {"type": "set_duration", "minutes": 0})
        assert state["pomodoro_duration"] == before_duration
        assert state["pomodoro_remaining"] == before_remaining

        state["break"] = True
        state["break_remaining"] = 123
        await backend_main.handle(state, {"type": "skip_break"})
        assert state["break"] is False
        assert state["break_remaining"] == 0

        await backend_main.handle(state, {"type": "music_play"})
        assert state["music"]["playing"] is True

        await backend_main.handle(state, {"type": "music_pause"})
        assert state["music"]["playing"] is False

        await backend_main.handle(state, {"type": "music_skip", "video_id": "dQw4w9WgXcQ"})
        assert state["music"]["video_id"] == "dQw4w9WgXcQ"

        await backend_main.handle(state, {"type": "music_skip", "video_id": "not-valid"})
        assert state["music"]["video_id"] == "dQw4w9WgXcQ"

    asyncio.run(run())


def test_advance_timer_state_counts_down_focus_and_requests_broadcast(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(backend_main_module, "get_celestial_state", celestial_stub)
    state = make_timer_state(focus=True, pomodoro_remaining=3)

    needs_broadcast = backend_main_module.advance_timer_state(state)

    assert needs_broadcast is True
    assert state["pomodoro_remaining"] == 2
    assert state["focus"] is True
    assert state["break"] is False


def test_advance_timer_state_transitions_focus_to_short_break(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(backend_main_module, "get_celestial_state", celestial_stub)
    state = make_timer_state(focus=True, pomodoro_remaining=1, pomodoro_duration=3000)

    needs_broadcast = backend_main_module.advance_timer_state(state)

    assert needs_broadcast is True
    assert state["focus"] is False
    assert state["sessions_done"] == 1
    assert state["break"] is True
    assert state["break_remaining"] == 600
    assert state["pomodoro_remaining"] == 3000


def test_advance_timer_state_counts_down_break_and_stops_at_zero(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(backend_main_module, "get_celestial_state", celestial_stub)
    state = make_timer_state(break_=True, break_remaining=1)

    needs_broadcast = backend_main_module.advance_timer_state(state)

    assert needs_broadcast is True
    assert state["break"] is False
    assert state["break_remaining"] == 0


def test_advance_timer_state_leaves_paused_focus_unchanged(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(backend_main_module, "get_celestial_state", celestial_stub)
    state = make_timer_state(focus=True, paused=True, pomodoro_remaining=7)

    needs_broadcast = backend_main_module.advance_timer_state(state)

    assert needs_broadcast is False
    assert state["pomodoro_remaining"] == 7
    assert state["focus"] is True
    assert state["paused"] is True


@pytest.mark.parametrize(
    "msg",
    [
        {"type": "location", "lat": "bad", "lon": 127.7},
        {"type": "location", "lat": 91, "lon": 127.7},
    ],
)
def test_handle_invalid_location_is_ignored_without_updating_celestial(
    msg: dict[str, object],
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(backend_main_module, "get_celestial_state", celestial_stub)
    state = backend_main.make_state()
    baseline: dict[str, object] = state["celestial"]
    called = {"count": 0}

    def tracking_get_celestial_state(*args: object, **kwargs: object) -> dict[str, object]:
        called["count"] += 1
        return updated_celestial_stub(*args, **kwargs)

    monkeypatch.setattr(backend_main_module, "get_celestial_state", tracking_get_celestial_state)

    async def run() -> None:
        await backend_main.handle(state, msg)

    asyncio.run(run())

    assert state["celestial"] == baseline
    assert called["count"] == 0


def test_lifespan_awaits_tick_cancellation(monkeypatch: pytest.MonkeyPatch):
    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def fake_tick() -> None:
        _ = started.set()
        try:
            _ = await asyncio.Event().wait()
        except asyncio.CancelledError:
            _ = cancelled.set()
            raise

    monkeypatch.setattr(backend_main_module, "tick", fake_tick)

    async def run() -> None:
        async with backend_main_module.lifespan(backend_main_module.app):
            _ = await started.wait()

    asyncio.run(run())

    assert cancelled.is_set()


def test_schedule_cleanup_keeps_rejoined_room(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(backend_main_module, "get_celestial_state", celestial_stub)
    room_id = "RACE"

    async def run() -> None:
        _ = backend_main_module.rooms.pop(room_id, None)
        monkeypatch.setattr(backend_main_module, "ROOM_TTL", 0)
        room = backend_main_module.get_room(room_id)
        assert room is not None
        cleanup_task = asyncio.create_task(backend_main_module.schedule_cleanup(room_id))
        room["cleanup"] = cleanup_task
        room["clients"].add(cast(WebSocket, object()))
        await cleanup_task
        assert room_id in backend_main_module.rooms

    try:
        asyncio.run(run())
    finally:
        _ = backend_main_module.rooms.pop(room_id, None)


def test_advance_timer_state_uses_long_break_on_fourth_session(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(backend_main_module, "get_celestial_state", celestial_stub)
    state = make_timer_state(focus=True, pomodoro_remaining=1, sessions_done=3)

    needs_broadcast = backend_main_module.advance_timer_state(state)

    assert needs_broadcast is True
    assert state["sessions_done"] == 4
    assert state["break"] is True
    assert state["break_remaining"] == 1500


def test_handle_time_override_accepts_none_and_iso(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(backend_main_module, "get_celestial_state", celestial_stub)
    state = backend_main.make_state()

    async def run() -> None:
        await backend_main.handle(state, {"type": "time_override", "iso": None})
        assert state["time_override"] is None

        await backend_main.handle(state, {"type": "time_override", "iso": "2026-01-01T10:00:00+00:00"})
        assert state["time_override"] == "2026-01-01T10:00:00+00:00"

    asyncio.run(run())


def test_handle_location_valid_updates_celestial(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(backend_main_module, "get_celestial_state", celestial_stub)
    state = backend_main.make_state()
    state["time_override"] = "2026-01-01T10:00:00+00:00"
    called = {"count": 0}

    def tracking_get_celestial_state(*args: object, **kwargs: object) -> dict[str, object]:
        del args
        called["count"] += 1
        assert kwargs["lat"] == pytest.approx(37.5)
        assert kwargs["lon"] == pytest.approx(127.1)
        assert cast(datetime, kwargs["dt"]).tzinfo is not None
        return {"marker": "updated"}

    monkeypatch.setattr(backend_main_module, "get_celestial_state", tracking_get_celestial_state)

    async def run() -> None:
        await backend_main.handle(state, {"type": "location", "lat": 37.5, "lon": 127.1})

    asyncio.run(run())

    assert called["count"] == 1
    assert state["celestial"] == {"marker": "updated"}


@pytest.mark.parametrize("minutes", [1, 120])
def test_handle_set_duration_accepts_boundary_minutes(minutes: int, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(backend_main_module, "get_celestial_state", celestial_stub)
    state = backend_main.make_state()

    async def run() -> None:
        await backend_main.handle(state, {"type": "set_duration", "minutes": minutes})

    asyncio.run(run())

    assert state["pomodoro_duration"] == minutes * 60
    assert state["pomodoro_remaining"] == minutes * 60


def test_handle_ignores_unknown_message_type(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(backend_main_module, "get_celestial_state", celestial_stub)
    state = backend_main.make_state()
    before = make_timer_state(
        focus=state["focus"],
        paused=state["paused"],
        pomodoro_remaining=state["pomodoro_remaining"],
        pomodoro_duration=state["pomodoro_duration"],
        break_=state["break"],
        break_remaining=state["break_remaining"],
        sessions_done=state["sessions_done"],
        time_override=state["time_override"],
        celestial=state["celestial"],
        music_playing=state["music"]["playing"],
        video_id=state["music"]["video_id"],
    )

    async def run() -> None:
        await backend_main.handle(state, {"type": "not_a_real_type", "x": 1})

    asyncio.run(run())

    assert state == before


def test_routes_serve_lobby_room_and_static_assets():
    with TestClient(backend_main_module.app) as client:
        lobby = client.get("/")
        assert lobby.status_code == 200
        assert "<title>AethelDesk</title>" in lobby.text

        room = client.get("/room/ABCD")
        assert room.status_code == 200
        assert 'id="room-label"' in room.text

        static_js = client.get("/app.js")
        assert static_js.status_code == 200
        assert 'import { startRoomApp } from "./src/room-controller.js";' in static_js.text
