from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "frontend" / "src"
ROOM_RENDERER_JS = SRC / "room-renderer.js"
TIMER_CONTROLS_JS = SRC / "timer-controls.js"


def test_room_renderer_delegates_celestial_and_timer_view_state_modules():
    # Given: room rendering should be split by visual responsibility.
    renderer_source = ROOM_RENDERER_JS.read_text(encoding="utf-8")
    timer_controls_source = TIMER_CONTROLS_JS.read_text(encoding="utf-8")

    # When: renderer module boundaries are inspected.
    celestial_source = (SRC / "celestial-renderer.js").read_text(encoding="utf-8")
    timer_view_source = (SRC / "timer-view.js").read_text(encoding="utf-8")

    # Then: heavy drawing and timer view-state logic are delegated.
    assert 'import { createCelestialRenderer } from "./celestial-renderer.js";' in renderer_source
    assert 'import { createTimerView } from "./timer-view.js";' in renderer_source
    assert "export function createCelestialRenderer" in celestial_source
    assert "export function createTimerView" in timer_view_source
    assert 'export { fmtTime } from "./timer-view.js";' in timer_controls_source
    for root_only_forbidden in ("function updateTimerTitle", "function drawCloud", "function renderFocus"):
        assert root_only_forbidden not in renderer_source
