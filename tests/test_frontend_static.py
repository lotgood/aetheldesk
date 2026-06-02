from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
APP_JS = FRONTEND / "app.js"
SCENES_JS = FRONTEND / "scenes.js"
LOBBY_JS = FRONTEND / "lobby.js"
ROOM_HTML = FRONTEND / "room.html"
LOBBY_HTML = FRONTEND / "lobby.html"
SRC = FRONTEND / "src"
STORAGE_JS = SRC / "storage.js"
ROOM_SOCKET_JS = SRC / "room-websocket.js"
ROOM_AUTH_JS = SRC / "room-auth.js"
ROOM_RENDERER_JS = SRC / "room-renderer.js"
TIMER_CONTROLS_JS = SRC / "timer-controls.js"
MUSIC_YOUTUBE_JS = SRC / "music-youtube.js"
LOBBY_SKY_JS = SRC / "lobby-sky.js"


def _frontend_sources() -> dict[str, str]:
    paths = [APP_JS, SCENES_JS, LOBBY_JS, *sorted(SRC.glob("*.js"))]
    return {path.name: path.read_text() for path in paths}


def test_playlist_is_read_once_and_reused_by_music_module():
    storage_source = STORAGE_JS.read_text()
    app_source = APP_JS.read_text()
    music_source = MUSIC_YOUTUBE_JS.read_text()

    assert "const savedPlaylist = readPlaylist();" in storage_source
    assert "ids: savedPlaylist || [...DEFAULT_PLAYLIST_IDS]" in storage_source
    assert "const playlist = createPlaylistState();" in app_source
    assert "if (playlist.savedPlaylist) showMusicBar();" in music_source
    assert storage_source.count("readPlaylist()") == 2


def test_duration_selection_does_not_write_dead_session_storage_key():
    combined_source = "\n".join(_frontend_sources().values())

    assert "pomodoro_minutes" not in combined_source


def test_frontend_persists_only_playlist_and_scene_local_storage_keys():
    sources = _frontend_sources()
    combined_source = "\n".join(sources.values())
    storage_source = STORAGE_JS.read_text()

    assert 'export const PLAYLIST_STORAGE_KEY = "playlist";' in storage_source
    assert 'export const SCENE_STORAGE_KEY = "scene";' in storage_source
    assert "localStorage.getItem(PLAYLIST_STORAGE_KEY)" in storage_source
    assert "localStorage.setItem(PLAYLIST_STORAGE_KEY" in storage_source
    assert "localStorage.getItem(SCENE_STORAGE_KEY)" in storage_source
    assert "localStorage.setItem(SCENE_STORAGE_KEY" in storage_source
    assert combined_source.count("localStorage.setItem(") == 2
    assert "localStorage.setItem(\"pomodoro_minutes\"" not in combined_source
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
    assert "export function createSceneController()" in scenes_source
    assert "render: renderScene" in scenes_source
    assert "sceneController.render(c);" in ROOM_RENDERER_JS.read_text()
    assert "window.AethelScenes" not in app_source + scenes_source
    assert '<script type="module" src="/scenes.js"></script>' not in room_source


def test_room_modules_have_intentional_boundaries():
    app_source = APP_JS.read_text()

    expected_imports = [
        './src/storage.js',
        './src/room-auth.js',
        './src/room-websocket.js',
        './src/room-renderer.js',
        './src/timer-controls.js',
        './src/music-youtube.js',
        './scenes.js',
    ]
    for module_path in expected_imports:
        assert module_path in app_source
    assert "new WebSocket" in ROOM_SOCKET_JS.read_text()
    assert "window.onYouTubeIframeAPIReady" in MUSIC_YOUTUBE_JS.read_text()
    assert "#dur-chips button" in TIMER_CONTROLS_JS.read_text()
    assert "renderFocus" in ROOM_RENDERER_JS.read_text()


def test_lobby_behavior_is_module_owned_not_inline_script():
    lobby_html = LOBBY_HTML.read_text()
    lobby_source = LOBBY_JS.read_text()

    assert '<script type="module" src="/lobby.js"></script>' in lobby_html
    assert "<script>" not in lobby_html
    assert 'import { tokenStorageKey } from "./src/storage.js";' in lobby_source
    assert 'import { startLobbySky } from "./src/lobby-sky.js";' in lobby_source
    assert "fetch(\"/api/rooms\"" in lobby_source
    assert "fetch(`/api/rooms/${encodeURIComponent(roomId)}/join`" in lobby_source


def test_static_pages_keep_vite_module_loading_path():
    room = ROOM_HTML.read_text()
    lobby = LOBBY_HTML.read_text()

    youtube_script = '<script src="https://www.youtube.com/iframe_api"></script>'
    app_script = '<script type="module" src="/app.js"></script>'
    lobby_script = '<script type="module" src="/lobby.js"></script>'

    assert '<script src="https://cdn.tailwindcss.com"></script>' in room
    assert '<script src="https://cdn.tailwindcss.com"></script>' in lobby
    assert youtube_script in room
    assert app_script in room
    assert lobby_script in lobby
    assert room.index(youtube_script) < room.index(app_script)
