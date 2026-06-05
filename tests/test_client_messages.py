import asyncio
import copy
import inspect
from typing import Any

import pytest

from backend import main as backend_main
from backend import state as backend_state


INVALID_MESSAGES: tuple[object, ...] = (
    None,
    [],
    {"type": "set_duration", "minutes": "25"},
    {"type": "set_duration", "minutes": 121},
    {"type": "music_skip", "video_id": "short"},
    {"type": "location", "lat": "bad", "lon": 127.7},
    {"type": "location", "lat": 91, "lon": 127.7},
    {"type": "not_a_real_type", "x": 1},
    {"type": "time_override", "iso": 5},
    {"type": "time_override", "iso": "not an iso timestamp"},
)


VALID_MESSAGES: tuple[dict[str, object], ...] = (
    {"type": "time_override", "iso": None},
    {"type": "time_override", "iso": "2026-01-01T10:00:00+00:00"},
    {"type": "focus_toggle"},
    {"type": "focus_pause"},
    {"type": "focus_cancel"},
    {"type": "set_duration", "minutes": 25},
    {"type": "skip_break"},
    {"type": "music_play"},
    {"type": "music_pause"},
    {"type": "music_skip", "video_id": "dQw4w9WgXcQ"},
    {"type": "location", "lat": 37.5, "lon": 127.1},
)


@pytest.mark.parametrize("payload", INVALID_MESSAGES)
def test_parse_client_message_rejects_malformed_and_unknown_payloads(payload: object):
    from backend.client_messages import parse_client_message

    assert parse_client_message(payload) is None


@pytest.mark.parametrize("payload", VALID_MESSAGES)
def test_parse_client_message_accepts_current_command_shapes(payload: dict[str, object]):
    from backend.client_messages import parse_client_message

    assert parse_client_message(payload) == payload


def test_state_handle_accepts_typed_command_not_raw_dict():
    signature = inspect.signature(backend_state.handle)
    command_parameter = list(signature.parameters.values())[1]

    assert command_parameter.name == "command"
    assert command_parameter.annotation is not inspect.Signature.empty
    assert command_parameter.annotation != dict[str, object]


@pytest.mark.parametrize("payload", INVALID_MESSAGES)
def test_service_handle_ignores_invalid_payloads_without_state_mutation(payload: object):
    state = backend_main.make_state()
    before: dict[str, Any] = copy.deepcopy(state)

    async def run() -> None:
        await backend_main.handle(state, payload)

    asyncio.run(run())

    assert state == before
