import asyncio
import copy

import pytest

from backend import main as backend_main


VALID_INTENT_MESSAGES: tuple[dict[str, object], ...] = (
    {"type": "intent_set_goal", "goal": "오늘 집중 목표"},
    {"type": "intent_add_task", "id": "task_001", "text": "보고서 정리"},
    {"type": "intent_update_task", "id": "task_001", "text": "보고서 초안 정리"},
    {"type": "intent_toggle_task", "id": "task_001", "done": True},
    {"type": "intent_select_task", "id": "task_001"},
    {"type": "intent_select_task", "id": None},
    {"type": "intent_delete_task", "id": "task_001"},
    {"type": "intent_clear_completed"},
)


INVALID_INTENT_MESSAGES: tuple[dict[str, object], ...] = (
    {"type": "intent_set_goal", "goal": "x" * 121},
    {"type": "intent_add_task", "id": "short", "text": "보고서"},
    {"type": "intent_add_task", "id": "task_001", "text": ""},
    {"type": "intent_add_task", "id": "task_001", "text": "x" * 81},
    {"type": "intent_update_task", "id": "task_001", "text": ""},
    {"type": "intent_toggle_task", "id": "task_001", "done": "yes"},
    {"type": "intent_select_task", "id": "missing"},
    {"type": "intent_delete_task", "id": 42},
)


@pytest.mark.parametrize("payload", VALID_INTENT_MESSAGES)
def test_parse_client_message_accepts_intent_commands(payload: dict[str, object]):
    from backend.client_messages import parse_client_message

    assert parse_client_message(payload) == payload


@pytest.mark.parametrize("payload", INVALID_INTENT_MESSAGES)
def test_parse_client_message_rejects_malformed_intent_commands(payload: dict[str, object]):
    from backend.client_messages import parse_client_message

    assert parse_client_message(payload) is None


def test_service_handle_applies_intent_commands_and_bounds_task_list():
    state = backend_main.make_state()

    async def run() -> None:
        await backend_main.handle(state, {"type": "intent_set_goal", "goal": "문서 정리"})
        for index in range(1, 10):
            await backend_main.handle(
                state,
                {"type": "intent_add_task", "id": f"task_{index:03d}", "text": f"작업 {index}"},
            )
        await backend_main.handle(state, {"type": "intent_select_task", "id": "task_003"})
        await backend_main.handle(state, {"type": "intent_toggle_task", "id": "task_003", "done": True})
        await backend_main.handle(state, {"type": "intent_update_task", "id": "task_003", "text": "핵심 작업"})
        await backend_main.handle(state, {"type": "intent_clear_completed"})

    asyncio.run(run())

    assert state["intent"]["goal"] == "문서 정리"
    assert len(state["intent"]["tasks"]) == 7
    assert state["intent"]["active_task_id"] is None
    assert all(task["id"] != "task_003" for task in state["intent"]["tasks"])


@pytest.mark.parametrize("payload", INVALID_INTENT_MESSAGES)
def test_service_handle_ignores_invalid_intent_commands_without_state_mutation(payload: dict[str, object]):
    state = backend_main.make_state()
    before = copy.deepcopy(state)

    async def run() -> None:
        await backend_main.handle(state, payload)

    asyncio.run(run())

    assert state == before
