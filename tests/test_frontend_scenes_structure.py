from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
SCENES_JS = FRONTEND / "scenes.js"
SCENE_SRC = FRONTEND / "src" / "scenes"


def test_scene_controller_delegates_renderers_to_per_scene_modules():
    # Given: scene controller remains the public room import.
    source = SCENES_JS.read_text(encoding="utf-8")

    # When: the scene source boundary is inspected.
    expected_modules = {
        "city.js": "createCityScene",
        "beach.js": "createBeachScene",
        "forest.js": "createForestScene",
        "shared.js": "prefersReducedMotion",
    }

    # Then: per-scene drawing loops live outside the public controller file.
    assert "export function createSceneController()" in source
    for module_name, export_name in expected_modules.items():
        module_source = (SCENE_SRC / module_name).read_text(encoding="utf-8")
        assert f"export function {export_name}" in module_source
        assert module_name in source
    for root_only_forbidden in ("function cityLoop", "function beachLoop", "function forestLoop"):
        assert root_only_forbidden not in source
