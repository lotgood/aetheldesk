from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
APP_JS = FRONTEND / "app.js"
SCENES_JS = FRONTEND / "scenes.js"
LOBBY_JS = FRONTEND / "lobby.js"
ROOM_HTML = FRONTEND / "room.html"
LOBBY_HTML = FRONTEND / "lobby.html"
ROOM_CSS = FRONTEND / "room.css"
LOBBY_CSS = FRONTEND / "lobby.css"
SRC = FRONTEND / "src"
STORAGE_JS = SRC / "storage.js"
ROOM_SOCKET_JS = SRC / "room-websocket.js"
ROOM_AUTH_JS = SRC / "room-auth.js"
ROOM_RENDERER_JS = SRC / "room-renderer.js"
TIMER_CONTROLS_JS = SRC / "timer-controls.js"
MUSIC_YOUTUBE_JS = SRC / "music-youtube.js"
DOM_JS = SRC / "dom.js"
LOBBY_SKY_JS = SRC / "lobby-sky.js"
SCENE_PICKER_JS = SRC / "scene-picker.js"
MOTION_JS = SRC / "3d" / "motion.js"
BEACH_SCENE_JS = SRC / "3d" / "scenes" / "beach-scene.js"
CITY_SCENE_JS = SRC / "3d" / "scenes" / "city-scene.js"
FOREST_SCENE_JS = SRC / "3d" / "scenes" / "forest-scene.js"
CELESTIAL_JS = SRC / "3d" / "celestial.js"
SKY_DOME_JS = SRC / "3d" / "sky-dome.js"
SCENE_MANAGER_JS = SRC / "3d" / "scenes" / "scene-manager.js"
ENGINE_JS = SRC / "3d" / "engine.js"
POST_JS = SRC / "3d" / "post.js"


def _frontend_sources() -> dict[str, str]:
    paths = [APP_JS, SCENES_JS, LOBBY_JS, *sorted(SRC.glob("*.js"))]
    return {path.name: path.read_text() for path in paths}


def test_playlist_is_read_once_and_shared_music_controls_stay_visible():
    storage_source = STORAGE_JS.read_text()
    app_source = APP_JS.read_text()
    music_source = MUSIC_YOUTUBE_JS.read_text()

    assert "const savedPlaylist = readPlaylist();" in storage_source
    assert "ids: savedPlaylist || [...DEFAULT_PLAYLIST_IDS]" in storage_source
    assert "const playlist = createPlaylistState();" in app_source
    assert "if (playlist.savedPlaylist) showMusicBar();" not in music_source
    sync_source = music_source.split("function syncYT(music)", 1)[1].split("function initYouTubePlayer", 1)[0]
    initialization_source = music_source.split('setHiddenInteraction(byId("music-bar"), true);', 1)[1]
    assert "showMusicBar();" in sync_source
    assert "showMusicBar();" in initialization_source
    assert "syncPlaybackControls(music.playing);" in sync_source
    assert storage_source.count("readPlaylist()") == 2


def test_duration_selection_does_not_write_dead_session_storage_key():
    combined_source = "\n".join(_frontend_sources().values())

    assert "pomodoro_minutes" not in combined_source


def test_frontend_persists_only_allowlisted_local_storage_keys():
    sources = _frontend_sources()
    combined_source = "\n".join(sources.values())
    storage_source = STORAGE_JS.read_text()

    assert 'export const PLAYLIST_STORAGE_KEY = "playlist";' in storage_source
    assert 'export const SCENE_STORAGE_KEY = "scene";' in storage_source
    assert 'export const DISPLAY_QUALITY_STORAGE_KEY = "display-quality";' in storage_source
    assert 'export const DISPLAY_FX_STORAGE_KEY = "display-fx";' in storage_source
    assert "localStorage.getItem(PLAYLIST_STORAGE_KEY)" in storage_source
    assert "localStorage.setItem(PLAYLIST_STORAGE_KEY" in storage_source
    assert "localStorage.getItem(SCENE_STORAGE_KEY)" in storage_source
    assert "localStorage.setItem(SCENE_STORAGE_KEY" in storage_source
    assert "localStorage.getItem(DISPLAY_QUALITY_STORAGE_KEY)" in storage_source
    assert "localStorage.setItem(DISPLAY_QUALITY_STORAGE_KEY" in storage_source
    assert "localStorage.getItem(DISPLAY_FX_STORAGE_KEY)" in storage_source
    assert "localStorage.setItem(DISPLAY_FX_STORAGE_KEY" in storage_source
    assert combined_source.count("localStorage.setItem(") == 4
    assert 'localStorage.setItem("pomodoro_minutes"' not in combined_source
    assert "localStorage.setItem(tokenStorageKey" not in combined_source
    assert "localStorage.getItem(tokenStorageKey" not in combined_source
    assert "localStorage.removeItem(tokenStorageKey" not in combined_source


def test_room_token_uses_session_storage_keyed_by_uppercase_room_id():
    storage_source = STORAGE_JS.read_text()
    app_source = APP_JS.read_text()
    lobby_source = LOBBY_JS.read_text()

    assert 'const ROOM_ID = location.pathname.split("/").pop().toUpperCase();' in app_source
    assert "export function tokenStorageKey(roomId) { return `room_token:${roomId}`; }" in storage_source
    assert "sessionStorage.getItem(tokenStorageKey(roomId))" in storage_source
    assert "sessionStorage.setItem(tokenStorageKey(roomId), token)" in storage_source
    assert "sessionStorage.removeItem(tokenStorageKey(roomId))" in storage_source
    assert "sessionStorage.setItem(tokenStorageKey(nextRoomId), data.token)" in lobby_source
    assert "sessionStorage.setItem(tokenStorageKey(roomId), data.token)" in lobby_source


def test_pin_flow_never_places_pin_or_token_in_page_urls_or_local_storage():
    sources = _frontend_sources()
    app_source = APP_JS.read_text()
    lobby_source = LOBBY_JS.read_text()
    combined_source = "\n".join(sources.values())

    assert "body: JSON.stringify({ room_id: roomId, pin })" in lobby_source
    assert "body: JSON.stringify({ pin })" in combined_source
    assert "?pin=" not in combined_source
    assert "&pin=" not in combined_source
    assert "localStorage" not in lobby_source
    assert 'localStorage.setItem("room_token' not in combined_source
    assert 'localStorage.getItem("room_token' not in combined_source
    assert 'localStorage.removeItem("room_token' not in combined_source
    assert "localStorage.setItem(token" not in combined_source
    assert "localStorage.getItem(token" not in combined_source
    assert "localStorage.removeItem(token" not in combined_source
    assert lobby_source.count("clearPin();") == 2
    assert 'roomPinInput.value = "";' in ROOM_AUTH_JS.read_text()
    assert "localStorage" not in app_source


def test_room_auth_uses_tokenized_websocket_and_generic_korean_rejection():
    socket_source = ROOM_SOCKET_JS.read_text()
    auth_source = ROOM_AUTH_JS.read_text()
    room_source = ROOM_HTML.read_text()
    lobby_source = LOBBY_JS.read_text()

    assert "/ws/${roomId}?token=${encodeURIComponent(token)}" in socket_source
    assert "event.code === 1008" in socket_source
    assert "입장할 수 없습니다" in socket_source
    assert "입장할 수 없습니다" in auth_source
    assert "입장할 수 없습니다" in lobby_source
    assert 'id="pin-input"' in LOBBY_HTML.read_text()
    assert 'id="room-pin-input"' in room_source
    assert 'id="room-pin-submit"' in room_source


def test_scene_system_is_es_module_without_required_window_global():
    app_source = APP_JS.read_text()
    scenes_source = SCENES_JS.read_text()
    room_source = ROOM_HTML.read_text()

    assert SCENES_JS.exists()
    assert 'import { createSceneController } from "./scenes.js";' in app_source
    assert "export function createSceneController({ container = document.body } = {})" in scenes_source
    assert "render: renderScene" in scenes_source
    assert "sceneController.render(c);" in ROOM_RENDERER_JS.read_text()
    assert "window.AethelScenes" not in app_source + scenes_source
    assert '<script type="module" src="/scenes.js"></script>' not in room_source


def test_room_modules_have_intentional_boundaries():
    app_source = APP_JS.read_text()

    expected_imports = [
        "./src/storage.js",
        "./src/room-auth.js",
        "./src/room-websocket.js",
        "./src/room-renderer.js",
        "./src/timer-controls.js",
        "./src/music-youtube.js",
        "./src/scene-picker.js",
        "./scenes.js",
    ]
    for module_path in expected_imports:
        assert module_path in app_source
    assert "new WebSocket" in ROOM_SOCKET_JS.read_text()
    assert "window.onYouTubeIframeAPIReady" in MUSIC_YOUTUBE_JS.read_text()
    assert "#dur-chips button" in TIMER_CONTROLS_JS.read_text()
    assert "renderFocus" in ROOM_RENDERER_JS.read_text()


def test_room_timer_updates_browser_title_from_renderer():
    room_source = ROOM_HTML.read_text()
    renderer_source = ROOM_RENDERER_JS.read_text()
    combined_source = "\n".join(_frontend_sources().values())

    assert "<title>AethelDesk</title>" in room_source
    assert "function updateTimerTitle(" in renderer_source
    assert "document.title" in renderer_source
    assert "fmtTime(remaining)" in renderer_source
    assert "fmtTime(breakRemaining)" in renderer_source
    assert "집중" in renderer_source
    assert "일시정지" in renderer_source
    assert "휴식" in renderer_source
    assert 'document.title = "AethelDesk";' in renderer_source
    assert combined_source.count("document.title") == renderer_source.count("document.title")
    assert "localStorage" not in renderer_source
    assert "sessionStorage" not in renderer_source


def test_lobby_behavior_is_module_owned_not_inline_script():
    lobby_html = LOBBY_HTML.read_text()
    lobby_source = LOBBY_JS.read_text()

    assert '<script type="module" src="/lobby.js"></script>' in lobby_html
    assert "<script>" not in lobby_html
    assert 'import { tokenStorageKey } from "./src/storage.js";' in lobby_source
    assert 'import { startLobbySky } from "./src/lobby-sky.js";' in lobby_source
    assert 'fetch("/api/rooms"' in lobby_source
    assert "fetch(`/api/rooms/${encodeURIComponent(roomId)}/join`" in lobby_source


def test_static_pages_keep_vite_module_loading_path():
    room = ROOM_HTML.read_text()
    lobby = LOBBY_HTML.read_text()

    youtube_script = '<script src="https://www.youtube.com/iframe_api"></script>'
    app_script = '<script type="module" src="/app.js"></script>'
    lobby_script = '<script type="module" src="/lobby.js"></script>'

    # Self-hosted assets replace the Tailwind/Google Fonts CDN so the
    # room works fully offline (YouTube stays as the allowed exception).
    assert '<link rel="stylesheet" href="/tailwind.css" />' in room
    assert '<link rel="stylesheet" href="/tailwind.css" />' in lobby
    assert '<link rel="stylesheet" href="/fonts.css" />' in room
    assert '<link rel="stylesheet" href="/fonts.css" />' in lobby
    assert '"/room.css"' in room
    assert '"/lobby.css"' in lobby
    assert youtube_script in room
    assert app_script in room
    assert lobby_script in lobby
    assert room.index(youtube_script) < room.index(app_script)


def test_responsive_polish_guards_short_landscape_and_mobile_copy():
    lobby_html = LOBBY_HTML.read_text()
    lobby_css = LOBBY_CSS.read_text()
    room_css = ROOM_CSS.read_text()

    assert "같은 하늘 아래,<br /> 각자의 일에 깊이 머무는 시간." in lobby_html
    assert "@media (orientation: landscape) and (max-height: 520px) and (min-width: 761px)" in lobby_css
    assert ".lobby-footer" in lobby_css and "position: static;" in lobby_css
    assert "body.track-panel-open #controls" in room_css
    assert "body.track-panel-open #track-row" in room_css
    assert "@media (pointer: coarse), (max-width: 900px), (orientation: landscape) and (max-height: 480px)" in room_css
    assert ".copy-room,\n  .icon-button,\n  #btn-reset-time,\n  #track-add,\n  #track-cancel" in room_css
    assert "#time-slider {\n    min-height: 2.75rem !important;" in room_css
    assert ".status-toast {\n  position: absolute;\n  top: calc(var(--room-edge) + 4.75rem);" in room_css
    assert "right: var(--room-edge);" in room_css
    assert "text-align: right;" in room_css
    assert "@media (pointer: coarse) and (min-width: 901px) and (orientation: landscape)" in room_css


def test_room_dialogs_use_shared_modal_isolation():
    dom_source = DOM_JS.read_text()
    modules = [
        ROOM_AUTH_JS.read_text(),
        MUSIC_YOUTUBE_JS.read_text(),
        SCENE_PICKER_JS.read_text(),
        (SRC / "display-settings.js").read_text(),
        APP_JS.read_text(),
    ]

    assert "export function setModalIsolation(root, active)" in dom_source
    assert "walkModalSiblings(root" in dom_source
    for source in modules:
        assert "setModalIsolation" in source
        assert "setModalIsolation(" in source

    for source, root_name in (
        (SCENE_PICKER_JS.read_text(), "panel"),
        ((SRC / "display-settings.js").read_text(), "panel"),
        (ROOM_AUTH_JS.read_text(), "authPrompt"),
    ):
        close_source = (
            source.split("function close", 1)[1] if "function close" in source else source.split("function hide", 1)[1]
        )
        assert close_source.index(f"setModalIsolation({root_name}, false);") < close_source.index(".deactivate(")

    app_source = APP_JS.read_text()
    assert 'setModalIsolation(byId("exit-confirm"), true);' in app_source
    assert 'setModalIsolation(byId("exit-confirm"), false);' in app_source
    close_exit_source = app_source.split("function closeExitConfirm", 1)[1]
    assert close_exit_source.index('setModalIsolation(byId("exit-confirm"), false);') < close_exit_source.index(
        "exitTrap.deactivate"
    )


def test_task_10_accessibility_markup_and_live_regions_present():
    room = ROOM_HTML.read_text()
    lobby = LOBBY_HTML.read_text()

    assert '<label for="pin-input"' in lobby
    assert 'id="lobby-error"' in lobby and 'aria-live="polite"' in lobby
    assert 'aria-expanded="false"' in lobby and 'aria-controls="code-section"' in lobby
    assert 'id="code-section" aria-hidden="true"' in lobby
    assert 'id="room-input"' in lobby and 'tabindex="-1"' in lobby

    assert 'id="conn-status"' in room and 'aria-live="polite"' in room
    assert 'id="conn-copy"' in room
    assert 'id="btn-copy-room"' in room and 'aria-label="방 코드 복사"' in room
    assert 'id="room-status"' in room and 'role="status"' in room
    assert 'id="timer-status"' in room and 'role="status"' in room
    assert 'id="time-slider"' in room and 'aria-valuetext="12:00"' in room
    assert 'id="track-error"' in room and 'aria-live="polite"' in room
    assert 'id="room-auth"' in room and 'role="dialog"' in room and 'aria-modal="true"' in room
    assert 'id="exit-confirm"' in room and 'role="alertdialog"' in room
    assert 'id="yt-frame"' in room and "inert" in room
    assert "@media (prefers-reduced-motion: reduce)" in room


def test_quiet_orbit_scene_picker_markup_and_module_contract():
    app_source = APP_JS.read_text()
    room_source = ROOM_HTML.read_text()
    picker_source = SCENE_PICKER_JS.read_text()
    scenes_source = SCENES_JS.read_text()

    assert 'import { createScenePicker } from "./src/scene-picker.js";' in app_source
    assert "createScenePicker({ sceneController" in app_source
    assert 'id="scene-panel"' in room_source
    assert 'role="dialog"' in room_source
    assert 'aria-labelledby="scene-panel-title"' in room_source
    assert 'id="btn-scene"' in room_source and 'aria-controls="scene-panel"' in room_source
    assert 'id="scene-label"' in room_source
    assert {f'data-scene="{name}"' for name in ("sky", "city", "forest")} <= {
        fragment for fragment in room_source.split() if fragment.startswith('data-scene="')
    }
    assert 'data-scene="beach"' not in room_source
    assert 'if (name === "beach") return "sky";' in scenes_source
    assert 'panel.querySelectorAll("[data-scene]")' in picker_source
    assert 'option.setAttribute("aria-pressed"' in picker_source
    assert "sceneController.switchScene(next);" in picker_source
    assert "getSceneHealth:" in scenes_source
    assert 'document.getElementById("btn-scene")' not in scenes_source
    assert "bindSceneButton" not in scenes_source


def test_quiet_orbit_idle_timer_connection_copy_and_break_progress_contracts():
    room_source = ROOM_HTML.read_text()
    app_source = APP_JS.read_text()
    socket_source = ROOM_SOCKET_JS.read_text()
    renderer_source = ROOM_RENDERER_JS.read_text()
    timer_source = TIMER_CONTROLS_JS.read_text()

    assert 'id="idle-duration"' in room_source
    assert 'id="focus-btn"' in room_source
    duration_handler = timer_source.split('document.querySelectorAll("#dur-chips button")', 1)[1].split(
        'timeSlider.addEventListener("input"', 1
    )[0]
    assert "focus_toggle" not in duration_handler
    assert "if (minutes !== activeMin) setDur(minutes);" in duration_handler
    assert 'byId("idle-duration")' in renderer_source

    assert 'id="conn-copy"' in room_source
    assert 'id="btn-copy-room"' in room_source
    assert 'class="status-toast"' in room_source
    assert "navigator.clipboard.writeText(ROOM_ID)" in app_source
    for label in ("연결 중", "연결됨", "재연결 중", "PIN 필요"):
        assert label in socket_source

    assert "state.break_duration" not in renderer_source
    assert "state.break_remaining" in renderer_source
    assert "state.sessions_done" in renderer_source

    all_frontend_source = "\n".join(
        path.read_text() for path in [APP_JS, SCENES_JS, LOBBY_JS, *sorted(SRC.rglob("*.js"))]
    )
    assert "state.break_duration" not in all_frontend_source
    celestial_source = CELESTIAL_JS.read_text()
    assert "state.sessions_done % 4 === 0 ? 1500 : 600" in celestial_source


def test_celestial_discs_and_scene_effects_keep_their_visual_contracts():
    celestial = CELESTIAL_JS.read_text()
    sky_dome = SKY_DOME_JS.read_text()
    forest = FOREST_SCENE_JS.read_text()
    scene_manager = SCENE_MANAGER_JS.read_text()

    assert "new THREE.Sprite(sunMat)" in celestial
    assert "coronaSprite.renderOrder = -1" in celestial
    assert "moonHaloSprite.renderOrder = -1" in celestial
    assert "pow(max(0.0, sunCos), 512.0) * 0.30" in sky_dome
    assert "vWorldPosition - cameraPosition" in sky_dome
    assert "uSunPosition - cameraPosition" in sky_dome
    assert "night_arc_pct" in celestial
    assert "180 * viewportAspect" in celestial
    assert "window.devicePixelRatio" not in celestial
    assert "window.devicePixelRatio" not in forest

    assert "setShaftsEnabled" in forest
    assert "setViewportAspect" in forest
    assert "setPixelRatio" in forest
    assert "THREE.UniformsLib.fog" in forest
    assert "setShaftsEnabled" in scene_manager
    assert "setViewportAspect" in scene_manager
    assert "setPixelRatio" in scene_manager


def test_beach_scene_imports_shared_reduced_motion_helper():
    motion_source = MOTION_JS.read_text()
    beach_source = BEACH_SCENE_JS.read_text()

    assert "export function prefersReducedMotion" in motion_source
    assert 'import { prefersReducedMotion } from "../motion.js";' in beach_source
    assert "const reducedMotion = prefersReducedMotion();" in beach_source


def test_3d_engine_fatal_teardown_and_post_quality_contracts():
    engine = ENGINE_JS.read_text()
    post = POST_JS.read_text()
    scenes = SCENES_JS.read_text()

    assert "create3DEngine(container = document.body, { onFatal, onFirstFrame } = {})" in engine
    assert 'reportFatal(error, "tick")' in engine
    assert 'reportFatal(error, "post-render")' in engine
    assert "renderer.debug.onShaderError" in engine
    assert 'canvas.addEventListener("webglcontextlost", onContextLost)' in engine
    assert 'canvas.addEventListener("webglcontextcreationerror", onContextCreationError)' in engine
    assert "if (fatalReported || destroyed) return;" in engine

    post_init = engine.index("post = createPostFX")
    canvas_mount = engine.index("container.insertBefore")
    pointer_registration = engine.index('window.addEventListener("pointermove"')
    assert post_init < canvas_mount < pointer_registration
    assert "renderer.dispose();" in engine[post_init:canvas_mount]
    assert 'reportFatal(error, "post-initialization")' in engine[post_init:canvas_mount]
    assert "animationFrameId = requestAnimationFrame(renderLoop);" in engine
    assert "\n  renderLoop();" not in engine
    assert "successfulFrameSerial >= contentReadyFrameSerial + 2" in engine
    assert "firstFramePublishScheduled" in engine
    assert "markContentReady" in engine
    assert 'typeof onFirstFrame === "function"' in engine
    assert "afterNextStableRender" in engine
    assert "renderer.compileAsync" in scenes
    assert "getActiveSceneProfile().suppressBloom" in scenes

    first_frame_callback = scenes.split("onFirstFrame:", 1)[1].split("},", 1)[0]
    assert 'document.body.classList.add("is-3d")' in first_frame_callback
    before_tick = scenes.split("engine.onTick", 1)[0]
    assert before_tick.count('document.body.classList.add("is-3d")') == 1

    assert "disposeSceneResources(scene);" in engine
    assert "for (const texture of textures) texture.dispose();" in engine
    assert "for (const material of materials) material.dispose();" in engine
    assert "for (const geometry of geometries) geometry.dispose();" in engine
    assert "for (const pass of [renderPass, bloom, shafts.pass, grade, output]) pass.dispose();" in post

    assert "const MAX_EFFECTIVE_DPR = 2;" in engine
    assert "return Math.min(MAX_EFFECTIVE_DPR, base, areaCapRatio);" in engine
    assert "if (!ratioChanged && !sizeChanged) return;" in engine
    assert "renderer.setDrawingBufferSize(width, height, nextPixelRatio);" in engine
    assert "resizeFrameId" not in engine
    assert "composer.setPixelRatio(1);" in post
    assert "composerWidth === physicalWidth" in post

    assert "uniform vec2  uTexelSize;" in post
    assert "radial * uTexelSize * (uCA * 0.5 * edge)" in post
    assert "0.0026" not in post
    assert "(0.0036 + 0.0081 * uNight)" in post
    assert "grade.uniforms.uTime.value = reducedMotion ? 0 : elapsed;" in post


def test_celestial_layers_wait_for_an_authoritative_state_before_becoming_visible():
    celestial = CELESTIAL_JS.read_text()
    renderer = ROOM_RENDERER_JS.read_text()

    assert "keyLight.visible = false;" in celestial
    assert "keyLight.visible = true;" in celestial
    assert "uOpacity: { value: 0 }" in celestial
    assert "starMesh.visible = false;" in celestial
    assert "mwMesh.visible = false;" in celestial
    assert "meteorPoints.visible = false;" in celestial
    assert "trailPoints.visible = false;" in celestial
    assert "satOrbitGroup.visible = false;" in celestial
    assert "const T = { sun: 0, moon: 0," in celestial
    assert "THREE.MathUtils.smoothstep(elev, 0, 6)" in celestial
    assert "const sunT = Math.max(0, Math.min(1, elev / 6));" in renderer
    assert "const sunOpacity = sunT * sunT * (3 - 2 * sunT);" in renderer
    assert "const rawMoonArcPct = Number(c.night_arc_pct);" in renderer
    assert "mg.style.transform = `translate(${moonX}px,${moonY}px)`;" in renderer


def test_focus_control_geometry_and_city_floor_have_no_aspect_dependent_crop():
    room_css = ROOM_CSS.read_text()
    city_source = CITY_SCENE_JS.read_text()

    for declaration in (
        "inline-size: var(--focus-diameter)",
        "block-size: var(--focus-diameter)",
        "min-inline-size: var(--focus-diameter)",
        "min-block-size: var(--focus-diameter)",
        "aspect-ratio: 1 / 1",
    ):
        assert declaration in room_css

    assert "const parapet =" not in city_source
    assert "const parapetCap =" not in city_source
    assert "new THREE.PlaneGeometry(1200, 1200)" in city_source


def test_task_10_accessibility_behavior_is_module_owned():
    app_source = APP_JS.read_text()
    dom_source = (SRC / "dom.js").read_text()
    auth_source = ROOM_AUTH_JS.read_text()
    renderer_source = ROOM_RENDERER_JS.read_text()
    music_source = MUSIC_YOUTUBE_JS.read_text()
    socket_source = ROOM_SOCKET_JS.read_text()
    scenes_source = SCENES_JS.read_text()
    lobby_sky_source = LOBBY_SKY_JS.read_text()

    assert "export function createFocusTrap" in dom_source
    assert "export function setHiddenInteraction" in dom_source
    assert 'el.dataset.originalTabIndex = el.hasAttribute("tabindex")' in dom_source
    assert '"__none__"' in dom_source
    assert 'el.dataset.interactionHidden === "true"' in dom_source
    assert "createFocusTrap(authPrompt" in auth_source
    assert 'createFocusTrap(byId("exit-confirm")' in app_source
    assert 'setHiddenInteraction(byId("exit-confirm"), true)' in app_source
    assert "setHiddenInteraction(breakRow, true)" in renderer_source
    assert "setHiddenInteraction(focusRow, false)" in renderer_source
    assert 'setHiddenInteraction(byId("music-bar"), true)' in music_source
    assert "createFocusTrap(trackRowEl" in music_source
    assert 'trackInput.setAttribute("aria-invalid", "true")' in music_source
    assert "showMusicBar();" in music_source
    assert "YouTube 링크 또는 11자리 영상 ID" in music_source
    assert "connStatus.textContent" in socket_source
    assert "prefersReducedMotion" in scenes_source
    assert "prefersReducedMotion" in lobby_sky_source


def test_youtube_player_replacement_stays_hidden_from_keyboard_navigation():
    music_source = MUSIC_YOUTUBE_JS.read_text()

    assert "function hideYouTubeFrame()" in music_source
    assert 'ytPlayer?.getIframe?.() || byId("yt-frame")' in music_source
    assert 'frame?.setAttribute("aria-hidden", "true")' in music_source
    assert 'frame?.setAttribute("tabindex", "-1")' in music_source
    assert 'frame?.toggleAttribute("inert", true)' in music_source
    assert "events: { onReady: () => { hideYouTubeFrame(); ytReady = true;" in music_source
    assert "setTimeout(hideYouTubeFrame, 0);" in music_source


def test_quiet_orbit_visual_structure_and_session_contracts():
    room = ROOM_HTML.read_text()
    lobby = LOBBY_HTML.read_text()
    room_css = ROOM_CSS.read_text()
    lobby_css = LOBBY_CSS.read_text()
    lobby_sky = LOBBY_SKY_JS.read_text()
    renderer = ROOM_RENDERER_JS.read_text()
    timer = TIMER_CONTROLS_JS.read_text()
    engine = (FRONTEND / "src" / "3d" / "engine.js").read_text()
    scenes = SCENES_JS.read_text()

    assert "--background:" not in room
    assert "--card:" not in room
    assert "--card-foreground:" not in room
    assert "--muted:" not in room
    assert "--border:" not in room
    assert "hsl(var(--foreground))" in room
    assert "hsl(var(--primary))" in room
    assert "hsl(var(--primary-foreground))" in room
    assert "hsl(var(--muted-foreground))" in room
    assert "var(--radius)" in room
    assert "var(--font-display)" in room
    assert "var(--font-body)" in room
    assert "var(--ease)" in room
    assert "var(--ease-slow)" in room

    # Shared Velorah layer: tokens/glass/type live in velorah.css, which
    # both pages consume.
    velorah = (FRONTEND / "velorah.css").read_text()
    assert "hsl(var(--ring))" in velorah
    assert "--radius-pill:" in velorah
    assert "--track-hangul:" in velorah
    assert ".liquid-glass" in velorah
    assert '"/velorah.css"' in room
    assert '"/velorah.css"' in lobby
    assert '"/room.css"' in room
    assert '"/lobby.css"' in lobby
    assert ".lobby-shell" in lobby_css
    assert ".entry-panel" in lobby_css
    assert "body.quiet-orbit" in room_css

    assert "celestial focus room" not in lobby
    assert "PIN 4자리 이상이면" not in lobby
    assert "AethelDesk" in lobby
    assert 'id="pin-input"' in lobby
    assert 'id="btn-start"' in lobby
    assert 'id="code-toggle"' in lobby
    assert 'id="code-section" aria-hidden="true"' in lobby
    assert 'document.body.classList.toggle("day"' in lobby_sky

    assert 'classList.toggle("is-session"' in renderer
    combined_room_styles = room + room_css
    assert "body.is-session #hud-tl" in combined_room_styles
    assert "body.is-session #time-dial" in combined_room_styles
    assert "body.is-session #dur-chips" in combined_room_styles
    assert "body.is-session #clock" in combined_room_styles
    assert "body.is-session #hud-tr .hud-chip" in combined_room_styles
    assert "body.is-session #hud-tr {" not in combined_room_styles
    assert "body.is-session #hud-tr{" not in combined_room_styles
    assert 'id="btn-pause-timer"' in room
    assert 'id="btn-skip-break"' in room
    assert 'id="btn-cancel-timer"' in room
    assert 'byId("pomodoro").addEventListener("click"' in timer
    assert 'send({ type: "focus_pause" })' in timer
    assert 'send({ type: "skip_break" })' in timer
    assert 'setHiddenInteraction(byId("time-dial")' in renderer

    assert "const initialSize = getContainerSize();" in engine
    assert "new THREE.PerspectiveCamera(55, initialSize.width / initialSize.height" in engine
    assert 'canvas.style.position = "absolute";' in engine
    assert "new ResizeObserver(resize)" in engine
    assert "window.innerWidth / window.innerHeight" not in engine
    assert "--stage-width: min(100vw, 177.777778vh);" not in room_css
    assert "--stage-height: min(100vh, 56.25vw);" not in room_css
    assert "@supports (height: 100dvh)" in room_css
    assert "--stage-width: min(100vw, 177.777778dvh);" not in room_css
    assert "--stage-height: min(100dvh, 56.25vw);" not in room_css
    assert "--stage-width: 100vw;" in room_css
    assert "--stage-height: 100dvh;" in room_css
    assert "min(23cqw, 40cqh)" in room_css
    assert "container: room-stage / size;" in room_css
    assert "const { width, height } = getStageSize();" in renderer
    assert "canvas.width = Math.round(width);" in renderer
    assert "toneMappingExposure = 1.1" in engine
    assert "const targetFov = focusActive && !reducedMotion ? 52.5 : 55;" in scenes
    assert "height * 0.88" in renderer
    assert "height * 0.55" in renderer
    assert "!is3D()" in renderer
