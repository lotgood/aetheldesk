import asyncio

from backend import main as backend_main


def test_advance_timer_state_tracks_focus_seconds_and_completed_sessions():
    state = backend_main.make_state()
    state["focus"] = True
    state["pomodoro_remaining"] = 1

    needs_broadcast = backend_main.advance_timer_state(state)

    assert needs_broadcast is True
    assert state["metrics"]["focus_seconds"] == 1
    assert state["metrics"]["sessions_completed"] == 1
    assert state["break"] is True


def test_task_completion_metric_increments_only_on_new_completion():
    state = backend_main.make_state()

    async def run() -> None:
        await backend_main.handle(state, {"type": "intent_add_task", "id": "task_001", "text": "초안"})
        await backend_main.handle(state, {"type": "intent_toggle_task", "id": "task_001", "done": True})
        await backend_main.handle(state, {"type": "intent_toggle_task", "id": "task_001", "done": True})
        await backend_main.handle(state, {"type": "intent_toggle_task", "id": "task_001", "done": False})

    asyncio.run(run())

    assert state["metrics"]["tasks_completed"] == 1
