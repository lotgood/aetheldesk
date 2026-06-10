import asyncio
import copy

import pytest

from backend import main as backend_main


VALID_CHECKIN_MESSAGES: tuple[dict[str, object], ...] = (
    {"type": "checkin_add", "id": "check_001", "kind": "ready", "text": "자료 준비"},
    {"type": "checkin_add", "id": "check_002", "kind": "progress", "text": "진행 중"},
    {"type": "checkin_add", "id": "check_003", "kind": "done", "text": ""},
    {"type": "checkin_clear"},
)

INVALID_CHECKIN_MESSAGES: tuple[dict[str, object], ...] = (
    {"type": "checkin_add", "id": "short", "kind": "ready", "text": "자료 준비"},
    {"type": "checkin_add", "id": "check_001", "kind": "blocked", "text": "자료 준비"},
    {"type": "checkin_add", "id": "check_001", "kind": "ready", "text": "x" * 81},
    {"type": "checkin_add", "id": "check_001", "kind": "ready", "text": 42},
    {"type": "checkin_clear", "id": "check_001"},
)


@pytest.mark.parametrize("payload", VALID_CHECKIN_MESSAGES)
def test_parse_client_message_accepts_checkin_commands(payload: dict[str, object]):
    from backend.client_messages import parse_client_message

    assert parse_client_message(payload) == payload


@pytest.mark.parametrize("payload", INVALID_CHECKIN_MESSAGES)
def test_parse_client_message_rejects_malformed_checkin_commands(payload: dict[str, object]):
    from backend.client_messages import parse_client_message

    assert parse_client_message(payload) is None


def test_service_handle_applies_checkins_with_deterministic_pruning_and_clear():
    state = backend_main.make_state()

    async def run() -> None:
        for index in range(1, 15):
            await backend_main.handle(
                state,
                {"type": "checkin_add", "id": f"check_{index:03d}", "kind": "progress", "text": f"상태 {index}"},
            )

    asyncio.run(run())

    assert [checkin["id"] for checkin in state["checkins"]] == [f"check_{index:03d}" for index in range(3, 15)]
    assert all(set(checkin) == {"id", "kind", "text"} for checkin in state["checkins"])

    async def clear() -> None:
        await backend_main.handle(state, {"type": "checkin_clear"})

    asyncio.run(clear())

    assert state["checkins"] == []


@pytest.mark.parametrize("payload", INVALID_CHECKIN_MESSAGES)
def test_service_handle_ignores_invalid_checkin_commands_without_state_mutation(payload: dict[str, object]):
    state = backend_main.make_state()
    before = copy.deepcopy(state)

    async def run() -> None:
        await backend_main.handle(state, payload)

    asyncio.run(run())

    assert state == before
