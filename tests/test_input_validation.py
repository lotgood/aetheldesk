"""Boundary validation and rate-limit-identity hardening.

Covers the room id alphabet/length guard, PIN length policy, and the
X-Forwarded-For trust gate that protects PIN brute-force throttling from a
spoofed header when the app is exposed directly (no trusted proxy).
"""

import importlib

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend import config
from tests.test_backend_routes import FakeRedis

room_store_module = importlib.import_module("backend.room_store")
RoomStore = getattr(room_store_module, "RoomStore")


@pytest.fixture
def api_client(monkeypatch: pytest.MonkeyPatch):
    from backend import main as backend_main

    redis = FakeRedis()
    store = RoomStore(redis)
    monkeypatch.setattr(backend_main, "room_store", store)
    monkeypatch.setattr(backend_main, "event_bus", backend_main._build_event_bus())
    monkeypatch.setattr(backend_main, "rooms", {})
    monkeypatch.setattr(backend_main, "local_pin_hashes", {})
    monkeypatch.setattr(backend_main, "local_token_hashes", {})
    monkeypatch.setattr(backend_main, "event_subscription_tasks", {})
    with TestClient(backend_main.app) as client:
        yield client, redis


@pytest.mark.parametrize("bad_room_id", ["A:B", "room id", "X" * 65, "-"])
def test_create_and_join_reject_malformed_room_ids(api_client, bad_room_id):
    client, redis = api_client

    created = client.post("/api/rooms", json={"room_id": bad_room_id, "pin": "2468"})
    joined = client.post(f"/api/rooms/{bad_room_id}/join", json={"pin": "2468"})

    assert created.status_code == 400
    assert joined.status_code == 400
    # A malformed id is rejected before any Redis room key is written.
    assert not any(":room:" in key for key in redis.values)


@pytest.mark.parametrize("bad_pin", ["", "1", "123", "x" * 65])
def test_pin_length_policy_is_enforced(api_client, bad_pin):
    client, _redis = api_client

    created = client.post("/api/rooms", json={"room_id": "PINLEN", "pin": bad_pin})
    joined = client.post("/api/rooms/PINLEN/join", json={"pin": bad_pin})

    assert created.status_code == 422
    assert joined.status_code == 422


def test_websocket_rejects_malformed_room_id(api_client):
    client, _redis = api_client

    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/BAD:ID?token=whatever") as websocket:
            websocket.receive_text()


def test_xforwarded_for_is_ignored_by_default_so_rate_limit_cannot_be_bypassed(api_client):
    client, _redis = api_client
    client.post("/api/rooms", json={"room_id": "SPOOF", "pin": "2468"})

    # A different spoofed forwarded IP per request must NOT reset the throttle
    # because the proxy is not trusted by default.
    last = None
    for i in range(6):
        last = client.post(
            "/api/rooms/SPOOF/join",
            json={"pin": "1111"},
            headers={"X-Forwarded-For": f"10.0.0.{i}"},
        )
    assert last.status_code == 403


def test_xforwarded_for_is_honored_when_proxy_trusted(api_client, monkeypatch):
    client, _redis = api_client
    monkeypatch.setattr(config, "TRUST_PROXY", True)
    client.post("/api/rooms", json={"room_id": "TRUST", "pin": "2468"})

    # Each request looks like a fresh client, so none reaches the 5-attempt block.
    for i in range(6):
        response = client.post(
            "/api/rooms/TRUST/join",
            json={"pin": "1111"},
            headers={"X-Forwarded-For": f"10.0.0.{i}"},
        )
        assert response.status_code == 401
