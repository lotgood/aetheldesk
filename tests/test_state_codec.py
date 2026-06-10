import asyncio
import json
from typing import cast

from backend.redis_contract import room_state_key
from backend.room_store import RoomStore
from backend.state import BackendState, make_state
from tests.test_room_store import FakeRedis


def sample_state() -> BackendState:
    state = make_state(lambda *_args, **_kwargs: {"marker": "celestial"})
    state["focus"] = True
    state["pomodoro_remaining"] = 42
    return state


def test_state_codec_round_trips_and_rejects_invalid_shapes():
    from backend.state_codec import decode_state_json, encode_state_json, validate_state_snapshot

    state = sample_state()
    missing_music_key = dict(state)
    missing_music_key["music"] = {"playing": False}
    extra_music_key = dict(state)
    extra_music_key["music"] = {"playing": False, "video_id": "jfKfPfyJRdk", "extra": True}
    bad_top_level = dict(state)
    bad_top_level["unexpected"] = True

    assert decode_state_json(encode_state_json(state)) == state
    assert validate_state_snapshot(state) == state
    assert validate_state_snapshot(missing_music_key) is None
    assert validate_state_snapshot(extra_music_key) is None
    assert validate_state_snapshot(bad_top_level) is None
    assert decode_state_json("not-json") is None


def test_room_store_get_state_uses_codec_for_corrupt_or_invalid_values():
    redis = FakeRedis()
    store = RoomStore(redis)
    invalid_state = dict(sample_state())
    invalid_state["music"] = {"playing": True}

    async def run() -> None:
        redis.values[room_state_key("BADJSON")] = "not-json"
        redis.values[room_state_key("BADSHAPE")] = json.dumps(invalid_state, separators=(",", ":"))

        assert await store.get_state("BADJSON") is None
        assert await store.get_state("BADSHAPE") is None

    asyncio.run(run())


def test_state_codec_rejects_wrong_field_types():
    from backend.state_codec import validate_state_snapshot

    state = dict(sample_state())
    state["focus"] = "true"
    assert validate_state_snapshot(cast(object, state)) is None


def test_state_codec_accepts_legacy_intent_without_enabled():
    from backend.state_codec import validate_state_snapshot

    state = dict(sample_state())
    state["intent"] = {"goal": "", "tasks": [], "active_task_id": None}

    validated = validate_state_snapshot(state)

    assert validated is not None
    assert validated["intent"]["enabled"] is True


def test_state_codec_rejects_malformed_feature_state_shapes():
    from backend.state_codec import validate_state_snapshot

    state = sample_state()

    missing_task_text = dict(state)
    missing_task_text["intent"] = {
        "goal": "",
        "tasks": [{"id": "task_0001", "done": False}],
        "active_task_id": None,
    }

    bad_checkin_kind = dict(state)
    bad_checkin_kind["checkins"] = [{"id": "check_001", "kind": "chat", "text": "hello"}]

    bad_ambience_volume = dict(state)
    bad_ambience_volume["ambience"] = {
        "enabled": False,
        "layers": {"rain": 101, "wind": 0, "brown_noise": 0},
    }

    bad_metrics = dict(state)
    bad_metrics["metrics"] = {"focus_seconds": -1, "sessions_completed": 0, "tasks_completed": 0}

    duplicate_task_ids = dict(state)
    duplicate_task_ids["intent"] = {
        "goal": "",
        "tasks": [
            {"id": "task_0001", "text": "first", "done": False},
            {"id": "task_0001", "text": "second", "done": False},
        ],
        "active_task_id": "task_0001",
    }

    assert validate_state_snapshot(missing_task_text) is None
    assert validate_state_snapshot(bad_checkin_kind) is None
    assert validate_state_snapshot(bad_ambience_volume) is None
    assert validate_state_snapshot(bad_metrics) is None
    assert validate_state_snapshot(duplicate_task_ids) is None
