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
    break_duration: int = 600,
    sessions_done: int = 0,
    reward_id: int = 0,
    revision: int = 0,
    last_tick_slot: int | None = None,
    time_override: str | None = None,
    celestial: dict[str, object] | None = None,
) -> BackendState:
    return {
        "celestial": celestial if celestial is not None else {"marker": "celestial"},
        "focus": focus,
        "paused": paused,
        "pomodoro_remaining": pomodoro_remaining,
        "pomodoro_duration": pomodoro_duration,
        "break": break_,
        "break_remaining": break_remaining,
        "break_duration": break_duration,
        "sessions_done": sessions_done,
        "reward_id": reward_id,
        "revision": revision,
        "last_tick_slot": last_tick_slot,
        "time_override": time_override,
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
    assert state["break_duration"] == 600
    assert state["reward_id"] == 0
    assert state["revision"] == 0
    assert state["last_tick_slot"] is None
    assert "music" not in state
    assert state["celestial"] == {"marker": "celestial"}
    assert state["time_override"] is None
    assert state["sessions_done"] == 0


def test_backend_main_exports_state_compatibility_names():
    assert backend_main_module.BackendState is backend_state_module.BackendState
    assert not hasattr(backend_main_module, "MusicState")
    assert backend_main_module.advance_timer_state is backend_state_module.advance_timer_state
    assert backend_main_module._parse_iso is backend_state_module._parse_iso


def test_normalize_state_upgrades_legacy_music_snapshot_without_issuing_reward():
    legacy = cast(dict[str, object], make_timer_state(break_=True, break_remaining=1500))
    legacy.pop("break_duration")
    legacy.pop("reward_id")
    legacy.pop("revision")
    legacy.pop("last_tick_slot")
    legacy["music"] = {"playing": True, "video_id": "dQw4w9WgXcQ"}

    normalized = backend_state_module.normalize_state(legacy)

    assert "music" not in normalized
    assert normalized["break_duration"] == 600
    assert normalized["break_remaining"] == 600
    assert normalized["reward_id"] == 0
    assert normalized["revision"] == 0
    assert normalized["last_tick_slot"] is None


def test_make_state_defaults(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(backend_main_module, "get_celestial_state", celestial_stub)

    state = backend_main.make_state()

    assert state["focus"] is False
    assert state["paused"] is False
    assert state["pomodoro_duration"] == 3000
    assert state["pomodoro_remaining"] == 3000
    assert state["break"] is False
    assert state["break_duration"] == 600
    assert state["reward_id"] == 0
    assert "music" not in state
    assert state["celestial"] == {"marker": "celestial"}
    assert state["time_override"] is None
    assert state["sessions_done"] == 0


def test_handle_focus_and_duration_transitions(monkeypatch: pytest.MonkeyPatch):
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

    asyncio.run(run())


def test_advance_timer_state_counts_down_focus_and_requests_broadcast(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(backend_main_module, "get_celestial_state", celestial_stub)
    state = make_timer_state(focus=True, pomodoro_remaining=3)

    needs_broadcast = backend_main_module.advance_timer_state(state)

    assert needs_broadcast is True
    assert state["pomodoro_remaining"] == 2
    assert state["focus"] is True
    assert state["break"] is False


def test_normal_focus_completion_starts_ten_minute_break_and_issues_one_reward(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(backend_main_module, "get_celestial_state", celestial_stub)
    state = make_timer_state(focus=True, pomodoro_remaining=1, pomodoro_duration=3000)

    needs_broadcast = backend_main_module.advance_timer_state(state)

    assert needs_broadcast is True
    assert state["focus"] is False
    assert state["sessions_done"] == 1
    assert state["reward_id"] == 1
    assert state["break"] is True
    assert state["break_duration"] == 600
    assert state["break_remaining"] == 600
    assert state["pomodoro_remaining"] == 3000

    backend_main_module.advance_timer_state(state)

    assert state["sessions_done"] == 1
    assert state["reward_id"] == 1
    assert state["break_remaining"] == 599


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


def test_redis_cleanup_never_eagerly_deletes_from_worker_local_presence(
    monkeypatch: pytest.MonkeyPatch,
):
    # Redis cleanup is TTL-driven because this worker cannot know whether a
    # different worker still owns a live socket for the same room.
    monkeypatch.setattr(backend_main_module, "room_store", object())

    asyncio.run(backend_main_module.schedule_cleanup("shared"))


def test_fourth_focus_completion_still_uses_ten_minute_break(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(backend_main_module, "get_celestial_state", celestial_stub)
    state = make_timer_state(focus=True, pomodoro_remaining=1, sessions_done=3, reward_id=3)

    needs_broadcast = backend_main_module.advance_timer_state(state)

    assert needs_broadcast is True
    assert state["sessions_done"] == 4
    assert state["reward_id"] == 4
    assert state["break"] is True
    assert state["break_duration"] == 600
    assert state["break_remaining"] == 600


def test_elapsed_catch_up_can_cross_focus_and_entire_break_with_one_reward(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(backend_main_module, "get_celestial_state", celestial_stub)
    state = make_timer_state(focus=True, pomodoro_remaining=2)

    changed = backend_main_module.advance_timer_state(state, 603)

    assert changed is True
    assert state["focus"] is False
    assert state["break"] is False
    assert state["break_remaining"] == 0
    assert state["sessions_done"] == 1
    assert state["reward_id"] == 1


def test_focus_cancel_does_not_issue_reward(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(backend_main_module, "get_celestial_state", celestial_stub)
    state = make_timer_state(focus=True, pomodoro_remaining=1, sessions_done=2, reward_id=2)

    asyncio.run(backend_main.handle(state, {"type": "focus_cancel"}))

    assert state["focus"] is False
    assert state["break"] is False
    assert state["sessions_done"] == 2
    assert state["reward_id"] == 2


def test_skip_break_returns_idle_without_revoking_reward(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(backend_main_module, "get_celestial_state", celestial_stub)
    state = make_timer_state(
        break_=True,
        break_remaining=123,
        sessions_done=4,
        reward_id=4,
    )

    asyncio.run(backend_main.handle(state, {"type": "skip_break"}))

    assert state["focus"] is False
    assert state["paused"] is False
    assert state["break"] is False
    assert state["break_remaining"] == 0
    assert state["pomodoro_remaining"] == state["pomodoro_duration"]
    assert state["sessions_done"] == 4
    assert state["reward_id"] == 4


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
    before = json.loads(json.dumps(state))

    async def run() -> None:
        await backend_main.handle(state, {"type": "not_a_real_type", "x": 1})

    asyncio.run(run())

    assert state == before


@pytest.mark.parametrize(
    "msg",
    [
        {"type": "music_play"},
        {"type": "music_pause"},
        {"type": "music_skip", "video_id": "dQw4w9WgXcQ"},
    ],
)
def test_handle_ignores_retired_music_commands(msg: dict[str, object], monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(backend_main_module, "get_celestial_state", celestial_stub)
    state = backend_main.make_state()
    before = json.loads(json.dumps(state))

    asyncio.run(backend_main.handle(state, msg))

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
        assert "const ROOM_ID" in static_js.text
