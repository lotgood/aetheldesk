from pathlib import Path


APP_JS = Path(__file__).resolve().parents[1] / "frontend" / "app.js"


def test_playlist_is_read_once_and_reused():
    source = APP_JS.read_text()

    assert "const savedPlaylist = readPlaylist();" in source
    assert "const SKIP_IDS = savedPlaylist || [...DEFAULT_IDS];" in source
    assert "if (savedPlaylist) showMusicBar();" in source
    assert source.count("readPlaylist()") == 2


def test_duration_selection_does_not_write_dead_session_storage_key():
    source = APP_JS.read_text()

    assert "pomodoro_minutes" not in source
