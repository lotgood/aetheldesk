import asyncio
import json
import logging
import re
import sys
import os
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timezone
from importlib import import_module
from typing import Protocol, TypedDict, cast
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

sys.path.insert(0, os.path.dirname(__file__))


class GetCelestialState(Protocol):
    def __call__(
        self, dt: datetime | None = None, lat: float | None = None, lon: float | None = None
    ) -> dict[str, object]: ...


get_celestial_state = cast(GetCelestialState, import_module("celestial").get_celestial_state)

logger = logging.getLogger("aetheldesk")

FRONTEND = os.path.join(os.path.dirname(__file__), "../frontend")
MAX_ROOMS = 50
ROOM_TTL = 300  # seconds before an empty room is deleted
YT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


def _parse_iso(iso: str) -> datetime:
    """Parse client ISO string; assume UTC when tz is missing."""
    dt = datetime.fromisoformat(iso)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)

# ── Room registry ─────────────────────────────────────────────────────────────


MusicState = TypedDict(
    "MusicState",
    {
        "playing": bool,
        "video_id": str,
    },
)


BackendState = TypedDict(
    "BackendState",
    {
        "celestial": dict[str, object],
        "focus": bool,
        "paused": bool,
        "pomodoro_remaining": int,
        "pomodoro_duration": int,
        "break": bool,
        "break_remaining": int,
        "sessions_done": int,
        "music": MusicState,
        "time_override": str | None,
    },
)


Room = TypedDict(
    "Room",
    {
        "state": BackendState,
        "clients": set[WebSocket],
        "cleanup": asyncio.Task[None] | None,
    },
)


rooms: dict[str, Room] = {}

def make_state() -> BackendState:
    return {
        "celestial": get_celestial_state(),
        "focus": False,
        "paused": False,
        "pomodoro_remaining": 3000,
        "pomodoro_duration": 3000,
        "break": False,
        "break_remaining": 0,
        "sessions_done": 0,
        "music": {"playing": False, "video_id": "jfKfPfyJRdk"},
        "time_override": None,
    }

def get_room(room_id: str) -> Room | None:
    if room_id not in rooms:
        if len(rooms) >= MAX_ROOMS:
            return None
        rooms[room_id] = {"state": make_state(), "clients": set(), "cleanup": None}
    else:
        # Cancel pending cleanup when someone rejoins
        task = rooms[room_id]["cleanup"]
        if task and not task.done():
            _ = task.cancel()
            rooms[room_id]["cleanup"] = None
    return rooms[room_id]


async def schedule_cleanup(room_id: str):
    await asyncio.sleep(ROOM_TTL)
    room = rooms.get(room_id)
    if room and not room["clients"] and room["cleanup"] is asyncio.current_task():
        _ = rooms.pop(room_id, None)


async def broadcast(room: Room, payload: dict[str, object]):
    dead: set[WebSocket] = set()
    for ws in room["clients"]:
        try:
            await ws.send_text(json.dumps(payload))
        except Exception:
            dead.add(ws)
    room["clients"].difference_update(dead)


def advance_timer_state(state: BackendState) -> bool:
    needs_broadcast = False

    # Pomodoro countdown
    if state["focus"] and not state["paused"] and state["pomodoro_remaining"] > 0:
        state["pomodoro_remaining"] -= 1
        needs_broadcast = True
        if state["pomodoro_remaining"] == 0:
            state["focus"] = False
            state["sessions_done"] += 1
            # Long break every 4 sessions, short break otherwise
            break_secs = 1500 if state["sessions_done"] % 4 == 0 else 600
            state["break"] = True
            state["break_remaining"] = break_secs
            state["pomodoro_remaining"] = state["pomodoro_duration"]

    # Break countdown
    elif state["break"] and state["break_remaining"] > 0:
        state["break_remaining"] -= 1
        needs_broadcast = True
        if state["break_remaining"] == 0:
            state["break"] = False

    return needs_broadcast


async def tick():
    counter = 0
    while True:
        await asyncio.sleep(1)
        counter += 1
        for room in list(rooms.values()):
            if not room["clients"]:
                continue
            state = room["state"]
            needs_broadcast = advance_timer_state(state)

            # Celestial refresh every 30 s when not overridden
            if counter % 30 == 0 and state["time_override"] is None:
                state["celestial"] = get_celestial_state()
                needs_broadcast = True

            if needs_broadcast:
                await broadcast(room, {"type": "state", "data": state})


@asynccontextmanager
async def lifespan(app: FastAPI):
    del app
    task = asyncio.create_task(tick())
    try:
        yield
    finally:
        _ = task.cancel()
        with suppress(asyncio.CancelledError):
            await task


app = FastAPI(lifespan=lifespan)

# ── Routes ────────────────────────────────────────────────────────────────────
@app.get("/")
async def lobby():
    return FileResponse(os.path.join(FRONTEND, "lobby.html"))

@app.get("/room/{room_id}")
async def room_page(room_id: str):
    _ = room_id
    return FileResponse(os.path.join(FRONTEND, "room.html"))


# ── WebSocket ─────────────────────────────────────────────────────────────────
@app.websocket("/ws/{room_id}")
async def ws_endpoint(websocket: WebSocket, room_id: str):
    room = get_room(room_id.upper())
    if room is None:
        await websocket.accept()
        await websocket.close(code=1008, reason="room limit reached")
        return
    await websocket.accept()
    room["clients"].add(websocket)
    await websocket.send_text(json.dumps({"type": "state", "data": room["state"]}))
    try:
        async for raw in websocket.iter_text():
            try:
                await handle(room["state"], cast(dict[str, object], json.loads(raw)))
                await broadcast(room, {"type": "state", "data": room["state"]})
            except Exception:
                # Bad input from one client must never kill the room loop.
                logger.exception("handle() failed for room %s", room_id)
    except WebSocketDisconnect:
        room["clients"].discard(websocket)
        if not room["clients"]:
            room["cleanup"] = asyncio.create_task(schedule_cleanup(room_id.upper()))


async def handle(state: BackendState, msg: dict[str, object]):
    t = msg.get("type")
    if t == "time_override":
        iso = cast(str | None, msg.get("iso"))
        dt = _parse_iso(iso) if iso else None
        state["time_override"] = iso
        state["celestial"] = get_celestial_state(dt)
    elif t == "focus_toggle":
        if state["break"]:
            # Cancel ongoing break and start fresh
            state["break"] = False
            state["break_remaining"] = 0
        state["focus"] = not state["focus"]
        state["paused"] = False
        state["pomodoro_remaining"] = state["pomodoro_duration"]
    elif t == "focus_pause":
        # Freeze/resume the running timer. Music is user-controlled, untouched.
        if state["focus"]:
            state["paused"] = not state["paused"]
    elif t == "focus_cancel":
        # End the session entirely → back to idle, timer reset.
        state["focus"] = False
        state["paused"] = False
        state["break"] = False
        state["break_remaining"] = 0
        state["pomodoro_remaining"] = state["pomodoro_duration"]
    elif t == "set_duration":
        mins = msg.get("minutes")
        if isinstance(mins, int) and 1 <= mins <= 120:
            state["pomodoro_duration"] = mins * 60
            if not state["focus"]:
                state["pomodoro_remaining"] = state["pomodoro_duration"]
    elif t == "skip_break":
        state["break"] = False
        state["break_remaining"] = 0
    elif t == "music_play":
        state["music"]["playing"] = True
    elif t == "music_pause":
        state["music"]["playing"] = False
    elif t == "music_skip":
        vid = msg.get("video_id")
        if isinstance(vid, str) and YT_ID_RE.match(vid):
            state["music"]["video_id"] = vid
    elif t == "location":
        lat, lon = msg.get("lat"), msg.get("lon")
        if not (isinstance(lat, (int, float)) and isinstance(lon, (int, float))):
            return
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            return
        dt = _parse_iso(state["time_override"]) if state["time_override"] else None
        state["celestial"] = get_celestial_state(lat=lat, lon=lon, dt=dt)


app.mount("/", StaticFiles(directory=FRONTEND), name="static")
