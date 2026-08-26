import asyncio
import logging
import os
from datetime import datetime
from importlib import import_module
from typing import Any, Protocol, TypedDict, cast

from fastapi import FastAPI, WebSocket
from fastapi.staticfiles import StaticFiles

from backend import config
from backend.connection_manager import LocalConnectionManager
from backend.state import BackendState, _parse_iso, advance_timer_state


def _backend_module(name: str) -> Any:
    return import_module(f"backend.{name}")


_lifespan_module = _backend_module("app_lifespan")
_frontend_routes_module = _backend_module("frontend_routes")
_room_routes_module = _backend_module("room_routes")
_room_service_module = _backend_module("room_service")
_scheduler_wiring_module = _backend_module("scheduler_wiring")
_websocket_handler_module = _backend_module("websocket_handler")

lifespan = cast(Any, _lifespan_module.lifespan)
frontend_router = cast(Any, _frontend_routes_module.router)
CreateRoomRequest = cast(Any, _room_routes_module.CreateRoomRequest)
JoinRoomRequest = cast(Any, _room_routes_module.JoinRoomRequest)
room_router = cast(Any, _room_routes_module.router)
_build_event_bus = cast(Any, _room_service_module._build_event_bus)
broadcast = cast(Any, _room_service_module.broadcast)
get_room = cast(Any, _room_service_module.get_room)
get_room_state = cast(Any, _room_service_module.get_room_state)
handle = cast(Any, _room_service_module.handle)
make_state = cast(Any, _room_service_module.make_state)
publish_room_state = cast(Any, _room_service_module.publish_room_state)
save_room_state = cast(Any, _room_service_module.save_room_state)
schedule_cleanup = cast(Any, _room_service_module.schedule_cleanup)
tick = cast(Any, _scheduler_wiring_module.tick)
websocket_router = cast(Any, _websocket_handler_module.router)


class GetCelestialState(Protocol):
    def __call__(
        self, dt: datetime | None = None, lat: float | None = None, lon: float | None = None
    ) -> dict[str, object]: ...


get_celestial_state = cast(GetCelestialState, import_module("backend.celestial").get_celestial_state)

logger = logging.getLogger("aetheldesk")

FRONTEND = os.path.abspath(os.path.join(os.path.dirname(__file__), "../frontend"))
FRONTEND_DIST = os.path.join(FRONTEND, "dist")
MAX_ROOMS = 50
ROOM_TTL = config.ROOM_TTL_SECONDS
WS_AUTH_CLOSE_CODE = 1008
WS_AUTH_CLOSE_REASON = "authentication failed"
WS_OPERATIONAL_CLOSE_CODE = 1011
WS_OPERATIONAL_CLOSE_REASON = "service unavailable"

Room = TypedDict(
    "Room",
    {
        "state": BackendState,
        "clients": set[WebSocket],
        "cleanup": asyncio.Task[None] | None,
    },
)

rooms: dict[str, Room] = {}
connections = LocalConnectionManager()
room_store: object | None = None
event_bus: object | None = None
event_subscription_tasks: dict[str, asyncio.Task[None]] = {}
event_subscription_ready: dict[str, asyncio.Future[None]] = {}
local_pin_hashes: dict[str, str] = {}
local_token_hashes: dict[str, set[str]] = {}
local_room_instance_ids: dict[str, str] = {}
worker_id = config.get_worker_identity()

__all__ = [
    "BackendState",
    "_parse_iso",
    "advance_timer_state",
]


class CacheControlledStaticFiles(StaticFiles):
    def __init__(self, *args: Any, cache_control: str, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._cache_control = cache_control

    async def get_response(self, path: str, scope: dict[str, Any]):
        response = await super().get_response(path, scope)
        if response.status_code == 200:
            response.headers["Cache-Control"] = self._cache_control
        return response


app = FastAPI(lifespan=lifespan)
app.include_router(frontend_router)
app.include_router(room_router)
app.include_router(websocket_router)
if os.path.isdir(os.path.join(FRONTEND_DIST, "assets")):
    app.mount(
        "/assets",
        CacheControlledStaticFiles(
            directory=os.path.join(FRONTEND_DIST, "assets"),
            cache_control="public, max-age=31536000, immutable",
        ),
        name="vite-assets",
    )
app.mount("/", CacheControlledStaticFiles(directory=FRONTEND, cache_control="no-cache"), name="static")
