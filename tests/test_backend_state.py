import asyncio
from collections.abc import Awaitable
from types import ModuleType
from typing import Callable, TypedDict, cast

import pytest
from fastapi import WebSocket

from backend import main as backend_main_module


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
    }


def celestial_stub(*_args: object, **_kwargs: object) -> dict[str, object]:
    return {"marker": "celestial"}


def updated_celestial_stub(*_args: object, **_kwargs: object) -> dict[str, object]:
    return {"marker": "updated"}


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
