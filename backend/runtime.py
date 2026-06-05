import asyncio
import logging
import os
import sys
from datetime import datetime
from types import ModuleType
from typing import Protocol, TypedDict

from fastapi import WebSocket

try:
    from backend import config
    from backend.celestial import get_celestial_state as _get_celestial_state
    from backend.connection_manager import LocalConnectionManager
    from backend.state import BackendState
except ModuleNotFoundError:
    import config
    from celestial import get_celestial_state as _get_celestial_state
    from connection_manager import LocalConnectionManager
    from state import BackendState


class GetCelestialState(Protocol):
    def __call__(
        self, dt: datetime | None = None, lat: float | None = None, lon: float | None = None
    ) -> dict[str, object]: ...


Room = TypedDict(
    "Room",
    {
        "state": BackendState,
        "clients": set[WebSocket],
        "cleanup": asyncio.Task[None] | None,
    },
)


logger = logging.getLogger("aetheldesk")
FRONTEND = os.path.abspath(os.path.join(os.path.dirname(__file__), "../frontend"))
FRONTEND_DIST = os.path.join(FRONTEND, "dist")
MAX_ROOMS = 50
ROOM_TTL = config.ROOM_TTL_SECONDS
WS_AUTH_CLOSE_CODE = 1008
WS_AUTH_CLOSE_REASON = "authentication failed"
WS_OPERATIONAL_CLOSE_CODE = 1011
WS_OPERATIONAL_CLOSE_REASON = "service unavailable"

rooms: dict[str, Room] = {}
connections = LocalConnectionManager()
room_store: object | None = None
event_bus: object | None = None
event_subscription_tasks: dict[str, asyncio.Task[None]] = {}
local_pin_hashes: dict[str, str] = {}
local_token_hashes: dict[str, set[str]] = {}
local_room_instance_ids: dict[str, str] = {}
worker_id = config.get_worker_identity()


def get_celestial_state(
    dt: datetime | None = None,
    lat: float | None = None,
    lon: float | None = None,
) -> dict[str, object]:
    return _get_celestial_state(dt, lat, lon)


def get_runtime() -> ModuleType:
    return sys.modules.get("backend.main") or sys.modules.get("main") or sys.modules[__name__]
