import asyncio
import copy

import pytest

from backend import main as backend_main


VALID_AMBIENCE_MESSAGES: tuple[dict[str, object], ...] = (
    {"type": "ambience_set_enabled", "enabled": True},
    {"type": "ambience_set_enabled", "enabled": False},
    {"type": "ambience_set_layer", "layer": "rain", "volume": 40},
    {"type": "ambience_set_layer", "layer": "wind", "volume": 0},
    {"type": "ambience_set_layer", "layer": "brown_noise", "volume": 100},
)

INVALID_AMBIENCE_MESSAGES: tuple[dict[str, object], ...] = (
    {"type": "ambience_set_enabled", "enabled": "yes"},
    {"type": "ambience_set_layer", "layer": "music", "volume": 40},
    {"type": "ambience_set_layer", "layer": "rain", "volume": -1},
    {"type": "ambience_set_layer", "layer": "rain", "volume": 101},
    {"type": "ambience_set_layer", "layer": "rain", "volume": 10.5},
)


@pytest.mark.parametrize("payload", VALID_AMBIENCE_MESSAGES)
def test_parse_client_message_accepts_ambience_commands(payload: dict[str, object]):
    from backend.client_messages import parse_client_message

    assert parse_client_message(payload) == payload


@pytest.mark.parametrize("payload", INVALID_AMBIENCE_MESSAGES)
def test_parse_client_message_rejects_malformed_ambience_commands(payload: dict[str, object]):
    from backend.client_messages import parse_client_message

    assert parse_client_message(payload) is None


def test_service_handle_applies_ambience_commands():
    state = backend_main.make_state()

    async def run() -> None:
        await backend_main.handle(state, {"type": "ambience_set_enabled", "enabled": True})
        await backend_main.handle(state, {"type": "ambience_set_layer", "layer": "rain", "volume": 35})
        await backend_main.handle(state, {"type": "ambience_set_layer", "layer": "brown_noise", "volume": 70})

    asyncio.run(run())

    assert state["ambience"] == {"enabled": True, "layers": {"rain": 35, "wind": 0, "brown_noise": 70}}


@pytest.mark.parametrize("payload", INVALID_AMBIENCE_MESSAGES)
def test_service_handle_ignores_invalid_ambience_commands_without_state_mutation(payload: dict[str, object]):
    state = backend_main.make_state()
    before = copy.deepcopy(state)

    async def run() -> None:
        await backend_main.handle(state, payload)

    asyncio.run(run())

    assert state == before
