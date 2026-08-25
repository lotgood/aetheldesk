import asyncio
import logging
import time
from importlib import import_module
from typing import Any, cast

from backend.scheduler import RoomTickScheduler
from backend.room_store import RedisUnavailable
from backend.state import advance_timer_state

_room_service = import_module("backend.room_service")
_runtime = cast(Any, _room_service._runtime)
broadcast = cast(Any, _room_service.broadcast)
logger = logging.getLogger("aetheldesk.scheduler")


async def tick():
    runtime = _runtime()
    counter = 0
    while True:
        await asyncio.sleep(1)
        counter += 1
        if runtime.room_store is not None:
            try:
                scheduler = RoomTickScheduler(
                    runtime.room_store,
                    connections=runtime.connections,
                    worker_id=runtime.worker_id,
                    celestial_provider=runtime.get_celestial_state,
                    publisher=runtime.event_bus,
                )
                await scheduler.tick_once(counter=counter)
            except asyncio.CancelledError:
                raise
            except RedisUnavailable:
                logger.warning("timer scheduler waiting for Redis recovery")
            except Exception:
                logger.exception("timer scheduler iteration failed")
            continue

        for room in list(runtime.rooms.values()):
            if not room["clients"]:
                continue
            state = room["state"]
            logical_slot = int(time.time())
            advancing = state["break"] or (state["focus"] and not state["paused"])
            needs_broadcast = False
            if advancing:
                previous_slot = state["last_tick_slot"]
                elapsed_seconds = 1 if previous_slot is None else max(0, logical_slot - previous_slot)
                needs_broadcast = advance_timer_state(state, elapsed_seconds)
                still_advancing = state["break"] or (state["focus"] and not state["paused"])
                state["last_tick_slot"] = logical_slot if still_advancing else None

            if counter % 30 == 0 and state["time_override"] is None:
                state["celestial"] = runtime.get_celestial_state()
                needs_broadcast = True

            if needs_broadcast:
                state["revision"] += 1
                await broadcast(room, {"type": "state", "data": state})
