from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
SRC = FRONTEND / "src"
ROOM_HTML = FRONTEND / "room.html"
ROOM_CHECKINS_JS = SRC / "room-checkins.js"


def test_room_checkins_ui_is_korean_primary_accessible_and_module_owned():
    room = ROOM_HTML.read_text(encoding="utf-8")
    controller = (SRC / "room-controller.js").read_text(encoding="utf-8")
    room_state = (SRC / "room-state.js").read_text(encoding="utf-8")
    checkins_source = ROOM_CHECKINS_JS.read_text(encoding="utf-8")

    assert 'id="checkins-panel"' in room
    assert 'id="checkin-text-input"' in room
    assert 'id="checkin-list"' in room
    assert 'id="checkin-status"' in room and 'aria-live="polite"' in room
    assert "준비" in room
    assert "진행 중" in room
    assert "완료" in room
    assert 'import { createRoomCheckinsController } from "./room-checkins.js";' in controller
    assert "checkins.renderCheckins(state, previousState)" in room_state
    assert ".textContent" in checkins_source
    assert ".innerHTML" not in checkins_source
    assert "checkin_add" in checkins_source
    assert "checkin_clear" in checkins_source
    assert "잘했어요" in checkins_source
