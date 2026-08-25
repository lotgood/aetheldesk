import builtins
import json
from collections.abc import Generator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from backend import auth
from backend import frontend_routes
from backend import main as backend_main
from backend.room_store import RoomStore


class FakePubSub:
    async def subscribe(self, *channels: str) -> bool:
        return True

    async def listen(self):
        if False:
            yield {}

    async def aclose(self) -> None:
        return None


class FakeRedis:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.sets: dict[str, builtins.set[str]] = {}
        self.ttls: dict[str, int] = {}
        self.published: list[tuple[str, str]] = []
        self.fail_ping = False
        self.fail_get = False
        self.fail_set = False

    async def get(self, name: str) -> str | None:
        if self.fail_get:
            raise ConnectionError("redis down")
        return self.values.get(name)

    async def set(self, name: str, value: str, ex: int | None = None, nx: bool = False) -> bool:
        if self.fail_set:
            raise ConnectionError("redis down")
        if nx and name in self.values:
            return False
        self.values[name] = value
        if ex is not None:
            self.ttls[name] = ex
        return True

    async def expire(self, name: str, time: int) -> bool:
        if name in self.values:
            self.ttls[name] = time
            return True
        return False

    async def delete(self, *names: str) -> int:
        deleted = 0
        for name in names:
            if name in self.values or name in self.sets:
                deleted += 1
            self.values.pop(name, None)
            self.sets.pop(name, None)
            self.ttls.pop(name, None)
        return deleted

    async def sadd(self, name: str, *values: str) -> int:
        bucket = self.sets.setdefault(name, set())
        before = len(bucket)
        bucket.update(values)
        return len(bucket) - before

    async def srem(self, name: str, *values: str) -> int:
        bucket = self.sets.setdefault(name, set())
        before = len(bucket)
        bucket.difference_update(values)
        return before - len(bucket)

    async def smembers(self, name: str) -> builtins.set[str]:
        return set(self.sets.get(name, set()))

    async def sismember(self, name: str, value: str) -> bool:
        return value in self.sets.get(name, set())

    async def scard(self, name: str) -> int:
        return len(self.sets.get(name, set()))

    async def ping(self) -> bool:
        if self.fail_ping:
            raise ConnectionError("redis down")
        return True

    async def incr(self, name: str) -> int:
        current = int(self.values.get(name, "0"))
        next_value = current + 1
        self.values[name] = str(next_value)
        return next_value

    async def eval(self, script: str, numkeys: int, *keys_and_args: object) -> object:
        if numkeys == 4 and "AETHEL_CREATE_ROOM" in script:
            (
                index_key,
                state_key,
                metadata_key,
                token_index_key,
                room_id,
                encoded_state,
                encoded_metadata,
                ttl,
                max_rooms,
            ) = (str(value) for value in keys_and_args)
            if state_key in self.values or metadata_key in self.values:
                return -1
            rooms = self.sets.setdefault(index_key, set())
            rooms.discard(room_id)
            if len(rooms) >= int(max_rooms):
                return -2
            self.sets.pop(token_index_key, None)
            self.values[state_key] = encoded_state
            self.values[metadata_key] = encoded_metadata
            self.ttls[state_key] = int(ttl)
            self.ttls[metadata_key] = int(ttl)
            rooms.add(room_id)
            return 1
        if numkeys == 3 and "AETHEL_ISSUE_ROOM_TOKEN" in script:
            metadata_key, state_key, token_index_key, expected, token_hash, limit, ttl = (
                str(value) for value in keys_and_args
            )
            encoded_metadata = self.values.get(metadata_key)
            if encoded_metadata is None or state_key not in self.values:
                return -1
            if json.loads(encoded_metadata).get("room_instance_id") != expected:
                return -1
            tokens = self.sets.setdefault(token_index_key, set())
            if token_hash not in tokens and len(tokens) >= int(limit):
                return -2
            tokens.add(token_hash)
            self.ttls[state_key] = int(ttl)
            self.ttls[metadata_key] = int(ttl)
            self.ttls[token_index_key] = int(ttl)
            return 1
        if numkeys == 3 and "EXPIRE" in script:
            state_key, metadata_key, token_index_key, ttl = (str(value) for value in keys_and_args)
            if state_key not in self.values or metadata_key not in self.values:
                return 0
            self.ttls[state_key] = int(ttl)
            self.ttls[metadata_key] = int(ttl)
            if token_index_key in self.sets:
                self.ttls[token_index_key] = int(ttl)
            return 1
        if numkeys == 1 and "SCARD" in script:
            token_index_key, token_hash, limit, ttl = (str(value) for value in keys_and_args)
            tokens = self.sets.setdefault(token_index_key, set())
            if token_hash not in tokens and len(tokens) >= int(limit):
                return 0
            tokens.add(token_hash)
            self.ttls[token_index_key] = int(ttl)
            return 1
        raise AssertionError(f"unexpected eval arguments: {keys_and_args!r}")

    async def publish(self, channel: str, message: str) -> int:
        self.published.append((channel, message))
        return 1

    def pubsub(self) -> FakePubSub:
        return FakePubSub()


@pytest.fixture
def api_client(monkeypatch: pytest.MonkeyPatch) -> Generator[tuple[TestClient, FakeRedis], None, None]:
    redis = FakeRedis()
    store = RoomStore(redis)
    monkeypatch.setattr(backend_main, "room_store", store)
    monkeypatch.setattr(backend_main, "event_bus", backend_main._build_event_bus())
    monkeypatch.setattr(backend_main, "rooms", {})
    monkeypatch.setattr(backend_main, "local_pin_hashes", {})
    monkeypatch.setattr(backend_main, "local_token_hashes", {})
    monkeypatch.setattr(backend_main, "local_room_instance_ids", {})
    monkeypatch.setattr(backend_main, "event_subscription_tasks", {})
    with TestClient(backend_main.app) as client:
        yield client, redis


def assert_no_secret_fields(payload: dict[str, Any]) -> None:
    assert "pin" not in payload
    assert "pin_hash" not in payload
    assert "token_hash" not in payload


def test_create_room_uppercases_id_returns_token_without_pin_or_hash(api_client: tuple[TestClient, FakeRedis]):
    client, redis = api_client

    response = client.post("/api/rooms", json={"room_id": "mixd", "pin": "2468"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["room_id"] == "MIXD"
    assert isinstance(payload["token"], str) and payload["token"]
    assert_no_secret_fields(payload)
    assert "2468" not in json.dumps(redis.values)
    assert payload["token"] not in json.dumps(redis.values)


def test_create_room_generates_uppercase_id_and_join_returns_token_only(api_client: tuple[TestClient, FakeRedis]):
    client, _redis = api_client

    created = client.post("/api/rooms", json={"pin": "1357"})
    joined = client.post(f"/api/rooms/{created.json()['room_id'].lower()}/join", json={"pin": "1357"})

    assert created.status_code == 200
    assert created.json()["room_id"].isupper()
    assert set(created.json()) == {"room_id", "token"}
    assert joined.status_code == 200
    assert set(joined.json()) == {"token"}
    assert joined.json()["token"] != created.json()["token"]


def test_wrong_and_missing_pin_have_uniform_auth_failure(api_client: tuple[TestClient, FakeRedis]):
    client, _redis = api_client
    client.post("/api/rooms", json={"room_id": "LOCK", "pin": "2468"})

    wrong_pin = client.post("/api/rooms/LOCK/join", json={"pin": "0000"})
    wrong_room = client.post("/api/rooms/NOPE/join", json={"pin": "2468"})

    assert wrong_pin.status_code == 401
    assert wrong_room.status_code == 401
    assert wrong_pin.json() == wrong_room.json() == auth.failure_body()


def test_health_returns_ok_when_redis_is_reachable(api_client: tuple[TestClient, FakeRedis]):
    client, _redis = api_client

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_health_returns_503_when_redis_unreachable(api_client: tuple[TestClient, FakeRedis]):
    client, redis = api_client
    redis.fail_ping = True

    response = client.get("/health")

    assert response.status_code == 503
    assert response.json() == {"detail": "redis unavailable"}


def test_create_room_returns_503_when_redis_runtime_get_fails(api_client: tuple[TestClient, FakeRedis]):
    client, redis = api_client
    redis.fail_get = True

    response = client.post("/api/rooms", json={"room_id": "DOWN", "pin": "2468"})

    assert response.status_code == 503
    assert response.json() == {"detail": "redis unavailable"}


def test_join_room_returns_503_when_redis_runtime_get_fails(api_client: tuple[TestClient, FakeRedis]):
    client, redis = api_client
    created = client.post("/api/rooms", json={"room_id": "JOIN503", "pin": "2468"})
    assert created.status_code == 200
    redis.fail_get = True

    response = client.post("/api/rooms/JOIN503/join", json={"pin": "2468"})

    assert response.status_code == 503
    assert response.json() == {"detail": "redis unavailable"}


def test_root_and_room_routes_serve_static_pages(api_client: tuple[TestClient, FakeRedis]):
    client, _redis = api_client

    lobby = client.get("/")
    room = client.get("/room/mixd")

    assert lobby.status_code == 200
    assert "text/html" in lobby.headers.get("content-type", "")
    assert 'id="btn-start"' in lobby.text
    assert room.status_code == 200
    assert "text/html" in room.headers.get("content-type", "")
    assert room.headers["cache-control"] == "no-cache"
    assert 'id="room-label"' in room.text


def test_api_routes_are_not_shadowed_by_root_static_mount(api_client: tuple[TestClient, FakeRedis]):
    client, _redis = api_client

    response = client.post("/api/rooms", json={"room_id": "STATIC", "pin": "2468"})

    assert response.status_code == 200
    assert response.json()["room_id"] == "STATIC"


def test_vite_asset_mount_uses_immutable_cache_headers(tmp_path: Path):
    assets_dir = tmp_path / "assets"
    assets_dir.mkdir()
    asset = assets_dir / "app-abc123.js"
    asset.write_text("export {};", encoding="utf-8")
    static_app = backend_main.CacheControlledStaticFiles(
        directory=str(assets_dir),
        cache_control="public, max-age=31536000, immutable",
    )

    from fastapi import FastAPI

    app = FastAPI()
    app.mount("/assets", static_app)

    with TestClient(app) as client:
        response = client.get("/assets/app-abc123.js")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "public, max-age=31536000, immutable"


def test_frontend_file_prefers_vite_dist_and_falls_back_to_source(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    source_dir = tmp_path / "frontend"
    dist_dir = source_dir / "dist"
    source_dir.mkdir()
    dist_dir.mkdir()
    source_file = source_dir / "room.html"
    built_file = dist_dir / "room.html"
    source_file.write_text("source room", encoding="utf-8")
    built_file.write_text("built room", encoding="utf-8")
    monkeypatch.setattr(backend_main, "FRONTEND", str(source_dir))
    monkeypatch.setattr(backend_main, "FRONTEND_DIST", str(dist_dir))

    assert frontend_routes._frontend_file("room.html") == str(built_file)

    built_file.unlink()

    assert frontend_routes._frontend_file("room.html") == str(source_file)
