from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
APP_JS = FRONTEND / "app.js"
SCENES_JS = FRONTEND / "scenes.js"
LOBBY_JS = FRONTEND / "lobby.js"
ROOM_HTML = FRONTEND / "room.html"
LOBBY_HTML = FRONTEND / "lobby.html"
ROOM_CSS = FRONTEND / "styles" / "room.css"
LOBBY_CSS = FRONTEND / "styles" / "lobby.css"
SRC = FRONTEND / "src"
STORAGE_JS = SRC / "storage.js"
ROOM_SOCKET_JS = SRC / "room-websocket.js"
ROOM_AUTH_JS = SRC / "room-auth.js"
ROOM_RENDERER_JS = SRC / "room-renderer.js"
TIMER_CONTROLS_JS = SRC / "timer-controls.js"
MUSIC_YOUTUBE_JS = SRC / "music-youtube.js"
LOBBY_SKY_JS = SRC / "lobby-sky.js"
GITIGNORE = ROOT / ".gitignore"


class ExternalAssetParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.origins: set[str] = set()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        for attr in ("src", "href"):
            value = attributes.get(attr)
            if value is None or not value.startswith("https://"):
                continue
            parsed = urlparse(value)
            self.origins.add(f"{parsed.scheme}://{parsed.netloc}")


def _frontend_sources() -> dict[str, str]:
    paths = [APP_JS, SCENES_JS, LOBBY_JS, *sorted(SRC.glob("*.js"))]
    return {path.name: path.read_text() for path in paths}


def test_playlist_is_read_once_and_reused_by_music_module():
    storage_source = STORAGE_JS.read_text()
    controller_source = (SRC / "room-controller.js").read_text()
    music_source = MUSIC_YOUTUBE_JS.read_text()

    assert "const savedPlaylist = readPlaylist();" in storage_source
    assert "ids: savedPlaylist || [...DEFAULT_PLAYLIST_IDS]" in storage_source
    assert "const playlist = createPlaylistState();" in controller_source
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
    assert 'localStorage.setItem("pomodoro_minutes"' not in combined_source
    assert "localStorage.setItem(tokenStorageKey" not in combined_source
    assert "localStorage.getItem(tokenStorageKey" not in combined_source
    assert "localStorage.removeItem(tokenStorageKey" not in combined_source


def test_room_token_uses_session_storage_keyed_by_uppercase_room_id():
    storage_source = STORAGE_JS.read_text()
    controller_source = (SRC / "room-controller.js").read_text()
    lobby_source = LOBBY_JS.read_text()

    assert 'const roomId = location.pathname.split("/").pop().toUpperCase();' in controller_source
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
    controller_source = (SRC / "room-controller.js").read_text()
    scenes_source = SCENES_JS.read_text()
    room_source = ROOM_HTML.read_text()

    assert SCENES_JS.exists()
    assert 'import { createSceneController } from "../scenes.js";' in controller_source
    assert "export function createSceneController()" in scenes_source
    assert "render: renderScene" in scenes_source
    assert "sceneController.render(c);" in (SRC / "celestial-renderer.js").read_text()
    assert "window.AethelScenes" not in controller_source + scenes_source
    assert '<script type="module" src="/scenes.js"></script>' not in room_source


def test_room_modules_have_intentional_boundaries():
    controller_source = (SRC / "room-controller.js").read_text()

    expected_imports = [
        "./storage.js",
        "./room-connection.js",
        "./room-renderer.js",
        "./timer-controls.js",
        "./music-youtube.js",
        "../scenes.js",
        "./room-state.js",
    ]
    for module_path in expected_imports:
        assert module_path in controller_source
    assert "new WebSocket" in ROOM_SOCKET_JS.read_text()
    assert "window.onYouTubeIframeAPIReady" in MUSIC_YOUTUBE_JS.read_text()
    assert "#dur-chips button" in TIMER_CONTROLS_JS.read_text()
    assert "renderFocus" in ROOM_RENDERER_JS.read_text()


def test_room_timer_updates_browser_title_from_renderer():
    room_source = ROOM_HTML.read_text()
    timer_view_source = (SRC / "timer-view.js").read_text()
    combined_source = "\n".join(_frontend_sources().values())

    assert "<title>AethelDesk</title>" in room_source
    assert "function updateTimerTitle(" in timer_view_source
    assert "document.title" in timer_view_source
    assert "fmtTime(remaining)" in timer_view_source
    assert "fmtTime(breakRemaining)" in timer_view_source
    assert "집중" in timer_view_source
    assert "일시정지" in timer_view_source
    assert "휴식" in timer_view_source
    assert 'document.title = "AethelDesk";' in timer_view_source
    assert combined_source.count("document.title") == timer_view_source.count("document.title")
    assert "localStorage" not in timer_view_source
    assert "sessionStorage" not in timer_view_source


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
    room_css = '<link rel="stylesheet" href="/styles/room.css" />'
    lobby_css = '<link rel="stylesheet" href="/styles/lobby.css" />'

    assert "https://cdn.tailwindcss.com" not in room
    assert "https://cdn.tailwindcss.com" not in lobby
    assert room_css in room
    assert lobby_css in lobby
    assert youtube_script in room
    assert app_script in room
    assert lobby_script in lobby
    assert room.index(room_css) < room.index(app_script)
    assert lobby.index(lobby_css) < lobby.index(lobby_script)
    assert room.index(youtube_script) < room.index(app_script)


def test_static_pages_allow_only_current_external_asset_origins():
    parser = ExternalAssetParser()
    parser.feed(ROOM_HTML.read_text())
    parser.feed(LOBBY_HTML.read_text())

    assert parser.origins == {"https://www.youtube.com"}


def test_static_pages_use_local_source_controlled_css():
    room_css = ROOM_CSS.read_text()
    lobby_css = LOBBY_CSS.read_text()

    assert ".liquid-glass" in room_css
    assert "#code-section" in lobby_css
    assert "ui-sans-serif" in room_css + lobby_css
    assert "Georgia" in room_css
    assert "@media (prefers-reduced-motion: reduce)" in room_css
    assert "@media (prefers-reduced-motion: reduce)" in lobby_css
    assert "cdn.tailwindcss.com" not in room_css + lobby_css


def test_frontend_dist_is_generated_output_not_a_source_target():
    readme = Path("README.md").read_text(encoding="utf-8")
    contracts = Path("docs/architecture/contracts.md").read_text(encoding="utf-8")
    gitignore = GITIGNORE.read_text(encoding="utf-8")

    assert "frontend/dist/" in gitignore
    assert "frontend/dist" in readme and "generated" in readme.lower()
    assert "do not edit" in readme.lower()
    assert "frontend/dist/` is generated" in contracts
    assert "should not be edited by hand" in contracts


def test_task_10_accessibility_markup_and_live_regions_present():
    room = ROOM_HTML.read_text()
    lobby = LOBBY_HTML.read_text()

    assert '<label for="pin-input"' in lobby
    assert 'id="lobby-error"' in lobby and 'aria-live="polite"' in lobby
    assert 'aria-expanded="false"' in lobby and 'aria-controls="code-section"' in lobby
    assert 'id="code-section" aria-hidden="true"' in lobby
    assert 'id="room-input"' in lobby and 'tabindex="-1"' in lobby

    assert 'id="conn-status"' in room and 'aria-live="polite"' in room
    assert 'id="room-status"' in room and 'role="status"' in room
    assert 'id="timer-status"' in room and 'role="status"' in room
    assert 'id="time-slider"' in room and 'aria-valuetext="12:00"' in room
    assert 'id="track-error"' in room and 'aria-live="polite"' in room
    assert 'id="room-auth"' in room and 'role="dialog"' in room and 'aria-modal="true"' in room
    assert 'id="exit-confirm"' in room and 'role="alertdialog"' in room
    assert 'id="yt-frame"' in room and "inert" in room
    assert "@media (prefers-reduced-motion: reduce)" in ROOM_CSS.read_text()


def test_task_10_accessibility_behavior_is_module_owned():
    exit_source = (SRC / "exit-confirm.js").read_text()
    dom_source = (SRC / "dom.js").read_text()
    auth_source = ROOM_AUTH_JS.read_text()
    timer_view_source = (SRC / "timer-view.js").read_text()
    music_source = MUSIC_YOUTUBE_JS.read_text()
    socket_source = ROOM_SOCKET_JS.read_text()
    scenes_source = SCENES_JS.read_text()
    lobby_sky_source = LOBBY_SKY_JS.read_text()

    assert "export function createFocusTrap" in dom_source
    assert "export function setHiddenInteraction" in dom_source
    assert "createFocusTrap(authPrompt" in auth_source
    assert "createFocusTrap(exitConfirm" in exit_source
    assert "setHiddenInteraction(exitConfirm, true)" in exit_source
    assert "setHiddenInteraction(breakRow, true)" in timer_view_source
    assert "setHiddenInteraction(focusRow, false)" in timer_view_source
    assert 'setHiddenInteraction(byId("music-bar"), true)' in music_source
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
