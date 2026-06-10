from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
SRC = FRONTEND / "src"
ROOM_HTML = FRONTEND / "room.html"
SCENES_JS = FRONTEND / "scenes.js"


def test_scene_picker_is_accessible_and_server_snapshot_owned():
    room = ROOM_HTML.read_text(encoding="utf-8")
    scenes_source = SCENES_JS.read_text(encoding="utf-8")
    controller = (SRC / "room-controller.js").read_text(encoding="utf-8")
    room_state = (SRC / "room-state.js").read_text(encoding="utf-8")

    assert 'id="btn-scene"' in room and 'aria-controls="scene-menu"' in room
    assert 'id="scene-menu"' in room and 'role="group"' in room
    for scene in ("sky", "city", "beach", "forest"):
        assert f'data-scene-option="{scene}"' in room
    assert "createSceneController({ send })" in controller
    assert 'send({ type: "scene_select", scene: name })' in scenes_source
    assert "applyScene(state.scene)" in room_state
    assert "storeScene(name)" in scenes_source
    assert "localStorage" not in room_state
