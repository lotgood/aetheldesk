import os
import sys
from importlib import import_module
from typing import Any, cast

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

sys.path.insert(0, os.path.dirname(__file__))

try:
    from backend import runtime as runtime_state
    from backend.connection_manager import LocalConnectionManager
    from backend.state import BackendState, MusicState, _parse_iso, advance_timer_state
except ModuleNotFoundError:
    import runtime as runtime_state
    from connection_manager import LocalConnectionManager
    from state import BackendState, MusicState, _parse_iso, advance_timer_state


def _backend_module(name: str) -> Any:
    try:
        return import_module(f"backend.{name}")
    except ModuleNotFoundError:
        return import_module(name)


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


Room = runtime_state.Room
get_celestial_state = runtime_state.get_celestial_state
logger = runtime_state.logger
FRONTEND = runtime_state.FRONTEND
FRONTEND_DIST = runtime_state.FRONTEND_DIST
MAX_ROOMS = runtime_state.MAX_ROOMS
ROOM_TTL = runtime_state.ROOM_TTL
WS_AUTH_CLOSE_CODE = runtime_state.WS_AUTH_CLOSE_CODE
WS_AUTH_CLOSE_REASON = runtime_state.WS_AUTH_CLOSE_REASON
WS_OPERATIONAL_CLOSE_CODE = runtime_state.WS_OPERATIONAL_CLOSE_CODE
WS_OPERATIONAL_CLOSE_REASON = runtime_state.WS_OPERATIONAL_CLOSE_REASON
rooms = runtime_state.rooms
connections = runtime_state.connections
room_store = runtime_state.room_store
event_bus = runtime_state.event_bus
event_subscription_tasks = runtime_state.event_subscription_tasks
local_pin_hashes = runtime_state.local_pin_hashes
local_token_hashes = runtime_state.local_token_hashes
local_room_instance_ids = runtime_state.local_room_instance_ids
worker_id = runtime_state.worker_id


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
