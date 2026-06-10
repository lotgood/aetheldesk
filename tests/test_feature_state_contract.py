import json

from backend.state import make_state


def test_make_state_includes_feature_contract_defaults():
    state = make_state(lambda *_args, **_kwargs: {"marker": "celestial"})

    assert json.dumps(state)
    assert state["intent"] == {"enabled": True, "goal": "", "tasks": [], "active_task_id": None}
    assert state["checkins"] == []
    assert state["scene"] == "sky"
    assert state["ambience"] == {
        "enabled": False,
        "layers": {"rain": 0, "wind": 0, "brown_noise": 0},
    }
    assert state["metrics"] == {
        "focus_seconds": 0,
        "sessions_completed": 0,
        "tasks_completed": 0,
    }
