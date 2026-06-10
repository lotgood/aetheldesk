from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
SRC = FRONTEND / "src"
ROOM_HTML = FRONTEND / "room.html"
AMBIENCE_JS = SRC / "ambience-audio.js"


def test_ambience_ui_uses_generated_audio_and_shared_state_only():
    room = ROOM_HTML.read_text(encoding="utf-8")
    controller = (SRC / "room-controller.js").read_text(encoding="utf-8")
    room_state = (SRC / "room-state.js").read_text(encoding="utf-8")
    ambience = AMBIENCE_JS.read_text(encoding="utf-8")
    combined = "\n".join(path.read_text(encoding="utf-8") for path in [AMBIENCE_JS, SRC / "room-controller.js"])

    assert 'id="ambience-panel"' in room
    assert 'id="btn-ambience"' in room
    assert 'id="ambience-rain"' in room
    assert 'id="ambience-wind"' in room
    assert 'id="ambience-brown-noise"' in room
    assert 'id="ambience-status"' in room and 'aria-live="polite"' in room
    assert "createAmbienceController" in controller
    assert "ambience.syncAmbience(state.ambience)" in room_state
    assert "AudioContext" in ambience
    assert "createBuffer" in ambience
    assert "ambience_set_enabled" in ambience
    assert "ambience_set_layer" in ambience
    assert "localStorage" not in combined
    assert "https://" not in ambience
