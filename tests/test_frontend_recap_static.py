from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
SRC = FRONTEND / "src"
ROOM_HTML = FRONTEND / "room.html"
ROOM_RECAP_JS = SRC / "room-recap.js"


def test_room_recap_is_korean_primary_and_snapshot_owned():
    room = ROOM_HTML.read_text(encoding="utf-8")
    controller = (SRC / "room-controller.js").read_text(encoding="utf-8")
    room_state = (SRC / "room-state.js").read_text(encoding="utf-8")
    recap = ROOM_RECAP_JS.read_text(encoding="utf-8")

    assert 'id="room-recap"' in room
    assert "createRoomRecapController" in controller
    assert "recap.renderRecap(state.metrics)" in room_state
    assert "이 방에서" in recap
    assert "완료" in recap
    assert ".textContent" in recap
    assert "localStorage" not in recap
    assert "fetch(" not in recap
