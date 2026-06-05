from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
SRC = FRONTEND / "src"


def test_room_app_entrypoint_delegates_bootstrap_modules():
    # Given: room app startup should be owned by cohesive modules.
    app_source = (FRONTEND / "app.js").read_text(encoding="utf-8")
    controller_source = (SRC / "room-controller.js").read_text(encoding="utf-8")

    # When: the app entrypoint and controller source are inspected.
    expected_modules = (
        "room-controller.js",
        "room-connection.js",
        "room-state.js",
        "location-status.js",
        "exit-confirm.js",
    )

    # Then: app.js is only the entrypoint and controller wires named modules.
    assert app_source.strip() == 'import { startRoomApp } from "./src/room-controller.js";\n\nstartRoomApp();'
    for module_name in expected_modules:
        assert (SRC / module_name).exists()
    for delegate in ("createRoomConnection", "createRoomStateApplier", "bindLocationStatus", "createExitConfirm"):
        assert delegate in controller_source
    for inline_responsibility in ("createRoomSocket", "createRoomAuth", "getCurrentPosition", "exit-confirm"):
        assert inline_responsibility not in app_source
