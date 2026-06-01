import importlib
from pathlib import Path

import pytest

from backend import redis_contract


def test_room_key_and_channel_builders_normalize_room_ids_to_uppercase():
    room_id = "  room-abc  "

    assert redis_contract.room_state_key(room_id) == "aetheldesk:room:ROOM-ABC:state"
    assert redis_contract.room_metadata_key(room_id) == "aetheldesk:room:ROOM-ABC:meta"
    assert (
        redis_contract.room_token_key(room_id, "hash123")
        == "aetheldesk:room:ROOM-ABC:token:hash123"
    )
    assert (
        redis_contract.room_pin_attempts_key(room_id, "fp123")
        == "aetheldesk:room:ROOM-ABC:pin-attempts:fp123"
    )
    assert (
        redis_contract.room_pin_block_key(room_id, "fp123")
        == "aetheldesk:room:ROOM-ABC:pin-block:fp123"
    )
    assert redis_contract.room_tick_lock_key(room_id) == "aetheldesk:room:ROOM-ABC:tick-lock"
    assert redis_contract.room_events_channel(room_id) == "aetheldesk:room:ROOM-ABC:events"

    assert redis_contract.room_state_key("room-abc") == redis_contract.room_state_key("ROOM-ABC")


def test_event_envelope_shape_and_version_are_exact():
    envelope = redis_contract.make_event_envelope(
        room_id="ab12",
        source_worker="worker-1",
        event_type="state_update",
        data={"ok": True},
        event_id="evt-1",
    )

    assert set(envelope.keys()) == {
        "version",
        "room_id",
        "event_id",
        "source_worker",
        "type",
        "data",
    }
    assert envelope["version"] == 1
    assert envelope["room_id"] == "AB12"
    assert envelope["event_id"] == "evt-1"
    assert envelope["source_worker"] == "worker-1"
    assert envelope["type"] == "state_update"
    assert envelope["data"] == {"ok": True}


def _reload_config(monkeypatch: pytest.MonkeyPatch, *, env: str | None, secret: str | None, pytest_active: bool):
    if env is None:
        monkeypatch.delenv("AETHELDESK_ENV", raising=False)
    else:
        monkeypatch.setenv("AETHELDESK_ENV", env)

    if secret is None:
        monkeypatch.delenv("AETHELDESK_SECRET_KEY", raising=False)
    else:
        monkeypatch.setenv("AETHELDESK_SECRET_KEY", secret)

    if pytest_active:
        monkeypatch.setenv("PYTEST_CURRENT_TEST", "yes")
    else:
        monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)

    import backend.config as config

    return importlib.reload(config)


def test_secret_key_required_for_production_and_docker_modes(monkeypatch: pytest.MonkeyPatch):
    config = _reload_config(monkeypatch, env="production", secret=None, pytest_active=False)
    with pytest.raises(RuntimeError, match="AETHELDESK_SECRET_KEY is required"):
        config.get_secret_key()

    config = _reload_config(monkeypatch, env="docker", secret=None, pytest_active=False)
    with pytest.raises(RuntimeError, match="production/docker"):
        config.get_secret_key()


def test_secret_key_uses_test_only_secret_in_pytest_mode(monkeypatch: pytest.MonkeyPatch):
    config = _reload_config(monkeypatch, env="production", secret=None, pytest_active=True)

    assert config.get_secret_key() == "test-only-secret"


def test_config_defaults_for_redis_and_ttls(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("REDIS_URL", raising=False)
    monkeypatch.delenv("ROOM_TTL_SECONDS", raising=False)
    monkeypatch.delenv("ROOM_TICK_LOCK_SECONDS", raising=False)

    import backend.config as config

    config = importlib.reload(config)
    assert config.REDIS_URL == "redis://redis:6379/0"
    assert config.ROOM_TTL_SECONDS == 300
    assert config.ROOM_TICK_LOCK_SECONDS == 2


@pytest.mark.parametrize("file_name", ["backend/redis_contract.py", "backend/config.py"])
def test_no_streams_or_sql_dependencies_introduced(file_name: str):
    source = Path(file_name).read_text(encoding="utf-8").lower()
    forbidden_tokens = ["xadd", "xread", "stream", "sqlite", "postgres", "sqlalchemy", "select "]
    for token in forbidden_tokens:
        assert token not in source
