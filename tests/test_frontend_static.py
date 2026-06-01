from pathlib import Path


APP_JS = Path(__file__).resolve().parents[1] / "frontend" / "app.js"
SCENES_JS = Path(__file__).resolve().parents[1] / "frontend" / "scenes.js"
ROOM_HTML = Path(__file__).resolve().parents[1] / "frontend" / "room.html"
LOBBY_HTML = Path(__file__).resolve().parents[1] / "frontend" / "lobby.html"


def test_playlist_is_read_once_and_reused():
    source = APP_JS.read_text()

    assert "const savedPlaylist = readPlaylist();" in source
    assert "const SKIP_IDS = savedPlaylist || [...DEFAULT_IDS];" in source
    assert "if (savedPlaylist) showMusicBar();" in source
    assert source.count("readPlaylist()") == 2


def test_duration_selection_does_not_write_dead_session_storage_key():
    source = APP_JS.read_text()

    assert "pomodoro_minutes" not in source


def test_frontend_persists_only_playlist_and_scene_local_storage_keys():
    app_source = APP_JS.read_text()
    scenes_source = SCENES_JS.read_text()
    combined_source = app_source + scenes_source

    assert 'localStorage.getItem("playlist")' in app_source
    assert 'localStorage.setItem("playlist"' in app_source
    assert "localStorage.getItem('scene')" in scenes_source
    assert "localStorage.setItem('scene', name)" in scenes_source
    assert combined_source.count("localStorage.setItem(") == 2
    assert "localStorage.setItem(\"pomodoro_minutes\"" not in combined_source
    assert "localStorage.setItem(tokenStorageKey" not in combined_source
    assert "localStorage.getItem(tokenStorageKey" not in combined_source
    assert "localStorage.removeItem(tokenStorageKey" not in combined_source


def test_room_token_uses_session_storage_keyed_by_uppercase_room_id():
    app_source = APP_JS.read_text()
    lobby_source = LOBBY_HTML.read_text()

    assert 'const ROOM_ID = location.pathname.split("/").pop().toUpperCase();' in app_source
    assert "function tokenStorageKey(roomId) { return `room_token:${roomId}`; }" in app_source
    assert "function tokenStorageKey(roomId) { return `room_token:${roomId}`; }" in lobby_source
    assert "sessionStorage.getItem(tokenStorageKey(ROOM_ID))" in app_source
    assert "sessionStorage.setItem(tokenStorageKey(ROOM_ID), token)" in app_source
    assert "sessionStorage.removeItem(tokenStorageKey(ROOM_ID))" in app_source
    assert "sessionStorage.setItem(tokenStorageKey(nextRoomId), data.token)" in lobby_source
    assert "sessionStorage.setItem(tokenStorageKey(roomId), data.token)" in lobby_source


def test_pin_flow_never_places_pin_or_token_in_page_urls_or_local_storage():
    app_source = APP_JS.read_text()
    lobby_source = LOBBY_HTML.read_text()
    combined_source = app_source + lobby_source

    assert "body: JSON.stringify({ room_id: roomId, pin })" in lobby_source
    assert "body: JSON.stringify({ pin })" in combined_source
    assert "?pin=" not in combined_source
    assert "&pin=" not in combined_source
    assert "localStorage" not in lobby_source
    assert 'localStorage.setItem("room_token' not in app_source
    assert 'localStorage.getItem("room_token' not in app_source
    assert 'localStorage.removeItem("room_token' not in app_source
    assert "localStorage.setItem(token" not in app_source
    assert "localStorage.getItem(token" not in app_source
    assert "localStorage.removeItem(token" not in app_source
    assert lobby_source.count("clearPin();") == 2
    assert 'roomPinInput.value = "";' in app_source


def test_room_auth_uses_tokenized_websocket_and_generic_korean_rejection():
    app_source = APP_JS.read_text()
    room_source = ROOM_HTML.read_text()
    lobby_source = LOBBY_HTML.read_text()

    assert "/ws/${ROOM_ID}?token=${encodeURIComponent(token)}" in app_source
    assert "event.code === 1008" in app_source
    assert "입장할 수 없습니다" in app_source
    assert "입장할 수 없습니다" in lobby_source
    assert 'id="pin-input"' in lobby_source
    assert 'id="room-pin-input"' in room_source
    assert 'id="room-pin-submit"' in room_source


def test_scene_system_is_extracted_to_classic_global():
    app_source = APP_JS.read_text()
    scenes_source = SCENES_JS.read_text()

    assert SCENES_JS.exists()
    assert "window.AethelScenes" in scenes_source
    assert "render: renderScene" in scenes_source
    assert "window.AethelScenes.render(c);" in app_source
    assert "function renderScene(c)" not in app_source


def test_static_pages_keep_classic_script_loading_path():
    room = ROOM_HTML.read_text()
    lobby = LOBBY_HTML.read_text()

    youtube_script = '<script src="https://www.youtube.com/iframe_api"></script>'
    scenes_script = '<script src="/scenes.js"></script>'
    app_script = '<script src="/app.js"></script>'

    assert '<script src="https://cdn.tailwindcss.com"></script>' in room
    assert '<script src="https://cdn.tailwindcss.com"></script>' in lobby
    assert youtube_script in room
    assert scenes_script in room
    assert app_script in room
    assert room.index(youtube_script) < room.index(scenes_script) < room.index(app_script)
