from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
SRC = FRONTEND / "src"
ROOM_HTML = FRONTEND / "room.html"
ROOM_INTENT_JS = SRC / "room-intent.js"


def test_room_intent_ui_is_korean_primary_accessible_and_module_owned():
    room = ROOM_HTML.read_text(encoding="utf-8")
    controller = (SRC / "room-controller.js").read_text(encoding="utf-8")
    room_state = (SRC / "room-state.js").read_text(encoding="utf-8")
    intent_source = ROOM_INTENT_JS.read_text(encoding="utf-8")
    room_css = (FRONTEND / "styles" / "room.css").read_text(encoding="utf-8")

    assert 'id="intent-panel"' in room
    assert 'id="intent-goal-input"' in room
    assert 'id="intent-task-input"' in room
    assert 'id="intent-task-list"' in room
    assert 'id="intent-status"' in room and 'aria-live="polite"' in room
    assert "방 목표" in room
    assert "작업 추가" in room
    assert 'import { createRoomIntentController } from "./room-intent.js";' in controller
    assert "intent.renderIntent(state.intent)" in room_state
    assert ".textContent" in intent_source
    assert ".innerHTML" not in intent_source
    assert "intent_add_task" in intent_source
    assert "intent_set_goal" in intent_source
    assert "body.day .intent-goal-text" in room_css
    assert 'body[data-scene="city"].day .intent-goal-text' in room_css
