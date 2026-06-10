import asyncio
import copy

import pytest

from backend import main as backend_main


VALID_SCENE_MESSAGES: tuple[dict[str, object], ...] = (
    {"type": "scene_select", "scene": "sky"},
    {"type": "scene_select", "scene": "city"},
    {"type": "scene_select", "scene": "beach"},
    {"type": "scene_select", "scene": "forest"},
)

INVALID_SCENE_MESSAGES: tuple[dict[str, object], ...] = (
    {"type": "scene_select", "scene": "space"},
    {"type": "scene_select", "scene": ""},
    {"type": "scene_select", "scene": 42},
    {"type": "scene_select"},
)


@pytest.mark.parametrize("payload", VALID_SCENE_MESSAGES)
def test_parse_client_message_accepts_scene_select(payload: dict[str, object]):
    from backend.client_messages import parse_client_message

    assert parse_client_message(payload) == payload


@pytest.mark.parametrize("payload", INVALID_SCENE_MESSAGES)
def test_parse_client_message_rejects_malformed_scene_select(payload: dict[str, object]):
    from backend.client_messages import parse_client_message

    assert parse_client_message(payload) is None


def test_service_handle_applies_scene_select():
    state = backend_main.make_state()

    async def run() -> None:
        await backend_main.handle(state, {"type": "scene_select", "scene": "forest"})

    asyncio.run(run())

    assert state["scene"] == "forest"


@pytest.mark.parametrize("payload", INVALID_SCENE_MESSAGES)
def test_service_handle_ignores_invalid_scene_select_without_state_mutation(payload: dict[str, object]):
    state = backend_main.make_state()
    before = copy.deepcopy(state)

    async def run() -> None:
        await backend_main.handle(state, payload)

    asyncio.run(run())

    assert state == before
